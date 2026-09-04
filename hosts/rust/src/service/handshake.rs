// Quackoscope host (Rust) -- service layer.
//
// The handshake of contract section 7: the FIRST message this host sends on
// every session, before any request is answered.
//
// The gap list is COMPUTED, never written: contract section 4 defines it as
// baseline capabilities minus the capabilities this host serves, and a host
// declares only the reason per gap. Removing a row from the dispatch table in
// session.rs is what turns a capability back into a gap, and the reason table
// below is the only thing this file adds by hand.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde_json::{json, Value as Json};

use super::manifest::Manifest;

/// contract.protocol_version.
pub const PROTOCOL_VERSION: &str = "1.0";

/// The 20 baseline capability ids of contract section 4, in contract order.
/// hosts/cpp reads these from generated/cpp/quackoscope-contract.hpp; the
/// contract compiler emits no equivalent Rust module (generated/rust holds
/// symbol-list.json only), so they are spelled out here and the wire method
/// names below are cross-checked against generated/rust/symbol-list.json at
/// startup instead. generated/wire/capability-baseline.json carries the same
/// 20 ids and the same wire-method grouping, and
/// verify_capability_table_against_generated_baseline below refuses to start
/// the host when this file and that artifact disagree, so growing the contract
/// cannot leave a host announcing a capability set computed against the old
/// baseline.
///
/// module.load is its own id and not part of module.read: listing the loaded
/// modules is an enumeration, while load_module_from_host_path makes THIS
/// process dlopen a file off its own disk and run that file's initialisation.
/// Capabilities are ALL-OF, so folding the two together would leave a host no
/// way to serve the Modules view without also serving the loader. The eight ids
/// added with the attributes, servers, recorder, batched-update and
/// configuration rows split along the same line and for the same reason:
/// attribute.read from attribute.write, server.discovery from server.add,
/// property.batched_update from property.write, configuration.save from
/// configuration.load.
pub const BASELINE_CAPABILITY_IDS: [&str; 20] = [
    "device.scan",
    "device.connect",
    "tree.read",
    "property.read",
    "property.write",
    "function_block.add",
    "streaming.decimated",
    "streaming.raw",
    "device.mode",
    "device.lock",
    "module.read",
    "module.load",
    "attribute.read",
    "attribute.write",
    "server.add",
    "server.discovery",
    "recorder.control",
    "property.batched_update",
    "configuration.save",
    "configuration.load",
];

/// Which capability owns which wire method, contract section 5.
pub const CONTRACT_OPERATION_TABLE: [(&str, &str); 30] = [
    ("scan_available_devices", "device.scan"),
    ("connect_device", "device.connect"),
    ("disconnect_device", "device.connect"),
    ("get_component_tree", "tree.read"),
    ("get_property_value", "property.read"),
    ("get_property_descriptors", "property.read"),
    ("set_property_value", "property.write"),
    ("list_function_block_types", "function_block.add"),
    ("add_function_block", "function_block.add"),
    ("remove_function_block", "function_block.add"),
    ("subscribe_signal", "streaming.decimated"),
    ("unsubscribe_signal", "streaming.decimated"),
    ("read_samples_raw", "streaming.raw"),
    ("get_device_operation_modes", "device.mode"),
    ("set_device_operation_mode", "device.mode"),
    ("lock_device", "device.lock"),
    ("unlock_device", "device.lock"),
    ("list_loaded_modules", "module.read"),
    ("load_module_from_host_path", "module.load"),
    ("get_component_attributes", "attribute.read"),
    ("set_component_attribute", "attribute.write"),
    ("list_server_types", "server.add"),
    ("add_server", "server.add"),
    ("set_server_discovery_enabled", "server.discovery"),
    ("start_recording", "recorder.control"),
    ("stop_recording", "recorder.control"),
    ("begin_batched_property_update", "property.batched_update"),
    ("end_batched_property_update", "property.batched_update"),
    (
        "save_instance_configuration_to_string",
        "configuration.save",
    ),
    (
        "load_instance_configuration_from_string",
        "configuration.load",
    ),
];

/// contract gap_generation.kinds: exactly these two, whether or not this host
/// currently declares a gap of each kind.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GapKind {
    /// The SDK binding for this host language lacks the feature.
    Binding,
    /// The handler has not been written yet.
    Host,
}

