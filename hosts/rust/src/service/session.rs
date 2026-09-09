// Quackoscope host (Rust) -- service layer.
//
// Session state and method dispatch. Owns the subscription registry, performs
// the decimation, maps every failure into the closed error-code set, and sends
// the handshake as message ordinal 1 on every session.
//
// A dropped socket invalidates that session: its subscriptions are torn down,
// its devices are released from the openDAQ Instance once no other live session
// still holds them, and the node ids it was allowed to name go with it. Nothing
// a session did is visible to the next one.
//
// NOT IMPLEMENTED HERE, and said plainly rather than left to be discovered:
// this host pushes none of the five events of contract section 6
// (component_added, component_removed, property_changed,
// property_descriptor_changed, device_disconnected). The opendaq crate does
// expose the core event -- Context::on_core_event() and Event::subscribe(..) --
// so the missing piece is this host, not the binding. Events are not part of
// any capability id, so the handshake cannot carry that fact as a gap.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value as Json};

use crate::transport::websocket_server::{ConnectionHandler, Connection};
use crate::transport::wire::{encode_data_frame, Outcome, DATA_FRAME_HEADER_BYTES};

use super::daq_backend_interface::{DaqBackend, SampleSink};
use super::decimator::decimate;
use super::error::{ErrorCode, ServiceError, ServiceResult};
use super::handshake::{
    build_handshake, capabilities_fully_served_by, gaps_against_baseline, Gap,
    BASELINE_CAPABILITY_IDS, CONTRACT_OPERATION_TABLE,
};
use super::manifest::Manifest;

// Contract section 7 limits, announced in the handshake and enforced here so
// the announcement is true. max_frame_bytes bounds pixel_columns rather than
// the frame: a decimated frame is 17 header bytes plus at most two float64 per
// requested column, so the column count is where the byte cap has to bite.
pub const MAX_SUBSCRIPTIONS_PER_SESSION: i64 = 64;
pub const MAX_FRAME_BYTES: i64 = 262_144;
pub const MAX_PIXEL_COLUMNS: u32 =
    ((MAX_FRAME_BYTES - DATA_FRAME_HEADER_BYTES as i64) / (2 * 8)) as u32;

/// The wire methods this host dispatches. Adding a name here (and the matching
/// arm in `dispatch`) is what adds its capability to the handshake; removing
/// one is what turns the capability back into a gap.
pub const SERVED_WIRE_METHODS: [&str; 27] = [
    "scan_available_devices",
    "connect_device",
    "disconnect_device",
    "get_component_tree",
    "get_property_descriptors",
    "get_property_value",
    "set_property_value",
    "subscribe_signal",
    "unsubscribe_signal",
    "get_device_operation_modes",
    "set_device_operation_mode",
    "lock_device",
    "unlock_device",
    "list_loaded_modules",
    "load_module_from_host_path",
    "get_component_attributes",
    "set_component_attribute",
    "list_server_types",
    "add_server",
    "remove_server",
    "set_server_discovery_enabled",
    "start_recording",
    "stop_recording",
    "begin_batched_property_update",
    "end_batched_property_update",
    "save_instance_configuration_to_string",
    "load_instance_configuration_from_string",
];

/// The values of Node.operation_mode in contract section 3, which are also the
/// vocabulary of get_device_operation_modes' array and of
/// set_device_operation_mode's `mode` param. Spelled here so a mode name
/// outside the set is refused with invalid_value before it reaches openDAQ.
pub const OPERATION_MODE_WIRE_NAMES: [&str; 4] =
    ["unknown", "idle", "operation", "safe_operation"];

#[derive(Debug, Clone)]
struct Subscription {
    signal_id: String,
    pixel_columns: u32,
}

/// Everything one WebSocket may see. A node id this session never reached
/// through a connect_device of its own is not addressable from it.
#[derive(Debug, Default)]
struct SessionState {
    subscriptions: BTreeMap<u32, Subscription>,
    /// connection string -> the device node id connect_device answered with
    device_node_ids_by_connection_string: BTreeMap<String, String>,
}

#[derive(Default)]
struct Hub {
    sessions: HashMap<u64, SessionState>,
    sessions_holding_device: HashMap<String, i64>,
    next_subscription_id: u32,
    /// The node ids add_server answered with, for the WHOLE PROCESS and not per
    /// session.
    ///
    /// A server is not under any connected device: openDAQ's
    /// IDevice::onAddServer refuses every device but the root
    /// (device_impl.h:1465-1476), so add_server puts the server under the ROOT
    /// INSTANCE, whose id is not a prefix of any id connect_device hands out.
    /// Without this set the very node add_server just returned would be
    /// unaddressable, and set_server_discovery_enabled and remove_server could
    /// never be called on it.
    ///
    /// IT IS INSTANCE-WIDE ON PURPOSE, and it used to be per session, which was
    /// a permission openDAQ does not have. A server sits in the root instance's
    /// `servers` folder, which IDevice::getServers() (device.h:294-298) reports
    /// to every caller; nothing in openDAQ records who added one and nothing
    /// consults such a record - IDevice::removeServer(IServer*)
    /// (device.h:300-304 -> device_impl.h:1479-1487) is `this->servers
    /// .removeItem(server)` with no owner check anywhere on the path. Scoping
    /// the id to its creator made this host refuse a second connection a
    /// removal openDAQ performs for anybody, which is exactly the shape of
    /// invention the device lock ruling forbids.
    server_node_ids: BTreeSet<String>,
}

pub struct SessionHub {
    backend: Arc<dyn DaqBackend>,
    handshake: Json,
    handshake_text: String,
    hub: Mutex<Hub>,
}

