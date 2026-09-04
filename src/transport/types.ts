// M1 wire contract types. Hand-written on purpose: the contract-driven generator
// is M3 work and must not be pulled forward.
//
// Everything here mirrors the JSON that crosses the single WebSocket at
// ws://127.0.0.1:7788/ws exactly, snake_case included. The frontend never learns
// which host implementation is on the other end.

export type NodeKind =
  | "device"
  | "channel"
  | "function_block"
  | "signal"
  | "folder";

/** IComponent's ComponentStatus, lowercased into the wire join. */
export type NodeComponentStatus = "ok" | "warning" | "error";

/** IDevice's ConnectionStatus. Device rows only; null on every other kind. */
export type NodeConnectionStatus =
  | "connected"
  | "reconnecting"
  | "unrecoverable"
  | "removed";

/** IDevice's OperationModeType. Device rows only; null on every other kind. */
export type NodeOperationMode =
  | "unknown"
  | "idle"
  | "operation"
  | "safe_operation";

export interface Node {
  id: string;
  name: string;
  kind: NodeKind;
  parent_id: string | null;
  child_ids: string[];
  property_ids: string[];
  /**
   * The six per-row state fields. EVERY ONE IS NULLABLE, and null means "this
   * host does not report it" — never false, never "ok". That is the reference's
   * own behaviour typed: gui_demo.py's _build_component_state_labels wraps each
   * read in try/except and appends no label when it raises.
   */
  /** IComponent.active. false draws the [inactive] label. */
  active: boolean | null;
  /** The EFFECTIVE lock, inheritance already applied host-side. true draws [locked]. */
  locked: boolean | null;
  component_status: NodeComponentStatus | null;
  component_status_message: string | null;
  /** Device rows only. Anything but "connected" draws [disconnected]. */
  connection_status: NodeConnectionStatus | null;
  /** Device rows only. The reference appends this to the row name as " | Idle". */
  operation_mode: NodeOperationMode | null;
}

/** One component type a loaded module can build. */
export interface ComponentTypeInfo {
  id: string;
  name: string;
  kind: "device" | "function_block" | "server" | "streaming";
  description: string | null;
  connection_string_prefix: string | null;
}

/** One module the host's SDK has loaded, as list_loaded_modules answers. */
export interface ModuleInfo {
  id: string;
  name: string;
  version: string | null;
  component_types: ComponentTypeInfo[];
}

export type PropertyValueType =
  | "bool"
  | "int"
  | "float"
  | "string"
  | "selection"
  | "struct";

export interface PropertyDescriptor {
  id: string;
  name: string;
  value_type: PropertyValueType;
  unit: string | null;
  description: string | null;
  read_only: boolean;
  visible: boolean;
  default: unknown;
  selection_values: string[] | null;
  suggested_values: unknown[] | null;
  min: number | null;
  max: number | null;
  /** EvalValue source string. Display only; never interpreted client-side. */
  validator: string | null;
  /** EvalValue source string. Display only; never interpreted client-side. */
  coercer: string | null;
}

export interface SignalDescriptor {
  id: string;
  name: string;
  sample_type: "float32" | "float64" | "int32" | "int64";
  unit: string | null;
  domain_id: string | null;
}

/** What scan_available_devices returns, one per device the host's SDK found. */
export interface DeviceInfo {
  connection_string: string;
  name: string;
  serial: string | null;
}

/** Closed set. A host emitting anything else is defective. */
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

// --- envelopes -------------------------------------------------------------

export interface WireRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface WireResponse {
  id: number;
  result: unknown;
}

export interface WireErrorResponse {
  id: number;
  error: { code: string; detail: string };
}

export interface WireEvent {
  event: string;
  payload: Record<string, unknown>;
}

// --- events ----------------------------------------------------------------

export interface EventPayloads {
  component_added: { node: Node };
  component_removed: { node_id: string };
  property_changed: { node_id: string; property_id: string; value: unknown };
  property_descriptor_changed: { node_id: string; descriptor: PropertyDescriptor };
  device_disconnected: { node_id: string; reason: string };
}

export type EventName = keyof EventPayloads;

// --- methods ---------------------------------------------------------------

/**
 * The nineteen methods of the operation table in contract/contract.yaml, the
 * same nineteen `WIRE_METHOD_NAMES` in generated/typescript/contract-types.ts.
 * No others exist. Still hand-written: the contract-driven generator replacing
 * this file is M3 work.
 */
export interface MethodContract {
  scan_available_devices: { params: Record<string, never>; result: DeviceInfo[] };
  connect_device: { params: { connection_string: string }; result: Node };
  disconnect_device: { params: { node_id: string }; result: null };
  get_component_tree: { params: { root_id?: string }; result: Node[] };
  get_property_descriptors: {
    params: { node_id: string };
    result: PropertyDescriptor[];
  };
  get_property_value: {
    params: { node_id: string; property_id: string };
    result: unknown;
  };
  set_property_value: {
    params: { node_id: string; property_id: string; value: unknown };
    result: null;
  };
  list_function_block_types: {
    params: Record<string, never>;
    result: string[];
  };
  add_function_block: {
    params: { parent_id: string; type_id: string };
    result: Node;
  };
  remove_function_block: { params: { node_id: string }; result: null };
  subscribe_signal: {
    params: { signal_id: string; pixel_columns: number };
    result: string;
  };
  unsubscribe_signal: { params: { subscription_id: string }; result: null };
  /**
   * The contract answers this one with `binary_frame`, not JSON: the frame
   * arrives on the binary plane and the JSON result carries nothing. Typed
   * `null` for that reason, so a caller cannot read samples off the result.
   */
  read_samples_raw: {
    params: { signal_id: string; count: number };
    result: null;
  };
  /** The AVAILABLE modes. The CURRENT one rides on Node.operation_mode. */
  get_device_operation_modes: {
    params: { node_id: string };
    result: string[];
  };
  set_device_operation_mode: {
    params: { node_id: string; mode: string };
    result: null;
  };
  lock_device: { params: { node_id: string }; result: null };
  /** force reaches IDevicePrivate.force_unlock(); omitted it is a plain unlock. */
  unlock_device: { params: { node_id: string; force?: boolean }; result: null };
  list_loaded_modules: { params: Record<string, never>; result: ModuleInfo[] };
  /**
   * `host_path` is a path on the filesystem of the machine the HOST process
   * runs on, not on the machine the browser runs on. contract/contract.yaml
   * chose that over uploading the module's bytes because openDAQ's
   * `IModuleManager::loadModule(IString* path, IModule**)` takes a path and has
   * no bytes-in sibling, this contract's request envelope carries only JSON,
   * and `handshake.limits.max_frame_bytes` defaults to 262144 while a module
   * binary is megabytes. The parameter is named `host_path` so that this fact
   * travels with every signature that mentions it.
   *
   * The answer is the module that was loaded — `loadModule`'s out-parameter —
   * so a caller gets the record it draws without a second `list_loaded_modules`.
   */
  load_module_from_host_path: {
    params: { host_path: string };
    result: ModuleInfo;
  };
}

export type MethodName = keyof MethodContract;

// --- binary data plane -----------------------------------------------------

export const DATA_FRAME_HEADER_BYTES = 17;

export type FrameEncoding = 0 | 1; // 0 = raw, 1 = min_max_envelope

export interface DataFrame {
  subscription_id: number;
  domain_start: bigint;
  sample_count: number;
  encoding: FrameEncoding;
  /**
   * encoding 0: sample_count values.
   * encoding 1: 2*sample_count values, interleaved (min, max) per column.
   */
  values: Float64Array;
}
