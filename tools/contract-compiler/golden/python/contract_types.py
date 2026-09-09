"""GENERATED FILE. Do not edit by hand.

Produced by tools/contract-compiler from contract/contract.yaml, which is the
single source of truth for the Quackoscope wire contract. Regenerate with:

    python tools/contract-compiler/compile_contract_to_generated_targets.py
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

PROTOCOL_VERSION = "1.0"


class WireErrorCode(str, Enum):
    """The closed error code set of contract 1.2. A native exception
    maps into one of these; the native message rides along in
    WireError.detail, which is display and logs only."""

    not_found = "not_found"
    not_connected = "not_connected"
    invalid_value = "invalid_value"
    read_only = "read_only"
    unsupported = "unsupported"
    timeout = "timeout"
    internal = "internal"


@dataclass(frozen=True, slots=True)
class WireError:
    code: WireErrorCode
    detail: str


class WireCallFailed(Exception):
    """Raised by a handler method to produce an error envelope. Any
    other exception escaping a handler becomes
    WireErrorCode.internal."""

    def __init__(self, code: WireErrorCode, detail: str) -> None:
        super().__init__(f"{code.value}: {detail}")
        self.error = WireError(code=code, detail=detail)


class NodeKind(str, Enum):
    """contract 1.3 types.Node.kind"""

    device = "device"
    channel = "channel"
    function_block = "function_block"
    signal = "signal"
    folder = "folder"
    server = "server"


class NodeComponentStatus(str, Enum):
    """contract 1.3 types.Node.component_status"""

    ok = "ok"
    warning = "warning"
    error = "error"


class NodeConnectionStatus(str, Enum):
    """contract 1.3 types.Node.connection_status"""

    connected = "connected"
    reconnecting = "reconnecting"
    unrecoverable = "unrecoverable"
    removed = "removed"


class NodeOperationMode(str, Enum):
    """contract 1.3 types.Node.operation_mode"""

    unknown = "unknown"
    idle = "idle"
    operation = "operation"
    safe_operation = "safe_operation"


class PropertyDescriptorValueType(str, Enum):
    """contract 1.3 types.PropertyDescriptor.value_type"""

    bool = "bool"
    int = "int"
    float = "float"
    string = "string"
    selection = "selection"
    struct = "struct"


class ComponentAttributeValueType(str, Enum):
    """contract 1.3 types.ComponentAttribute.value_type"""

    bool = "bool"
    int = "int"
    float = "float"
    string = "string"
    string_list = "string_list"


class SignalDescriptorSampleType(str, Enum):
    """contract 1.3 types.SignalDescriptor.sample_type"""

    float32 = "float32"
    float64 = "float64"
    int32 = "int32"
    int64 = "int64"


class GapKind(str, Enum):
    """contract 1.3 types.Gap.kind"""

    binding = "binding"
    host = "host"


class ComponentTypeInfoKind(str, Enum):
    """contract 1.3 types.ComponentTypeInfo.kind"""

    device = "device"
    function_block = "function_block"
    server = "server"
    streaming = "streaming"


@dataclass(frozen=True, slots=True)
class DeviceInfo:
    """contract 1.3 types.DeviceInfo"""

    connection_string: str
    name: str
    serial: str | None

    WIRE_KEYS = {
        "connection_string": "connection_string",
        "name": "name",
        "serial": "serial",
    }

    @classmethod
    def from_wire(cls, payload: dict[str, Any]) -> "DeviceInfo":
        return cls(
            connection_string=payload["connection_string"],
            name=payload["name"],
            serial=payload["serial"],
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "connection_string": self.connection_string,
            "name": self.name,
            "serial": self.serial,
        }


@dataclass(frozen=True, slots=True)
class Node:
    """contract 1.3 types.Node"""

    id_: str
    name: str
    kind: NodeKind
    parent_id: str | None
    child_ids: list[str]
    property_ids: list[str]
    active: bool | None
    locked: bool | None
    component_status: NodeComponentStatus | None
    component_status_message: str | None
    connection_status: NodeConnectionStatus | None
    operation_mode: NodeOperationMode | None
    updating: bool | None
    recording: bool | None

    WIRE_KEYS = {
        "id_": "id",
        "name": "name",
        "kind": "kind",
        "parent_id": "parent_id",
        "child_ids": "child_ids",
        "property_ids": "property_ids",
        "active": "active",
        "locked": "locked",
        "component_status": "component_status",
        "component_status_message": "component_status_message",
        "connection_status": "connection_status",
        "operation_mode": "operation_mode",
        "updating": "updating",
        "recording": "recording",
    }

    @classmethod
    def from_wire(cls, payload: dict[str, Any]) -> "Node":
        return cls(
            id_=payload["id"],
            name=payload["name"],
            kind=NodeKind(payload["kind"]),
            parent_id=payload["parent_id"],
            child_ids=payload["child_ids"],
            property_ids=payload["property_ids"],
            active=payload["active"],
            locked=payload["locked"],
            component_status=None if payload["component_status"] is None else NodeComponentStatus(payload["component_status"]),
            component_status_message=payload["component_status_message"],
            connection_status=None if payload["connection_status"] is None else NodeConnectionStatus(payload["connection_status"]),
            operation_mode=None if payload["operation_mode"] is None else NodeOperationMode(payload["operation_mode"]),
            updating=payload["updating"],
            recording=payload["recording"],
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id_,
            "name": self.name,
            "kind": self.kind.value,
            "parent_id": self.parent_id,
            "child_ids": self.child_ids,
            "property_ids": self.property_ids,
            "active": self.active,
            "locked": self.locked,
            "component_status": None if self.component_status is None else self.component_status.value,
            "component_status_message": self.component_status_message,
            "connection_status": None if self.connection_status is None else self.connection_status.value,
            "operation_mode": None if self.operation_mode is None else self.operation_mode.value,
            "updating": self.updating,
            "recording": self.recording,
        }


@dataclass(frozen=True, slots=True)
class PropertyDescriptor:
    """contract 1.3 types.PropertyDescriptor"""

    id_: str
    name: str
    value_type: PropertyDescriptorValueType
    unit: str | None
    description: str | None
    read_only: bool
    visible: bool
    default: Any | None
    selection_values: list[str] | None
    suggested_values: list[Any] | None
    min: float | None
    max: float | None
    validator: str | None
    coercer: str | None

    WIRE_KEYS = {
        "id_": "id",
        "name": "name",
        "value_type": "value_type",
        "unit": "unit",
        "description": "description",
        "read_only": "read_only",
        "visible": "visible",
        "default": "default",
        "selection_values": "selection_values",
        "suggested_values": "suggested_values",
        "min": "min",
        "max": "max",
        "validator": "validator",
        "coercer": "coercer",
    }

    @classmethod
    def from_wire(cls, payload: dict[str, Any]) -> "PropertyDescriptor":
        return cls(
            id_=payload["id"],
            name=payload["name"],
            value_type=PropertyDescriptorValueType(payload["value_type"]),
            unit=payload["unit"],
            description=payload["description"],
            read_only=payload["read_only"],
            visible=payload["visible"],
            default=payload["default"],
            selection_values=payload["selection_values"],
            suggested_values=payload["suggested_values"],
            min=payload["min"],
            max=payload["max"],
            validator=payload["validator"],
            coercer=payload["coercer"],
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id_,
            "name": self.name,
            "value_type": self.value_type.value,
            "unit": self.unit,
            "description": self.description,
            "read_only": self.read_only,
            "visible": self.visible,
            "default": self.default,
            "selection_values": self.selection_values,
            "suggested_values": self.suggested_values,
            "min": self.min,
            "max": self.max,
            "validator": self.validator,
            "coercer": self.coercer,
        }


@dataclass(frozen=True, slots=True)
class ComponentAttribute:
    """contract 1.3 types.ComponentAttribute"""

    id_: str
    name: str
    value: Any | None
    value_type: ComponentAttributeValueType
    read_only: bool

    WIRE_KEYS = {
        "id_": "id",
        "name": "name",
        "value": "value",
        "value_type": "value_type",
        "read_only": "read_only",
    }

    @classmethod
    def from_wire(cls, payload: dict[str, Any]) -> "ComponentAttribute":
        return cls(
            id_=payload["id"],
            name=payload["name"],
            value=payload["value"],
            value_type=ComponentAttributeValueType(payload["value_type"]),
            read_only=payload["read_only"],
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id_,
            "name": self.name,
            "value": self.value,
            "value_type": self.value_type.value,
            "read_only": self.read_only,
        }


@dataclass(frozen=True, slots=True)
class SignalDescriptor:
    """contract 1.3 types.SignalDescriptor"""

    id_: str
    name: str
    sample_type: SignalDescriptorSampleType
    unit: str | None
    domain_id: str | None

    WIRE_KEYS = {
        "id_": "id",
        "name": "name",
        "sample_type": "sample_type",
        "unit": "unit",
        "domain_id": "domain_id",
    }

    @classmethod
    def from_wire(cls, payload: dict[str, Any]) -> "SignalDescriptor":
        return cls(
            id_=payload["id"],
            name=payload["name"],
            sample_type=SignalDescriptorSampleType(payload["sample_type"]),
            unit=payload["unit"],
            domain_id=payload["domain_id"],
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id_,
            "name": self.name,
            "sample_type": self.sample_type.value,
            "unit": self.unit,
            "domain_id": self.domain_id,
        }


@dataclass(frozen=True, slots=True)
class Gap:
    """contract 1.3 types.Gap"""

    capability: str
    kind: GapKind
    reason: str

    WIRE_KEYS = {
        "capability": "capability",
        "kind": "kind",
        "reason": "reason",
    }

    @classmethod
    def from_wire(cls, payload: dict[str, Any]) -> "Gap":
        return cls(
            capability=payload["capability"],
            kind=GapKind(payload["kind"]),
            reason=payload["reason"],
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "capability": self.capability,
            "kind": self.kind.value,
            "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class ComponentTypeInfo:
    """contract 1.3 types.ComponentTypeInfo"""

    id_: str
    name: str
    kind: ComponentTypeInfoKind
    description: str | None
    connection_string_prefix: str | None

    WIRE_KEYS = {
        "id_": "id",
        "name": "name",
        "kind": "kind",
        "description": "description",
        "connection_string_prefix": "connection_string_prefix",
    }

    @classmethod
    def from_wire(cls, payload: dict[str, Any]) -> "ComponentTypeInfo":
        return cls(
            id_=payload["id"],
            name=payload["name"],
            kind=ComponentTypeInfoKind(payload["kind"]),
            description=payload["description"],
            connection_string_prefix=payload["connection_string_prefix"],
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id_,
            "name": self.name,
            "kind": self.kind.value,
            "description": self.description,
            "connection_string_prefix": self.connection_string_prefix,
        }


@dataclass(frozen=True, slots=True)
class ModuleInfo:
    """contract 1.3 types.ModuleInfo"""

    id_: str
    name: str
    version: str | None
    component_types: list[ComponentTypeInfo]

    WIRE_KEYS = {
        "id_": "id",
        "name": "name",
        "version": "version",
        "component_types": "component_types",
    }

    @classmethod
    def from_wire(cls, payload: dict[str, Any]) -> "ModuleInfo":
        return cls(
            id_=payload["id"],
            name=payload["name"],
            version=payload["version"],
            component_types=[ComponentTypeInfo.from_wire(item) for item in payload["component_types"]],
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id_,
            "name": self.name,
            "version": self.version,
            "component_types": [item.to_wire() for item in self.component_types],
        }


#: Baseline capability ids of contract 4. A host declares the subset it
#: implements; the gap list is this baseline minus that subset.
BASELINE_CAPABILITY_IDS: tuple[str, ...] = (
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
)

#: The closed operation table of contract 1.4. A public host method
#: whose wire name is absent from this tuple violates
#: lints.no_undeclared_public_method.
WIRE_METHOD_NAMES: tuple[str, ...] = (
    "scan_available_devices",
    "connect_device",
    "disconnect_device",
    "get_component_tree",
    "get_property_value",
    "get_property_descriptors",
    "set_property_value",
    "list_function_block_types",
    "add_function_block",
    "remove_function_block",
    "subscribe_signal",
    "unsubscribe_signal",
    "read_samples_raw",
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
)

#: Server-push events of contract 1.5. Events carry no id field.
WIRE_EVENT_NAMES: tuple[str, ...] = (
    "component_added",
    "component_removed",
    "property_changed",
    "property_descriptor_changed",
    "device_disconnected",
)


class BinaryFrameEncoding(int, Enum):
    """contract 1.9 binary_frame.encodings, little_endian."""

    raw = 0
    min_max_envelope = 1


BINARY_FRAME_HEADER_BYTES = 17
BINARY_FRAME_PAYLOAD_OFFSET = 17


@dataclass(frozen=True, slots=True)
class BinaryFrameHeader:
    """17 bytes, little_endian. The payload
    offset is 17, which is not 8-byte aligned, so a
    reader must copy the payload out rather than view it in place."""

    subscription_id: int  # offset 0, 4 bytes, uint32
    domain_start: int  # offset 4, 8 bytes, uint64
    sample_count: int  # offset 12, 4 bytes, uint32
    encoding: BinaryFrameEncoding  # offset 16, 1 bytes, uint8


@dataclass(frozen=True, slots=True)
class BinarySampleFrame:
    header: BinaryFrameHeader
    values: list[float]


@dataclass(frozen=True, slots=True)
class WireHandshake:
    """contract 1.6, the first message the server sends."""

    protocol_version: str
    #: DISPLAY ONLY. No behavioural branch may read this.
    implementation_name: str
    implementation_version: str
    sdk_version: str
    sdk_commit: str
    capabilities: list[str]
    gaps: list[Gap]
    max_subscriptions: int = 64
    max_frame_bytes: int = 262144

    def to_wire(self) -> dict[str, Any]:
        return {
            "protocol_version": self.protocol_version,
            "implementation": {
                "name": self.implementation_name,
                "version": self.implementation_version,
            },
            "sdk": {
                "version": self.sdk_version,
                "commit": self.sdk_commit,
            },
            "capabilities": list(self.capabilities),
            "gaps": [gap.to_wire() for gap in self.gaps],
            "limits": {
                "max_subscriptions": self.max_subscriptions,
                "max_frame_bytes": self.max_frame_bytes,
            },
        }