impl SessionHub {
    /// `implementation_name` and `implementation_version` are DISPLAY ONLY:
    /// they go into the handshake and no behavioural branch in this host reads
    /// them. The SDK version and commit come from the manifest and nowhere else.
    pub fn new(
        backend: Arc<dyn DaqBackend>,
        manifest: &Manifest,
        implementation_name: &str,
        implementation_version: &str,
    ) -> Result<SessionHub, String> {
        let mut served: BTreeSet<String> = BTreeSet::new();
        for method in SERVED_WIRE_METHODS {
            if !CONTRACT_OPERATION_TABLE
                .iter()
                .any(|(wire_method, _)| *wire_method == method)
            {
                return Err(format!(
                    "\"{method}\" is listed in SERVED_WIRE_METHODS of hosts/rust/src/service/session.rs but is \
                     not a wire method of contract/contract.yaml section 5"
                ));
            }
            served.insert(method.to_string());
        }

        let capabilities = capabilities_fully_served_by(&served);
        let gaps = gaps_against_baseline(&capabilities)?;

        let handshake = build_handshake(
            implementation_name,
            implementation_version,
            manifest,
            &capabilities,
            &gaps,
            MAX_SUBSCRIPTIONS_PER_SESSION,
            MAX_FRAME_BYTES,
        );
        let handshake_text = handshake.to_string();

        println!(
            "[service] dispatch table holds {} of the contract's {} wire methods, so {} of the {} baseline \
             capabilities are declared and {} are gaps:",
            served.len(),
            CONTRACT_OPERATION_TABLE.len(),
            capabilities.len(),
            BASELINE_CAPABILITY_IDS.len(),
            gaps.len()
        );
        for capability in &capabilities {
            println!("[service]   capability {capability}");
        }
        for gap in &gaps {
            print_gap(gap);
        }
        println!(
            "[service] limits announced: max_subscriptions {MAX_SUBSCRIPTIONS_PER_SESSION} per session, \
             max_frame_bytes {MAX_FRAME_BYTES}, which caps pixel_columns at {MAX_PIXEL_COLUMNS} \
             ({DATA_FRAME_HEADER_BYTES} header bytes + 2 float64 per column)"
        );

        Ok(SessionHub {
            backend,
            handshake,
            handshake_text,
            hub: Mutex::new(Hub {
                next_subscription_id: 1,
                ..Hub::default()
            }),
        })
    }

    /// The exact JSON this host sends as the first message of every session.
    pub fn handshake(&self) -> &Json {
        &self.handshake
    }

    fn lock_hub(&self) -> std::sync::MutexGuard<'_, Hub> {
        match self.hub.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    // --- session-scoped addressability -------------------------------------

    fn require_device_in_session(&self, connection_id: u64) -> ServiceResult<()> {
        let hub = self.lock_hub();
        let state = hub
            .sessions
            .get(&connection_id)
            .ok_or_else(|| ServiceError::not_connected("this WebSocket session is already closed"))?;
        if state.device_node_ids_by_connection_string.is_empty() {
            return Err(ServiceError::not_connected(
                "this session has connected no device; call connect_device first (a device another session \
                 connected is not visible here)",
            ));
        }
        Ok(())
    }

    fn require_node_reachable_from_session(
        &self,
        connection_id: u64,
        params: &Json,
        key: &str,
    ) -> ServiceResult<String> {
        let node_id = require_string(params, key)?;

        let hub = self.lock_hub();
        let state = hub
            .sessions
            .get(&connection_id)
            .ok_or_else(|| ServiceError::not_connected("this WebSocket session is already closed"))?;

        for device_node_id in state.device_node_ids_by_connection_string.values() {
            if node_id == *device_node_id || node_id.starts_with(&format!("{device_node_id}/")) {
                return Ok(node_id);
            }
        }

        // Any server standing in the root instance, and anything beneath it,
        // whichever session's add_server created it. openDAQ's servers folder
        // is not scoped to a caller and removeServer carries no owner check, so
        // this host scopes it to none either.
        for server_node_id in &hub.server_node_ids {
            if node_id == *server_node_id || node_id.starts_with(&format!("{server_node_id}/")) {
                return Ok(node_id);
            }
        }

        if state.device_node_ids_by_connection_string.is_empty() && hub.server_node_ids.is_empty() {
            return Err(ServiceError::not_connected(format!(
                "this session has connected no device and the openDAQ Instance holds no server, so \
                 \"{node_id}\" is not addressable; call connect_device first"
            )));
        }

        let reachable = state
            .device_node_ids_by_connection_string
            .values()
            .chain(hub.server_node_ids.iter())
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        Err(ServiceError::not_found(format!(
            "no component with id \"{node_id}\" reachable from this session; it holds the device(s) it \
             connected and every server standing in the openDAQ Instance: {reachable}"
        )))
    }

    /// The same resolution, narrowed to the codes ONE operation declares.
    ///
    /// require_node_reachable_from_session answers invalid_value for a node_id
    /// that is absent or not a string, and not_connected for a session that
    /// holds no device. Four of the five operations added with contract
    /// capabilities device.mode, device.lock and module.read declare error
    /// subsets that carry one of those codes and not the other -- lock_device
    /// and unlock_device declare [not_found, read_only, unsupported], and
    /// set_device_operation_mode declares no not_connected -- and contract
    /// section 5 makes an operation's subset binding. So a failure whose code
    /// is outside the subset is restated as not_found, which is the true thing
    /// this host can say from inside the subset: the id names no node it can
    /// reach. The original wording is kept, so the detail still says exactly
    /// what was wrong with the request.
    fn resolve_node_within_declared_error_subset(
        &self,
        connection_id: u64,
        params: &Json,
        key: &str,
        declared_errors: &[ErrorCode],
    ) -> ServiceResult<String> {
        self.require_node_reachable_from_session(connection_id, params, key)
            .map_err(|e| {
                if declared_errors.contains(&e.code) {
                    return e;
                }
                ServiceError::not_found(format!(
                    "{} -- restated as not_found because contract/contract.yaml declares the error \
                     subset [{}] for this operation, which does not carry {}",
                    e.detail,
                    declared_errors
                        .iter()
                        .map(|code| code.to_wire())
                        .collect::<Vec<_>>()
                        .join(", "),
                    e.code.to_wire()
                ))
            })
    }

    // --- dispatch ----------------------------------------------------------

    fn dispatch(
        &self,
        connection: &Arc<Connection>,
        method: &str,
        params: &Json,
    ) -> ServiceResult<Json> {
        let connection_id = connection.id();
        match method {
            "scan_available_devices" => self.scan_available_devices(),
            "connect_device" => self.connect_device(connection_id, params),
            "disconnect_device" => self.disconnect_device(connection_id, params),
            "get_component_tree" => self.component_tree(connection_id, params),
            "get_property_descriptors" => self.property_descriptors(connection_id, params),
            "get_property_value" => self.property_value(connection_id, params),
            "set_property_value" => self.set_property_value(connection_id, params),
            "subscribe_signal" => self.subscribe_signal(connection, params),
            "unsubscribe_signal" => self.unsubscribe_signal(connection_id, params),
            "get_device_operation_modes" => self.device_operation_modes(connection_id, params),
            "set_device_operation_mode" => self.set_device_operation_mode(connection_id, params),
            "lock_device" => self.lock_device(connection_id, params),
            "unlock_device" => self.unlock_device(connection_id, params),
            "list_loaded_modules" => self.list_loaded_modules(),
            "load_module_from_host_path" => self.load_module_from_host_path(params),
            "get_component_attributes" => self.component_attributes(connection_id, params),
            "set_component_attribute" => self.set_component_attribute(connection_id, params),
            "list_server_types" => self.list_server_types(),
            "add_server" => self.add_server(connection_id, params),
            "remove_server" => self.remove_server(connection_id, params),
            "set_server_discovery_enabled" => {
                self.set_server_discovery_enabled(connection_id, params)
            }
            "start_recording" => self.start_recording(connection_id, params),
            "stop_recording" => self.stop_recording(connection_id, params),
            "begin_batched_property_update" => {
                self.begin_batched_property_update(connection_id, params)
            }
            "end_batched_property_update" => {
                self.end_batched_property_update(connection_id, params)
            }
            "save_instance_configuration_to_string" => {
                self.save_instance_configuration_to_string()
            }
            "load_instance_configuration_from_string" => {
                self.load_instance_configuration_from_string(params)
            }
            other => Err(self.explain_unserved_method(other)),
        }
    }

