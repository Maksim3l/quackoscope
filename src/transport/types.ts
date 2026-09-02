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

export interface Node {
  id: string;
  name: string;
  kind: NodeKind;
  parent_id: string | null;
  child_ids: string[];
  property_ids: string[];
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

/** The seven M1 methods. No others exist. */
export interface MethodContract {
  connect_device: { params: { connection_string: string }; result: Node };
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
  subscribe_signal: {
    params: { signal_id: string; pixel_columns: number };
    result: string;
  };
  unsubscribe_signal: { params: { subscription_id: string }; result: null };
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
