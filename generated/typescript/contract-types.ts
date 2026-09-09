// GENERATED FILE. Do not edit by hand.
//
// Produced by tools/contract-compiler from contract/contract.yaml, which is
// the single source of truth for the Quackoscope wire contract. Regenerate
// with:
//
//   python tools/contract-compiler/compile_contract_to_generated_targets.py
//

// Wire types. Every field name is the snake_case wire key verbatim, so a
// parsed JSON envelope is assignable to these shapes with no renaming.

/** The closed error code set of contract 1.2. A host emitting
 *  anything else is defective. Frontend logic branches on this and
 *  never on WireError.detail. */
export type WireErrorCode =
  | "not_found"
  | "not_connected"
  | "invalid_value"
  | "read_only"
  | "unsupported"
  | "timeout"
  | "internal";

export const WIRE_ERROR_CODES: readonly WireErrorCode[] = [
  "not_found",
  "not_connected",
  "invalid_value",
  "read_only",
  "unsupported",
  "timeout",
  "internal",
];

export interface WireError {
  code: WireErrorCode;
  /** Native exception text. Display and logs only; never parsed. */
  detail: string;
}

// Inline enums of contract 1.3, one exported union per enum field.

export type NodeKind =
  | "device"
  | "channel"
  | "function_block"
  | "signal"
  | "folder"
  | "server";

export type NodeComponentStatus =
  | "ok"
  | "warning"
  | "error";

export type NodeConnectionStatus =
  | "connected"
  | "reconnecting"
  | "unrecoverable"
  | "removed";

export type NodeOperationMode =
  | "unknown"
  | "idle"
  | "operation"
  | "safe_operation";

export type PropertyDescriptorValueType =
  | "bool"
  | "int"
  | "float"
  | "string"
  | "selection"
  | "struct";

export type ComponentAttributeValueType =
  | "bool"
  | "int"
  | "float"
  | "string"
  | "string_list";

export type SignalDescriptorSampleType =
  | "float32"
  | "float64"
  | "int32"
  | "int64";

export type GapKind =
  | "binding"
  | "host";

export type ComponentTypeInfoKind =
  | "device"
  | "function_block"
  | "server"
  | "streaming";

export interface DeviceInfo {
  connection_string: string;
  name: string;
  serial: string | null;
}

export interface Node {
  id: string;
  name: string;
  kind: NodeKind;
  parent_id: string | null;
  child_ids: string[];
  property_ids: string[];
  active: boolean | null;
  locked: boolean | null;
  component_status: NodeComponentStatus | null;
  component_status_message: string | null;
  connection_status: NodeConnectionStatus | null;
  operation_mode: NodeOperationMode | null;
  updating: boolean | null;
  recording: boolean | null;
}

export interface PropertyDescriptor {
  id: string;
  name: string;
  value_type: PropertyDescriptorValueType;
  unit: string | null;
  description: string | null;
  read_only: boolean;
  visible: boolean;
  default: unknown | null;
  selection_values: string[] | null;
  suggested_values: unknown[] | null;
  min: number | null;
  max: number | null;
  /** openDAQ EvalValue source string. Display only; never
   *  interpreted client-side. */
  validator: string | null;
  /** openDAQ EvalValue source string. Display only; never
   *  interpreted client-side. */
  coercer: string | null;
}

export interface ComponentAttribute {
  id: string;
  name: string;
  value: unknown | null;
  value_type: ComponentAttributeValueType;
  read_only: boolean;
}

export interface SignalDescriptor {
  id: string;
  name: string;
  sample_type: SignalDescriptorSampleType;
  unit: string | null;
  domain_id: string | null;
}

export interface Gap {
  capability: string;
  kind: GapKind;
  reason: string;
}

export interface ComponentTypeInfo {
  id: string;
  name: string;
  kind: ComponentTypeInfoKind;
  description: string | null;
  connection_string_prefix: string | null;
}

export interface ModuleInfo {
  id: string;
  name: string;
  version: string | null;
  component_types: ComponentTypeInfo[];
}

/** Baseline capability ids of contract 4. A host declares the subset
 *  it implements; the gap list is this baseline minus that subset. */