    /// A method the contract does declare but this host does not serve is a
    /// declared gap, and the handshake already said so; anything else is not a
    /// wire method at all. Both are unsupported, and the detail says which.
    fn explain_unserved_method(&self, method: &str) -> ServiceError {
        for (wire_method, capability) in CONTRACT_OPERATION_TABLE {
            if wire_method == method {
                return ServiceError::unsupported(format!(
                    "quackoscope-host-rust does not serve \"{method}\"; capability \"{capability}\" is a \
                     declared gap in this session's handshake, which lists the capabilities this host does serve"
                ));
            }
        }
        ServiceError::unsupported(format!(
            "\"{method}\" is not a wire method of the M1 contract; this host serves {}",
            SERVED_WIRE_METHODS.join(", ")
        ))
    }

    // --- the twenty-six served methods --------------------------------------

    fn scan_available_devices(&self) -> ServiceResult<Json> {
        // Discovery asks the modules what is out there; it needs no connected
        // device and touches no session state at all.
        let devices = self.backend.scan_available_devices()?;
        Ok(Json::Array(
            devices.iter().map(super::types::DeviceInfo::to_json).collect(),
        ))
    }

    fn connect_device(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        let connection_string = require_string(params, "connection_string")?;
        if connection_string.is_empty() {
            return Err(ServiceError::invalid_value(
                "params.connection_string is empty; it must name a device, e.g. \"daqref://device0\"",
            ));
        }

        // Idempotent within the session: the backend hands back the
        // already-added device for a connection string this process has seen,
        // and the holder count only moves the first time THIS session asks.
        let node = self.backend.connect_device(&connection_string)?;

        {
            let mut hub = self.lock_hub();
            let is_new = match hub.sessions.get_mut(&connection_id) {
                Some(state) => state
                    .device_node_ids_by_connection_string
                    .insert(connection_string.clone(), node.id.clone())
                    .is_none(),
                None => {
                    return Err(ServiceError::not_connected(
                        "this WebSocket session is already closed",
                    ))
                }
            };
            if is_new {
                *hub.sessions_holding_device
                    .entry(connection_string.clone())
                    .or_insert(0) += 1;
            }
        }

        Ok(node.to_json())
    }

    fn disconnect_device(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        let node_id = require_string(params, "node_id")?;

        let connection_string;
        let this_session_was_the_last_holder;
        let holders_left;
        {
            let mut hub = self.lock_hub();
            let state = hub.sessions.get_mut(&connection_id).ok_or_else(|| {
                ServiceError::not_connected("this WebSocket session is already closed")
            })?;

            let held = state
                .device_node_ids_by_connection_string
                .iter()
                .find(|(_, held_node_id)| **held_node_id == node_id)
                .map(|(held_connection_string, _)| held_connection_string.clone());

            let Some(held_connection_string) = held else {
                let holds_instead = state
                    .device_node_ids_by_connection_string
                    .values()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ");
                let holds_instead = if holds_instead.is_empty() {
                    "no device at all".to_string()
                } else {
                    holds_instead
                };
                return Err(ServiceError::not_found(format!(
                    "this session did not connect a device with id \"{node_id}\"; it holds {holds_instead}"
                )));
            };

            state
                .device_node_ids_by_connection_string
                .remove(&held_connection_string);
            connection_string = held_connection_string;

            match hub.sessions_holding_device.get_mut(&connection_string) {
                Some(holders) => {
                    *holders -= 1;
                    holders_left = *holders;
                    this_session_was_the_last_holder = holders_left <= 0;
                    if this_session_was_the_last_holder {
                        hub.sessions_holding_device.remove(&connection_string);
                    }
                }
                None => {
                    holders_left = 0;
                    this_session_was_the_last_holder = true;
                }
            }
        }

        if !this_session_was_the_last_holder {
            // The device stays in the openDAQ Instance for the sessions that
            // still hold it; it simply stops being addressable from this one.
            println!(
                "[service] disconnect_device {node_id} ({connection_string}): dropped from this session, kept \
                 in the openDAQ Instance because {holders_left} other session(s) still hold it"
            );
            return Ok(Json::Null);
        }

        self.backend.disconnect_device(&node_id)?;
        Ok(Json::Null)
    }

