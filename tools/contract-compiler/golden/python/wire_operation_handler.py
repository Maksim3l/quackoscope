"""GENERATED FILE. Do not edit by hand.

Produced by tools/contract-compiler from contract/contract.yaml, which is the
single source of truth for the Quackoscope wire contract. Regenerate with:

    python tools/contract-compiler/compile_contract_to_generated_targets.py
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from contract_types import (
    ComponentAttribute,
    ComponentTypeInfo,
    DeviceInfo,
    Gap,
    ModuleInfo,
    Node,
    PropertyDescriptor,
    SignalDescriptor,
    BinarySampleFrame,
)


@runtime_checkable
class WireOperationHandler(Protocol):
    """The handler protocol. A Python host satisfies every method of
    this protocol; a missing method is what
    lints.host_covers_every_operation costs, and a public method whose
    wire name is absent from WIRE_METHOD_NAMES is what
    lints.no_undeclared_public_method costs.

    Methods are synchronous: casing.async_style_applies_to scopes the
    async convention to generated CLIENT call symbols, and this is the
    server side of the same operations."""

    def scan_available_devices(self) -> list[DeviceInfo]:
        """wire method "scan_available_devices", capability device.scan, kind action.

        Declared errors: internal. Signal one by
        raising WireCallFailed.
        """
        ...

    def connect_device(self, connection_string: str) -> Node:
        """wire method "connect_device", capability device.connect, kind action.

        Declared errors: not_found, invalid_value, timeout. Signal one by
        raising WireCallFailed.
        """
        ...

    def disconnect_device(self, node_id: str) -> None:
        """wire method "disconnect_device", capability device.connect, kind action.

        Declared errors: not_found. Signal one by
        raising WireCallFailed.
        """
        ...

    def get_component_tree(self, root_id: str | None = None) -> list[Node]:
        """wire method "get_component_tree", capability tree.read, kind getter.

        Declared errors: not_connected, not_found. Signal one by
        raising WireCallFailed.
        """
        ...

    def get_property_value(self, node_id: str, property_id: str) -> Any:
        """wire method "get_property_value", capability property.read, kind getter.

        Declared errors: not_found, not_connected. Signal one by
        raising WireCallFailed.
        """
        ...

    def get_property_descriptors(self, node_id: str) -> list[PropertyDescriptor]:
        """wire method "get_property_descriptors", capability property.read, kind getter.

        Declared errors: not_found, not_connected. Signal one by
        raising WireCallFailed.
        """
        ...

    def set_property_value(self, node_id: str, property_id: str, value: Any) -> None:
        """wire method "set_property_value", capability property.write, kind setter.

        Declared errors: not_found, read_only, invalid_value. Signal one by
        raising WireCallFailed.
        """
        ...

    def list_function_block_types(self) -> list[str]:
        """wire method "list_function_block_types", capability function_block.add, kind getter.

        Declared errors: not_connected. Signal one by
        raising WireCallFailed.
        """
        ...

    def add_function_block(self, parent_id: str, type_id: str) -> Node:
        """wire method "add_function_block", capability function_block.add, kind action.

        Declared errors: not_found, unsupported. Signal one by
        raising WireCallFailed.
        """
        ...

    def remove_function_block(self, node_id: str) -> None:
        """wire method "remove_function_block", capability function_block.add, kind action.

        Declared errors: not_found. Signal one by
        raising WireCallFailed.
        """
        ...

    def subscribe_signal(self, signal_id: str, pixel_columns: int) -> str:
        """wire method "subscribe_signal", capability streaming.decimated, kind action.

        Declared errors: not_found, not_connected. Signal one by
        raising WireCallFailed.
        """
        ...

    def unsubscribe_signal(self, subscription_id: str) -> None:
        """wire method "unsubscribe_signal", capability streaming.decimated, kind action.

        Declared errors: not_found, invalid_value. Signal one by
        raising WireCallFailed.
        """
        ...

    def read_samples_raw(self, signal_id: str, count: int) -> BinarySampleFrame:
        """wire method "read_samples_raw", capability streaming.raw, kind action.

        Declared errors: not_found, not_connected. Signal one by
        raising WireCallFailed.

        UNSPECIFIED IN contract.yaml: this operation returns a
        binary frame, but envelopes.result carries a JSON result
        and binary_frame.header has no correlation id, so a
        binary response cannot be matched to its request id. See
        the contract-compiler report.
        """
        ...

    def get_device_operation_modes(self, node_id: str) -> list[str]:
        """wire method "get_device_operation_modes", capability device.mode, kind getter.

        Declared errors: not_found, not_connected, unsupported. Signal one by
        raising WireCallFailed.
        """
        ...

    def set_device_operation_mode(self, node_id: str, mode: str) -> None:
        """wire method "set_device_operation_mode", capability device.mode, kind setter.

        Declared errors: not_found, invalid_value, read_only, unsupported. Signal one by
        raising WireCallFailed.
        """
        ...

    def lock_device(self, node_id: str) -> None:
        """wire method "lock_device", capability device.lock, kind action.

        Declared errors: not_found, read_only, unsupported. Signal one by
        raising WireCallFailed.
        """
        ...

    def unlock_device(self, node_id: str, force: bool | None = None) -> None:
        """wire method "unlock_device", capability device.lock, kind action.

        Declared errors: not_found, read_only, unsupported. Signal one by
        raising WireCallFailed.
        """
        ...

    def list_loaded_modules(self) -> list[ModuleInfo]:
        """wire method "list_loaded_modules", capability module.read, kind getter.

        Declared errors: not_connected, internal. Signal one by
        raising WireCallFailed.
        """
        ...

    def load_module_from_host_path(self, host_path: str) -> ModuleInfo:
        """wire method "load_module_from_host_path", capability module.load, kind action.

        Declared errors: not_found, not_connected, invalid_value, internal. Signal one by
        raising WireCallFailed.
        """
        ...

    def get_component_attributes(self, node_id: str) -> list[ComponentAttribute]:
        """wire method "get_component_attributes", capability attribute.read, kind getter.

        Declared errors: not_found, not_connected. Signal one by
        raising WireCallFailed.
        """
        ...

    def set_component_attribute(self, node_id: str, attribute_id: str, value: Any) -> None:
        """wire method "set_component_attribute", capability attribute.write, kind setter.

        Declared errors: not_found, read_only, invalid_value. Signal one by
        raising WireCallFailed.
        """
        ...

    def list_server_types(self) -> list[ComponentTypeInfo]:
        """wire method "list_server_types", capability server.add, kind getter.

        Declared errors: not_connected. Signal one by
        raising WireCallFailed.
        """
        ...

    def add_server(self, type_id: str) -> Node:
        """wire method "add_server", capability server.add, kind action.

        Declared errors: not_connected, unsupported, invalid_value, internal. Signal one by
        raising WireCallFailed.
        """
        ...

    def set_server_discovery_enabled(self, node_id: str, enabled: bool) -> None:
        """wire method "set_server_discovery_enabled", capability server.discovery, kind setter.

        Declared errors: not_found, unsupported, internal. Signal one by
        raising WireCallFailed.
        """
        ...

    def start_recording(self, node_id: str) -> None:
        """wire method "start_recording", capability recorder.control, kind action.

        Declared errors: not_found, unsupported, internal. Signal one by
        raising WireCallFailed.
        """
        ...

    def stop_recording(self, node_id: str) -> None:
        """wire method "stop_recording", capability recorder.control, kind action.

        Declared errors: not_found, unsupported, internal. Signal one by
        raising WireCallFailed.
        """
        ...

    def begin_batched_property_update(self, node_id: str) -> None:
        """wire method "begin_batched_property_update", capability property.batched_update, kind action.

        Declared errors: not_found, not_connected. Signal one by
        raising WireCallFailed.
        """
        ...

    def end_batched_property_update(self, node_id: str) -> None:
        """wire method "end_batched_property_update", capability property.batched_update, kind action.

        Declared errors: not_found, not_connected, invalid_value. Signal one by
        raising WireCallFailed.
        """
        ...

    def save_instance_configuration_to_string(self) -> str:
        """wire method "save_instance_configuration_to_string", capability configuration.save, kind getter.

        Declared errors: not_connected, internal. Signal one by
        raising WireCallFailed.
        """
        ...

    def load_instance_configuration_from_string(self, configuration: str) -> None:
        """wire method "load_instance_configuration_from_string", capability configuration.load, kind action.

        Declared errors: not_connected, invalid_value, internal. Signal one by
        raising WireCallFailed.
        """
        ...


@runtime_checkable
class WireEventSink(Protocol):
    """Server push. A host calls these to emit the events of
    contract 1.5. Events carry no id field."""

    def component_added(self, node: Node) -> None:
        """wire event "component_added\""""
        ...

    def component_removed(self, node_id: str) -> None:
        """wire event "component_removed\""""
        ...

    def property_changed(self, node_id: str, property_id: str, value: Any) -> None:
        """wire event "property_changed\""""
        ...

    def property_descriptor_changed(self, node_id: str, descriptor: PropertyDescriptor) -> None:
        """wire event "property_descriptor_changed\""""
        ...

    def device_disconnected(self, node_id: str, reason: str) -> None:
        """wire event "device_disconnected\""""
        ...

