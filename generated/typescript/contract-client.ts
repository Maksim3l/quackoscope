// GENERATED FILE. Do not edit by hand.
//
// Produced by tools/contract-compiler from contract/contract.yaml, which is
// the single source of truth for the Quackoscope wire contract. Regenerate
// with:
//
//   python tools/contract-compiler/compile_contract_to_generated_targets.py
//

// The typed transport client. The frontend imports this and
// contract-types.ts and nothing else; it never learns which host
// implementation is on the other end of the socket.

import type {
  BinaryFrameEncodingName,
  BinarySampleFrame,
  ComponentAttribute,
  ComponentTypeInfo,
  DeviceInfo,
  ModuleInfo,
  Node,
  PropertyDescriptor,
  WireError,
  WireErrorEnvelope,
  WireEventEnvelope,
  WireEventName,
  WireEventPayloads,
  WireHandshake,
  WireMethodName,
  WireRequestEnvelope,
  WireResultEnvelope,
} from "./contract-types";
import {
  BINARY_FRAME_ENCODINGS,
  BINARY_FRAME_HEADER_BYTES,
} from "./contract-types";

/** A wire error that arrived as an error envelope. `code` is the only
 *  member client logic may branch on. */
export class WireCallFailed extends Error {
  readonly code: WireError["code"];
  readonly detail: string;

  constructor(method: WireMethodName, error: WireError) {
    super(`${method} failed with ${error.code}: ${error.detail}`);
    this.name = "WireCallFailed";
    this.code = error.code;
    this.detail = error.detail;
  }
}

/** Decodes one binary sample frame. Returns null for the two
 *  drop_frame conditions of contract 1.9: on_unknown_encoding (drop_frame)
 *  and on_truncated_frame (drop_frame). */
export function decodeBinarySampleFrame(buffer: ArrayBuffer): BinarySampleFrame | null {
  if (buffer.byteLength < BINARY_FRAME_HEADER_BYTES) {
    return null;
  }
  const view = new DataView(buffer);
  const subscription_id = view.getUint32(0, true);
  const domain_start = view.getBigUint64(4, true);
  const sample_count = view.getUint32(12, true);
  const encoding = view.getUint8(16);
  const encoding_name: BinaryFrameEncodingName | undefined =
    BINARY_FRAME_ENCODINGS[encoding];
  if (encoding_name === undefined) {
    return null;
  }
  const value_count =
    encoding_name === "min_max_envelope" ? sample_count * 2 :
    sample_count;
  const payload_bytes = value_count * 8;  // every encoding carries float64 values
  if (buffer.byteLength < BINARY_FRAME_HEADER_BYTES + payload_bytes) {
    return null;
  }
  // The payload offset is not 8-byte aligned, so the bytes are copied
  // out rather than viewed in place.
  const values = new Float64Array(value_count);
  for (let index = 0; index < value_count; index += 1) {
    values[index] = view.getFloat64(BINARY_FRAME_HEADER_BYTES + index * 8, true);
  }
  return {
    subscription_id,
    domain_start,
    sample_count,
    encoding,
    encoding_name,
    values,
  };
}

