// Quackoscope host (C++) -- service layer.
//
// The wire DTOs of the M1 contract and their JSON marshalling. Snake_case on
// the wire, always. These types are the vocabulary the openDAQ layer speaks
// back in; nothing here knows about the SDK or about sockets.
#pragma once

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

namespace qs::service
{

using Json = nlohmann::json;

// What scan_available_devices answers with: a device discovery saw, which is
// not a device that has been added to the Instance. connection_string is the
// string connect_device takes.
struct DeviceInfo
{
    std::string connection_string;
    std::string name;
    std::optional<std::string> serial;
};

// Every field from `active` down is nullable on the wire and null means "this
// host did not determine it", never "false" and never "ok". The six keys are
// ALWAYS present in the JSON object; only their values go null.
struct Node
{
    std::string id;
    std::string name;
    std::string kind;  // "device" | "channel" | "function_block" | "signal" | "folder"
    std::optional<std::string> parent_id;
    std::vector<std::string> child_ids;
    std::vector<std::string> property_ids;

    std::optional<bool> active;   // IComponent.getActive()
    std::optional<bool> locked;   // EFFECTIVE: the nearest IDevice ancestor's isLocked(), self included
    std::optional<std::string> component_status;          // "ok" | "warning" | "error"
    std::optional<std::string> component_status_message;
    std::optional<std::string> connection_status;  // device rows only: connected|reconnecting|unrecoverable|removed
    std::optional<std::string> operation_mode;     // device rows only: unknown|idle|operation|safe_operation

    // IPropertyObject::getUpdating(): true between a beginUpdate and its
    // endUpdate, during which every set_property_value against the component is
    // HELD rather than applied. Every openDAQ component is an IPropertyObject,
    // so this host fills it on every row.
    std::optional<bool> updating;
    // IRecorder::getIsRecording(). Recorder function-block rows only; null on
    // every other kind, because the cast to IRecorder is what decides whether a
    // node is a recorder at all and null is this host saying "not a recorder".
    std::optional<bool> recording;
};

// One row of the ATTRIBUTES panel over a single component: a fixed member of
// the openDAQ interface itself (IComponent.name, ISignal.public,
// IInputPort.requires_signal, ...), which is a different thing from a property
// in the component's property bag.
//
// read_only is openDAQ's answer about the COMPONENT -- the reference's own
// hardcoded Locked flag for the ids that cannot be written at all, plus
// IComponent::getLockedAttributes() folded in -- and never this host's answer
// about itself. This host implements the writer, so it never reports read_only
// in place of a missing writer.
struct ComponentAttribute
{
    std::string id;
    std::string name;       // the reference's own label: "Global ID", "Domain Signal ID"
    Json value = nullptr;
    std::string value_type;  // "bool" | "int" | "float" | "string" | "string_list"
    bool read_only = false;
};

// One component type a loaded module offers: a row of one of the four type
// dictionaries an openDAQ module publishes.
struct ComponentTypeInfo
{
    std::string id;
    std::string name;
    std::string kind;  // "device" | "function_block" | "server" | "streaming"
    std::optional<std::string> description;
    std::optional<std::string> connection_string_prefix;  // IDeviceType and IStreamingType only
};

// One loaded module, as IModuleInfo reports it, with everything it can
// instantiate carried inside so the Modules view is one request and not 1 + 4N.
struct ModuleInfo
{
    std::string id;
    std::string name;
    std::optional<std::string> version;  // major.minor.patch, null when the module carries no version info
    std::vector<ComponentTypeInfo> component_types;
};

struct PropertyDescriptor
{
    std::string id;
    std::string name;
    std::string value_type;  // "bool" | "int" | "float" | "string" | "selection" | "struct"
    std::optional<std::string> unit;
    std::optional<std::string> description;
    bool read_only = false;
    bool visible = true;
    Json default_value = nullptr;
    std::optional<std::vector<std::string>> selection_values;
    std::optional<std::vector<Json>> suggested_values;
    std::optional<double> min;
    std::optional<double> max;
    std::optional<std::string> validator;  // EvalValue source, display only
    std::optional<std::string> coercer;    // EvalValue source, display only
};

Json toJson(const DeviceInfo& info);
Json toJson(const Node& node);
Json toJson(const ComponentAttribute& attribute);
Json toJson(const PropertyDescriptor& descriptor);
Json toJson(const ComponentTypeInfo& type);
Json toJson(const ModuleInfo& module);

// Server-pushed events. The openDAQ layer fills these in; the session
// marshals them into {"event": ..., "payload": ...} envelopes.
enum class EventKind
{
    ComponentAdded,
    ComponentRemoved,
    PropertyChanged,
    PropertyDescriptorChanged,
    DeviceDisconnected
};

struct Event
{
    EventKind kind = EventKind::PropertyChanged;
    std::optional<Node> node;                      // ComponentAdded
    std::string node_id;                           // all but ComponentAdded
    std::string property_id;                       // PropertyChanged
    Json value = nullptr;                          // PropertyChanged
    std::optional<PropertyDescriptor> descriptor;  // PropertyDescriptorChanged
    std::string reason;                            // DeviceDisconnected
};

// {"event": name, "payload": {...}}
Json toEnvelope(const Event& event);

}  // namespace qs::service