    fn component_tree(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        self.require_device_in_session(connection_id)?;

        let roots: Vec<String> = if params.get("root_id").and_then(Json::as_str).is_some() {
            vec![self.require_node_reachable_from_session(connection_id, params, "root_id")?]
        } else {
            // No root_id means "everything this session can address": the
            // devices it connected itself, plus every server standing in the
            // root instance.
            //
            // THE SERVERS ARE HERE BECAUSE openDAQ PUTS THEM THERE. add_server
            // returns a Node whose kind is `server`, and openDAQ's
            // IDevice::onAddServer (device_impl.h:1465-1476) files it under the
            // ROOT DEVICE's servers folder -- never under a connected device --
            // so a tree rooted at a connected device cannot contain it. Leaving
            // them out made this host answer add_server with a row that its own
            // get_component_tree then denied existed, while
            // IDevice::getServers() (device.h:294-298) reports it to anybody.
            let hub = self.lock_hub();
            let mut roots: Vec<String> = hub
                .sessions
                .get(&connection_id)
                .map(|state| {
                    state
                        .device_node_ids_by_connection_string
                        .values()
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            roots.extend(hub.server_node_ids.iter().cloned());
            roots
        };

        let mut out = Vec::new();
        for root in &roots {
            for node in self.backend.component_tree(Some(root))? {
                out.push(node.to_json());
            }
        }
        Ok(Json::Array(out))
    }

    fn property_descriptors(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        self.require_device_in_session(connection_id)?;
        let node_id = self.require_node_reachable_from_session(connection_id, params, "node_id")?;
        let descriptors = self.backend.property_descriptors(&node_id)?;
        Ok(Json::Array(
            descriptors
                .iter()
                .map(super::types::PropertyDescriptor::to_json)
                .collect(),
        ))
    }

    fn property_value(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        self.require_device_in_session(connection_id)?;
        let node_id = self.require_node_reachable_from_session(connection_id, params, "node_id")?;
        let property_id = require_string(params, "property_id")?;
        self.backend.property_value(&node_id, &property_id)
    }

    fn set_property_value(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        self.require_device_in_session(connection_id)?;
        let node_id = self.require_node_reachable_from_session(connection_id, params, "node_id")?;
        let property_id = require_string(params, "property_id")?;
        let Some(value) = params.get("value") else {
            return Err(ServiceError::invalid_value("params.value is required"));
        };
        self.backend
            .set_property_value(&node_id, &property_id, value)?;
        Ok(Json::Null)
    }

    fn subscribe_signal(&self, connection: &Arc<Connection>, params: &Json) -> ServiceResult<Json> {
        let connection_id = connection.id();
        self.require_device_in_session(connection_id)?;

        let signal_id =
            self.require_node_reachable_from_session(connection_id, params, "signal_id")?;
        // pixel_columns is capped by the max_frame_bytes this session's
        // handshake announced, so no frame this host emits can exceed it.
        let pixel_columns =
            require_int_in_range(params, "pixel_columns", 1, MAX_PIXEL_COLUMNS as i64)? as u32;

        let subscription_id = {
            let mut hub = self.lock_hub();
            let live = hub
                .sessions
                .get(&connection_id)
                .map(|state| state.subscriptions.len())
                .ok_or_else(|| {
                    ServiceError::not_connected("this WebSocket session is already closed")
                })?;
            if live as i64 >= MAX_SUBSCRIPTIONS_PER_SESSION {
                return Err(ServiceError::invalid_value(format!(
                    "this session already holds {live} subscriptions, which is the max_subscriptions this \
                     session's handshake announced ({MAX_SUBSCRIPTIONS_PER_SESSION}); unsubscribe_signal one \
                     before subscribing to \"{signal_id}\""
                )));
            }
            let id = hub.next_subscription_id;
            hub.next_subscription_id = hub.next_subscription_id.wrapping_add(1);
            id
        };

        let sink_connection = Arc::clone(connection);
        let sink: SampleSink = Arc::new(move |id: u32, domain_start: u64, values: &[f64]| {
            emit_frame(&sink_connection, id, pixel_columns, domain_start, values);
        });

        self.backend
            .subscribe_signal(&signal_id, subscription_id, sink)?;

        {
            let mut hub = self.lock_hub();
            if let Some(state) = hub.sessions.get_mut(&connection_id) {
                state.subscriptions.insert(
                    subscription_id,
                    Subscription {
                        signal_id: signal_id.clone(),
                        pixel_columns,
                    },
                );
            }
        }

        println!(
            "[service] subscribe_signal {signal_id} at {pixel_columns} pixel columns -> subscription_id \
             {subscription_id}"
        );

        // The subscription_id on the wire is the decimal text of the uint32
        // that rides in the binary frame header (contract, subscription_id_encoding).
        Ok(json!(subscription_id.to_string()))
    }

    fn unsubscribe_signal(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        let text = require_string(params, "subscription_id")?;

        let Some(subscription_id) = parse_whole_uint32(&text) else {
            return Err(ServiceError::invalid_value(format!(
                "params.subscription_id must be the decimal text of a uint32, whole and with nothing else in \
                 it; got \"{text}\""
            )));
        };

        let signal_id = {
            let mut hub = self.lock_hub();
            let state = hub.sessions.get_mut(&connection_id).ok_or_else(|| {
                ServiceError::not_connected("this WebSocket session is already closed")
            })?;
            match state.subscriptions.remove(&subscription_id) {
                Some(subscription) => subscription.signal_id,
                None => {
                    return Err(ServiceError::not_found(format!(
                        "no subscription \"{text}\" on this session"
                    )))
                }
            }
        };

        self.backend.unsubscribe_signal(subscription_id)?;
        println!("[service] unsubscribe_signal {subscription_id} on signal {signal_id}: reader released");
        Ok(Json::Null)
    }

    // --- device.mode -------------------------------------------------------

    fn device_operation_modes(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        // errors: [not_found, not_connected, unsupported].
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &[
                ErrorCode::NotFound,
                ErrorCode::NotConnected,
                ErrorCode::Unsupported,
            ],
        )?;

        let modes = self.backend.device_operation_modes(&node_id)?;
        println!(
            "[service] get_device_operation_modes {node_id}: {} mode(s) available: {}",
            modes.len(),
            if modes.is_empty() {
                "none".to_string()
            } else {
                modes.join(", ")
            }
        );
        Ok(Json::Array(modes.into_iter().map(Json::String).collect()))
    }

    fn set_device_operation_mode(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        // errors: [not_found, invalid_value, unsupported]. There is deliberately
        // no not_connected here, so the node resolution is narrowed to the three
        // codes the contract does declare.
        //
        // read_only WAS in this list and is gone, which is the correction of an
        // invented refusal. The contract row used to say "read_only: the device
        // is locked"; openDAQ's GenericDevice::setOperationMode
        // (device_impl.h:1257-1281) reads onGetAvailableOperationModes, takes
        // the tree lock guard and writes, and consults no user lock at all. The
        // lock refuses writes only in the config-protocol server
        // (config_server_access_control.h:75-81, protectLockedComponent), and
        // this host is in-process, so no lock refusal can reach this row.
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &[
                ErrorCode::NotFound,
                ErrorCode::InvalidValue,
                ErrorCode::Unsupported,
            ],
        )?;

        let mode = require_string(params, "mode")?;
        if !OPERATION_MODE_WIRE_NAMES.contains(&mode.as_str()) {
            return Err(ServiceError::invalid_value(format!(
                "params.mode is \"{mode}\"; contract/contract.yaml gives Node.operation_mode the values \
                 {}, and set_device_operation_mode's mode is one of them",
                OPERATION_MODE_WIRE_NAMES.join(", ")
            )));
        }

        self.backend.set_device_operation_mode(&node_id, &mode)?;
        println!("[service] set_device_operation_mode {node_id} = {mode}");
        Ok(Json::Null)
    }

    // --- device.lock -------------------------------------------------------

