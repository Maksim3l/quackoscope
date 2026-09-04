// Quackoscope host (Rust) -- openDAQ layer.
//
// THE ONLY module that mentions the `opendaq` crate. Nothing here knows about
// sockets, HTTP or the WebSocket envelope; it speaks the service layer's DTOs
// and returns service::ServiceError with codes drawn from the closed set by
// service::error::map_native_error_code.
//
// Every operation marks the SDK calls a reader would need in order to write
// that same operation against openDAQ in another language, inside quack-snippet
// markers that tools/snippet-extractor reads:
//
//     // quack-snippet capability=<id>[,<id>...] [uses=<name>,...] [step=<n>]
//     ...the SDK calls...
//     // quack-snippet end
//
//     // quack-snippet shared=<name> [uses=<name>,...] [step=<n>]
//     ...the SDK calls...
//     // quack-snippet end
//
// The capability ids and the shared-region names are the ones
// hosts/cpp/src/opendaq/daq_backend.cpp uses -- component-kind,
// property-wire-value-type, property-descriptor, json-to-opendaq-value,
// property-by-name, component-node, instance-with-module-path -- so the
// extractor pairs the C++ and Rust columns row by row.
//
// The rows added with contract capabilities device.mode, device.lock and
// module.read bring five more shared regions, named the same way and for the
// same reason: component-status-container (the ComponentStatus /
// ConnectionStatus pair every component keeps), effective-device-lock-state
// (IDevice.isLocked() walked up the parent chain, which is what makes
// Node.locked effective), operation-mode-names (OperationModeType <-> the
// wire's four names), device-facet-of-component (the cast the four
// device-scoped operations all begin with) and module-component-types (the
// four type dictionaries a module advertises).
//
// The eleven rows added with attribute.read, attribute.write, server.add,
// server.discovery, recorder.control, property.batched_update,
// configuration.save and configuration.load bring four more, and their names are
// hosts/cpp/src/opendaq/daq_backend.cpp's, so the extractor pairs the columns:
// server-of-component and recorder-of-component (the two interface queries that
// decide whether a component has a discovery control or a Start/Stop control at
// all), property-object-update-state (IPropertyObject::getUpdating, which is
// Node.updating and is also what tells begin from end), and
// component-attribute-rows (the whole attribute enumeration, which
// get_component_attributes answers with and set_component_attribute consults
// before it writes, so the two can never disagree about what is writable).
//
// One name here does NOT match the C++ host and is left alone deliberately:
// this file's device-facet-of-component is hosts/cpp's device-of-component. That
// pair predates these rows, renaming it would touch four operations this change
// is not about, and it is stated here rather than left to be discovered.
//
// Session bookkeeping, JSON marshalling, node-id registry lookups and the
// native-status-code mapping stay OUTSIDE every region: they are this host's
// plumbing, not openDAQ.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use opendaq::{
    Component, ComponentKind, ComponentStatusContainer, ComponentType, CoreType, Device,
    DevicePrivate, Folder, InputPort, Instance, InstanceBuilder, Interface, LogLevel,
    ModuleManager, OperationModeType, Property, PropertyObject, Recorder, Server, Signal,
    StreamReader, Struct, StructBuilder, TagsPrivate, Value as DaqValue,
};
use serde_json::{Map, Value as Json};

use crate::service::daq_backend_interface::{DaqBackend as DaqBackendTrait, SampleSink};
use crate::service::error::{
    map_native_error_code, ErrorCode, MapContext, ServiceError, ServiceResult,
};
use crate::service::types::{
    ComponentAttribute, ComponentTypeInfo, DeviceInfo, ModuleInfo as WireModuleInfo, Node,
    PropertyDescriptor,
};

/// How many samples one pump read asks for, and how long it waits for them.
/// The same 65536 / 50 ms the C++ host uses, so the two hosts produce frames
/// at the same cadence for the same signal.
const PUMP_BUFFER_SAMPLES: usize = 65536;
const PUMP_TIMEOUT_MS: usize = 50;

// --- native failures -------------------------------------------------------

/// Native openDAQ failure -> closed-set error. The classification table lives
/// in the service layer; this only ferries the status code across the seam.
fn translate(e: &opendaq::Error, context: MapContext) -> ServiceError {
    ServiceError::new(map_native_error_code(e.code(), context), e.to_string())
}

fn translate_general(e: &opendaq::Error) -> ServiceError {
    translate(e, MapContext::General)
}

/// daqModuleManager_loadModule's own reading of the status codes. It differs
/// from the general one in exactly the two places the general one would put a
/// code outside this operation's declared subset on the wire: see
/// MapContext::ModuleLoad in hosts/rust/src/service/error.rs.
fn translate_module_load(e: &opendaq::Error) -> ServiceError {
    translate(e, MapContext::ModuleLoad)
}

// --- Value <-> JSON --------------------------------------------------------

/// openDAQ value -> wire JSON.
fn value_to_json(value: &DaqValue) -> Json {
    match value {
        DaqValue::Null => Json::Null,
        DaqValue::Bool(b) => Json::Bool(*b),
        DaqValue::Int(i) => Json::from(*i),
        DaqValue::Float(f) => serde_json::Number::from_f64(*f)
            .map(Json::Number)
            .unwrap_or(Json::Null),
        DaqValue::Str(s) => Json::String(s.clone()),
        DaqValue::List(items) => Json::Array(items.iter().map(value_to_json).collect()),
        DaqValue::Dict(pairs) => {
            let mut object = Map::new();
            for (key, item) in pairs {
                object.insert(describe(key), value_to_json(item));
            }
            Json::Object(object)
        }
        DaqValue::Object(object) => {
            // A Struct is the one object type the wire's value_type set carries;
            // everything else (procedures, functions, property objects) crosses
            // as its openDAQ string rendering.
            match object.try_cast::<Struct>() {
                Some(structure) => struct_to_json(&structure),
                None => Json::String(object.to_string()),
            }
        }
        // Ratio and Complex have no member of the contract's value_type set;
        // they cross as their openDAQ string rendering, like the C++ host's
        // default branch does.
        other => Json::String(other.to_string()),
    }
}

fn struct_to_json(structure: &Struct) -> Json {
    let mut object = Map::new();
    let Ok(field_names) = structure.field_names() else {
        return Json::String(structure.to_string());
    };
    for name in field_names {
        match structure.get(&name) {
            Ok(field) => {
                object.insert(name, value_to_json(&field));
            }
            Err(e) => {
                object.insert(name, Json::String(format!("<unreadable struct field: {e}>")));
            }
        }
    }
    Json::Object(object)
}

fn describe(value: &DaqValue) -> String {
    match value {
        DaqValue::Str(s) => s.clone(),
        other => other.to_string(),
    }
}

// --- component kind --------------------------------------------------------

/// How a component's kind is decided. The shared region component-kind;
/// component-node uses it, and so reach it connect_device and
/// get_component_tree.
fn kind_of(component: &Component) -> &'static str {
    // quack-snippet shared=component-kind
    // openDAQ has no "kind" attribute: a component's kind is whichever of the
    // component interfaces it can be cast to, most-derived first, because a
    // Channel is also a FunctionBlock and a Device is also a Folder. The
    // opendaq crate does that probe once in BaseObject::component_kind(),
    // which is Rust's spelling of the C++ host's chain of asPtrOrNull casts.
    let kind = component.as_base_object().component_kind();
    let wire_kind = match kind {
        Some(ComponentKind::Channel) => "channel",
        Some(ComponentKind::Device) => "device",
        Some(ComponentKind::FunctionBlock) => "function_block",
        Some(ComponentKind::Signal) => "signal",
        // A server is INVISIBLE to that probe. openDAQ's IServer derives from
        // IFolder, so component_kind() answers Folder for one, and the crate's
        // ComponentKind enum has no Server variant at all -- it is
        // (Channel, FunctionBlock, Device, Signal, InputPort, Folder, Component).
        // The only thing that tells a server row from a folder row is asking the
        // object for the IServer interface, which is what NodeKind's `server`
        // value and the row menu's discovery items both need.
        //
        // Input ports still fall through to "folder": the contract's NodeKind
        // has no input_port value, and this host does not invent one.
        _ => match component.as_base_object().try_cast::<Server>() {
            Some(_) => "server",
            None => "folder",
        },
    };
    // quack-snippet end
    wire_kind
}

/// The Server facet of a component. The shared region server-of-component;
/// component-kind uses it, and so does set_server_discovery_enabled.
fn server_facet_of(component: &Component) -> Option<Server> {
    // quack-snippet shared=server-of-component
    // openDAQ declares enableDiscovery() and disableDiscovery() on IServer
    // (server.h:66 and server.h:90) and on no other interface, so a component
    // has to be queried for IServer before either can be called. A Server IS a
    // Folder and a Component; the reverse does not hold, which is why this is an
    // interface query and not a reinterpretation.
    let server = component.as_base_object().try_cast::<Server>();
    // quack-snippet end
    server
}

/// The Recorder facet of a component. The shared region
/// recorder-of-component; component-node reads Node.recording through it,
/// and start_recording and stop_recording both begin with it.
fn recorder_facet_of(component: &Component) -> Option<Recorder> {
    // quack-snippet shared=recorder-of-component
    // A recorder is a function block that ALSO carries IRecorder, which is
    // where getIsRecording(), startRecording() and stopRecording() live
    // (recorder.h:62 and below). Nothing about a function block's type id or its
    // place in the tree says whether it is one, so the question is an interface
    // query -- the same one the reference asks with
    // daq.IRecorder.can_cast_from(self.node) before it builds RecorderView
    // (block_view.py:169-171).
    let recorder = component.as_base_object().try_cast::<Recorder>();
    // quack-snippet end
    recorder
}

/// Whether a batched property update is open on this component. The shared
/// region property-object-update-state; component-node fills Node.updating from
/// it and the two batched-update operations bracket it.
fn batched_update_is_open_on(component: &Component) -> Option<bool> {
    // quack-snippet shared=property-object-update-state
    // IPropertyObject::getUpdating(Bool*) (property_object.h:361) answers "a
    // beginUpdate has been called on this object and no endUpdate has closed
    // it", and while that holds every setPropertyValue against the object is
    // STAGED rather than applied. Almost every openDAQ component is an
    // IPropertyObject, but not literally every one, so the facet is queried
    // rather than assumed and a component without it reports null.
    let updating = component
        .as_base_object()
        .try_cast::<PropertyObject>()
        .and_then(|object| object.updating().ok());
    // quack-snippet end
    updating
}

// --- component state -------------------------------------------------------
//
// The six nullable fields contract section 3 puts on types.Node. Every one of
// them is read defensively: openDAQ answers OPENDAQ_ERR_NOTFOUND for a status a
// component does not keep, and that is not a failure of the read -- it is the
// component saying it does not report that fact -- so it becomes null on the
// wire and the client draws no label. That is gui_demo.py's
// _build_component_state_labels, which wraps every one of these reads in
// try/except and appends no label when it raises.

/// openDAQ's OperationModeType <-> the wire's operation_mode vocabulary. The
/// shared region operation-mode-names; Node.operation_mode,
/// get_device_operation_modes and set_device_operation_mode all use it.
fn operation_mode_wire_name(mode: OperationModeType) -> Option<&'static str> {
    // quack-snippet shared=operation-mode-names step=1
    // openDAQ's OperationModeType, declared in
    // core/opendaq/component/include/opendaq/component.h, is (Unknown, Idle,
    // Operation, SafeOperation). The wire carries the same four, lowercased
    // with an underscore join. The opendaq crate marks the enum
    // #[non_exhaustive], so a variant a later SDK adds reaches the wildcard and
    // is reported as "not a mode this contract carries" rather than being
    // mislabelled as one of the four.
    let wire_name = match mode {
        OperationModeType::Unknown => Some("unknown"),
        OperationModeType::Idle => Some("idle"),
        OperationModeType::Operation => Some("operation"),
        OperationModeType::SafeOperation => Some("safe_operation"),
        _ => None,
    };
    // quack-snippet end
    wire_name
}

fn operation_mode_from_wire_name(wire_name: &str) -> Option<OperationModeType> {
    // quack-snippet shared=operation-mode-names step=2
    let mode = match wire_name {
        "unknown" => Some(OperationModeType::Unknown),
        "idle" => Some(OperationModeType::Idle),
        "operation" => Some(OperationModeType::Operation),
        "safe_operation" => Some(OperationModeType::SafeOperation),
        _ => None,
    };
    // quack-snippet end
    mode
}

/// One named status out of a component's status container, as the enumerator's
/// own name. The shared region component-status-container; component-node uses
/// it for both ComponentStatus and ConnectionStatus.
fn status_enumerator_name(
    container: &ComponentStatusContainer,
    status_name: &str,
) -> Option<String> {
    // quack-snippet shared=component-status-container
    // Every component keeps a status container addressed by name. openDAQ's own
    // two names are "ComponentStatus", whose EnumerationType is
    // (Ok, Warning, Error), and "ConnectionStatus", whose EnumerationType is
    // (Connected, Reconnecting, Unrecoverable, Removed); both are registered on
    // the type manager in core/opendaq/modulemanager/src/context_impl.cpp. The
    // value is an Enumeration, and its value() is the enumerator's own name.
    // A container that keeps no status of that name answers
    // OPENDAQ_ERR_NOTFOUND, which means "this component does not report it".
    let found = container.status(status_name);
    let enumerator_name = match found {
        Ok(Some(status)) => status.value().ok(),
        _ => None,
    };
    // quack-snippet end
    enumerator_name
}

fn status_message(container: &ComponentStatusContainer, status_name: &str) -> Option<String> {
    // quack-snippet shared=component-status-container step=2
    let message = container.status_message(status_name);
    // quack-snippet end
    match message {
        Ok(text) if !text.is_empty() => Some(text),
        _ => None,
    }
}

/// ComponentStatusType's enumerator names -> the wire's component_status set.
/// No SDK call: this is the wire mapping, so it sits outside every region.
fn component_status_wire_value(enumerator_name: &str) -> Option<&'static str> {
    match enumerator_name {
        "Ok" => Some("ok"),
        "Warning" => Some("warning"),
        "Error" => Some("error"),
        _ => None,
    }
}

