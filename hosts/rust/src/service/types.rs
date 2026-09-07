// Quackoscope host (Rust) -- service layer.
//
// The wire DTOs of contract section 3 and their JSON marshalling. Snake_case
// on the wire, always. These types are the vocabulary the openDAQ layer speaks
// back in; nothing here knows about the SDK or about sockets.
//
// Presence follows contract section 3 exactly: a type record emits EVERY key,
// writing null where a value is absent, so `Option::None` becomes `null` and
// never a missing key.

use serde_json::{json, Value as Json};

/// What scan_available_devices answers with: a discovery sighting, not a device
/// that has been added to the Instance. `connection_string` is the string
/// connect_device takes back.
#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub connection_string: String,
    pub name: String,
    pub serial: Option<String>,
}

impl DeviceInfo {
    pub fn to_json(&self) -> Json {
        json!({
            "connection_string": self.connection_string,
            "name": self.name,
            "serial": self.serial,
        })
    }
}

#[derive(Debug, Clone)]
pub struct Node {
    pub id: String,
    pub name: String,
    /// "device" | "channel" | "function_block" | "signal" | "folder"
    pub kind: String,
    pub parent_id: Option<String>,
    pub child_ids: Vec<String>,
    pub property_ids: Vec<String>,

    // --- component state, contract section 3 types.Node ---------------------
    //
    // All six are nullable and null means "this host does not report it": the
    // client then draws no label and no colour. That is the reference's own
    // behaviour typed rather than a fudge -- gui_demo.py
    // _build_component_state_labels wraps every read in try/except and appends
    // no label when it raises -- so a field this host cannot determine is
    // written null instead of guessed.
    /// IComponent.active.
    pub active: Option<bool>,
    /// The EFFECTIVE lock state with inheritance already applied: a device
    /// reports its own IDevice.isLocked(), every other component reports the
    /// nearest ancestor device's.
    pub locked: Option<bool>,
    /// "ok" | "warning" | "error", from the status container's ComponentStatus.
    pub component_status: Option<String>,
    pub component_status_message: Option<String>,
    /// Device rows only: "connected" | "reconnecting" | "unrecoverable" |
    /// "removed", from the status container's ConnectionStatus.
    pub connection_status: Option<String>,
    /// Device rows only: "unknown" | "idle" | "operation" | "safe_operation".
    pub operation_mode: Option<String>,
    /// IPropertyObject::getUpdating(Bool*): true while a
    /// begin_batched_property_update is open on this component and no
    /// end_batched_property_update has closed it, during which every
    /// set_property_value against it is HELD rather than applied. null on a
    /// component that carries no IPropertyObject facet at all.
    pub updating: Option<bool>,
    /// IRecorder::getIsRecording(Bool*). Recorder rows only; null everywhere
    /// else, which is both "not a recorder" and "not reported" -- the same
    /// conflation connection_status and operation_mode already make. The client
    /// draws no Start/Stop control for null, which is why this rides on the tree
    /// read instead of costing a round trip per row whose answer would be
    /// `unsupported` on almost every node.
    pub recording: Option<bool>,
}

impl Node {
    pub fn to_json(&self) -> Json {
        json!({
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "parent_id": self.parent_id,
            "child_ids": self.child_ids,
            "property_ids": self.property_ids,
            "active": self.active,
            "locked": self.locked,
            "component_status": self.component_status,
            "component_status_message": self.component_status_message,
            "connection_status": self.connection_status,
            "operation_mode": self.operation_mode,
            "updating": self.updating,
            "recording": self.recording,
        })
    }
}

/// One row of the attributes panel, contract section 3 types.ComponentAttribute.
///
/// An attribute is NOT a property: it is a fixed member of an openDAQ interface
/// -- IComponent.name, ISignal.public, IInputPort.requires_signal -- reached by
/// its own getter and setter, never through get/setPropertyValue. Which rows
/// exist depends on which interfaces the component carries, so the set is not
/// fixed and a cast this host cannot perform simply yields fewer rows.
#[derive(Debug, Clone)]
pub struct ComponentAttribute {
    pub id: String,
    /// The label the reference prints: "Global ID", "Domain Signal ID". Carried
    /// rather than derived, because it is not a mechanical transform of the id.
    pub name: String,
    pub value: Json,
    /// "bool" | "int" | "float" | "string" | "string_list"
    pub value_type: String,
    /// openDAQ's answer about the COMPONENT: either IComponent.locked_attributes
    /// names it, or the openDAQ interface declares no setter for it at all.
    /// NEVER this host's answer about itself -- a host with no writer declares
    /// no attribute.write capability and the client disables the editors from
    /// the gap.
    pub read_only: bool,
}

impl ComponentAttribute {
    pub fn to_json(&self) -> Json {
        json!({
            "id": self.id,
            "name": self.name,
            "value": self.value,
            "value_type": self.value_type,
            "read_only": self.read_only,
        })
    }
}

/// One component type a loaded module offers, contract section 3
/// types.ComponentTypeInfo. `connection_string_prefix` exists only on
/// IDeviceType and IStreamingType, which is why it is nullable.
#[derive(Debug, Clone)]
pub struct ComponentTypeInfo {
    pub id: String,
    pub name: String,
    /// "device" | "function_block" | "server" | "streaming"
    pub kind: String,
    pub description: Option<String>,
    pub connection_string_prefix: Option<String>,
}

impl ComponentTypeInfo {
    pub fn to_json(&self) -> Json {
        json!({
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "description": self.description,
            "connection_string_prefix": self.connection_string_prefix,
        })
    }
}

/// One loaded module, contract section 3 types.ModuleInfo. `version` is the
/// major.minor.patch string the module's version info renders, and is null
/// where a module carries no version info.
#[derive(Debug, Clone)]
pub struct ModuleInfo {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub component_types: Vec<ComponentTypeInfo>,
}

impl ModuleInfo {
    pub fn to_json(&self) -> Json {
        json!({
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "component_types": Json::Array(
                self.component_types
                    .iter()
                    .map(ComponentTypeInfo::to_json)
                    .collect()
            ),
        })
    }
}

#[derive(Debug, Clone)]
pub struct PropertyDescriptor {
    pub id: String,
    pub name: String,
    /// "bool" | "int" | "float" | "string" | "selection" | "struct"
    pub value_type: String,
    pub unit: Option<String>,
    pub description: Option<String>,
    pub read_only: bool,
    pub visible: bool,
    /// The wire key is "default", which is a keyword in Rust, C++ and C#;
    /// contract section 3 flags it with wire_key_is_language_keyword_in.
    pub default_value: Json,
    pub selection_values: Option<Vec<String>>,
    pub suggested_values: Option<Vec<Json>>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// EvalValue source text, display only; never evaluated client side.
    pub validator: Option<String>,
    /// EvalValue source text, display only; never evaluated client side.
    pub coercer: Option<String>,
}

impl PropertyDescriptor {
    pub fn to_json(&self) -> Json {
        json!({
            "id": self.id,
            "name": self.name,
            "value_type": self.value_type,
            "unit": self.unit,
            "description": self.description,
            "read_only": self.read_only,
            "visible": self.visible,
            "default": self.default_value,
            "selection_values": self.selection_values,
            "suggested_values": self.suggested_values,
            "min": self.min,
            "max": self.max,
            "validator": self.validator,
            "coercer": self.coercer,
        })
    }
}