    fn lock_device(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        // errors: [not_found, read_only, unsupported].
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &[
                ErrorCode::NotFound,
                ErrorCode::ReadOnly,
                ErrorCode::Unsupported,
            ],
        )?;

        self.backend.lock_device(&node_id)?;
        println!("[service] lock_device {node_id}: the device is now locked");
        Ok(Json::Null)
    }

    fn unlock_device(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        // errors: [not_found, read_only, unsupported].
        let declared_errors = [
            ErrorCode::NotFound,
            ErrorCode::ReadOnly,
            ErrorCode::Unsupported,
        ];
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &declared_errors,
        )?;

        // contract: {name: force, type: bool, presence: optional}. Absent means
        // the plain IDevice.unlock(); true means the forced path. A `force` that
        // is neither absent nor a boolean cannot be answered invalid_value,
        // because unlock_device does not declare that code, so it is refused as
        // unsupported and the detail says exactly why.
        let force = match params.get("force") {
            None | Some(Json::Null) => false,
            Some(Json::Bool(value)) => *value,
            Some(other) => {
                return Err(ServiceError::unsupported(format!(
                    "params.force of unlock_device is declared {{type: bool, presence: optional}} in \
                     contract/contract.yaml; got {other}. This operation's declared error subset is \
                     [not_found, read_only, unsupported] and carries no invalid_value, so the malformed \
                     parameter is refused as unsupported rather than with a code the contract does not \
                     permit here"
                )))
            }
        };

        self.backend.unlock_device(&node_id, force)?;
        println!(
            "[service] unlock_device {node_id} (force {force}): the device is now unlocked"
        );
        Ok(Json::Null)
    }

    // --- module.read -------------------------------------------------------

    fn list_loaded_modules(&self) -> ServiceResult<Json> {
        // The modules are loaded into the openDAQ Instance when it is built
        // from the manifest's module_path, before any device is connected, so
        // this operation touches no session state and requires no device: the
        // Modules view is drawn before anything is connected. contract errors
        // are [not_connected, internal]; the path that can fail here is
        // reaching the module manager off the Instance, which is internal.
        let modules = self.backend.list_loaded_modules()?;
        let total_component_types: usize = modules
            .iter()
            .map(|module| module.component_types.len())
            .sum();
        println!(
            "[service] list_loaded_modules: {} module(s) loaded, offering {total_component_types} \
             component type(s) in total",
            modules.len()
        );
        Ok(Json::Array(
            modules
                .iter()
                .map(super::types::ModuleInfo::to_json)
                .collect(),
        ))
    }

    // --- module.load -------------------------------------------------------

    fn load_module_from_host_path(&self, params: &Json) -> ServiceResult<Json> {
        // params.host_path is {type: string, presence: required}. A missing or
        // non-string one is invalid_value, which this operation declares.
        let host_path = match params.get("host_path") {
            Some(Json::String(text)) => text.clone(),
            None | Some(Json::Null) => {
                return Err(ServiceError::invalid_value(
                    "params.host_path of load_module_from_host_path is declared \
                     {type: string, presence: required} in contract/contract.yaml and is absent. It is a \
                     path on the machine this host runs on, not on the caller's",
                ))
            }
            Some(other) => {
                return Err(ServiceError::invalid_value(format!(
                    "params.host_path of load_module_from_host_path is declared \
                     {{type: string, presence: required}} in contract/contract.yaml; got {other}"
                )))
            }
        };
        if host_path.trim().is_empty() {
            return Err(ServiceError::invalid_value(
                "params.host_path of load_module_from_host_path is empty; it must be the absolute path \
                 of an openDAQ module file on the machine this host runs on, e.g. \
                 C:\\openDAQ\\bin\\Release\\reference_device_module.module.dll",
            ));
        }

        // The module manager belongs to the process, not to a session: it is
        // built with the Instance and there is one of it. So this operation
        // takes no node id and touches no session state, exactly as
        // list_loaded_modules does -- and what it loads is visible to every
        // session, not only this one. openDAQ offers no unload, so a session
        // ending does not take the module with it; disconnect_device releases a
        // device, nothing releases a module.
        let module = self.backend.load_module_from_host_path(&host_path)?;

        // What goes stale when this succeeds, and what this host does about it.
        // Nothing here caches a module list, a device-type list or a
        // function-block-type list: list_loaded_modules re-reads
        // daqModuleManager_getModules on every call, and
        // scan_available_devices re-asks the Instance on every call, so both
        // answer the new module the very next time they are asked, in this
        // session and in every other. There is no invalidation to send either:
        // contract section 6's five events are component_added,
        // component_removed, property_changed, property_descriptor_changed and
        // device_disconnected, and none of them describes the module set
        // changing -- so a client that is showing the Modules view re-asks, and
        // is told here that it should.
        println!(
            "[service] load_module_from_host_path {host_path}: module {} (name {}, version {}) is loaded \
             into this process, offering {} component type(s). No module list is cached anywhere in this \
             host, so the next list_loaded_modules and the next scan_available_devices of every session \
             already include it; contract section 6 declares no event for a changed module set, so none \
             is pushed",
            module.id,
            module.name,
            module.version.as_deref().unwrap_or("none reported"),
            module.component_types.len()
        );
        Ok(module.to_json())
    }

    // --- attribute.read ------------------------------------------------------

    fn component_attributes(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        // errors: [not_found, not_connected, invalid_value]. invalid_value is
        // error_policy's malformed_parameter_becomes: a node_id arriving as 17
        // rather than as a string never reaches
        // IComponent::findComponent(IString*, IComponent**), so not_found would
        // assert a lookup that never happened.
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &[
                ErrorCode::NotFound,
                ErrorCode::NotConnected,
                ErrorCode::InvalidValue,
            ],
        )?;

        let attributes = self.backend.component_attributes(&node_id)?;
        println!(
            "[service] get_component_attributes {node_id}: {} attribute row(s): {}",
            attributes.len(),
            attributes
                .iter()
                .map(|attribute| format!(
                    "{}={} ({}{})",
                    attribute.id,
                    attribute.value,
                    attribute.value_type,
                    if attribute.read_only {
                        ", read-only"
                    } else {
                        ", writable"
                    }
                ))
                .collect::<Vec<_>>()
                .join("; ")
        );
        Ok(Json::Array(
            attributes
                .iter()
                .map(super::types::ComponentAttribute::to_json)
                .collect(),
        ))
    }

    // --- attribute.write -----------------------------------------------------

    fn set_component_attribute(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        // errors: [not_found, read_only, invalid_value]. invalid_value IS in
        // this subset, so a malformed node_id keeps its own code here.
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &[
                ErrorCode::NotFound,
                ErrorCode::ReadOnly,
                ErrorCode::InvalidValue,
            ],
        )?;
        let attribute_id = require_string(params, "attribute_id")?;
        let Some(value) = params.get("value") else {
            return Err(ServiceError::invalid_value(
                "params.value of set_component_attribute is declared {type: any, presence: required} in \
                 contract/contract.yaml and is absent",
            ));
        };

        self.backend
            .set_component_attribute(&node_id, &attribute_id, value)?;
        println!("[service] set_component_attribute {node_id}.{attribute_id} = {value}");
        Ok(Json::Null)
    }

    // --- server.add ----------------------------------------------------------

    fn list_server_types(&self) -> ServiceResult<Json> {
        // errors: [not_connected]. This row names no node and needs no
        // connected device: the server types are the INSTANCE's, and the
        // instance exists from process start, so the add-server grid draws
        // before anything is connected.
        let types = self.backend.list_server_types()?;
        println!(
            "[service] list_server_types: the instance accepts {} server type(s): {}",
            types.len(),
            if types.is_empty() {
                "none".to_string()
            } else {
                types
                    .iter()
                    .map(|entry| entry.id.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        );
        Ok(Json::Array(
            types
                .iter()
                .map(super::types::ComponentTypeInfo::to_json)
                .collect(),
        ))
    }

    fn add_server(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        // errors: [not_connected, unsupported, invalid_value, internal], and
        // invalid_value is among them, so a malformed type_id keeps its code.
        let type_id = require_string(params, "type_id")?;
        if type_id.is_empty() {
            return Err(ServiceError::invalid_value(
                "params.type_id of add_server is empty; it must be one of the ComponentTypeInfo.id \
                 values list_server_types answered with",
            ));
        }

        let node = self.backend.add_server(&type_id)?;

        // The server is under the ROOT INSTANCE, not under any device this
        // session connected, so it is recorded here or it would not be
        // addressable at all. The record is instance-wide, matching openDAQ:
        // the root device's servers folder is visible to every caller of
        // IDevice::getServers() and nothing there remembers who added what.
        let servers_now_standing: Vec<String> = {
            let mut hub = self.lock_hub();
            hub.server_node_ids.insert(node.id.clone());
            hub.server_node_ids.iter().cloned().collect()
        };

        println!(
            "[service] add_server {type_id} -> node {} (kind {}, name {}); connection {connection_id} \
             created it and every session on this host can address it. Servers standing in the openDAQ \
             Instance now: {}",
            node.id,
            node.kind,
            node.name,
            servers_now_standing.join(", ")
        );
        Ok(node.to_json())
    }

    /// remove_server, contract errors [not_found, unsupported, internal].
    ///
    /// The undo of add_server, and a real one: openDAQ's
    /// IDevice::removeServer(IServer*) drops the item from the servers folder,
    /// folder_impl.h:598-605 calls IComponent::removed on it, and
    /// ServerImpl::removed (server_impl.h:199-202) is `checkErrorInfo(stop());
    /// Super::removed();` -- the listening socket closes.
    fn remove_server(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        let declared_errors = [
            ErrorCode::NotFound,
            ErrorCode::Unsupported,
            ErrorCode::Internal,
        ];
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &declared_errors,
        )?;

        self.backend.remove_server(&node_id)?;

        let servers_still_standing: Vec<String> = {
            let mut hub = self.lock_hub();
            hub.server_node_ids.remove(&node_id);
            hub.server_node_ids.iter().cloned().collect()
        };

        println!(
            "[service] remove_server {node_id} from connection {connection_id}: daqDevice_removeServer \
             took it out of the root instance's servers folder and IServer::stop closed its listening \
             socket. Servers standing in the openDAQ Instance now: {}",
            if servers_still_standing.is_empty() {
                "none".to_string()
            } else {
                servers_still_standing.join(", ")
            }
        );
        Ok(Json::Null)
    }

    // --- server.discovery ----------------------------------------------------

    fn set_server_discovery_enabled(
        &self,
        connection_id: u64,
        params: &Json,
    ) -> ServiceResult<Json> {
        // errors: [not_found, unsupported, internal, invalid_value]. The
        // contract's own note on invalid_value here is error_policy's
        // malformed_parameter_becomes: `enabled` arriving as the string "yes"
        // selects neither IServer::enableDiscovery (server.h:66) nor
        // disableDiscovery (server.h:90), both of which take no parameter, so no
        // SDK call can be made to raise about it and neither not_found nor
        // unsupported would be honest -- nothing was looked up, and the server
        // is perfectly capable of the operation that was mis-typed.
        let declared_errors = [
            ErrorCode::NotFound,
            ErrorCode::Unsupported,
            ErrorCode::Internal,
            ErrorCode::InvalidValue,
        ];
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &declared_errors,
        )?;

        let enabled = match params.get("enabled") {
            Some(Json::Bool(value)) => *value,
            other => {
                return Err(ServiceError::invalid_value(format!(
                    "params.enabled of set_server_discovery_enabled is declared \
                     {{type: bool, presence: required}} in contract/contract.yaml; got {}. It is this \
                     contract's selector between IServer::enableDiscovery (server.h:66) and \
                     IServer::disableDiscovery (server.h:90), both of which take no parameter, so a \
                     non-boolean selects neither and no openDAQ call was made",
                    other.unwrap_or(&Json::Null)
                )))
            }
        };

        self.backend
            .set_server_discovery_enabled(&node_id, enabled)?;
        println!(
            "[service] set_server_discovery_enabled {node_id} = {enabled}. There is no getter for this \
             state anywhere in openDAQ, so nothing on Node reports it back and a client must draw two \
             named actions rather than a switch with a position"
        );
        Ok(Json::Null)
    }

    // --- recorder.control ----------------------------------------------------

    fn start_recording(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        // errors: [not_found, unsupported, internal, invalid_value].
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &[
                ErrorCode::NotFound,
                ErrorCode::Unsupported,
                ErrorCode::Internal,
                ErrorCode::InvalidValue,
            ],
        )?;
        self.backend.start_recording(&node_id)?;
        println!("[service] start_recording {node_id}");
        Ok(Json::Null)
    }

    fn stop_recording(&self, connection_id: u64, params: &Json) -> ServiceResult<Json> {
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &[
                ErrorCode::NotFound,
                ErrorCode::Unsupported,
                ErrorCode::Internal,
            ],
        )?;
        self.backend.stop_recording(&node_id)?;
        println!("[service] stop_recording {node_id}");
        Ok(Json::Null)
    }

    // --- property.batched_update ---------------------------------------------
    //
    // WHAT THIS HOST DELIBERATELY DOES NOT DO, because contract/contract.yaml
    // states it as an OPEN question and names it the same one already escalated
    // for device.lock: it does not end an abandoned batch when the session that
    // began it drops, and it does not refuse an end from a session that did not
    // begin. Either would be a policy this host invented and called the
    // contract. openDAQ's beginUpdate is recursive over child property objects,
    // so a batch is a property of the COMPONENT and outlives the socket; what
    // this host does instead is report Node.updating on every tree row, so the
    // next session SEES the open batch rather than writing properties that
    // silently never land.

    fn begin_batched_property_update(
        &self,
        connection_id: u64,
        params: &Json,
    ) -> ServiceResult<Json> {
        // errors: [not_found, not_connected, invalid_value].
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &[
                ErrorCode::NotFound,
                ErrorCode::NotConnected,
                ErrorCode::InvalidValue,
            ],
        )?;
        self.backend.begin_batched_property_update(&node_id)?;
        println!(
            "[service] begin_batched_property_update {node_id}: every set_property_value against this \
             component and its child property objects is now HELD until end_batched_property_update. \
             The batch belongs to the component, not to this socket: it survives this session closing, \
             and contract/contract.yaml leaves who may end it open"
        );
        Ok(Json::Null)
    }

    fn end_batched_property_update(
        &self,
        connection_id: u64,
        params: &Json,
    ) -> ServiceResult<Json> {
        // errors: [not_found, not_connected, invalid_value]. invalid_value is
        // this row's and not begin's: endUpdate raises when no beginUpdate is
        // open. The reference swallows exactly that with a bare
        // `except RuntimeError: pass`; this host must not, because silence would
        // tell a user their batch was applied.
        let node_id = self.resolve_node_within_declared_error_subset(
            connection_id,
            params,
            "node_id",
            &[
                ErrorCode::NotFound,
                ErrorCode::NotConnected,
                ErrorCode::InvalidValue,
            ],
        )?;
        self.backend.end_batched_property_update(&node_id)?;
        println!(
            "[service] end_batched_property_update {node_id}: everything set since the matching \
             begin has been applied at once"
        );
        Ok(Json::Null)
    }

    // --- configuration.save --------------------------------------------------

    fn save_instance_configuration_to_string(&self) -> ServiceResult<Json> {
        // errors: [not_connected, internal].
        let configuration = self.backend.save_instance_configuration_to_string()?;

        // The frame-limit check the contract assigns to the HOST on this row.
        // The result is measured as the encoded JSON envelope will carry it --
        // the string plus the quoting and escaping serde_json applies -- not as
        // raw character count, because it is the frame that has to fit.
        let encoded = Json::String(configuration.clone()).to_string();
        if encoded.len() as i64 > MAX_FRAME_BYTES {
            return Err(ServiceError::internal(format!(
                "save_instance_configuration_to_string produced a configuration of {} characters, which \
                 encodes to {} JSON bytes, and this session's handshake announced \
                 max_frame_bytes {MAX_FRAME_BYTES}. The result is not sent, because a frame over the \
                 limit this host itself declared may never arrive as a parseable envelope. Both byte \
                 counts are stated here rather than a bare failure, so this is distinguishable from a \
                 broken instance; a deployment that expects configurations this large declares a larger \
                 max_frame_bytes, which is what that handshake field is for",
                configuration.len(),
                encoded.len()
            )));
        }

        println!(
            "[service] save_instance_configuration_to_string: {} characters, {} JSON bytes encoded, \
             within the announced max_frame_bytes {MAX_FRAME_BYTES}",
            configuration.len(),
            encoded.len()
        );
        Ok(Json::String(configuration))
    }

    // --- configuration.load --------------------------------------------------

    fn load_instance_configuration_from_string(&self, params: &Json) -> ServiceResult<Json> {
        // errors: [not_connected, invalid_value, internal]. The matching
        // frame-limit check on THIS direction belongs to the client, not here:
        // an oversize request frame may never arrive as a parseable envelope, in
        // which case this host has no id to answer with at all. A request that
        // did arrive is by definition within the limit.
        let configuration = match params.get("configuration") {
            Some(Json::String(text)) => text.clone(),
            other => {
                return Err(ServiceError::invalid_value(format!(
                    "params.configuration of load_instance_configuration_from_string is declared \
                     {{type: string, presence: required}} in contract/contract.yaml; got {}. It is the \
                     text of a configuration a save_instance_configuration_to_string produced, on this \
                     host or another -- not a path on either machine",
                    other.unwrap_or(&Json::Null)
                )))
            }
        };
        if configuration.trim().is_empty() {
            return Err(ServiceError::invalid_value(
                "params.configuration of load_instance_configuration_from_string is empty; openDAQ has \
                 no configuration to apply from an empty string",
            ));
        }

        self.backend
            .load_instance_configuration_from_string(&configuration)?;
        println!(
            "[service] load_instance_configuration_from_string: {} characters applied to the whole \
             openDAQ Instance with openDAQ's default UpdateParameters. This is NOT session-scoped -- it \
             replaces the configuration of every device under the instance, including devices other \
             live sessions connected -- and contract/contract.yaml carries no UpdateParameters on this \
             row, so nothing narrower could have been asked for",
            configuration.len()
        );
        Ok(Json::Null)
    }
}