type PendingCall = {
  method: WireMethodName;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export interface WireSocket {
  send(payload: string): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
}

export class QuackoscopeWireClient {
  private readonly socket: WireSocket;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventListeners = new Map<
    WireEventName,
    ((payload: never) => void)[]
  >();
  private binaryFrameListener:
    | ((frame: BinarySampleFrame) => void)
    | null = null;
  private handshakeListener: ((handshake: WireHandshake) => void) | null =
    null;
  private nextCorrelationId = 1;
  private handshakeSeen = false;

  constructor(socket: WireSocket) {
    this.socket = socket;
    this.socket.addEventListener("message", (event) => {
      this.receive(event.data);
    });
  }

  /** The handshake is the first server-to-client message and arrives
   *  before any result. */
  onHandshake(listener: (handshake: WireHandshake) => void): void {
    this.handshakeListener = listener;
  }

  onEvent<K extends WireEventName>(
    event: K,
    listener: (payload: WireEventPayloads[K]) => void,
  ): void {
    const listeners = this.eventListeners.get(event) ?? [];
    listeners.push(listener as (payload: never) => void);
    this.eventListeners.set(event, listeners);
  }

  onBinaryFrame(listener: (frame: BinarySampleFrame) => void): void {
    this.binaryFrameListener = listener;
  }

  /** capability device.scan, kind action. Errors: internal. */
  async scan_available_devices(): Promise<DeviceInfo[]> {
    const params: Record<string, unknown> = {};
    return (await this.callAndAwaitResult("scan_available_devices", params)) as DeviceInfo[];
  }

  /** capability device.connect, kind action. Errors: not_found, invalid_value, timeout. */
  async connect_device(connection_string: string): Promise<Node> {
    const params: Record<string, unknown> = {};
    params["connection_string"] = connection_string;
    return (await this.callAndAwaitResult("connect_device", params)) as Node;
  }

  /** capability device.connect, kind action. Errors: not_found. */
  async disconnect_device(node_id: string): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    await this.callAndAwaitResult("disconnect_device", params);
  }

  /** capability tree.read, kind getter. Errors: not_connected, not_found. */
  async get_component_tree(root_id?: string): Promise<Node[]> {
    const params: Record<string, unknown> = {};
    if (root_id !== undefined) {
      params["root_id"] = root_id;
    }
    return (await this.callAndAwaitResult("get_component_tree", params)) as Node[];
  }

  /** capability property.read, kind getter. Errors: not_found, not_connected. */
  async get_property_value(node_id: string, property_id: string): Promise<unknown> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    params["property_id"] = property_id;
    return (await this.callAndAwaitResult("get_property_value", params)) as unknown;
  }

  /** capability property.read, kind getter. Errors: not_found, not_connected. */
  async get_property_descriptors(node_id: string): Promise<PropertyDescriptor[]> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    return (await this.callAndAwaitResult("get_property_descriptors", params)) as PropertyDescriptor[];
  }

  /** capability property.write, kind setter. Errors: not_found, read_only, invalid_value. */
  async set_property_value(node_id: string, property_id: string, value: unknown): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    params["property_id"] = property_id;
    params["value"] = value;
    await this.callAndAwaitResult("set_property_value", params);
  }

  /** capability function_block.add, kind getter. Errors: not_connected. */
  async list_function_block_types(): Promise<string[]> {
    const params: Record<string, unknown> = {};
    return (await this.callAndAwaitResult("list_function_block_types", params)) as string[];
  }

  /** capability function_block.add, kind action. Errors: not_found, unsupported. */
  async add_function_block(parent_id: string, type_id: string): Promise<Node> {
    const params: Record<string, unknown> = {};
    params["parent_id"] = parent_id;
    params["type_id"] = type_id;
    return (await this.callAndAwaitResult("add_function_block", params)) as Node;
  }

  /** capability function_block.add, kind action. Errors: not_found. */
  async remove_function_block(node_id: string): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    await this.callAndAwaitResult("remove_function_block", params);
  }

  /** capability streaming.decimated, kind action. Errors: not_found, not_connected, invalid_value. */
  async subscribe_signal(signal_id: string, pixel_columns: number): Promise<string> {
    const params: Record<string, unknown> = {};
    params["signal_id"] = signal_id;
    params["pixel_columns"] = pixel_columns;
    return (await this.callAndAwaitResult("subscribe_signal", params)) as string;
  }

  /** capability streaming.decimated, kind action. Errors: not_found, invalid_value. */
  async unsubscribe_signal(subscription_id: string): Promise<void> {
    const params: Record<string, unknown> = {};
    params["subscription_id"] = subscription_id;
    await this.callAndAwaitResult("unsubscribe_signal", params);
  }

  /** capability streaming.raw, kind action. Errors: not_found, not_connected. */
  //
  // UNSPECIFIED IN contract.yaml: this operation declares
  // returns: {type: binary_frame}, but envelopes.result carries a
  // JSON result and binary_frame.header has no correlation id, so
  // a binary response cannot be matched to its request id. The
  // generated call follows envelopes.result, the only specified
  // response path. See the contract-compiler report.
  async read_samples_raw(signal_id: string, count: number): Promise<BinarySampleFrame> {
    const params: Record<string, unknown> = {};
    params["signal_id"] = signal_id;
    params["count"] = count;
    return (await this.callAndAwaitResult("read_samples_raw", params)) as BinarySampleFrame;
  }

  /** capability device.mode, kind getter. Errors: not_found, not_connected, unsupported. */
  async get_device_operation_modes(node_id: string): Promise<string[]> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    return (await this.callAndAwaitResult("get_device_operation_modes", params)) as string[];
  }

  /** capability device.mode, kind setter. Errors: not_found, invalid_value, unsupported. */
  async set_device_operation_mode(node_id: string, mode: string): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    params["mode"] = mode;
    await this.callAndAwaitResult("set_device_operation_mode", params);
  }

  /** capability device.lock, kind action. Errors: not_found, read_only, unsupported. */
  async lock_device(node_id: string): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    await this.callAndAwaitResult("lock_device", params);
  }

  /** capability device.lock, kind action. Errors: not_found, read_only, unsupported. */
  async unlock_device(node_id: string, force?: boolean): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    if (force !== undefined) {
      params["force"] = force;
    }
    await this.callAndAwaitResult("unlock_device", params);
  }

  /** capability module.read, kind getter. Errors: not_connected, internal. */
  async list_loaded_modules(): Promise<ModuleInfo[]> {
    const params: Record<string, unknown> = {};
    return (await this.callAndAwaitResult("list_loaded_modules", params)) as ModuleInfo[];
  }

  /** capability module.load, kind action. Errors: not_found, not_connected, invalid_value, internal. */
  async load_module_from_host_path(host_path: string): Promise<ModuleInfo> {
    const params: Record<string, unknown> = {};
    params["host_path"] = host_path;
    return (await this.callAndAwaitResult("load_module_from_host_path", params)) as ModuleInfo;
  }

  /** capability attribute.read, kind getter. Errors: not_found, not_connected, invalid_value. */
  async get_component_attributes(node_id: string): Promise<ComponentAttribute[]> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    return (await this.callAndAwaitResult("get_component_attributes", params)) as ComponentAttribute[];
  }

  /** capability attribute.write, kind setter. Errors: not_found, read_only, invalid_value. */
  async set_component_attribute(node_id: string, attribute_id: string, value: unknown): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    params["attribute_id"] = attribute_id;
    params["value"] = value;
    await this.callAndAwaitResult("set_component_attribute", params);
  }

  /** capability server.add, kind getter. Errors: not_connected. */
  async list_server_types(): Promise<ComponentTypeInfo[]> {
    const params: Record<string, unknown> = {};
    return (await this.callAndAwaitResult("list_server_types", params)) as ComponentTypeInfo[];
  }

  /** capability server.add, kind action. Errors: not_connected, unsupported, invalid_value, internal. */
  async add_server(type_id: string): Promise<Node> {
    const params: Record<string, unknown> = {};
    params["type_id"] = type_id;
    return (await this.callAndAwaitResult("add_server", params)) as Node;
  }

  /** capability server.add, kind action. Errors: not_found, unsupported, internal. */
  async remove_server(node_id: string): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    await this.callAndAwaitResult("remove_server", params);
  }

  /** capability server.discovery, kind setter. Errors: not_found, unsupported, internal, invalid_value. */
  async set_server_discovery_enabled(node_id: string, enabled: boolean): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    params["enabled"] = enabled;
    await this.callAndAwaitResult("set_server_discovery_enabled", params);
  }

  /** capability recorder.control, kind action. Errors: not_found, unsupported, internal, invalid_value. */
  async start_recording(node_id: string): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    await this.callAndAwaitResult("start_recording", params);
  }

  /** capability recorder.control, kind action. Errors: not_found, unsupported, internal. */
  async stop_recording(node_id: string): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    await this.callAndAwaitResult("stop_recording", params);
  }

  /** capability property.batched_update, kind action. Errors: not_found, not_connected, invalid_value. */
  async begin_batched_property_update(node_id: string): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    await this.callAndAwaitResult("begin_batched_property_update", params);
  }

  /** capability property.batched_update, kind action. Errors: not_found, not_connected, invalid_value. */
  async end_batched_property_update(node_id: string): Promise<void> {
    const params: Record<string, unknown> = {};
    params["node_id"] = node_id;
    await this.callAndAwaitResult("end_batched_property_update", params);
  }

  /** capability configuration.save, kind getter. Errors: not_connected, internal. */
  async save_instance_configuration_to_string(): Promise<string> {
    const params: Record<string, unknown> = {};
    return (await this.callAndAwaitResult("save_instance_configuration_to_string", params)) as string;
  }

  /** capability configuration.load, kind action. Errors: not_connected, invalid_value, internal. */
  async load_instance_configuration_from_string(configuration: string): Promise<void> {
    const params: Record<string, unknown> = {};
    params["configuration"] = configuration;
    await this.callAndAwaitResult("load_instance_configuration_from_string", params);
  }

  private callAndAwaitResult(
    method: WireMethodName,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.nextCorrelationId;
    this.nextCorrelationId += 1;
    const envelope: WireRequestEnvelope = { id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.send(JSON.stringify(envelope));
    });
  }

  private receive(payload: unknown): void {
    if (payload instanceof ArrayBuffer) {
      const frame = decodeBinarySampleFrame(payload);
      if (frame !== null && this.binaryFrameListener !== null) {
        this.binaryFrameListener(frame);
      }
      return;
    }
    if (typeof payload !== "string") {
      return;
    }
    const message = JSON.parse(payload) as Record<string, unknown>;
    if (!this.handshakeSeen) {
      this.handshakeSeen = true;
      if ("protocol_version" in message) {
        if (this.handshakeListener !== null) {
          this.handshakeListener(message as unknown as WireHandshake);
        }
        return;
      }
    }
    if ("event" in message) {
      const envelope = message as unknown as WireEventEnvelope;
      const listeners = this.eventListeners.get(envelope.event) ?? [];
      for (const listener of listeners) {
        listener(envelope.payload as never);
      }
      return;
    }
    const id = message["id"];
    if (typeof id !== "number") {
      return;
    }
    const call = this.pending.get(id);
    if (call === undefined) {
      return;
    }
    this.pending.delete(id);
    if ("error" in message) {
      const envelope = message as unknown as WireErrorEnvelope;
      call.reject(new WireCallFailed(call.method, envelope.error));
      return;
    }
    const envelope = message as unknown as WireResultEnvelope;
    call.resolve(envelope.result);
  }
}

