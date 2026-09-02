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

Json toJson(const Node& node)
{
    return Json{{"id", node.id},
                {"name", node.name},
                {"kind", node.kind},
                {"parent_id", orNull(node.parent_id)},
                {"child_ids", node.child_ids},
                {"property_ids", node.property_ids}};
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