impl ConnectionHandler for SessionHub {
    fn on_open(&self, connection: &Arc<Connection>) {
        let live = {
            let mut hub = self.lock_hub();
            hub.sessions.insert(connection.id(), SessionState::default());
            hub.sessions.len()
        };

        // Contract section 7: the handshake is message ordinal 1 on every
        // session. It is sent here, before the first read is answered, so
        // nothing -- no result, no binary frame -- can get ahead of it.
        connection.send_text(&self.handshake_text);

        println!(
            "[service] session opened on connection {} from {} ({live} live); sent the handshake first, {} \
             bytes: {}",
            connection.id(),
            connection.peer(),
            self.handshake_text.len(),
            self.handshake_text
        );
    }

    fn on_close(&self, connection: &Arc<Connection>) {
        let connection_id = connection.id();

        let state;
        let mut devices_to_release: Vec<(String, String)> = Vec::new();
        let live_sessions;
        {
            let mut hub = self.lock_hub();
            let Some(closing) = hub.sessions.remove(&connection_id) else {
                return;
            };
            live_sessions = hub.sessions.len();

            for (connection_string, node_id) in &closing.device_node_ids_by_connection_string {
                if let Some(holders) = hub.sessions_holding_device.get_mut(connection_string) {
                    *holders -= 1;
                    if *holders <= 0 {
                        hub.sessions_holding_device.remove(connection_string);
                        devices_to_release.push((connection_string.clone(), node_id.clone()));
                    }
                }
            }
            state = closing;
        }

        // Dropped socket = session invalidated: every subscription it held
        // goes away.
        for (subscription_id, subscription) in &state.subscriptions {
            println!(
                "[service] session teardown: dropping subscription {subscription_id} on signal {} ({} pixel columns)",
                subscription.signal_id, subscription.pixel_columns
            );
            if let Err(e) = self.backend.unsubscribe_signal(*subscription_id) {
                eprintln!(
                    "[service] teardown of subscription {subscription_id} on signal {} failed: {e}",
                    subscription.signal_id
                );
            }
        }

        // ...and so does every device no other live session is still holding,
        // so the next session opens against an instance without it.
        for (connection_string, node_id) in &devices_to_release {
            match self.backend.disconnect_device(node_id) {
                Ok(()) => println!(
                    "[service] released device {node_id} ({connection_string}); no live session holds it any more"
                ),
                Err(e) => eprintln!(
                    "[service] releasing device {node_id} ({connection_string}) failed: {e}"
                ),
            }
        }

        println!(
            "[service] session on connection {connection_id} closed: {} subscription(s) and {} device(s) \
             dropped, {} of those removed from the instance, {live_sessions} session(s) still live",
            state.subscriptions.len(),
            state.device_node_ids_by_connection_string.len(),
            devices_to_release.len()
        );

        // What teardown does NOT undo, said plainly rather than left to be
        // discovered. A server stays in the openDAQ Instance with its listening
        // socket open when the session that added it goes away. That is not a
        // missing row any more -- remove_server exists and any session may send
        // it -- it is this host declining to invent a lifecycle openDAQ does not
        // have: nothing in openDAQ ties an IServer to the connection that called
        // addServer, so nothing here removes one on a disconnect. And a batch
        // this session opened with begin_batched_property_update stays open on
        // the component, because who may end an abandoned batch is the open
        // question the contract escalates alongside device.lock, and ending it
        // here would be this host answering it.
        let servers_still_standing: Vec<String> = {
            let hub = self.lock_hub();
            hub.server_node_ids.iter().cloned().collect()
        };
        if !servers_still_standing.is_empty() {
            println!(
                "[service] session teardown on connection {connection_id}: {} server(s) stay in the \
                 openDAQ Instance and keep listening -- {}. Any session may take one down with \
                 remove_server; this teardown removes none, because openDAQ records no owner for a \
                 server and this host will not invent one",
                servers_still_standing.len(),
                servers_still_standing.join(", ")
            );
        }
    }