/// ConnectionStatusType's enumerator names -> the wire's connection_status set.
fn connection_status_wire_value(enumerator_name: &str) -> Option<&'static str> {
    match enumerator_name {
        "Connected" => Some("connected"),
        "Reconnecting" => Some("reconnecting"),
        "Unrecoverable" => Some("unrecoverable"),
        "Removed" => Some("removed"),
        _ => None,
    }
}

/// The EFFECTIVE lock state contract types.Node.locked asks for, inheritance
/// already applied. The shared region effective-device-lock-state;
/// component-node uses it.
fn effective_locked(component: &Component) -> Option<bool> {
    // quack-snippet shared=effective-device-lock-state
    // openDAQ declares isLocked() on IDevice and nowhere else, so a component
    // that is not a device has no lock state of its own and inherits the
    // nearest ancestor device's -- which is exactly what the reference
    // recomputes client side in gui_demo.py's _set_node_lock_status_recursive.
    // Doing it here means one walk up the parent chain per row instead of a
    // rule every client has to reimplement.
    if let Some(device) = component.as_base_object().try_cast::<Device>() {
        return device.is_locked().ok();
    }
    let mut ancestor = component.parent().ok().flatten();
    while let Some(current) = ancestor {
        if let Some(device) = current.as_base_object().try_cast::<Device>() {
            return device.is_locked().ok();
        }
        ancestor = current.parent().ok().flatten();
    }
    // quack-snippet end
    None
}

// --- property descriptors --------------------------------------------------

/// The closed value_type set. A property whose openDAQ core type has no member
/// of that set (Object, Proc, Func, Ratio, Enumeration, ...) is not
/// representable on the M1 wire and is omitted rather than misreported.
fn wire_value_type(property: &Property) -> Result<Option<&'static str>, opendaq::Error> {
    // quack-snippet shared=property-wire-value-type
    // A property with selection values is a selection whatever its storage
    // type says; otherwise the core type of the property decides.
    if !property.selection_values()?.is_null() {
        return Ok(Some("selection"));
    }
    let wire_type = match property.value_type()? {
        CoreType::Bool => Some("bool"),
        CoreType::Int => Some("int"),
        CoreType::Float => Some("float"),
        CoreType::String => Some("string"),
        CoreType::Struct => Some("struct"),
        _ => None,
    };
    // quack-snippet end
    Ok(wire_type)
}

fn is_representable(property: &Property) -> bool {
    matches!(wire_value_type(property), Ok(Some(_)))
}

/// The whole descriptor mechanism: everything openDAQ can say about one
/// property. The shared region property-descriptor; get_property_descriptors
/// uses it.
fn to_descriptor(property: &Property) -> Result<PropertyDescriptor, opendaq::Error> {
    // quack-snippet shared=property-descriptor uses=property-wire-value-type
    let name = property.name()?;
    let value_type = wire_value_type(property)? // shared region property-wire-value-type
        .unwrap_or("string");
    let read_only = property.read_only()?;
    let visible = property.visible()?;
    let default_value = property.default_value()?;

    let unit = match property.unit()? {
        Some(unit) => Some(unit.symbol()?),
        None => None,
    };
    let description = match property.description()? {
        text if text.is_empty() => None,
        text => Some(text),
    };
    let min = property.min_value()?;
    let max = property.max_value()?;
    let validator = match property.validator()? {
        Some(validator) => Some(validator.eval()?),
        None => None,
    };
    let coercer = match property.coercer()? {
        Some(coercer) => Some(coercer.eval()?),
        None => None,
    };

    // Selection values arrive either as a List of labels or as a Dict keyed by
    // the stored index; both flatten to the label list the wire carries.
    let selection_values = match property.selection_values()? {
        DaqValue::List(items) => Some(items.iter().map(describe).collect::<Vec<String>>()),
        DaqValue::Dict(pairs) => Some(
            pairs
                .iter()
                .map(|(_, label)| describe(label))
                .collect::<Vec<String>>(),
        ),
        _ => None,
    };

    // take_list() gives an empty Vec both for "no suggested values" and for an
    // empty list, so an empty one is reported as absent.
    let suggested = property.suggested_values()?;
    // quack-snippet end

    Ok(PropertyDescriptor {
        id: name.clone(), // openDAQ property names are the identifiers
        name,
        value_type: value_type.to_string(),
        unit,
        description,
        read_only,
        visible,
        default_value: value_to_json(&default_value),
        selection_values,
        suggested_values: if suggested.is_empty() {
            None
        } else {
            Some(suggested.iter().map(value_to_json).collect())
        },
        min,
        max,
        validator,
        coercer,
    })
}

/// JSON -> openDAQ value, shaped by the property's declared type. Coercion and
/// validation stay openDAQ's business: this only builds a value of the right
/// kind and lets set_property_value judge it.
fn json_to_opendaq_value(property: &Property, value: &Json) -> ServiceResult<DaqValue> {
    let property_name = property.name().unwrap_or_else(|_| "<unnamed>".to_string());

    // quack-snippet shared=json-to-opendaq-value
    // Building the openDAQ value that set_property_value will write: the
    // property's own value type picks the variant, and a struct has to be
    // rebuilt field by field through a StructBuilder seeded from the current
    // value, because openDAQ rejects a struct whose field types do not match.
    let value_type = property.value_type().map_err(|e| translate_general(&e))?;
    let converted: Option<DaqValue> = match value_type {
        CoreType::Bool => match value {
            Json::Bool(b) => Some(DaqValue::Bool(*b)),
            Json::Number(n) => Some(DaqValue::Bool(n.as_f64().unwrap_or(0.0) != 0.0)),
            _ => None,
        },
        CoreType::Int => match value {
            Json::Number(n) if n.is_i64() => Some(DaqValue::Int(n.as_i64().unwrap())),
            Json::Number(n) => Some(DaqValue::Int(n.as_f64().unwrap_or(0.0) as i64)),
            Json::Bool(b) => Some(DaqValue::Int(i64::from(*b))),
            _ => None,
        },
        CoreType::Float => match value {
            Json::Number(n) => Some(DaqValue::Float(n.as_f64().unwrap_or(0.0))),
            _ => None,
        },
        CoreType::String => match value {
            Json::String(s) => Some(DaqValue::Str(s.clone())),
            _ => None,
        },
        CoreType::Struct => match value.as_object() {
            None => None,
            Some(fields) => {
                // Struct fields are strongly typed: an incoming JSON 5 must
                // become a Float if the field holds a Float, or openDAQ
                // rejects the build.
                let current = property
                    .value()
                    .map_err(|e| translate_general(&e))?
                    .as_object()
                    .and_then(|object| object.try_cast::<Struct>())
                    .ok_or_else(|| {
                        ServiceError::invalid_value(format!(
                            "property \"{property_name}\" reports value type Struct but its current value is \
                             not a Struct, so no StructBuilder can be seeded from it"
                        ))
                    })?;
                let builder =
                    StructBuilder::from_struct(&current).map_err(|e| translate_general(&e))?;
                for (field_name, field_value) in fields {
                    let existing = current.get(field_name).ok();
                    let rebuilt = match (&existing, field_value) {
                        (Some(DaqValue::Bool(_)), Json::Bool(b)) => DaqValue::Bool(*b),
                        (Some(DaqValue::Bool(_)), Json::Number(n)) => {
                            DaqValue::Bool(n.as_f64().unwrap_or(0.0) != 0.0)
                        }
                        (Some(DaqValue::Float(_)), Json::Number(n)) => {
                            DaqValue::Float(n.as_f64().unwrap_or(0.0))
                        }
                        (Some(DaqValue::Int(_)), Json::Number(n)) => {
                            DaqValue::Int(n.as_f64().unwrap_or(0.0) as i64)
                        }
                        (Some(DaqValue::Str(_)), Json::String(s)) => DaqValue::Str(s.clone()),
                        (None, Json::Bool(b)) => DaqValue::Bool(*b),
                        (None, Json::Number(n)) if n.is_i64() => DaqValue::Int(n.as_i64().unwrap()),
                        (None, Json::Number(n)) => DaqValue::Float(n.as_f64().unwrap_or(0.0)),
                        (None, Json::String(s)) => DaqValue::Str(s.clone()),
                        _ => {
                            return Err(ServiceError::invalid_value(format!(
                                "struct field \"{field_name}\" of property \"{property_name}\" cannot take \
                                 {field_value}"
                            )))
                        }
                    };
                    builder
                        .set(field_name, rebuilt)
                        .map_err(|e| translate(&e, MapContext::PropertyWrite))?;
                }
                let built = builder
                    .build()
                    .map_err(|e| translate(&e, MapContext::PropertyWrite))?
                    .ok_or_else(|| {
                        ServiceError::invalid_value(format!(
                            "openDAQ built no Struct for property \"{property_name}\" from {value}"
                        ))
                    })?;
                Some(DaqValue::Object(built.to_base_object()))
            }
        },
        other => {
            return Err(ServiceError::unsupported(format!(
                "property \"{property_name}\" has openDAQ value type {other:?}, which the M1 wire contract \
                 does not carry"
            )))
        }
    };
    // quack-snippet end

    converted.ok_or_else(|| {
        ServiceError::invalid_value(format!(
            "value {value} does not fit property \"{property_name}\", whose openDAQ value type is \
             {value_type:?}"
        ))
    })
}

// --- the backend -----------------------------------------------------------

struct SubscriptionPump {
    signal_id: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

pub struct DaqBackend {
    instance: Instance,
    root_global_id: String,
    /// manifest.module_path, kept because load_module_from_host_path answers
    /// not_found by naming the directory this host actually swept at startup,
    /// which is the one place on the host's filesystem a caller can be sure of.
    module_path: String,
    subscriptions: Mutex<HashMap<u32, SubscriptionPump>>,
}

impl DaqBackend {
    /// `module_path` and `log_level` both arrive from manifest.json; neither is
    /// hardcoded anywhere in this source tree.
    ///
    /// `native_library_directory` is the directory the openDAQ crate loads
    /// copendaq.dll / opendaq-64-3.dll / daqcoreobjects-64-3.dll /
    /// daqcoretypes-64-3.dll from. Pointing it at the manifest's module_path is
    /// what makes this host load the SAME native binaries the C++, Python and
    /// C# hosts load, instead of the prebuilt archive the crate would otherwise
    /// download; OPENDAQ_NO_DOWNLOAD is set so that a missing local library
    /// fails loudly rather than being silently replaced by a downloaded one.
    pub fn new(
        module_path: &str,
        log_level: i64,
        native_library_directory: &str,
    ) -> Result<DaqBackend, String> {
        // The opendaq crate's own name for this switch; the crate documents it
        // but does not re-export the constant, so it is spelled out here.
        std::env::set_var("OPENDAQ_NO_DOWNLOAD", "1");
        std::env::set_var("OPENDAQ_LOG_LEVEL", log_level.to_string());

        println!(
            "[opendaq] loading the openDAQ native libraries from {native_library_directory} \
             (OPENDAQ_NO_DOWNLOAD is set, so the crate's own prebuilt archive is never substituted)"
        );
        opendaq::init_from(native_library_directory).map_err(|e| {
            format!("loading the openDAQ native libraries from {native_library_directory} failed: {e}")
        })?;

        let resolved = opendaq::native_library_directory()
            .map(|dir| dir.display().to_string())
            .unwrap_or_else(|e| format!("<unresolved: {e}>"));
        println!("[opendaq] native libraries resolved to {resolved}");

        let level = LogLevel::from_raw(log_level as u32).ok_or_else(|| {
            format!(
                "manifest log_level {log_level} is not one of the openDAQ LogLevel values 0..=7 \
                 (0 Trace, 1 Debug, 2 Info, 3 Warn, 4 Error, 5 Critical, 6 Off, 7 Default)"
            )
        })?;

        // quack-snippet shared=instance-with-module-path
        // The Instance is built with the module path from the manifest, so the
        // device and function-block modules come from that directory and no
        // other.
        let builder = InstanceBuilder::new()
            .map_err(|e| format!("creating an openDAQ InstanceBuilder failed: {e}"))?;
        builder
            .set_module_path(module_path)
            .map_err(|e| format!("setting the InstanceBuilder module path to {module_path} failed: {e}"))?;
        builder
            .set_global_log_level(level)
            .map_err(|e| format!("setting the InstanceBuilder global log level to {level:?} failed: {e}"))?;
        let instance = Instance::from_builder(&builder)
            .map_err(|e| format!("constructing the openDAQ Instance failed: {e}"))?;
        // quack-snippet end

        let root_global_id = instance
            .global_id()
            .map_err(|e| format!("reading the root component's global id failed: {e}"))?;

        println!("[opendaq] Instance constructed with module_path {module_path}, global log level {level:?}");

        Ok(DaqBackend {
            instance,
            root_global_id,
            module_path: module_path.to_string(),
            subscriptions: Mutex::new(HashMap::new()),
        })
    }

    /// The global id of the root component, which every node id this host hands
    /// out is prefixed with.
    pub fn root_id(&self) -> &str {
        &self.root_global_id
    }

    /// What DeviceInfo::sdk_version() on the root device reports, which is the
    /// version string baked into the native binaries that were actually loaded.
    /// The host prints it beside the manifest's sdk_version so a provenance
    /// mismatch is visible instead of assumed.
    pub fn sdk_version_reported_by_the_loaded_binaries(&self) -> Result<String, String> {
        let info = self
            .instance
            .info()
            .map_err(|e| format!("reading the root device's DeviceInfo failed: {e}"))?
            .ok_or_else(|| "the root device reports no DeviceInfo".to_string())?;
        info.sdk_version()
            .map_err(|e| format!("reading DeviceInfo::sdk_version() failed: {e}"))
    }

    fn root_component(&self) -> ServiceResult<Component> {
        self.instance
            .as_base_object()
            .cast::<Component>()
            .map_err(|e| translate_general(&e))
    }

