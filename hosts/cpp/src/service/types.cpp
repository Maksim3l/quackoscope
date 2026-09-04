#include "service/types.hpp"

namespace qs::service
{
namespace
{

template <typename T>
Json orNull(const std::optional<T>& v)
{
    return v.has_value() ? Json(*v) : Json(nullptr);
}

}  // namespace

Json toJson(const DeviceInfo& info)
{
    return Json{{"connection_string", info.connection_string},
                {"name", info.name},
                {"serial", orNull(info.serial)}};
}

Json toJson(const Node& node)
{
    // The eight state keys are always written. A key that is absent would say
    // "this host has never heard of component state"; null says "this host did
    // not determine this one fact about this one component", which is what the
    // contract asks a nullable field to mean. updating and recording joined the
    // six when the contract grew property.batched_update and recorder.control:
    // both are per-row facts the reference reads per row, so both travel with
    // the row rather than costing a call.
    return Json{{"id", node.id},
                {"name", node.name},
                {"kind", node.kind},
                {"parent_id", orNull(node.parent_id)},
                {"child_ids", node.child_ids},
                {"property_ids", node.property_ids},
                {"active", orNull(node.active)},
                {"locked", orNull(node.locked)},
                {"component_status", orNull(node.component_status)},
                {"component_status_message", orNull(node.component_status_message)},
                {"connection_status", orNull(node.connection_status)},
                {"operation_mode", orNull(node.operation_mode)},
                {"updating", orNull(node.updating)},
                {"recording", orNull(node.recording)}};
}

Json toJson(const ComponentAttribute& attribute)
{
    return Json{{"id", attribute.id},
                {"name", attribute.name},
                {"value", attribute.value},
                {"value_type", attribute.value_type},
                {"read_only", attribute.read_only}};
}

Json toJson(const ComponentTypeInfo& t)
{
    return Json{{"id", t.id},
                {"name", t.name},
                {"kind", t.kind},
                {"description", orNull(t.description)},
                {"connection_string_prefix", orNull(t.connection_string_prefix)}};
}

Json toJson(const ModuleInfo& m)
{
    Json types = Json::array();
    for (const auto& t : m.component_types)
        types.push_back(toJson(t));

    return Json{{"id", m.id}, {"name", m.name}, {"version", orNull(m.version)}, {"component_types", types}};
}

Json toJson(const PropertyDescriptor& d)
{
    return Json{{"id", d.id},
                {"name", d.name},
                {"value_type", d.value_type},
                {"unit", orNull(d.unit)},
                {"description", orNull(d.description)},
                {"read_only", d.read_only},
                {"visible", d.visible},
                {"default", d.default_value},
                {"selection_values", orNull(d.selection_values)},
                {"suggested_values", orNull(d.suggested_values)},
                {"min", orNull(d.min)},
                {"max", orNull(d.max)},
                {"validator", orNull(d.validator)},
                {"coercer", orNull(d.coercer)}};
}

Json toEnvelope(const Event& e)
{
    switch (e.kind)
    {
        case EventKind::ComponentAdded:
            return Json{{"event", "component_added"},
                        {"payload", {{"node", e.node ? toJson(*e.node) : Json(nullptr)}}}};
        case EventKind::ComponentRemoved:
            return Json{{"event", "component_removed"}, {"payload", {{"node_id", e.node_id}}}};
        case EventKind::PropertyChanged:
            return Json{{"event", "property_changed"},
                        {"payload",
                         {{"node_id", e.node_id}, {"property_id", e.property_id}, {"value", e.value}}}};
        case EventKind::PropertyDescriptorChanged:
            return Json{{"event", "property_descriptor_changed"},
                        {"payload",
                         {{"node_id", e.node_id},
                          {"descriptor", e.descriptor ? toJson(*e.descriptor) : Json(nullptr)}}}};
        case EventKind::DeviceDisconnected:
            return Json{{"event", "device_disconnected"},
                        {"payload", {{"node_id", e.node_id}, {"reason", e.reason}}}};
    }
    return Json{{"event", "internal"}, {"payload", Json::object()}};
}

}  // namespace qs::service