    fn on_request(&self, connection: &Arc<Connection>, method: &str, params: &Json) -> Outcome {
        match self.dispatch(connection, method, params) {
            Ok(result) => Outcome::Result(result),
            Err(e) => {
                if e.code != ErrorCode::NotFound {
                    eprintln!(
                        "[service] {method} on connection {} answered {}: {}",
                        connection.id(),
                        e.code.to_wire(),
                        e.detail
                    );
                }
                Outcome::Failure {
                    code: e.code.to_wire().to_string(),
                    detail: e.detail,
                }
            }
        }
    }
}

// --- data plane ------------------------------------------------------------

fn emit_frame(
    connection: &Arc<Connection>,
    subscription_id: u32,
    pixel_columns: u32,
    domain_start: u64,
    values: &[f64],
) {
    if !connection.is_open() {
        return;
    }
    let chunk = decimate(values, pixel_columns);
    if chunk.sample_count == 0 {
        return;
    }
    connection.send_binary(&encode_data_frame(
        subscription_id,
        domain_start,
        chunk.sample_count,
        chunk.encoding,
        &chunk.payload,
    ));
}

// --- params ----------------------------------------------------------------

fn require_string(params: &Json, key: &str) -> ServiceResult<String> {
    match params.get(key) {
        Some(Json::String(value)) => Ok(value.clone()),
        Some(other) => Err(ServiceError::invalid_value(format!(
            "params.{key} must be a string; got {other}"
        ))),
        None => Err(ServiceError::invalid_value(format!(
            "params.{key} must be a string; it was absent"
        ))),
    }
}