    fn resolve(&self, id: &str) -> ServiceResult<Component> {
        if id == self.root_global_id {
            return self.root_component();
        }

        let prefix = format!("{}/", self.root_global_id);
        if let Some(relative) = id.strip_prefix(&prefix) {
            if let Ok(Some(found)) = self.instance.find_component(relative) {
                return Ok(found);
            }
        }

        Err(ServiceError::not_found(format!(
            "no component with id \"{id}\"; this host's ids are the root global id \"{}\" and paths under it",
            self.root_global_id
        )))
    }

    fn resolve_property_object(&self, id: &str) -> ServiceResult<PropertyObject> {
        let component = self.resolve(id)?;
        component
            .as_base_object()
            .try_cast::<PropertyObject>()
            .ok_or_else(|| {
                ServiceError::not_found(format!("component \"{id}\" carries no properties"))
            })
    }

    fn resolve_property(
        &self,
        object: &PropertyObject,
        node_id: &str,
        name: &str,
    ) -> ServiceResult<Property> {
        // quack-snippet shared=property-by-name
        let found = object.property(name);
        // quack-snippet end
        match found {
            Ok(Some(property)) => Ok(property),
            Ok(None) => Err(ServiceError::not_found(format!(
                "property \"{name}\" not found on \"{node_id}\""
            ))),
            Err(e) => Err(ServiceError::new(
                map_native_error_code(e.code(), MapContext::General),
                format!("property \"{name}\" not found on \"{node_id}\": {e}"),
            )),
        }
    }

    /// The whole component -> Node mapping. The shared region component-node:
    /// connect_device and get_component_tree both use it.
    fn build_node(&self, component: &Component) -> ServiceResult<Node> {
        // quack-snippet shared=component-node uses=component-kind,property-wire-value-type,component-status-container,effective-device-lock-state,operation-mode-names,property-object-update-state,recorder-of-component
        // Identity, then the two structural facts openDAQ exposes: a component
        // knows its parent, and a component that is a Folder knows its items.
        // Properties come from the PropertyObject facet, which most but not all
        // components have.
        let id = component.global_id().map_err(|e| translate_general(&e))?;
        let name = component.name().map_err(|e| translate_general(&e))?;
        let kind = kind_of(component); // shared region component-kind

        let parent_id = match component.parent().map_err(|e| translate_general(&e))? {
            Some(parent) => Some(parent.global_id().map_err(|e| translate_general(&e))?),
            None => None,
        };

        let mut child_ids = Vec::new();
        if let Some(folder) = component.as_base_object().try_cast::<Folder>() {
            for child in folder.items().map_err(|e| translate_general(&e))? {
                child_ids.push(child.global_id().map_err(|e| translate_general(&e))?);
            }
        }

        let mut property_ids = Vec::new();
        if let Some(object) = component.as_base_object().try_cast::<PropertyObject>() {
            for property in object.all_properties().map_err(|e| translate_general(&e))? {
                if is_representable(&property) {
                    // shared region property-wire-value-type
                    property_ids.push(property.name().map_err(|e| translate_general(&e))?);
                }
            }
        }

        // The six state facts. active and the status container are asked of
        // every component; the connection status and the operation mode are
        // asked only where the component carries the Device interface, which is
        // what "device rows only" in contract types.Node means. The lock state
        // is the shared region effective-device-lock-state, which walks to the
        // nearest ancestor device when this component is not one.
        let device_facet = component.as_base_object().try_cast::<Device>();
        let active = component.active().ok();
        let locked = effective_locked(component); // shared region effective-device-lock-state
        let status_container = component.status_container().ok().flatten();
        let component_status_enumerator = status_container
            .as_ref()
            .and_then(|container| status_enumerator_name(container, "ComponentStatus"));
        let component_status_message = match (&status_container, &component_status_enumerator) {
            (Some(container), Some(_)) => status_message(container, "ComponentStatus"),
            _ => None,
        };
        let connection_status_enumerator = match (&device_facet, &status_container) {
            (Some(_), Some(container)) => status_enumerator_name(container, "ConnectionStatus"),
            _ => None,
        };
        let operation_mode = match &device_facet {
            Some(_) => component
                .operation_mode()
                .ok()
                .and_then(operation_mode_wire_name), // shared region operation-mode-names
            None => None,
        };

        // The two facts added with the batched-update and recorder rows, and
        // both are here for the same reason the six above are: a per-row fact
        // must not cost a per-row call. `updating` is asked of every component,
        // because the reference reads it on every component too
        // (_set_node_update_status_recursive walks the whole tree). `recording`
        // is null unless the component carries IRecorder, and that null means
        // BOTH "not a recorder" and "not reported" -- the client draws no
        // Start/Stop control either way.
        let updating = batched_update_is_open_on(component); // shared region property-object-update-state
        let recording = recorder_facet_of(component) // shared region recorder-of-component
            .and_then(|recorder| recorder.is_recording().ok());
        // quack-snippet end

        let component_status = component_status_enumerator
            .as_deref()
            .and_then(component_status_wire_value)
            .map(str::to_string);
        let connection_status = connection_status_enumerator
            .as_deref()
            .and_then(connection_status_wire_value)
            .map(str::to_string);

        Ok(Node {
            id,
            name,
            kind: kind.to_string(),
            parent_id,
            child_ids,
            property_ids,
            active,
            locked,
            component_status,
            component_status_message,
            connection_status,
            operation_mode: operation_mode.map(str::to_string),
            updating,
            recording,
        })
    }

    /// The Device facet of a node, for the four operations contract section 5
    /// declares over a device: get_device_operation_modes,
    /// set_device_operation_mode, lock_device and unlock_device. A node that
    /// exists but is not a device is answered `unsupported`, never `not_found`
    /// -- the node IS there, it simply has no device to act on, and the
    /// contract says so in as many words for each of the four rows.
    fn resolve_device(&self, node_id: &str) -> ServiceResult<Device> {
        let component = self.resolve(node_id)?;

        // quack-snippet shared=device-facet-of-component
        // openDAQ declares isLocked(), lock(), unlock(),
        // getAvailableOperationModes() and setOperationMode() on IDevice and not
        // on IComponent, so a component has to be queried for its Device
        // interface before any of them can be called. A Device is also a Folder
        // and a Component, but the reverse does not hold, which is why this is a
        // query and not a reinterpretation.
        let device = component.as_base_object().try_cast::<Device>();
        // quack-snippet end

        device.ok_or_else(|| {
            ServiceError::unsupported(format!(
                "component \"{node_id}\" is a {}, not a device; it carries no openDAQ IDevice \
                 interface, so it has no lock and no operation mode",
                kind_of(&component)
            ))
        })
    }

