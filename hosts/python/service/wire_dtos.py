"""Quackoscope host (Python) -- service layer.

The wire DTOs of the M1 contract and their JSON marshalling. Snake_case on the
wire, always. These types are the vocabulary the openDAQ layer speaks back in;
nothing here knows about the SDK or about sockets.
"""


class Node:
    """Every state field is None until the openDAQ layer fills it, and None goes
    to the wire as null, which contract/contract.yaml section 3 reads as "this
    host does not report it" -- not as "false" and not as "unknown". A host that
    cannot determine one of them writes null rather than guessing."""

    def __init__(self):
        self.id = ""
        self.name = ""
        self.kind = ""          # "device" | "channel" | "function_block" | "signal" | "folder"
        self.parent_id = None
        self.child_ids = []
        self.property_ids = []
        self.active = None                    # IComponent.active
        self.locked = None                    # EFFECTIVE lock: nearest ancestor device's
        self.component_status = None          # "ok" | "warning" | "error"
        self.component_status_message = None
        self.connection_status = None         # device rows only; "connected" | "reconnecting"
                                              # | "unrecoverable" | "removed"
        self.operation_mode = None            # device rows only; "unknown" | "idle"
                                              # | "operation" | "safe_operation"


class ComponentTypeInfo:
    """One component type a module offers, as IComponentType reports it.
    connection_string_prefix exists only on IDeviceType and IStreamingType."""

    def __init__(self):
        self.id = ""
        self.name = ""
        self.kind = ""          # "device" | "function_block" | "server" | "streaming"
        self.description = None
        self.connection_string_prefix = None


class ModuleInfo:
    """One loaded module, as IModuleInfo reports it, with the component types it
    offers carried inside so a module view needs one call and not 1 + 4N."""

    def __init__(self):
        self.id = ""
        self.name = ""
        self.version = None     # "major.minor.patch", or None where the module carries no
                                # version info
        self.component_types = []


class PropertyDescriptor:
    def __init__(self):
        self.id = ""
        self.name = ""
        self.value_type = ""    # "bool" | "int" | "float" | "string" | "selection" | "struct"
        self.unit = None
        self.description = None
        self.read_only = False
        self.visible = True
        self.default_value = None
        self.selection_values = None
        self.suggested_values = None
        self.min = None
        self.max = None
        self.validator = None   # EvalValue source, display only
        self.coercer = None     # EvalValue source, display only


def node_to_json(node):
    return {
        "id": node.id,
        "name": node.name,
        "kind": node.kind,
        "parent_id": node.parent_id,
        "child_ids": list(node.child_ids),
        "property_ids": list(node.property_ids),
        "active": node.active,
        "locked": node.locked,
        "component_status": node.component_status,
        "component_status_message": node.component_status_message,
        "connection_status": node.connection_status,
        "operation_mode": node.operation_mode,
    }


def component_type_info_to_json(component_type):
    return {
        "id": component_type.id,
        "name": component_type.name,
        "kind": component_type.kind,
        "description": component_type.description,
        "connection_string_prefix": component_type.connection_string_prefix,
    }


def module_info_to_json(module):
    return {
        "id": module.id,
        "name": module.name,
        "version": module.version,
        "component_types": [
            component_type_info_to_json(component_type) for component_type in module.component_types
        ],
    }


def property_descriptor_to_json(d):
    return {
        "id": d.id,
        "name": d.name,
        "value_type": d.value_type,
        "unit": d.unit,
        "description": d.description,
        "read_only": d.read_only,
        "visible": d.visible,
        "default": d.default_value,
        "selection_values": d.selection_values,
        "suggested_values": d.suggested_values,
        "min": d.min,
        "max": d.max,
        "validator": d.validator,
        "coercer": d.coercer,
    }


# Server-pushed events. {"event": name, "payload": {...}}, never an id.
def component_added_envelope(node):
    return {"event": "component_added", "payload": {"node": node_to_json(node) if node else None}}


def component_removed_envelope(node_id):
    return {"event": "component_removed", "payload": {"node_id": node_id}}


def property_changed_envelope(node_id, property_id, value):
    return {
        "event": "property_changed",
        "payload": {"node_id": node_id, "property_id": property_id, "value": value},
    }


def property_descriptor_changed_envelope(node_id, descriptor):
    return {
        "event": "property_descriptor_changed",
        "payload": {
            "node_id": node_id,
            "descriptor": property_descriptor_to_json(descriptor) if descriptor else None,
        },
    }


def device_disconnected_envelope(node_id, reason):
    return {"event": "device_disconnected", "payload": {"node_id": node_id, "reason": reason}}