fn require_int_in_range(params: &Json, key: &str, low: i64, high: i64) -> ServiceResult<i64> {
    let Some(value) = params.get(key).and_then(Json::as_i64) else {
        return Err(ServiceError::invalid_value(format!(
            "params.{key} must be an integer; got {}",
            params.get(key).unwrap_or(&Json::Null)
        )));
    };
    if value < low || value > high {
        return Err(ServiceError::invalid_value(format!(
            "params.{key} must be in [{low}, {high}]; got {value}"
        )));
    }
    Ok(value)
}

/// A subscription id has to be the whole string and nothing else: "12abc" is
/// not 12 and "-1" is not 4294967295.
fn parse_whole_uint32(text: &str) -> Option<u32> {
    if text.is_empty() || text.len() > 10 {
        return None;
    }
    let mut value: u64 = 0;
    for c in text.chars() {
        let digit = c.to_digit(10)?;
        value = value * 10 + digit as u64;
    }
    u32::try_from(value).ok()
}

fn print_gap(gap: &Gap) {
    println!(
        "[service]   gap        {} (kind {}): {}",
        gap.capability,
        gap.kind.to_wire(),
        gap.reason
    );
}

#[cfg(test)]
mod dispatch_table_agrees_with_the_contract {
    use super::{parse_whole_uint32, CONTRACT_OPERATION_TABLE, SERVED_WIRE_METHODS};

    #[test]
    fn every_served_wire_method_is_a_wire_method_of_the_contract() {
        for method in SERVED_WIRE_METHODS {
            assert!(
                CONTRACT_OPERATION_TABLE
                    .iter()
                    .any(|(wire_method, _)| *wire_method == method),
                "{method} is served but is not in the contract operation table"
            );
        }
    }

    #[test]
    fn a_subscription_id_must_be_the_whole_decimal_text_of_a_uint32() {
        assert_eq!(parse_whole_uint32("7"), Some(7));
        assert_eq!(parse_whole_uint32("4294967295"), Some(4_294_967_295));
        assert_eq!(parse_whole_uint32("4294967296"), None);
        assert_eq!(parse_whole_uint32("12abc"), None);
        assert_eq!(parse_whole_uint32("-1"), None);
        assert_eq!(parse_whole_uint32(""), None);
    }
}