    /// The two halves of one Start/Stop control, which are the same three steps
    /// with one call swapped, so they are written once.
    ///
    /// A node that exists but is not a recorder is answered `unsupported`, never
    /// `not_found`: the node IS there, it simply carries no IRecorder. That is
    /// the same reading resolve_device already gives a node that is not a
    /// device, and contract/contract.yaml names the code for each of these two
    /// rows in as many words.
    fn drive_recorder(&self, node_id: &str, start: bool) -> ServiceResult<()> {
        let driven = (|| -> ServiceResult<()> {
            let component = self.resolve(node_id)?;
            let recorder = recorder_facet_of(&component).ok_or_else(|| {
                // shared region recorder-of-component
                ServiceError::unsupported(format!(
                    "component \"{node_id}\" is a {} and carries no openDAQ IRecorder interface, so it \
                     has no recording to start or stop. contract types.Node.recording is null for it on \
                     every tree read, which is how a client knows not to draw the control at all",
                    kind_of(&component)
                ))
            })?;

            // quack-snippet capability=recorder.control uses=recorder-of-component step=1
            // IRecorder::startRecording() and IRecorder::stopRecording(), both
            // taking nothing. The state they move is IRecorder::getIsRecording(),
            // which contract types.Node.recording already carries on every tree
            // row -- so a client never calls these to find out where it is, only
            // to change it.
            let result = if start {
                recorder.start_recording()
            } else {
                recorder.stop_recording()
            };
            // quack-snippet end

            result.map_err(|e| translate_general(&e))?;

            // Read back rather than assume, exactly as lock_device does: what
            // the next get_component_tree will put in Node.recording is what
            // openDAQ reports now, not what this call intended.
            println!(
                "[opendaq] {} {node_id}: daqRecorder_{} returned success; daqRecorder_getIsRecording \
                 now reports {}",
                if start {
                    "start_recording"
                } else {
                    "stop_recording"
                },
                if start {
                    "startRecording"
                } else {
                    "stopRecording"
                },
                match recorder.is_recording() {
                    Ok(state) => state.to_string(),
                    Err(ref e) => format!("<unreadable: {e}>"),
                }
            );
            Ok(())
        })();

        // contract errors for both rows: [not_found, unsupported, internal].
        driven.map_err(|e| match e.code {
            ErrorCode::NotFound | ErrorCode::Unsupported | ErrorCode::Internal => e,
            other => ServiceError::internal(format!(
                "{} -- restated as internal because contract/contract.yaml declares the error subset \
                 [not_found, unsupported, internal] for start_recording and stop_recording, which does \
                 not carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }

    /// The one openDAQ IModuleManager this process has. Both module.read and
    /// module.load start here: list_loaded_modules asks it what it holds,
    /// load_module_from_host_path asks it to load one more.
    fn module_manager_of_this_instance(&self) -> ServiceResult<ModuleManager> {
        // quack-snippet shared=module-manager-of-instance uses=instance-with-module-path step=1
        // The loaded modules do not hang off the Instance: they hang off the
        // Context the Instance was built with. Context.getModuleManager()
        // answers a plain object rather than a typed manager, so it has to be
        // queried for the IModuleManager interface before it can be asked for
        // anything.
        let context = self.instance.context();
        // quack-snippet end

        let context = context
            .map_err(|e| translate_general(&e))?
            .ok_or_else(|| {
                ServiceError::internal(
                    "the openDAQ Instance reports no Context, so daqContext_getModuleManager cannot \
                     be reached and this process's loaded modules can be neither listed nor added to",
                )
            })?;

        // quack-snippet shared=module-manager-of-instance step=2
        let manager_object = context.module_manager();
        // quack-snippet end

        let manager_object = manager_object.map_err(|e| translate_general(&e))?;
        manager_object
            .as_object()
            .and_then(|object| object.try_cast::<ModuleManager>())
            .ok_or_else(|| {
                ServiceError::internal(format!(
                    "daqContext_getModuleManager answered {manager_object}, which does not carry the \
                     openDAQ IModuleManager interface, so neither daqModuleManager_getModules nor \
                     daqModuleManager_loadModule can be called"
                ))
            })
    }
}

/// A module that offers no component types of one sort answers
/// OPENDAQ_ERR_NOTIMPLEMENTED rather than an empty dictionary -- the mock
/// modules in the openDAQ build tree do exactly that, and openDAQ's own
/// ModuleManager logs "Failed to enumerate module's supported SRV types: Not
/// Implemented" and carries on loading the module. So "not implemented" here
/// means "this module offers none of that sort", and only some OTHER failure is
/// a failure. Reporting it as one would make one mock module empty the whole
/// Modules view.
fn none_of_that_sort_when_opendaq_says_not_implemented<T>(
    read: Result<std::collections::HashMap<String, T>, opendaq::Error>,
    module_id: &str,
    sort: &str,
) -> ServiceResult<std::collections::HashMap<String, T>> {
    match read {
        Ok(types) => Ok(types),
        Err(e) if map_native_error_code(e.code(), MapContext::General) == ErrorCode::Unsupported => {
            eprintln!(
                "[opendaq] list_loaded_modules: module {module_id} answered \"{e}\" when asked for its \
                 {sort} types, which openDAQ's own ModuleManager treats as \"this module offers none\"; \
                 it contributes no {sort} type to the answer"
            );
            Ok(std::collections::HashMap::new())
        }
        Err(e) => Err(translate_general(&e)),
    }
}

/// The four type dictionaries one loaded module advertises. The shared region
/// module-component-types; list_loaded_modules uses it.
fn component_types_offered_by(
    module: &opendaq::Module,
    module_id: &str,
) -> ServiceResult<Vec<ComponentTypeInfo>> {
    // quack-snippet shared=module-component-types step=1
    // A module advertises what it can create through four separate
    // dictionaries, one per sort, each keyed by the type id. openDAQ has no
    // single "all component types" call, so the Modules view IS these four
    // reads. The values are IDeviceType, IFunctionBlockType, IServerType and
    // IStreamingType; every one of them IS an IComponentType and answers id,
    // name and description through it, and only IDeviceType and IStreamingType
    // add a connection string prefix.
    let device_types = module.available_device_types();
    let function_block_types = module.available_function_block_types();
    let server_types = module.available_server_types();
    let streaming_types = module.available_streaming_types();
    // quack-snippet end

    let device_types =
        none_of_that_sort_when_opendaq_says_not_implemented(device_types, module_id, "device")?;
    let function_block_types = none_of_that_sort_when_opendaq_says_not_implemented(
        function_block_types,
        module_id,
        "function block",
    )?;
    let server_types =
        none_of_that_sort_when_opendaq_says_not_implemented(server_types, module_id, "server")?;
    let streaming_types = none_of_that_sort_when_opendaq_says_not_implemented(
        streaming_types,
        module_id,
        "streaming",
    )?;

    let mut out = Vec::new();
    for (_, device_type) in device_types {
        let prefix = device_type.connection_string_prefix().ok();
        out.push(describe_component_type(&device_type, "device", prefix)?);
    }
    for (_, function_block_type) in function_block_types {
        // IFunctionBlockType has no connection string prefix: a function block
        // is created by type id, never by a connection string.
        out.push(describe_component_type(
            &function_block_type,
            "function_block",
            None,
        )?);
    }
    for (_, server_type) in server_types {
        out.push(describe_component_type(&server_type, "server", None)?);
    }
    for (_, streaming_type) in streaming_types {
        let prefix = streaming_type.connection_string_prefix().ok();
        out.push(describe_component_type(&streaming_type, "streaming", prefix)?);
    }

    // The four dictionaries are hash maps, so their iteration order is not
    // stable between runs; the wire order is not openDAQ's to decide, and a
    // stable one makes two Modules views comparable.
    out.sort_by(|left, right| (&left.kind, &left.id).cmp(&(&right.kind, &right.id)));
    Ok(out)
}

/// One loaded module as the contract's types.ModuleInfo record. `None` means
/// the module carries no IModuleInfo at all, so it has neither the id nor the
/// name the record requires -- the caller decides whether to leave it out of a
/// list or to fail the call that produced it.
///
/// Both module operations render their module through this, so a module card
/// looks the same whether it arrived in a list_loaded_modules array or as the
/// single record load_module_from_host_path answers with.
fn module_info_record(
    module: &opendaq::Module,
    called_from: &str,
) -> ServiceResult<Option<WireModuleInfo>> {
    // quack-snippet capability=module.read,module.load uses=module-component-types step=2
    // IModuleInfo carries the module's id, its name and a VersionInfo whose
    // major, minor and patch are three separate reads. A module that carries no
    // version info at all is normal -- the reference prints "N/A" for it -- so
    // version is nullable on the wire.
    let info = module.module_info();
    // quack-snippet end

    let info = match info.map_err(|e| translate_general(&e))? {
        Some(info) => info,
        None => return Ok(None),
    };

    let id = info.id().map_err(|e| translate_general(&e))?;
    let name = info.name().map_err(|e| translate_general(&e))?;

    // quack-snippet capability=module.read,module.load step=3
    let version_info = info.version_info();
    // quack-snippet end

    let version = match version_info.map_err(|e| translate_general(&e))? {
        Some(version_info) => {
            // quack-snippet capability=module.read,module.load step=4
            let major = version_info.major();
            let minor = version_info.minor();
            let patch = version_info.patch();
            // quack-snippet end
            Some(format!(
                "{}.{}.{}",
                major.map_err(|e| translate_general(&e))?,
                minor.map_err(|e| translate_general(&e))?,
                patch.map_err(|e| translate_general(&e))?
            ))
        }
        None => None,
    };

    // The four type dictionaries are the shared region module-component-types.
    let component_types = component_types_offered_by(module, &id)?;

    println!(
        "[opendaq] {called_from}: module {id} (name {name}, version {}) offers {} component type(s)",
        version.as_deref().unwrap_or("none reported"),
        component_types.len()
    );

    Ok(Some(WireModuleInfo {
        id,
        name,
        version,
        component_types,
    }))
}

fn describe_component_type(
    component_type: &ComponentType,
    wire_kind: &str,
    connection_string_prefix: Option<String>,
) -> ServiceResult<ComponentTypeInfo> {
    // quack-snippet shared=module-component-types step=2
    let id = component_type.id();
    let name = component_type.name();
    let description = component_type.description();
    // quack-snippet end

    Ok(ComponentTypeInfo {
        id: id.map_err(|e| translate_general(&e))?,
        name: name.map_err(|e| translate_general(&e))?,
        kind: wire_kind.to_string(),
        description: match description.map_err(|e| translate_general(&e))? {
            text if text.is_empty() => None,
            text => Some(text),
        },
        connection_string_prefix: connection_string_prefix.filter(|prefix| !prefix.is_empty()),
    })
}

// --- component attributes ---------------------------------------------------
//
// An attribute is NOT a property. A property lives in the component's property
// bag and is read with getPropertyValue; an attribute is a fixed member of an
// openDAQ INTERFACE, with its own getter and, where openDAQ declares one, its
// own setter. Which rows exist therefore depends on which interfaces the
// component carries, and a cast that does not succeed yields fewer rows rather
// than a row with a null value.

/// The name openDAQ's IComponent::getLockedAttributes() uses for an attribute
/// this contract calls by a wire id, or None where openDAQ has no lockable
/// attribute of that name.
///
/// The seven names are openDAQ's own, read out of the headers rather than
/// guessed: COMPONENT_AVAILABLE_ATTRIBUTES is {"Name", "Description", "Visible",
/// "Active"} at component_impl.h:59, SIGNAL_AVAILABLE_ATTRIBUTES is {"Public",
/// "DomainSignal", "RelatedSignals"} at signal_impl.h:53 and
/// INPUT_PORT_AVAILABLE_ATTRIBUTES is {"Public"} at input_port_impl.h:47. Those
/// are exactly the strings a locked-attributes list can contain, so an attribute
/// with no name here can never appear in one.
///
/// No SDK call: this is a wire mapping, so it sits outside every region.
fn locked_attribute_name_of(wire_id: &str) -> Option<&'static str> {
    match wire_id {
        "name" => Some("Name"),
        "description" => Some("Description"),
        "active" => Some("Active"),
        "visible" => Some("Visible"),
        "public" => Some("Public"),
        "domain_signal_id" => Some("DomainSignal"),
        "related_signal_ids" => Some("RelatedSignals"),
        _ => None,
    }
}

/// The attributes this host reports read_only whatever the component says,
/// each with the reason established from the openDAQ surface rather than
/// assumed. contract/contract.yaml names the same eight as the set the
/// reference hardcodes Locked.
///
/// Six of them have no setter at all on the interface that declares them. The
/// opendaq crate 0.1.1 was enumerated to say so: in its vendored source at
/// ~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/opendaq-0.1.1/, the
/// inherent `impl Component` block of src/generated/component.rs declares
/// exactly four setters -- set_active, set_description, set_name, set_visible --
/// and neither global_id nor local_id is among them; `impl Signal` in the same
/// file declares set_public and set_streamed and no setter for domain_signal,
/// related_signals or last_value; `impl InputPort` in src/generated/reader.rs
/// declares set_public and no setter for signal or requires_signal.
///
/// `streamed` is the eighth and it is the one with a setter, so its reason is a
/// different one and it is stated rather than lumped in: openDAQ's
/// SignalBase::setStreamed returns OPENDAQ_IGNORED
/// (core/opendaq/signal/include/opendaq/signal_impl.h:1332), and signal.h:127-130
/// documents it in as many words -- "Setting the 'Streamed' flag has no effect
/// if the signal is local to the current Instance. Method returns
/// OPENDAQ_IGNORED if that is the case." A write that is silently ignored is
/// worse than a refused one, so this host reports the attribute read_only
/// instead of offering an editor that appears to work.
fn attribute_is_read_only_whatever_the_component_says(wire_id: &str) -> Option<&'static str> {
    match wire_id {
        "global_id" => Some(
            "IComponent declares getGlobalId() and no setter; the opendaq crate's `impl Component` \
             carries set_active, set_description, set_name and set_visible only",
        ),
        "local_id" => Some(
            "IComponent declares getLocalId() and no setter; the opendaq crate's `impl Component` \
             carries set_active, set_description, set_name and set_visible only",
        ),
        "domain_signal_id" => Some(
            "ISignal declares getDomainSignal() and no setter; setting a domain signal is \
             ISignalConfig's, which is the signal's owner's interface and not this component's",
        ),
        "related_signal_ids" => Some(
            "ISignal declares getRelatedSignals() and no setter; adding and removing related \
             signals is ISignalConfig's",
        ),
        "streamed" => Some(
            "ISignal does declare setStreamed(Bool), but SignalBase::setStreamed returns \
             OPENDAQ_IGNORED (signal_impl.h:1332) and signal.h:127-130 says a write has no effect \
             for a signal local to this instance; a write that is silently ignored is reported \
             read-only rather than offered as an editor that appears to work",
        ),
        "last_value" => Some(
            "ISignal declares getLastValue() and no setter; the last value is what the signal \
             produced, not a field of it",
        ),
        "signal_id" => Some(
            "IInputPort declares getSignal() and no setSignal; a signal is put on an input port \
             with connect(ISignal*), which is an act on the connection and not a write of this \
             attribute, and no row of this contract asks for it",
        ),
        "requires_signal" => Some(
            "IInputPort declares getRequiresSignal() and no setter; the opendaq crate's \
             `impl InputPort` carries set_public only",
        ),
        _ => None,
    }
}

/// One attribute row, built from a value this host has already read.
fn attribute_row(
    wire_id: &str,
    label: &str,
    value: Json,
    value_type: &str,
    locked_attributes: &[String],
) -> ComponentAttribute {
    // read_only has exactly the two sources contract/contract.yaml names, and
    // NEITHER of them is "this host has no writer": a host with no writer
    // declares no attribute.write capability and the client disables the editor
    // from the gap. Saying read_only there would claim openDAQ locked the
    // attribute, which is a cause nobody established.
    //
    // The comparison is CASE-INSENSITIVE, and that is not defensive spelling:
    // openDAQ's own inserts use the canonical case (component_impl.h:269 inserts
    // "Visible", COMPONENT_AVAILABLE_ATTRIBUTES is {"Name", "Description",
    // "Visible", "Active"}), while IComponentPrivate::lockAttributes lower-cases
    // whatever a caller passes it (component_impl.h:702) and documents its list
    // as "not case sensitive" (component_private.h:40). So one list can hold
    // both spellings, and an exact match would miss an attribute a caller had
    // locked.
    let read_only = attribute_is_read_only_whatever_the_component_says(wire_id).is_some()
        || locked_attribute_name_of(wire_id).is_some_and(|opendaq_name| {
            locked_attributes
                .iter()
                .any(|held| held.eq_ignore_ascii_case(opendaq_name))
        });

    ComponentAttribute {
        id: wire_id.to_string(),
        name: label.to_string(),
        value,
        value_type: value_type.to_string(),
        read_only,
    }
}

/// Pushes one string-valued attribute row, or records why it was left out.
///
/// An attribute whose getter FAILED is omitted rather than reported with a null
/// value, because a null row would say "this attribute exists on this component
/// and has no value", which is a different claim from "this host could not read
/// it". No SDK call of its own: the read has already happened at the call site,
/// inside the region that shows it.
fn push_string_attribute(
    rows: &mut Vec<ComponentAttribute>,
    skipped: &mut Vec<String>,
    wire_id: &str,
    label: &str,
    read: Result<String, opendaq::Error>,
    locked_attributes: &[String],
) {
    match read {
        Ok(text) => rows.push(attribute_row(
            wire_id,
            label,
            Json::String(text),
            "string",
            locked_attributes,
        )),
        Err(e) => skipped.push(format!("{wire_id} ({e})")),
    }
}

/// An openDAQ value rendered for a `last_value` row, plus the wire value_type
/// that matches it. ComponentAttributeValueType is a closed set of five, so a
/// value with no member of it crosses as its openDAQ string rendering and is
/// typed `string` -- which is what the reference's own fall-through does when
/// its editor branch finds no Python type it can edit.
fn attribute_value_and_type(value: &DaqValue) -> (Json, &'static str) {
    match value {
        DaqValue::Bool(b) => (Json::Bool(*b), "bool"),
        DaqValue::Int(i) => (Json::from(*i), "int"),
        DaqValue::Float(f) => (
            serde_json::Number::from_f64(*f)
                .map(Json::Number)
                .unwrap_or(Json::Null),
            "float",
        ),
        DaqValue::Str(s) => (Json::String(s.clone()), "string"),
        DaqValue::Null => (Json::Null, "string"),
        other => (Json::String(other.to_string()), "string"),
    }
}

/// Every attribute row of one component, in the order the reference's
/// attributes treeview builds them. The shared region
/// component-attribute-rows: get_component_attributes answers with these rows,
/// and set_component_attribute reads the same rows to learn whether a write is
/// refused BEFORE it makes it, so the two operations can never disagree about
/// which attribute is writable.
fn component_attribute_rows(
    component: &Component,
    node_id: &str,
) -> ServiceResult<Vec<ComponentAttribute>> {
    // quack-snippet shared=component-attribute-rows step=1
    // ONE call decides read_only for every row below.
    // IComponent::getLockedAttributes() answers the attribute names
    // openDAQ has locked on THIS component -- the strings are openDAQ's
    // own, from COMPONENT_AVAILABLE_ATTRIBUTES {"Name", "Description",
    // "Visible", "Active"}, SIGNAL_AVAILABLE_ATTRIBUTES {"Public",
    // "DomainSignal", "RelatedSignals"} and
    // INPUT_PORT_AVAILABLE_ATTRIBUTES {"Public"}. It is read once here
    // rather than per row, because the answer is per component.
    let locked_attributes = component.locked_attributes();
    // quack-snippet end

    let locked_attributes = locked_attributes.map_err(|e| translate_general(&e))?;
    let mut rows: Vec<ComponentAttribute> = Vec::new();

    // quack-snippet shared=component-attribute-rows step=2
    // The seven every IComponent carries. Each is a getter on the
    // interface itself, NOT an entry in the property bag: none of them
    // is reachable through getPropertyValue, and the reference writes
    // them with setattr rather than through the property API.
    let name = component.name();
    let description = component.description();
    let active = component.active();
    let global_id = component.global_id();
    let local_id = component.local_id();
    let visible = component.visible();
    let tags = component.tags();
    // quack-snippet end

    let mut skipped: Vec<String> = Vec::new();
    push_string_attribute(
        &mut rows,
        &mut skipped,
        "name",
        "Name",
        name,
        &locked_attributes,
    );
    push_string_attribute(
        &mut rows,
        &mut skipped,
        "description",
        "Description",
        description,
        &locked_attributes,
    );
    match active {
        Ok(state) => rows.push(attribute_row(
            "active",
            "Active",
            Json::Bool(state),
            "bool",
            &locked_attributes,
        )),
        Err(e) => skipped.push(format!("active ({e})")),
    }
    push_string_attribute(
        &mut rows,
        &mut skipped,
        "global_id",
        "Global ID",
        global_id,
        &locked_attributes,
    );
    push_string_attribute(
        &mut rows,
        &mut skipped,
        "local_id",
        "Local ID",
        local_id,
        &locked_attributes,
    );

    match tags.map_err(|e| translate_general(&e))? {
        Some(tag_object) => {
            // quack-snippet shared=component-attribute-rows step=3
            // ITags is READ-ONLY as an interface: it declares getList(),
            // contains() and query() and nothing that changes the set.
            // Adding, removing and replacing tags live on ITagsPrivate,
            // a separate interface the tags object has to be queried
            // for, so whether this component's tags can be written at
            // all is established by that query rather than assumed.
            let listed = tag_object.list();
            let writable = tag_object.as_base_object().try_cast::<TagsPrivate>();
            // quack-snippet end

            match listed {
                Ok(list) => {
                    let mut row = attribute_row(
                        "tags",
                        "Tags",
                        Json::Array(
                            list.iter().map(|tag| Json::String(tag.clone())).collect(),
                        ),
                        "string_list",
                        &locked_attributes,
                    );
                    if writable.is_none() {
                        row.read_only = true;
                    }
                    rows.push(row);
                }
                Err(e) => skipped.push(format!("tags ({e})")),
            }
        }
        None => skipped.push(
            "tags (this component reports no ITags object at all, so there is no tag list to \
             report and a row with a null value would claim otherwise)"
                .to_string(),
        ),
    }

    match visible {
        Ok(state) => rows.push(attribute_row(
            "visible",
            "Visible",
            Json::Bool(state),
            "bool",
            &locked_attributes,
        )),
        Err(e) => skipped.push(format!("visible ({e})")),
    }

    // quack-snippet shared=component-attribute-rows step=4
    // Five more attributes exist only if the component carries ISignal,
    // and three more only if it carries IInputPort. The two sets do not
    // overlap except in `public`, which both declare. A cast that does
    // not succeed yields FEWER ROWS -- never a row with a null value,
    // which would claim the attribute exists and has none.
    let signal_facet = component.as_base_object().try_cast::<Signal>();
    let input_port_facet = component.as_base_object().try_cast::<InputPort>();
    // quack-snippet end

    if let Some(signal) = &signal_facet {
        // quack-snippet shared=component-attribute-rows step=5
        // The domain signal and the related signals are OBJECTS in
        // openDAQ; what crosses this wire is their global ids, which is
        // why the wire ids carry _id and _ids and the binding's own
        // names (domain_signal, related_signals) do not.
        let public = signal.public();
        let streamed = signal.streamed();
        let last_value = signal.last_value();
        let domain_signal = signal.domain_signal();
        let related_signals = signal.related_signals();
        // quack-snippet end

        match public {
            Ok(state) => rows.push(attribute_row(
                "public",
                "Public",
                Json::Bool(state),
                "bool",
                &locked_attributes,
            )),
            Err(e) => skipped.push(format!("public ({e})")),
        }
        match domain_signal.map_err(|e| translate_general(&e))? {
            Some(domain) => push_string_attribute(
                &mut rows,
                &mut skipped,
                "domain_signal_id",
                "Domain Signal ID",
                domain.global_id(),
                &locked_attributes,
            ),
            None => rows.push(attribute_row(
                "domain_signal_id",
                "Domain Signal ID",
                Json::Null,
                "string",
                &locked_attributes,
            )),
        }
        match related_signals {
            Ok(related) => {
                let mut ids = Vec::new();
                for signal in &related {
                    ids.push(Json::String(
                        signal.global_id().map_err(|e| translate_general(&e))?,
                    ));
                }
                rows.push(attribute_row(
                    "related_signal_ids",
                    "Related Signal IDs",
                    Json::Array(ids),
                    "string_list",
                    &locked_attributes,
                ));
            }
            Err(e) => skipped.push(format!("related_signal_ids ({e})")),
        }
        match streamed {
            Ok(state) => rows.push(attribute_row(
                "streamed",
                "Streamed",
                Json::Bool(state),
                "bool",
                &locked_attributes,
            )),
            Err(e) => skipped.push(format!("streamed ({e})")),
        }
        match last_value {
            Ok(value) => {
                let (rendered, value_type) = attribute_value_and_type(&value);
                rows.push(attribute_row(
                    "last_value",
                    "Last Value",
                    rendered,
                    value_type,
                    &locked_attributes,
                ));
            }
            Err(e) => skipped.push(format!("last_value ({e})")),
        }
    }

    if let Some(input_port) = &input_port_facet {
        // quack-snippet shared=component-attribute-rows step=6
        let public = input_port.public();
        let requires_signal = input_port.requires_signal();
        let connected_signal = input_port.signal();
        // quack-snippet end

        if signal_facet.is_none() {
            match public {
                Ok(state) => rows.push(attribute_row(
                    "public",
                    "Public",
                    Json::Bool(state),
                    "bool",
                    &locked_attributes,
                )),
                Err(e) => skipped.push(format!("public ({e})")),
            }
        }
        match connected_signal.map_err(|e| translate_general(&e))? {
            Some(signal) => push_string_attribute(
                &mut rows,
                &mut skipped,
                "signal_id",
                "Signal ID",
                signal.global_id(),
                &locked_attributes,
            ),
            None => rows.push(attribute_row(
                "signal_id",
                "Signal ID",
                Json::Null,
                "string",
                &locked_attributes,
            )),
        }
        match requires_signal {
            Ok(state) => rows.push(attribute_row(
                "requires_signal",
                "Requires Signal",
                Json::Bool(state),
                "bool",
                &locked_attributes,
            )),
            Err(e) => skipped.push(format!("requires_signal ({e})")),
        }
    }

    println!(
        "[opendaq] component attribute rows for {node_id}: the component is a {}; ISignal cast {}, \
         IInputPort cast {}. IComponent_getLockedAttributes reported [{}]. {} row(s) reported{}",
        kind_of(component),
        if signal_facet.is_some() {
            "succeeded"
        } else {
            "did not succeed"
        },
        if input_port_facet.is_some() {
            "succeeded"
        } else {
            "did not succeed"
        },
        locked_attributes.join(", "),
        rows.len(),
        if skipped.is_empty() {
            String::new()
        } else {
            format!(
                "; {} attribute(s) left out rather than reported with a null value: {}",
                skipped.len(),
                skipped.join(", ")
            )
        }
    );

    Ok(rows)
}

impl Drop for DaqBackend {
    fn drop(&mut self) {
        let pending: Vec<(u32, SubscriptionPump)> = {
            let mut subscriptions = match self.subscriptions.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            subscriptions.drain().collect()
        };
        for (id, mut pump) in pending {
            pump.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = pump.thread.take() {
                let _ = thread.join();
            }
            println!(
                "[opendaq] shutdown: stopped the pump thread of subscription {id} on signal {}",
                pump.signal_id
            );
        }
    }
}

impl DaqBackendTrait for DaqBackend {
    // --- scan_available_devices --------------------------------------------

    fn scan_available_devices(&self) -> ServiceResult<Vec<DeviceInfo>> {
        // quack-snippet capability=device.scan uses=instance-with-module-path step=1
        // Discovery. Every loaded module is asked what it can see right now;
        // the answer is DeviceInfo objects, not devices. Nothing is added to
        // the Instance and no connection is opened by this call, which is why
        // it is a separate capability from device.connect.
        let available = self.instance.available_devices();
        // quack-snippet end
        let available = available.map_err(|e| translate_general(&e))?;

        let mut out = Vec::new();
        for info in &available {
            // quack-snippet capability=device.scan step=2
            // The three fields the wire carries. connection_string is precisely
            // the string connect_device takes back; the serial number is a
            // plain DeviceInfo property that many devices leave empty.
            let connection_string = info.connection_string();
            let name = info.name();
            let serial = info.serial_number();
            // quack-snippet end

            let connection_string = connection_string.map_err(|e| translate_general(&e))?;
            let name = name.map_err(|e| translate_general(&e))?;
            let serial = serial.map_err(|e| translate_general(&e))?;

            out.push(DeviceInfo {
                connection_string,
                name,
                serial: if serial.is_empty() { None } else { Some(serial) },
            });
        }

        println!(
            "[opendaq] scan_available_devices: discovery reported {} device(s)",
            out.len()
        );
        for entry in &out {
            println!(
                "[opendaq]   {}  (name {}, serial {})",
                entry.connection_string,
                entry.name,
                entry.serial.as_deref().unwrap_or("none")
            );
        }
        Ok(out)
    }

    // --- connect_device ----------------------------------------------------

    fn connect_device(&self, connection_string: &str) -> ServiceResult<Node> {
        // The openDAQ Instance outlives any single WebSocket session, so a
        // browser reload or a second client asks to connect a device that is
        // already added. add_device() refuses a duplicate, so an already-added
        // device with the same connection string is reused and connect_device
        // stays idempotent.
        let mut reused = false;

        // quack-snippet capability=device.connect uses=instance-with-module-path,component-node step=1
        let mut device: Option<Device> = None;
        for added in self.instance.devices().map_err(|e| translate_general(&e))? {
            if let Ok(Some(info)) = added.info() {
                if info.connection_string().is_ok_and(|added| added == connection_string) {
                    device = Some(added);
                    break;
                }
            }
        }
        if device.is_none() {
            device = self
                .instance
                .add_device(connection_string)
                .map_err(|e| translate_general(&e))?;
        } else {
            reused = true;
        }
        // quack-snippet end

        let device = device.ok_or_else(|| {
            ServiceError::not_found(format!("no device at \"{connection_string}\""))
        })?;

        let component = device
            .as_base_object()
            .cast::<Component>()
            .map_err(|e| translate_general(&e))?;
        // The component -> Node mapping is the shared region component-node.
        let node = self.build_node(&component)?;

        println!(
            "[opendaq] connect_device {connection_string} -> {} {} (name {})",
            if reused {
                "reusing already-added device"
            } else {
                "added device"
            },
            node.id,
            node.name
        );
        Ok(node)
    }

    // --- disconnect_device -------------------------------------------------

    fn disconnect_device(&self, node_id: &str) -> ServiceResult<()> {
        let component = self.resolve(node_id)?;

        // quack-snippet capability=device.connect step=2
        // Undoing an add_device. The component has to be taken through its
        // Device facet, because remove_device is declared over a device, not a
        // component, and the device is removed from the same Instance that
        // added it.
        let device = component.as_base_object().try_cast::<Device>();
        // quack-snippet end

        let device = device.ok_or_else(|| {
            ServiceError::not_found(format!(
                "component \"{node_id}\" is a {}, not a device; disconnect_device takes the node id \
                 connect_device answered with",
                kind_of(&component)
            ))
        })?;

        // quack-snippet capability=device.connect step=3
        self.instance
            .remove_device(&device)
            .map_err(|e| translate_general(&e))?;
        // quack-snippet end

        println!("[opendaq] disconnect_device {node_id}: removed from the openDAQ Instance");
        Ok(())
    }

    // --- get_component_tree ------------------------------------------------

    fn component_tree(&self, root_id: Option<&str>) -> ServiceResult<Vec<Node>> {
        let root = match root_id {
            Some(id) => self.resolve(id)?,
            None => self.root_component()?,
        };

        let mut flat: Vec<Component> = Vec::new();
        // quack-snippet capability=tree.read uses=component-node
        // Depth-first over the component tree: a component that is a Folder
        // knows its items, and everything else is a leaf.
        let mut stack = vec![root];
        while let Some(component) = stack.pop() {
            if let Some(folder) = component.as_base_object().try_cast::<Folder>() {
                let children = folder.items().map_err(|e| translate_general(&e))?;
                for child in children.into_iter().rev() {
                    stack.push(child);
                }
            }
            flat.push(component);
        }
        // quack-snippet end

        // The component -> Node mapping for each of them is the shared region
        // component-node.
        let mut nodes = Vec::with_capacity(flat.len());
        for component in &flat {
            nodes.push(self.build_node(component)?);
        }
        Ok(nodes)
    }

    // --- get_property_descriptors ------------------------------------------

    fn property_descriptors(&self, node_id: &str) -> ServiceResult<Vec<PropertyDescriptor>> {
        let object = self.resolve_property_object(node_id)?;

        // quack-snippet capability=property.read
        let properties = object.all_properties();
        // quack-snippet end
        let properties = properties.map_err(|e| translate_general(&e))?;

        let mut out = Vec::new();
        // quack-snippet capability=property.read uses=property-wire-value-type,property-descriptor
        // Each property is described by the shared region property-descriptor;
        // a property whose openDAQ core type has no member of the wire's
        // value_type set is omitted rather than misreported, which is the
        // shared region property-wire-value-type.
        for property in &properties {
            if !is_representable(property) {
                continue;
            }
            match to_descriptor(property) {
                Ok(descriptor) => out.push(descriptor),
                Err(e) => eprintln!("[opendaq] skipping a property on \"{node_id}\": {e}"),
            }
        }
        // quack-snippet end

        Ok(out)
    }

    // --- get_property_value ------------------------------------------------

    fn property_value(&self, node_id: &str, property_id: &str) -> ServiceResult<Json> {
        let object = self.resolve_property_object(node_id)?;
        self.resolve_property(&object, node_id, property_id)?; // shared region property-by-name

        // quack-snippet capability=property.read uses=property-by-name
        let value = object.property_value(property_id);
        // quack-snippet end

        let value = value.map_err(|e| translate_general(&e))?;
        Ok(value_to_json(&value))
    }

    // --- set_property_value ------------------------------------------------

    fn set_property_value(
        &self,
        node_id: &str,
        property_id: &str,
        value: &Json,
    ) -> ServiceResult<()> {
        let object = self.resolve_property_object(node_id)?;
        let property = self.resolve_property(&object, node_id, property_id)?; // shared region property-by-name

        // quack-snippet capability=property.write uses=property-by-name
        // openDAQ answers a write to a read-only property with a status code
        // that does not distinguish it from a rejected value, so the flag is
        // read first.
        let read_only = property.read_only();
        // quack-snippet end

        if read_only.map_err(|e| translate_general(&e))? {
            return Err(ServiceError::read_only(format!(
                "property \"{property_id}\" on \"{node_id}\" is read-only"
            )));
        }

        let converted = json_to_opendaq_value(&property, value)?; // shared region json-to-opendaq-value

        // quack-snippet capability=property.write uses=json-to-opendaq-value
        let written = object.set_property_value(property_id, converted);
        // quack-snippet end

        // The property exists (it was resolved above), so a NOTFOUND raised by
        // the write itself means the value was rejected, not the property.
        written.map_err(|e| translate(&e, MapContext::PropertyWrite))?;

        println!("[opendaq] set_property_value {node_id}.{property_id} = {value}");
        Ok(())
    }

    // --- subscribe_signal --------------------------------------------------

    fn subscribe_signal(
        &self,
        signal_id: &str,
        subscription_id: u32,
        sink: SampleSink,
    ) -> ServiceResult<()> {
        let component = self.resolve(signal_id)?;

        // quack-snippet capability=streaming.decimated step=1
        // Only a component that carries the Signal interface can be read from.
        let signal = component.as_base_object().try_cast::<Signal>();
        // quack-snippet end

        let signal = signal.ok_or_else(|| {
            ServiceError::invalid_value(format!(
                "component \"{signal_id}\" is a {}, not a signal",
                kind_of(&component)
            ))
        })?;

        // quack-snippet capability=streaming.decimated step=2
        // A StreamReader is what turns that signal into samples: it is asked
        // for f64 values against an i64 domain, and openDAQ converts whatever
        // the signal's own descriptor says into those two types.
        let reader = StreamReader::<f64, i64>::new(&signal);
        // quack-snippet end

        let reader = reader.map_err(|e| translate_general(&e))?;

        let stop = Arc::new(AtomicBool::new(false));
        let pump_stop = Arc::clone(&stop);
        let pump_signal_id = signal_id.to_string();

        let thread = std::thread::Builder::new()
            .name(format!("quackoscope-signal-pump-{subscription_id}"))
            .spawn(move || {
                pump_samples_until_stopped(
                    subscription_id,
                    &pump_signal_id,
                    reader,
                    sink,
                    &pump_stop,
                );
            })
            .map_err(|e| {
                ServiceError::internal(format!(
                    "spawning the sample pump thread for subscription {subscription_id} on \"{signal_id}\" \
                     failed: {e}"
                ))
            })?;

        let mut subscriptions = match self.subscriptions.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        subscriptions.insert(
            subscription_id,
            SubscriptionPump {
                signal_id: signal_id.to_string(),
                stop,
                thread: Some(thread),
            },
        );

        println!(
            "[opendaq] subscribe_signal {signal_id}: StreamReader<f64, i64> built, pump thread \
             quackoscope-signal-pump-{subscription_id} started"
        );
        Ok(())
    }

    // --- unsubscribe_signal ------------------------------------------------

    fn unsubscribe_signal(&self, subscription_id: u32) -> ServiceResult<()> {
        let pump = {
            let mut subscriptions = match self.subscriptions.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            subscriptions.remove(&subscription_id)
        };

        let Some(mut pump) = pump else {
            // The session registry already reported an unknown id.
            return Ok(());
        };

        pump.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = pump.thread.take() {
            let _ = thread.join();
        }
        // The pump thread owned the StreamReader; joining it is what drops the
        // reader, and dropping the reader is what disconnects it from the signal.
        println!(
            "[opendaq] unsubscribe_signal {subscription_id} on {}: pump thread joined, StreamReader dropped",
            pump.signal_id
        );
        Ok(())
    }

    // --- get_device_operation_modes ----------------------------------------

    fn device_operation_modes(&self, node_id: &str) -> ServiceResult<Vec<String>> {
        let device = self.resolve_device(node_id)?; // shared region device-facet-of-component

        // quack-snippet capability=device.mode uses=device-facet-of-component,operation-mode-names step=1
        // The modes THIS device will accept, which is a different question from
        // the mode it is in now (that one is IComponent.getOperationMode(), and
        // it rides on every Node). openDAQ hands the available list over as
        // plain integers rather than as OperationModeType values, so each one
        // has to be turned back into the enum before it can be named.
        let available = device.available_operation_modes();
        // quack-snippet end

        let available = available.map_err(|e| translate_general(&e))?;

        let mut modes = Vec::new();
        for raw in &available {
            // quack-snippet capability=device.mode uses=operation-mode-names step=2
            let mode = u32::try_from(*raw)
                .ok()
                .and_then(OperationModeType::from_raw);
            // quack-snippet end

            match mode.and_then(operation_mode_wire_name) {
                Some(wire_name) => modes.push(wire_name.to_string()),
                None => eprintln!(
                    "[opendaq] get_device_operation_modes {node_id}: \
                     daqDevice_getAvailableOperationModes listed {raw}, which is not one of the four \
                     OperationModeType values (0 Unknown, 1 Idle, 2 Operation, 3 SafeOperation) that \
                     contract types.Node.operation_mode carries; it is omitted from the answer"
                ),
            }
        }

        println!(
            "[opendaq] get_device_operation_modes {node_id}: \
             daqDevice_getAvailableOperationModes reported the raw list {available:?} -> {}",
            if modes.is_empty() {
                "no mode this contract carries".to_string()
            } else {
                modes.join(", ")
            }
        );
        Ok(modes)
    }

    // --- set_device_operation_mode -----------------------------------------

    fn set_device_operation_mode(&self, node_id: &str, mode: &str) -> ServiceResult<()> {
        let device = self.resolve_device(node_id)?; // shared region device-facet-of-component

        let requested = operation_mode_from_wire_name(mode).ok_or_else(|| {
            ServiceError::invalid_value(format!(
                "\"{mode}\" is not one of the operation modes contract types.Node.operation_mode \
                 carries (unknown, idle, operation, safe_operation)"
            ))
        })?; // shared region operation-mode-names

        // The contract's own reading of invalid_value for this row is "a mode
        // the device did not list as available", so the available list is read
        // first rather than letting openDAQ answer with a status code that does
        // not distinguish that case from a locked device.
        let available = self.device_operation_modes(node_id)?;
        if !available.iter().any(|listed| listed == mode) {
            return Err(ServiceError::invalid_value(format!(
                "device \"{node_id}\" does not list \"{mode}\" among its available operation modes; \
                 daqDevice_getAvailableOperationModes reported {}",
                if available.is_empty() {
                    "an empty list".to_string()
                } else {
                    available.join(", ")
                }
            )));
        }

        // quack-snippet capability=device.mode uses=device-facet-of-component,operation-mode-names step=3
        // setOperationMode changes THIS device only. openDAQ also declares
        // setOperationModeRecursive(), which carries the same mode into every
        // sub-device; the contract's row is the single-device one, so this is
        // the non-recursive call and the recursion is a client's decision.
        let written = device.set_operation_mode(requested);
        // quack-snippet end

        // A locked device refuses the write with OPENDAQ_ERR_DEVICE_LOCKED,
        // which the closed-set table maps to read_only -- the code contract
        // section 5 names for exactly this refusal.
        written.map_err(|e| translate_general(&e))?;

        println!(
            "[opendaq] set_device_operation_mode {node_id} = {mode} \
             (daqDevice_setOperationMode with OperationModeType::{requested:?} = {})",
            requested as u32
        );
        Ok(())
    }

    // --- lock_device --------------------------------------------------------

    fn lock_device(&self, node_id: &str) -> ServiceResult<()> {
        let device = self.resolve_device(node_id)?; // shared region device-facet-of-component

        // quack-snippet capability=device.lock uses=device-facet-of-component step=1
        // IDevice.lock() takes no arguments: it locks for whichever user the
        // session authenticated as, and openDAQ then permits an unlock only by
        // that same user. The two-argument form, IDevicePrivate.lock(user),
        // names a user explicitly and is not what a client calls.
        let locked = device.lock();
        // quack-snippet end

        locked.map_err(|e| translate_general(&e))?;

        // Read back rather than assume: the answer the next get_component_tree
        // will put in Node.locked is the one openDAQ now reports, not the one
        // this call intended.
        let reported = device.is_locked();
        println!(
            "[opendaq] lock_device {node_id}: daqDevice_lock returned success; daqDevice_isLocked \
             now reports {}",
            match reported {
                Ok(state) => state.to_string(),
                Err(ref e) => format!("<unreadable: {e}>"),
            }
        );
        Ok(())
    }

    // --- unlock_device ------------------------------------------------------

    fn unlock_device(&self, node_id: &str, force: bool) -> ServiceResult<()> {
        let device = self.resolve_device(node_id)?; // shared region device-facet-of-component

        if force {
            // quack-snippet capability=device.lock uses=device-facet-of-component step=3
            // A forced unlock is not on IDevice at all: openDAQ puts it on
            // IDevicePrivate, a separate interface the device has to be queried
            // for. That is why the contract's `force` is a parameter and not a
            // second row -- the same act on the same node -- and why a device
            // that does not carry IDevicePrivate can only answer unsupported.
            let private = device.as_base_object().try_cast::<DevicePrivate>();
            // quack-snippet end

            let private = private.ok_or_else(|| {
                ServiceError::unsupported(format!(
                    "device \"{node_id}\" does not carry the openDAQ IDevicePrivate interface, so \
                     unlock_device with force: true has no forced path to take on it; \
                     IDevice.unlock() (force absent or false) is the only unlock available here"
                ))
            })?;

            // quack-snippet capability=device.lock uses=device-facet-of-component step=4
            let forced = private.force_unlock();
            // quack-snippet end

            forced.map_err(|e| translate_general(&e))?;
            println!(
                "[opendaq] unlock_device {node_id} force=true: daqDevicePrivate_forceUnlock returned \
                 success; daqDevice_isLocked now reports {}",
                match device.is_locked() {
                    Ok(state) => state.to_string(),
                    Err(e) => format!("<unreadable: {e}>"),
                }
            );
            return Ok(());
        }

        // quack-snippet capability=device.lock uses=device-facet-of-component step=2
        // IDevice.unlock() refuses with OPENDAQ_ERR_ACCESSDENIED when another
        // user holds the lock -- device.h says only the user who locked it may
        // unlock it. The closed-set table maps that to read_only, which is the
        // exact signal a client turns into the force-unlock control.
        let unlocked = device.unlock();
        // quack-snippet end

        unlocked.map_err(|e| translate_general(&e))?;
        println!(
            "[opendaq] unlock_device {node_id} force=false: daqDevice_unlock returned success; \
             daqDevice_isLocked now reports {}",
            match device.is_locked() {
                Ok(state) => state.to_string(),
                Err(e) => format!("<unreadable: {e}>"),
            }
        );
        Ok(())
    }

    // --- list_loaded_modules ------------------------------------------------

    fn list_loaded_modules(&self) -> ServiceResult<Vec<WireModuleInfo>> {
        // contract section 5 gives this row the error subset
        // [not_connected, internal] and nothing else. So every failure raised
        // below is restated as internal, keeping its original wording, rather
        // than answered with a code the contract does not permit here: the
        // first version of this handler put `unsupported` on the wire, straight
        // out of a mock module's un-implemented server-type enumeration.
        let read = (|| -> ServiceResult<Vec<WireModuleInfo>> {
            let manager = self.module_manager_of_this_instance()?;

            // quack-snippet capability=module.read uses=instance-with-module-path,module-manager-of-instance step=1
            // Every module the manager currently holds: the ones swept out of
            // the manifest's module_path when the Instance was built, plus any
            // that daqModuleManager_loadModule has added since.
            let modules = manager.modules();
            // quack-snippet end

            let modules = modules.map_err(|e| translate_general(&e))?;

            let mut out = Vec::new();
            for (index, module) in modules.iter().enumerate() {
                match module_info_record(module, "list_loaded_modules")? {
                    Some(record) => out.push(record),
                    None => eprintln!(
                        "[opendaq] list_loaded_modules: module {index} of {} reports no IModuleInfo, \
                         so it carries neither the id nor the name contract types.ModuleInfo requires; \
                         it is left out of the answer rather than invented",
                        modules.len()
                    ),
                }
            }

            println!(
                "[opendaq] list_loaded_modules: daqModuleManager_getModules reported {} module(s), {} of \
                 them describable as contract types.ModuleInfo records",
                modules.len(),
                out.len()
            );
            Ok(out)
        })();

        read.map_err(|e| match e.code {
            ErrorCode::NotConnected | ErrorCode::Internal => e,
            other => ServiceError::internal(format!(
                "{} -- restated as internal because contract/contract.yaml declares the error subset \
                 [not_connected, internal] for list_loaded_modules, which does not carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }

    // --- load_module_from_host_path ------------------------------------------

    fn load_module_from_host_path(&self, host_path: &str) -> ServiceResult<WireModuleInfo> {
        let loaded = (|| -> ServiceResult<WireModuleInfo> {
            // not_found, and the only place this host can produce it. openDAQ
            // does not tell "no such file" apart from "wrong extension": both
            // leave ModuleManagerImpl as OPENDAQ_ERR_INVALIDPARAMETER
            // (module_manager_impl.cpp:292 for the extension, :317 for the
            // missing file), which the closed-set table reads as invalid_value.
            // So whether the file is on THIS machine's disk is settled here,
            // before the SDK is asked, which is what lets the answer be
            // not_found -- the code contract/contract.yaml names as the one a
            // path copied off the caller's own machine will produce.
            let path = std::path::Path::new(host_path);
            if !path.exists() {
                return Err(ServiceError::not_found(format!(
                    "there is no file at {host_path} on the machine quackoscope-host-rust runs on. \
                     load_module_from_host_path resolves its path on the HOST's filesystem, never the \
                     caller's; the directory this host swept for modules at startup is {}",
                    self.module_path
                )));
            }
            if !path.is_file() {
                return Err(ServiceError::invalid_value(format!(
                    "{host_path} exists on the machine quackoscope-host-rust runs on but is not a \
                     regular file, so there is no shared library at it to load"
                )));
            }

            let manager = self.module_manager_of_this_instance()?;

            // quack-snippet capability=module.load uses=instance-with-module-path,module-manager-of-instance step=1
            // daqModuleManager_loadModule LOADS AND ADDS: the file at this
            // absolute path is dlopen'd into this process, its module entry
            // point runs, and the module handed back is already in the
            // manager's list, so the next daqModuleManager_getModules carries
            // it without anything further being done. Which extension the file
            // must have -- .module.dll, .dylib or .module.so -- is decided by
            // the platform THIS process runs on, because this process is the
            // one doing the loading.
            let module = manager.load_module(host_path);
            // quack-snippet end

            let module = module
                .map_err(|e| translate_module_load(&e))?
                .ok_or_else(|| {
                    ServiceError::internal(format!(
                        "daqModuleManager_loadModule reported success for {host_path} but handed back no \
                         IModule, so there is no module for contract types.ModuleInfo to describe"
                    ))
                })?;

            let record =
                module_info_record(&module, "load_module_from_host_path")?.ok_or_else(|| {
                    ServiceError::internal(format!(
                        "the module loaded from {host_path} reports no IModuleInfo, so it carries neither \
                         the id nor the name contract types.ModuleInfo requires; it is in this process's \
                         module manager but cannot be described on the wire"
                    ))
                })?;

            println!(
                "[opendaq] load_module_from_host_path {host_path}: daqModuleManager_loadModule loaded and \
                 added module {} (name {}, version {}), offering {} component type(s). It is in this \
                 process's module manager from now on, so the next list_loaded_modules of every session \
                 carries it, and the device types it advertises are visible to the next \
                 scan_available_devices",
                record.id,
                record.name,
                record.version.as_deref().unwrap_or("none reported"),
                record.component_types.len()
            );
            Ok(record)
        })();

        loaded.map_err(|e| match e.code {
            ErrorCode::NotFound
            | ErrorCode::NotConnected
            | ErrorCode::InvalidValue
            | ErrorCode::Internal => e,
            other => ServiceError::internal(format!(
                "{} -- restated as internal because contract/contract.yaml declares the error subset \
                 [not_found, not_connected, invalid_value, internal] for load_module_from_host_path, \
                 which does not carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }

    // --- get_component_attributes -------------------------------------------

    fn component_attributes(&self, node_id: &str) -> ServiceResult<Vec<ComponentAttribute>> {
        let read = (|| -> ServiceResult<Vec<ComponentAttribute>> {
            let component = self.resolve(node_id)?;

            // quack-snippet capability=attribute.read uses=component-attribute-rows
            // ONE PANEL, ONE CALL. The attributes view is a panel over one
            // selected component, so every row it draws is read here in a single
            // pass -- the shared region component-attribute-rows, which is also
            // what set_component_attribute consults before it writes.
            let rows = component_attribute_rows(&component, node_id);
            // quack-snippet end

            let rows = rows?;
            println!(
                "[opendaq] get_component_attributes {node_id}: {} attribute row(s) answered",
                rows.len()
            );
            Ok(rows)
        })();

        // contract errors: [not_found, not_connected] and nothing else.
        read.map_err(|e| match e.code {
            ErrorCode::NotFound | ErrorCode::NotConnected => e,
            other => ServiceError::not_found(format!(
                "{} -- restated as not_found because contract/contract.yaml declares the error subset \
                 [not_found, not_connected] for get_component_attributes, which does not carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }

    // --- set_component_attribute ---------------------------------------------

    fn set_component_attribute(
        &self,
        node_id: &str,
        attribute_id: &str,
        value: &Json,
    ) -> ServiceResult<()> {
        let written = (|| -> ServiceResult<()> {
            let component = self.resolve(node_id)?;

            // quack-snippet capability=attribute.write uses=component-attribute-rows step=1
            // THE SAME ROWS get_component_attributes ANSWERS WITH, read again
            // here rather than remembered from that call, because openDAQ fills
            // getLockedAttributes() at runtime and it can have changed since.
            // Checking read_only before the write is the same discipline
            // set_property_value follows with Property.read_only: openDAQ
            // answers a refused attribute write with a status code that does not
            // distinguish "locked" from "bad value", so the flag is asked for
            // first and the two failures stay distinguishable on the wire.
            let rows = component_attribute_rows(&component, node_id);
            // quack-snippet end

            let rows = rows?;
            let Some(row) = rows.iter().find(|row| row.id == attribute_id) else {
                let reported: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
                return Err(ServiceError::not_found(format!(
                    "\"{attribute_id}\" is not an attribute this host reports for \"{node_id}\"; \
                     get_component_attributes answers [{}] for it",
                    reported.join(", ")
                )));
            };
            if row.read_only {
                let reason = attribute_is_read_only_whatever_the_component_says(attribute_id)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        format!(
                            "openDAQ reports it locked on this component -- \
                             IComponent_getLockedAttributes named \"{}\"",
                            locked_attribute_name_of(attribute_id).unwrap_or(attribute_id)
                        )
                    });
                return Err(ServiceError::read_only(format!(
                    "attribute \"{attribute_id}\" on \"{node_id}\" cannot be written: {reason}"
                )));
            }

            match attribute_id {
                "name" | "description" => {
                    let Json::String(text) = value else {
                        return Err(ServiceError::invalid_value(format!(
                            "attribute \"{attribute_id}\" is value_type string; got {value}"
                        )));
                    };
                    // quack-snippet capability=attribute.write step=2
                    // Attribute setters are declared on the INTERFACE, one per
                    // attribute: IComponent::setName(IString*) and
                    // setDescription(IString*). There is no generic
                    // "set attribute by name" call anywhere in openDAQ, which is
                    // why this is a branch and not a table lookup.
                    let result = if attribute_id == "name" {
                        component.set_name(text)
                    } else {
                        component.set_description(text)
                    };
                    // quack-snippet end
                    result.map_err(|e| translate(&e, MapContext::PropertyWrite))?;
                }
                "active" | "visible" => {
                    let Json::Bool(state) = value else {
                        return Err(ServiceError::invalid_value(format!(
                            "attribute \"{attribute_id}\" is value_type bool; got {value}"
                        )));
                    };
                    // quack-snippet capability=attribute.write step=3
                    let result = if attribute_id == "active" {
                        component.set_active(*state)
                    } else {
                        component.set_visible(*state)
                    };
                    // quack-snippet end
                    result.map_err(|e| translate(&e, MapContext::PropertyWrite))?;
                }
                "public" => {
                    let Json::Bool(state) = value else {
                        return Err(ServiceError::invalid_value(format!(
                            "attribute \"public\" is value_type bool; got {value}"
                        )));
                    };
                    // quack-snippet capability=attribute.write step=4
                    // `public` is declared TWICE in openDAQ, on ISignal and on
                    // IInputPort, and they are different methods on different
                    // interfaces. Which one to call is decided by which
                    // interface this component actually carries.
                    let signal_facet = component.as_base_object().try_cast::<Signal>();
                    let input_port_facet = component.as_base_object().try_cast::<InputPort>();
                    let result = match (&signal_facet, &input_port_facet) {
                        (Some(signal), _) => Some(signal.set_public(*state)),
                        (None, Some(input_port)) => Some(input_port.set_public(*state)),
                        (None, None) => None,
                    };
                    // quack-snippet end
                    match result {
                        Some(result) => {
                            result.map_err(|e| translate(&e, MapContext::PropertyWrite))?
                        }
                        None => {
                            return Err(ServiceError::not_found(format!(
                                "component \"{node_id}\" is a {} and carries neither ISignal nor \
                                 IInputPort, so it has no \"public\" attribute; \
                                 get_component_attributes does not report one for it either",
                                kind_of(&component)
                            )))
                        }
                    }
                }
                "tags" => {
                    let Json::Array(items) = value else {
                        return Err(ServiceError::invalid_value(format!(
                            "attribute \"tags\" is value_type string_list; got {value}"
                        )));
                    };
                    let mut tags: Vec<String> = Vec::with_capacity(items.len());
                    for item in items {
                        match item {
                            Json::String(text) => tags.push(text.clone()),
                            other => {
                                return Err(ServiceError::invalid_value(format!(
                                    "attribute \"tags\" is value_type string_list and every element \
                                     must be a string; got {other}"
                                )))
                            }
                        }
                    }

                    // quack-snippet capability=attribute.write step=5
                    // ITags cannot be written through: it declares getList(),
                    // contains() and query() and nothing else. add(), remove()
                    // and replace() are on ITagsPrivate, so the tags object has
                    // to be queried for that interface first. `replace` is the
                    // one that matches this row, which carries the WHOLE list.
                    let tag_object = component.tags();
                    let private = tag_object.as_ref().ok().and_then(|held| {
                        held.as_ref()
                            .and_then(|tags| tags.as_base_object().try_cast::<TagsPrivate>())
                    });
                    let borrowed: Vec<&str> = tags.iter().map(String::as_str).collect();
                    let result = private.map(|private| private.replace(&borrowed));
                    // quack-snippet end

                    tag_object.map_err(|e| translate_general(&e))?;
                    match result {
                        Some(result) => {
                            result.map_err(|e| translate(&e, MapContext::PropertyWrite))?
                        }
                        None => {
                            return Err(ServiceError::read_only(format!(
                                "the ITags object of \"{node_id}\" does not carry ITagsPrivate, which is \
                                 the only interface in openDAQ that can add, remove or replace a tag; \
                                 get_component_attributes reports this attribute read_only for the same \
                                 reason"
                            )))
                        }
                    }
                }
                other => {
                    // Unreachable through the two checks above -- the id was
                    // found among the rows and the row was not read_only, and
                    // every such id has a branch here. Stated as a refusal
                    // rather than left as a silent fall-through, so a row added
                    // to component_attribute_rows without a writer says so
                    // instead of appearing to succeed.
                    return Err(ServiceError::read_only(format!(
                        "attribute \"{other}\" on \"{node_id}\" is reported writable by \
                         get_component_attributes but quackoscope-host-rust has no setter branch for \
                         it, so nothing was written; that disagreement is this host's, not openDAQ's"
                    )));
                }
            }

            println!(
                "[opendaq] set_component_attribute {node_id}.{attribute_id} = {value} (openDAQ's own \
                 setter on the interface, not a property write)"
            );
            Ok(())
        })();

        // contract errors: [not_found, read_only, invalid_value].
        written.map_err(|e| match e.code {
            ErrorCode::NotFound | ErrorCode::ReadOnly | ErrorCode::InvalidValue => e,
            other => ServiceError::invalid_value(format!(
                "{} -- restated as invalid_value because contract/contract.yaml declares the error \
                 subset [not_found, read_only, invalid_value] for set_component_attribute, which does \
                 not carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }

    // --- list_server_types ----------------------------------------------------

    fn list_server_types(&self) -> ServiceResult<Vec<ComponentTypeInfo>> {
        let read = (|| -> ServiceResult<Vec<ComponentTypeInfo>> {
            // quack-snippet capability=server.add uses=instance-with-module-path step=1
            // What the INSTANCE will accept, asked of the instance. This is not
            // the same question as "what server types does each loaded module
            // offer" -- that is daqModule_getAvailableServerTypes, which
            // list_loaded_modules asks -- and the two are only accidentally
            // equal. The answer is a dictionary keyed by type id whose values
            // are IServerType, and every IServerType IS an IComponentType.
            let available = self.instance.available_server_types();
            // quack-snippet end

            let available = available.map_err(|e| translate_general(&e))?;

            let mut out = Vec::new();
            for (_, server_type) in available {
                // IServerType has no connection string prefix: a server is
                // created by type id, never by a connection string. Only
                // IDeviceType and IStreamingType carry one.
                out.push(describe_component_type(&server_type, "server", None)?);
            }
            out.sort_by(|left, right| left.id.cmp(&right.id));

            println!(
                "[opendaq] list_server_types: daqInstance_getAvailableServerTypes reported {} type(s): {}",
                out.len(),
                if out.is_empty() {
                    "none".to_string()
                } else {
                    out.iter()
                        .map(|entry| format!("{} ({})", entry.id, entry.name))
                        .collect::<Vec<_>>()
                        .join(", ")
                }
            );
            Ok(out)
        })();

        // contract errors: [not_connected] and nothing else.
        read.map_err(|e| match e.code {
            ErrorCode::NotConnected => e,
            other => ServiceError::not_connected(format!(
                "{} -- restated as not_connected because contract/contract.yaml declares the error \
                 subset [not_connected] for list_server_types, which does not carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }

    // --- add_server -----------------------------------------------------------

    fn add_server(&self, type_id: &str) -> ServiceResult<Node> {
        let added = (|| -> ServiceResult<Node> {
            // quack-snippet capability=server.add uses=instance-with-module-path step=2
            // The type id is checked against what the instance will accept
            // before the add is attempted, because openDAQ answers an unknown
            // type id with a status code that does not distinguish it from a
            // socket that could not be bound -- and this row's contract gives
            // those two different codes (unsupported and internal).
            let available = self.instance.available_server_types();
            // quack-snippet end

            let available = available.map_err(|e| translate_general(&e))?;
            let Some(server_type) = available.get(type_id) else {
                let mut offered: Vec<&String> = available.keys().collect();
                offered.sort();
                return Err(ServiceError::unsupported(format!(
                    "\"{type_id}\" is not a server type this instance accepts; \
                     daqInstance_getAvailableServerTypes offers {}",
                    if offered.is_empty() {
                        "no server type at all".to_string()
                    } else {
                        offered
                            .iter()
                            .map(|id| id.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    }
                )));
            };

            // quack-snippet capability=server.add step=3
            // openDAQ's addServer takes a config PROPERTY OBJECT, not an
            // optional one: IDevice::addServer(IString* typeId,
            // IPropertyObject* config, IServer** server). The default config is
            // the type's own -- IComponentType::createDefaultConfig() -- which
            // is exactly what the reference builds for its "Add with config"
            // screen before letting a user edit it. This contract carries no
            // config on the row, so the default is passed unedited.
            let default_config = server_type.create_default_config();
            // quack-snippet end

            let default_config = default_config.map_err(|e| translate_general(&e))?;
            let default_config = match default_config {
                Some(config) => config,
                None => {
                    // A type that offers no default config still has to be
                    // given something, because the parameter is not optional.
                    PropertyObject::new().map_err(|e| translate_general(&e))?
                }
            };

            // quack-snippet capability=server.add uses=component-node step=4
            // addServer is called ON THE INSTANCE and on nothing else:
            // IDevice::onAddServer refuses every device but the root, which is
            // why this contract's row takes no parent id -- it would be a
            // parameter with exactly one legal value. Adding a server OPENS A
            // LISTENING SOCKET in this process, which is why a failure here can
            // be about a bound port rather than about the type id.
            let server = self.instance.add_server(type_id, &default_config);
            // quack-snippet end

            let server = server.map_err(|e| translate_general(&e))?.ok_or_else(|| {
                ServiceError::internal(format!(
                    "daqDevice_addServer reported success for type \"{type_id}\" but handed back no \
                     IServer, so there is no component for contract types.Node to describe"
                ))
            })?;

            let component = server
                .as_base_object()
                .cast::<Component>()
                .map_err(|e| translate_general(&e))?;
            // The component -> Node mapping is the shared region component-node;
            // its kind_of() answers "server" here, which is the NodeKind value
            // this row is the reason for.
            let node = self.build_node(&component)?;

            println!(
                "[opendaq] add_server {type_id}: daqDevice_addServer on the root instance created {} \
                 (name {}, kind {}). It is listening from now on and every session can see it; the M1 \
                 contract declares no remove_server row, so nothing on this wire takes it down again",
                node.id, node.name, node.kind
            );
            Ok(node)
        })();

        // contract errors: [not_connected, unsupported, invalid_value, internal].
        added.map_err(|e| match e.code {
            ErrorCode::NotConnected
            | ErrorCode::Unsupported
            | ErrorCode::InvalidValue
            | ErrorCode::Internal => e,
            other => ServiceError::internal(format!(
                "{} -- restated as internal because contract/contract.yaml declares the error subset \
                 [not_connected, unsupported, invalid_value, internal] for add_server, which does not \
                 carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }

    // --- set_server_discovery_enabled ------------------------------------------

    fn set_server_discovery_enabled(&self, node_id: &str, enabled: bool) -> ServiceResult<()> {
        let written = (|| -> ServiceResult<()> {
            let component = self.resolve(node_id)?;
            let server = server_facet_of(&component).ok_or_else(|| {
                // shared region server-of-component
                ServiceError::unsupported(format!(
                    "component \"{node_id}\" is a {}, not a server; it carries no openDAQ IServer \
                     interface, so it has no discovery to enable or disable",
                    kind_of(&component)
                ))
            })?;

            // quack-snippet capability=server.discovery uses=server-of-component step=1
            // TWO METHODS, NOT ONE SETTER: openDAQ declares
            // IServer::enableDiscovery() at server.h:66 and
            // IServer::disableDiscovery() at server.h:90, each taking nothing.
            // The contract's single boolean row picks between them here.
            //
            // AND THERE IS NO GETTER. IServer's whole surface is stop, getId,
            // enableDiscovery, getSignals, getStreaming and disableDiscovery --
            // nothing reports whether discovery is currently on. That is why no
            // field of contract types.Node carries this state: no host could
            // fill it.
            let result = if enabled {
                server.enable_discovery()
            } else {
                server.disable_discovery()
            };
            // quack-snippet end

            result.map_err(|e| translate_general(&e))?;

            println!(
                "[opendaq] set_server_discovery_enabled {node_id} = {enabled}: \
                 daqServer_{} returned success. openDAQ has no discovery-state getter, so this host \
                 cannot read the setting back and does not pretend to -- nothing on the next \
                 get_component_tree will report it",
                if enabled {
                    "enableDiscovery"
                } else {
                    "disableDiscovery"
                }
            );
            Ok(())
        })();

        // contract errors: [not_found, unsupported, internal].
        written.map_err(|e| match e.code {
            ErrorCode::NotFound | ErrorCode::Unsupported | ErrorCode::Internal => e,
            other => ServiceError::internal(format!(
                "{} -- restated as internal because contract/contract.yaml declares the error subset \
                 [not_found, unsupported, internal] for set_server_discovery_enabled, which does not \
                 carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }

    // --- start_recording / stop_recording ---------------------------------------

    fn start_recording(&self, node_id: &str) -> ServiceResult<()> {
        self.drive_recorder(node_id, true)
    }

    fn stop_recording(&self, node_id: &str) -> ServiceResult<()> {
        self.drive_recorder(node_id, false)
    }

    // --- begin_batched_property_update -------------------------------------------

    fn begin_batched_property_update(&self, node_id: &str) -> ServiceResult<()> {
        let opened = (|| -> ServiceResult<()> {
            let object = self.resolve_property_object(node_id)?;
            let was_open = batched_update_is_open_on(&self.resolve(node_id)?); // shared region property-object-update-state

            // quack-snippet capability=property.batched_update step=1
            // IPropertyObject::beginUpdate() (property_object.h:330-349). While
            // it is open, setPropertyValue STAGES the value instead of applying
            // it: reads still answer the old value and no OnPropertyValueWrite
            // or OnEndUpdate event fires. It is RECURSIVE over child property
            // objects (property_object.h:335), so one call on a device puts a
            // whole subtree into batch mode -- for every session at once, not
            // just the one that called it.
            //
            // The crate also offers an RAII bracket, BatchedPropertyUpdate,
            // which opens the batch on construction and commits it on drop.
            // That shape cannot serve these two rows: the contract's begin and
            // end are two separate requests on two separate frames, and a guard
            // that commits when its scope ends would end the batch before the
            // client's next frame arrived.
            let result = object.begin_update();
            // quack-snippet end

            result.map_err(|e| translate_general(&e))?;

            println!(
                "[opendaq] begin_batched_property_update {node_id}: daqPropertyObject_beginUpdate \
                 returned success (getUpdating reported {} before the call, {} after). The batch is \
                 recursive over this component's child property objects and belongs to the COMPONENT, \
                 not to the socket that opened it",
                match was_open {
                    Some(state) => state.to_string(),
                    None => "nothing".to_string(),
                },
                match object.updating() {
                    Ok(state) => state.to_string(),
                    Err(ref e) => format!("<unreadable: {e}>"),
                }
            );
            Ok(())
        })();

        // contract errors: [not_found, not_connected].
        opened.map_err(|e| match e.code {
            ErrorCode::NotFound | ErrorCode::NotConnected => e,
            other => ServiceError::not_found(format!(
                "{} -- restated as not_found because contract/contract.yaml declares the error subset \
                 [not_found, not_connected] for begin_batched_property_update, which does not carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }

    // --- end_batched_property_update ---------------------------------------------

    fn end_batched_property_update(&self, node_id: &str) -> ServiceResult<()> {
        let closed = (|| -> ServiceResult<()> {
            let object = self.resolve_property_object(node_id)?;

            // A call that arrives with no batch open is the closed set's
            // invalid_value -- the request is well formed and the STATE refuses
            // it -- and this host answers exactly that rather than swallowing
            // it. The reference swallows it with a bare `except RuntimeError:
            // pass` (gui_demo.py:1374-1378); silence here would tell a user
            // their batch was applied when nothing was ever staged.
            let updating = object.updating().map_err(|e| translate_general(&e))?;
            if !updating {
                return Err(ServiceError::invalid_value(format!(
                    "no batched property update is open on \"{node_id}\": \
                     daqPropertyObject_getUpdating reports false, so there is nothing for \
                     daqPropertyObject_endUpdate to apply. contract types.Node.updating carries this \
                     state on every tree row, so a client can tell which of Begin and End is the live \
                     item without asking"
                )));
            }

            // quack-snippet capability=property.batched_update step=2
            // IPropertyObject::endUpdate() applies everything staged since the
            // matching beginUpdate, all at once, and fires the OnEndUpdate event
            // with the list of changed properties. It raises when no beginUpdate
            // is open.
            let result = object.end_update();
            // quack-snippet end

            result.map_err(|e| translate(&e, MapContext::PropertyWrite))?;

            println!(
                "[opendaq] end_batched_property_update {node_id}: daqPropertyObject_endUpdate applied \
                 the staged values (getUpdating now reports {})",
                match object.updating() {
                    Ok(state) => state.to_string(),
                    Err(ref e) => format!("<unreadable: {e}>"),
                }
            );
            Ok(())
        })();

        // contract errors: [not_found, not_connected, invalid_value].
        closed.map_err(|e| match e.code {
            ErrorCode::NotFound | ErrorCode::NotConnected | ErrorCode::InvalidValue => e,
            other => ServiceError::invalid_value(format!(
                "{} -- restated as invalid_value because contract/contract.yaml declares the error \
                 subset [not_found, not_connected, invalid_value] for end_batched_property_update, \
                 which does not carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }

    // --- save_instance_configuration_to_string ------------------------------------

    fn save_instance_configuration_to_string(&self) -> ServiceResult<String> {
        let saved = (|| -> ServiceResult<String> {
            // quack-snippet capability=configuration.save uses=instance-with-module-path step=1
            // IDevice::saveConfiguration(IString** configuration), device.h:242
            // -- "Saves the configuration of the device to string". It answers a
            // STRING and there is no path overload anywhere in openDAQ, which is
            // why this contract's row carries the string over the wire instead
            // of writing a file on the host: the host would have had to invent
            // file I/O openDAQ never asked for, and put the result on a machine
            // the user may have no shell on.
            //
            // Called on the Instance, which IS a Device, so the whole instance
            // and every device under it is serialised in one call.
            let configuration = self.instance.save_configuration();
            // quack-snippet end

            let configuration = configuration.map_err(|e| translate_general(&e))?;
            println!(
                "[opendaq] save_instance_configuration_to_string: \
                 daqDevice_saveConfiguration produced {} characters covering the whole instance",
                configuration.len()
            );
            Ok(configuration)
        })();

        // contract errors: [not_connected, internal].
        saved.map_err(|e| match e.code {
            ErrorCode::NotConnected | ErrorCode::Internal => e,
            other => ServiceError::internal(format!(
                "{} -- restated as internal because contract/contract.yaml declares the error subset \
                 [not_connected, internal] for save_instance_configuration_to_string, which does not \
                 carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }

    // --- load_instance_configuration_from_string ----------------------------------

    fn load_instance_configuration_from_string(&self, configuration: &str) -> ServiceResult<()> {
        let loaded = (|| -> ServiceResult<()> {
            // quack-snippet capability=configuration.load uses=instance-with-module-path step=1
            // IDevice::loadConfiguration(IString* configuration,
            // IUpdateParameters* config = nullptr), device.h:248. The second
            // argument is openDAQ's UpdateParameters board -- per device a
            // LocalId, Manufacturer, SerialNumber, ConnectionString and
            // UpdateMode, recursively down the device tree. This contract's row
            // carries none of it, so the null default is used, which is what
            // openDAQ does with no second argument and what the reference's own
            // _load_config path does.
            //
            // This REPLACES the configuration of every device under the
            // instance, in one call, for every session at once. There is no
            // narrower form of it in openDAQ and none on this row.
            let result = self.instance.load_configuration(configuration);
            // quack-snippet end

            // MapContext::ConfigurationLoad, not the general table. A string
            // openDAQ will not deserialise comes back as
            // OPENDAQ_ERR_DESERIALIZE_PARSE_ERROR and friends, which the general
            // table sends to internal because no other operation raises them --
            // and contract/contract.yaml is explicit that this row must answer
            // invalid_value there, because it is a refusal of the file the user
            // chose and not a fault of the instance.
            result.map_err(|e| translate(&e, MapContext::ConfigurationLoad))?;

            println!(
                "[opendaq] load_instance_configuration_from_string: \
                 daqDevice_loadConfiguration applied {} characters to the whole instance with \
                 openDAQ's default UpdateParameters. Every node id, property value and device under \
                 this instance may now be different, in this session and in every other one",
                configuration.len()
            );
            Ok(())
        })();

        // contract errors: [not_connected, invalid_value, internal].
        loaded.map_err(|e| match e.code {
            ErrorCode::NotConnected | ErrorCode::InvalidValue | ErrorCode::Internal => e,
            other => ServiceError::invalid_value(format!(
                "{} -- restated as invalid_value because contract/contract.yaml declares the error \
                 subset [not_connected, invalid_value, internal] for \
                 load_instance_configuration_from_string, which does not carry {}",
                e.detail,
                other.to_wire()
            )),
        })
    }
}

/// The pump. Reads f64 values with i64 domain stamps until the subscription is
/// dropped, handing every non-empty chunk to the service layer's sink; the
/// sink is where decimation and framing happen, not here.
fn pump_samples_until_stopped(
    subscription_id: u32,
    signal_id: &str,
    reader: StreamReader<f64, i64>,
    sink: SampleSink,
    stop: &AtomicBool,
) {
    let mut reader = reader;
    while !stop.load(Ordering::SeqCst) {
        // quack-snippet capability=streaming.decimated step=3
        let read = reader.read_with_domain(PUMP_BUFFER_SAMPLES, PUMP_TIMEOUT_MS);
        // quack-snippet end

        match read {
            Ok((samples, domain)) => {
                if samples.is_empty() || domain.is_empty() {
                    continue;
                }
                sink(subscription_id, domain[0] as u64, samples.values());
            }
            Err(e) if e.is_reader_invalidated() => {
                // quack-snippet capability=streaming.decimated step=4
                // A descriptor change invalidates the reader: the read fails
                // once and every later read would keep failing, so the reader
                // has to be rebuilt over the same signal, inheriting the
                // unread packets of the invalidated one.
                let rebuilt = StreamReader::<f64, i64>::from_existing(&reader);
                // quack-snippet end
                match rebuilt {
                    Ok(replacement) => {
                        println!(
                            "[opendaq] subscription {subscription_id} on {signal_id}: the reader was \
                             invalidated by a descriptor change and has been rebuilt ({e})"
                        );
                        reader = replacement;
                    }
                    Err(rebuild_error) => {
                        eprintln!(
                            "[opendaq] subscription {subscription_id} on {signal_id}: the reader was \
                             invalidated ({e}) and could not be rebuilt: {rebuild_error}"
                        );
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "[opendaq] read on subscription {subscription_id} ({signal_id}) failed: {e}"
                );
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
    println!("[opendaq] subscription {subscription_id} on {signal_id}: pump thread exiting");
}