export type CapabilityId =
  | "device.scan"
  | "device.connect"
  | "tree.read"
  | "property.read"
  | "property.write"
  | "function_block.add"
  | "streaming.decimated"
  | "streaming.raw"
  | "device.mode"
  | "device.lock"
  | "module.read"
  | "module.load"
  | "attribute.read"
  | "attribute.write"
  | "server.add"
  | "server.discovery"
  | "recorder.control"
  | "property.batched_update"
  | "configuration.save"
  | "configuration.load";

export const BASELINE_CAPABILITY_IDS: readonly CapabilityId[] = [
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
];

/** The closed operation table of contract 1.4. A method name outside
 *  this union must not exist on any host. */
export type WireMethodName =
  | "scan_available_devices"
  | "connect_device"
  | "disconnect_device"
  | "get_component_tree"
  | "get_property_value"
  | "get_property_descriptors"
  | "set_property_value"
  | "list_function_block_types"
  | "add_function_block"
  | "remove_function_block"
  | "subscribe_signal"
  | "unsubscribe_signal"
  | "read_samples_raw"
  | "get_device_operation_modes"
  | "set_device_operation_mode"
  | "lock_device"
  | "unlock_device"
  | "list_loaded_modules"
  | "load_module_from_host_path"
  | "get_component_attributes"
  | "set_component_attribute"
  | "list_server_types"
  | "add_server"
  | "remove_server"
  | "set_server_discovery_enabled"
  | "start_recording"
  | "stop_recording"
  | "begin_batched_property_update"
  | "end_batched_property_update"
  | "save_instance_configuration_to_string"
  | "load_instance_configuration_from_string";

export const WIRE_METHOD_NAMES: readonly WireMethodName[] = [
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
];

/** Server-push events of contract 1.5. Events carry no id field and
 *  are never correlated to a request. */
export interface WireEventPayloads {
  component_added: {
    node: Node;
  };
  component_removed: {
    node_id: string;
  };
  property_changed: {
    node_id: string;
    property_id: string;
    value: unknown;
  };
  property_descriptor_changed: {
    node_id: string;
    descriptor: PropertyDescriptor;
  };
  device_disconnected: {
    node_id: string;
    reason: string;
  };
}

export type WireEventName = keyof WireEventPayloads;

export const WIRE_EVENT_NAMES: readonly WireEventName[] = [
  "component_added",
  "component_removed",
  "property_changed",
  "property_descriptor_changed",
  "device_disconnected",
];

// Wire envelopes of contract 1.7.

export interface WireRequestEnvelope {
  id: number;
  method: WireMethodName;
  params: Record<string, unknown>;
}

export interface WireResultEnvelope {
  id: number;
  result: unknown;
}

export interface WireErrorEnvelope {
  id: number;
  error: WireError;
}

export interface WireEventEnvelope<K extends WireEventName = WireEventName> {
  event: K;
  payload: WireEventPayloads[K];
}

export type WireServerMessage =
  | WireResultEnvelope
  | WireErrorEnvelope
  | WireEventEnvelope;

/** The first message the server sends, before any request is answered. */
export interface WireHandshake {
  protocol_version: "1.0";
  implementation: {
    /** DISPLAY ONLY. No behavioural branch may read this. */
    name: string;
    version: string;
  };
  sdk: {
    version: string;
    commit: string;
  };
  capabilities: CapabilityId[];
  gaps: Gap[];
  limits: {
    max_subscriptions: number;
    max_frame_bytes: number;
  };
}

export const HANDSHAKE_LIMIT_DEFAULTS = {
  max_subscriptions: 64,
  max_frame_bytes: 262144,
} as const;

export const PROTOCOL_VERSION = "1.0";

// Binary sample frames of contract 1.9. Little-endian, 17-byte header.

export type BinaryFrameEncodingName =
  | "raw"
  | "min_max_envelope";

export const BINARY_FRAME_ENCODINGS: Readonly<
  Record<number, BinaryFrameEncodingName>
> = {
  0: "raw",
  1: "min_max_envelope",
};

export const BINARY_FRAME_HEADER_BYTES = 17;

export interface BinarySampleFrame {
  /** offset 0, 4 bytes, uint32 */
  subscription_id: number;
  /** offset 4, 8 bytes, uint64 */
  domain_start: bigint;
  /** offset 12, 4 bytes, uint32 */
  sample_count: number;
  /** offset 16, 1 bytes, uint8 */
  encoding: number;
  encoding_name: BinaryFrameEncodingName;
  /** float64 payload, copied out of the received buffer because the
   *  17-byte payload offset is not 8-byte aligned. */
  values: Float64Array;
}

