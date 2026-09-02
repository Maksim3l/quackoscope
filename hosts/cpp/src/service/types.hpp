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

struct Node
{
    std::string id;
    std::string name;
    std::string kind;  // "device" | "channel" | "function_block" | "signal" | "folder"
    std::optional<std::string> parent_id;
    std::vector<std::string> child_ids;
    std::vector<std::string> property_ids;
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

Json toJson(const Node& node);
Json toJson(const PropertyDescriptor& descriptor);

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