impl GapKind {
    pub fn to_wire(self) -> &'static str {
        match self {
            GapKind::Binding => "binding",
            GapKind::Host => "host",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Gap {
    pub capability: String,
    pub kind: GapKind,
    pub reason: String,
}

/// The reason this host declares for each capability it does not serve.
///
/// Every kind here is "host". GapKind::Binding is a claim that a language's
/// openDAQ binding CANNOT do the thing, and this host only makes it where the
/// surface was actually enumerated and the API was genuinely absent; the
/// neutral default is "currently not available", which blames nobody. Where the
/// surface WAS enumerated and the members are there, the reason says so, names
/// the members with their real signatures, and names where they were read.
///
/// A further reason this host never reaches for GapKind::Binding lightly: it
/// does not use an openDAQ binding at all. openDAQ ships c, dotnet and python
/// bindings only. This host builds on the THIRD-PARTY crate `opendaq` 0.1.1
/// (github.com/mihoci10/opendaq-rs, MIT, author Miha Krajnc), which dlopens
/// copendaq through libloading. Anything missing there is that crate's gap and
/// must be worded as that crate's gap, never as "the openDAQ Rust binding
/// cannot" -- there is no openDAQ Rust binding to accuse.
fn declared_gap_reasons() -> BTreeMap<&'static str, (GapKind, String)> {
    let mut reasons = BTreeMap::new();

    reasons.insert(
        "function_block.add",
        (
            GapKind::Host,
            "list_function_block_types, add_function_block and remove_function_block have no handler in \
             quackoscope-host-rust; currently not available. This is unwritten host code and not a gap in the \
             third-party opendaq crate 0.1.1, and that crate's surface was enumerated to say so: in its vendored \
             source at \
             ~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/opendaq-0.1.1/src/generated/device.rs, the \
             inherent `impl Device` block spans lines 2735-3467 and declares 49 public methods, of which six \
             match *function_block*: \
             `pub fn available_function_block_types(&self) -> Result<std::collections::HashMap<String, FunctionBlockType>>` \
             (line 2966), `pub fn add_function_block(&self, type_id: &str) -> Result<Option<FunctionBlock>>` \
             (line 2824), \
             `pub fn add_function_block_with(&self, type_id: &str, config: Option<&PropertyObject>) -> Result<Option<FunctionBlock>>` \
             (line 2842), `pub fn remove_function_block(&self, function_block: &FunctionBlock) -> Result<()>` \
             (line 3403), `pub fn function_blocks(&self) -> Result<Vec<FunctionBlock>>` (line 3130) and \
             `pub fn function_blocks_with(&self, search_filter: Option<&SearchFilter>) -> Result<Vec<FunctionBlock>>` \
             (line 3146). Every one is Result-wrapped -- `opendaq::Result<T, E = Error>`, declared at \
             opendaq-0.1.1/src/error.rs line 12 -- so each call site needs `?`, and the crate's own \
             examples/add_function_block.rs exercises exactly that path with \
             `instance.add_function_block(\"RefFBModuleStatistics\")?`. All three contract operations are therefore \
             writable against this crate; they were not written in the time this host was built."
                .to_string(),
        ),
    );

    reasons.insert(
        "streaming.raw",
        (
            GapKind::Host,
            "read_samples_raw has no handler in quackoscope-host-rust; currently not available. \
             contract/contract.yaml declares \
             returns: {type: binary_frame} for it, but envelopes.result carries a JSON result and the 17-byte \
             binary frame header (subscription_id, domain_start, sample_count, encoding) has no correlation id, \
             so a binary answer cannot be matched back to its request id. The two generated clients already \
             disagree about the JSON stand-in, and this host will not pick one of them on the contract's behalf. \
             hosts/cpp declares the same capability a gap for the same reason."
                .to_string(),
        ),
    );

    reasons
}

/// The hand-written operation table above is checked against the contract
/// compiler's output before the handshake is built. If they disagree the host
/// refuses to start rather than announce a capability set computed against the
/// wrong baseline.
pub fn verify_operation_table_against_generated_symbol_list(
    symbol_list_path: &Path,
) -> Result<usize, String> {
    let text = std::fs::read_to_string(symbol_list_path).map_err(|e| {
        format!(
            "the generated symbol list could not be read: {} ({e}); it is what the hand-written operation \
             table in hosts/rust/src/service/handshake.rs is checked against",
            symbol_list_path.display()
        )
    })?;

    let parsed: Json = serde_json::from_str(&text).map_err(|e| {
        format!(
            "the generated symbol list is not valid JSON ({}): {e}",
            symbol_list_path.display()
        )
    })?;

    let symbols = parsed
        .get("symbols")
        .and_then(Json::as_array)
        .ok_or_else(|| {
            format!(
                "the generated symbol list has no \"symbols\" array: {}",
                symbol_list_path.display()
            )
        })?;

    let mut generated_wire_methods = BTreeSet::new();
    for symbol in symbols {
        if symbol.get("kind").and_then(Json::as_str) != Some("call") {
            continue;
        }
        for method in symbol
            .get("covers_wire_methods")
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
            .filter_map(Json::as_str)
        {
            generated_wire_methods.insert(method.to_string());
        }
    }

    let mut table_wire_methods = BTreeSet::new();
    for (wire_method, capability) in CONTRACT_OPERATION_TABLE {
        if !table_wire_methods.insert(wire_method.to_string()) {
            return Err(format!(
                "wire method \"{wire_method}\" appears twice in the operation table of \
                 hosts/rust/src/service/handshake.rs"
            ));
        }
        if !BASELINE_CAPABILITY_IDS.contains(&capability) {
            return Err(format!(
                "wire method \"{wire_method}\" is mapped to capability \"{capability}\", which is not one of \
                 the {} baseline capability ids of contract/contract.yaml section 4",
                BASELINE_CAPABILITY_IDS.len()
            ));
        }
    }

    for method in &generated_wire_methods {
        if !table_wire_methods.contains(method) {
            return Err(format!(
                "wire method \"{method}\" is a call symbol in {} but is missing from the operation table of \
                 hosts/rust/src/service/handshake.rs",
                symbol_list_path.display()
            ));
        }
    }
    for method in &table_wire_methods {
        if !generated_wire_methods.contains(method) {
            return Err(format!(
                "wire method \"{method}\" is in the operation table of hosts/rust/src/service/handshake.rs \
                 but is not a call symbol in {}",
                symbol_list_path.display()
            ));
        }
    }

    for capability in BASELINE_CAPABILITY_IDS {
        if !CONTRACT_OPERATION_TABLE
            .iter()
            .any(|(_, owner)| *owner == capability)
        {
            return Err(format!(
                "baseline capability \"{capability}\" owns no wire method in the operation table of \
                 hosts/rust/src/service/handshake.rs"
            ));
        }
    }

    Ok(generated_wire_methods.len())
}

/// The capability table above is checked against
/// generated/wire/capability-baseline.json -- the artifact the contract compiler
/// writes and every host, the snippet extractor and the conformance harness read
/// -- before the handshake is built.
///
/// This exists because the gap list is COMPUTED as baseline minus served: a
/// baseline this file has fallen behind on does not fail loudly, it silently
/// shrinks the set a gap can be computed against, and the host announces a clean
/// sweep of a contract that has since grown. hosts/csharp does the same check in
/// CapabilityBaselineArtifact.cs.
pub fn verify_capability_table_against_generated_baseline(
    capability_baseline_path: &Path,
) -> Result<usize, String> {
    let text = std::fs::read_to_string(capability_baseline_path).map_err(|e| {
        format!(
            "the generated capability baseline could not be read: {} ({e}); it is what the capability \
             table in hosts/rust/src/service/handshake.rs is checked against, and the gap list is \
             computed as that baseline minus the capabilities this host serves",
            capability_baseline_path.display()
        )
    })?;

    let parsed: Json = serde_json::from_str(&text).map_err(|e| {
        format!(
            "the generated capability baseline is not valid JSON ({}): {e}",
            capability_baseline_path.display()
        )
    })?;

    let capabilities = parsed
        .get("capabilities")
        .and_then(Json::as_array)
        .ok_or_else(|| {
            format!(
                "the generated capability baseline has no \"capabilities\" array: {}",
                capability_baseline_path.display()
            )
        })?;

    let mut baseline_pairs: BTreeSet<(String, String)> = BTreeSet::new();
    let mut baseline_ids: Vec<String> = Vec::new();
    for capability in capabilities {
        let id = capability
            .get("id")
            .and_then(Json::as_str)
            .ok_or_else(|| {
                format!(
                    "a capability entry in {} has no string \"id\"",
                    capability_baseline_path.display()
                )
            })?
            .to_string();
        for wire_method in capability
            .get("wire_methods")
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
            .filter_map(Json::as_str)
        {
            baseline_pairs.insert((wire_method.to_string(), id.clone()));
        }
        baseline_ids.push(id);
    }

    if baseline_ids.len() != BASELINE_CAPABILITY_IDS.len() {
        return Err(format!(
            "{} lists {} capability ids ({}) but BASELINE_CAPABILITY_IDS in \
             hosts/rust/src/service/handshake.rs holds {} ({})",
            capability_baseline_path.display(),
            baseline_ids.len(),
            baseline_ids.join(", "),
            BASELINE_CAPABILITY_IDS.len(),
            BASELINE_CAPABILITY_IDS.join(", ")
        ));
    }
    for (index, id) in baseline_ids.iter().enumerate() {
        if BASELINE_CAPABILITY_IDS[index] != id {
            return Err(format!(
                "capability id {} of {} is \"{id}\" but BASELINE_CAPABILITY_IDS in \
                 hosts/rust/src/service/handshake.rs has \"{}\" there; the two must agree in contract order",
                index + 1,
                capability_baseline_path.display(),
                BASELINE_CAPABILITY_IDS[index]
            ));
        }
    }

    let table_pairs: BTreeSet<(String, String)> = CONTRACT_OPERATION_TABLE
        .iter()
        .map(|(wire_method, capability)| (wire_method.to_string(), capability.to_string()))
        .collect();

    for (wire_method, capability) in &baseline_pairs {
        if !table_pairs.contains(&(wire_method.clone(), capability.clone())) {
            return Err(format!(
                "{} maps wire method \"{wire_method}\" to capability \"{capability}\", which the operation \
                 table of hosts/rust/src/service/handshake.rs does not",
                capability_baseline_path.display()
            ));
        }
    }
    for (wire_method, capability) in &table_pairs {
        if !baseline_pairs.contains(&(wire_method.clone(), capability.clone())) {
            return Err(format!(
                "the operation table of hosts/rust/src/service/handshake.rs maps wire method \
                 \"{wire_method}\" to capability \"{capability}\", which {} does not",
                capability_baseline_path.display()
            ));
        }
    }

    Ok(baseline_pairs.len())
}

/// A capability is served only when EVERY wire method it owns has a handler.
pub fn capabilities_fully_served_by(served_wire_methods: &BTreeSet<String>) -> Vec<String> {
    BASELINE_CAPABILITY_IDS
        .iter()
        .filter(|capability| {
            CONTRACT_OPERATION_TABLE
                .iter()
                .filter(|(_, owner)| owner == *capability)
                .all(|(wire_method, _)| served_wire_methods.contains(*wire_method))
        })
        .map(|capability| capability.to_string())
        .collect()
}

/// baseline minus served, with the declared reason attached to each.
pub fn gaps_against_baseline(served_capabilities: &[String]) -> Result<Vec<Gap>, String> {
    let reasons = declared_gap_reasons();
    let mut gaps = Vec::new();

    for capability in BASELINE_CAPABILITY_IDS {
        if served_capabilities.iter().any(|served| served == capability) {
            continue;
        }
        match reasons.get(capability) {
            Some((kind, reason)) if !reason.is_empty() => gaps.push(Gap {
                capability: capability.to_string(),
                kind: *kind,
                reason: reason.clone(),
            }),
            _ => {
                return Err(format!(
                    "capability \"{capability}\" is a gap (this host dispatches none or only some of its wire \
                     methods) but hosts/rust/src/service/handshake.rs declares no reason for it; contract \
                     types.Gap.reason has min_length 1, so the handshake cannot be built"
                ))
            }
        }
    }
    Ok(gaps)
}

pub fn build_handshake(
    implementation_name: &str,
    implementation_version: &str,
    manifest: &Manifest,
    capabilities: &[String],
    gaps: &[Gap],
    max_subscriptions: i64,
    max_frame_bytes: i64,
) -> Json {
    let gap_array: Vec<Json> = gaps
        .iter()
        .map(|gap| {
            json!({
                "capability": gap.capability,
                "kind": gap.kind.to_wire(),
                "reason": gap.reason,
            })
        })
        .collect();

    json!({
        "protocol_version": PROTOCOL_VERSION,
        "implementation": { "name": implementation_name, "version": implementation_version },
        "sdk": { "version": manifest.sdk_version, "commit": manifest.commit },
        "capabilities": capabilities,
        "gaps": gap_array,
        "limits": { "max_subscriptions": max_subscriptions, "max_frame_bytes": max_frame_bytes },
    })
}
