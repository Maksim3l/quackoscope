// quackoscope-host-mock -- service layer.
//
// Seventeen of the contract's eighteen operations, the five events and the
// closed error set (read_samples_raw is the one not answered here). This file
// knows nothing about sockets: it is handed an object that can send text and
// binary, and hands back an outcome the transport turns into an envelope.

import { encodeDataFrame, type RequestOutcome } from "../transport/wire-envelope.ts";
import { decimateToPixelColumns } from "./decimate-to-pixel-columns.ts";
import { ServiceRefusal } from "./wire-errors.ts";
import { DEVICE_NODE_ID, SyntheticReferenceDevice, type DeviceEvent } from "../synthetic-device/synthetic-reference-device.ts";
import {
  BASELINE_CAPABILITY_IDS,
  capabilitiesFullyServedBy,
  gapsAgainstBaseline,
  WIRE_METHOD_NAMES,
  type CapabilityId,
  type WireMethodName,
} from "./capabilities-from-served-wire-methods.ts";

export const PROTOCOL_VERSION = "1.0";
export const HOST_IMPLEMENTATION_NAME = "quackoscope-host-mock";
export const HOST_IMPLEMENTATION_VERSION = "0.1.0";
export const MAX_SUBSCRIPTIONS = 64;
export const MAX_FRAME_BYTES = 262144;

/** What a session can be handed to talk back on. */
export interface SessionSocket {
  sendText(text: string): void;
  sendBinary(bytes: Buffer): void;
  readonly describedPeer: string;
}

interface SessionState {
  socket: SessionSocket;
  /** The device lock is held by a SESSION, and two sessions can share a peer
   *  address, so the lock is keyed on this rather than on describedPeer. */
  sessionKey: string;
  describedSession: string;
  /** connection_string -> device node id, exactly the C++ host's session scoping. */
  deviceNodeIdsByConnectionString: Map<string, string>;
  subscriptions: Map<number, { signalId: string; pixelColumns: number }>;
}

/** The wire methods dispatch() below actually answers. Every name here is one
 *  of the 19 in generated/typescript/contract-types.ts; adding a case to
 *  dispatch() and a name here is what grows the declared capability list. */
export const SERVED_WIRE_METHODS: readonly WireMethodName[] = [
  "scan_available_devices",
  "connect_device",
  "disconnect_device",
  "get_component_tree",
  "get_property_descriptors",
  "get_property_value",
  "set_property_value",
  "list_function_block_types",
  "add_function_block",
  "remove_function_block",
  "subscribe_signal",
  "unsubscribe_signal",
  "get_device_operation_modes",
  "set_device_operation_mode",
  "lock_device",
  "unlock_device",
  "list_loaded_modules",
];

const REASON_TABLE_FILE = "hosts/mock-ts/src/service/session-hub.ts";

// The REASON this host has for each capability it does not serve, and nothing
// more: contract/contract.yaml gap_generation.declared_by_host is reason_only,
// and host_may_declare_gap_list is false, so the list itself is computed below
// as baseline minus declared.
//
// Every kind here is "host", and every reason names the exact wire method that
// has no case in dispatch(). None of them is "binding": there is no openDAQ
// SDK binding in this process at all -- the device is synthesised in
// hosts/mock-ts/src/synthetic-device/ -- so no binding could be at fault, and
// "binding" would be a claim about openDAQ that this host has no standing to
// make.
const GAP_KIND_AND_REASON_BY_CAPABILITY: Readonly<
  Partial<Record<CapabilityId, { kind: "binding" | "host"; reason: string }>>
> = {
  "streaming.raw": {
    kind: "host",
    reason:
      "read_samples_raw has no case in dispatch() of hosts/mock-ts/src/service/session-hub.ts. The samples " +
      "themselves are not the obstacle -- subscribe_signal already delivers them, decimated to pixel_columns by " +
      "hosts/mock-ts/src/service/decimate-to-pixel-columns.ts -- the answer envelope is: contract/contract.yaml " +
      "declares returns: {type: binary_frame} for read_samples_raw, envelopes.result carries a JSON result, and " +
      "the 17-byte binary frame header carries no correlation id, so a binary answer cannot be matched to the " +
      "request that asked for it. The two generated clients already disagree about the JSON stand-in: " +
      "generated/typescript/contract-client.ts casts the JSON result to the flat BinarySampleFrame " +
      "{subscription_id, domain_start, sample_count, encoding, encoding_name, values}, while " +
      "generated/python/contract_types.py declares BinarySampleFrame as {header, values}. This host will not " +
      "invent a third shape; currently not available",
  },
  "module.load": {
    kind: "host",
    reason:
      "load_module_from_host_path has no case in dispatch() of hosts/mock-ts/src/service/session-hub.ts. " +
      "contract/contract.yaml defines the row as a dlopen of a file on this host's own disk followed by that " +
      "file's initialisation, and there is no openDAQ module manager in this process to load it into: the one " +
      "module list_loaded_modules answers with is mock_synthetic_component_module, built in TypeScript by " +
      "hosts/mock-ts/src/synthetic-device/synthetic-reference-device.ts and loaded from no file at all. " +
      "contract/contract.yaml splits module.load from module.read for this case by name -- \"The mock host and " +
      "any sandboxed deployment need precisely that split\" -- so this host declares module.read and withholds " +
      "module.load; currently not available",
  },
};

/** The capability ids of contract section 4 whose every wire method dispatch()
 *  answers. Never wire method names, never event names. */
export const DECLARED_CAPABILITIES: readonly CapabilityId[] = capabilitiesFullyServedBy(SERVED_WIRE_METHODS);

/** baseline minus DECLARED_CAPABILITIES, computed, never written by hand. */
export const COMPUTED_GAPS = gapsAgainstBaseline(
  DECLARED_CAPABILITIES,
  GAP_KIND_AND_REASON_BY_CAPABILITY,
  REASON_TABLE_FILE,
);

/** The first message the server sends on every accepted WebSocket. */
export function handshakeMessage(): string {
  return JSON.stringify({
    protocol_version: PROTOCOL_VERSION,
    implementation: { name: HOST_IMPLEMENTATION_NAME, version: HOST_IMPLEMENTATION_VERSION },
    sdk: { version: "none (synthetic device, no openDAQ SDK is loaded)", commit: "none" },
    capabilities: DECLARED_CAPABILITIES,
    gaps: COMPUTED_GAPS,
    limits: { max_subscriptions: MAX_SUBSCRIPTIONS, max_frame_bytes: MAX_FRAME_BYTES },
  });
}

/** Says, at startup, exactly which capability ids this host will declare and
 *  which gaps that leaves. */
export function printHandshakeItWillSend(): void {
  console.log(
    `[handshake] protocol_version ${PROTOCOL_VERSION}, implementation ${HOST_IMPLEMENTATION_NAME} ` +
      `${HOST_IMPLEMENTATION_VERSION} (display only; nothing branches on it), sdk version ` +
      '"none (synthetic device, no openDAQ SDK is loaded)" at commit "none"',
  );
  console.log(
    `[handshake] dispatch() answers ${SERVED_WIRE_METHODS.length} of the contract's ${WIRE_METHOD_NAMES.length} wire methods ` +
      `(${SERVED_WIRE_METHODS.join(", ")}), so ${DECLARED_CAPABILITIES.length} of the ` +
      `${BASELINE_CAPABILITY_IDS.length} baseline capabilities are declared and ` +
      `${COMPUTED_GAPS.length === 1 ? "1 is a gap" : `${COMPUTED_GAPS.length} are gaps`}`,
  );
  for (const capability of DECLARED_CAPABILITIES) console.log(`[handshake]   capability ${capability}`);
  for (const gap of COMPUTED_GAPS) console.log(`[handshake]   gap        ${gap.capability} (kind ${gap.kind}): ${gap.reason}`);
  console.log(
    `[handshake] limits: max_subscriptions = ${MAX_SUBSCRIPTIONS}, max_frame_bytes = ${MAX_FRAME_BYTES}`,
  );
}

export class SessionHub {
  private device: SyntheticReferenceDevice;
  private sessions = new Map<SessionSocket, SessionState>();
  private nextSubscriptionId = 1;
  private nextSessionOrdinal = 1;

  constructor(device: SyntheticReferenceDevice) {
    this.device = device;
    this.device.setEventSink((event) => this.publish(event));
  }

  openSession(socket: SessionSocket): void {
    const sessionKey = `session-${this.nextSessionOrdinal++}`;
    this.sessions.set(socket, {
      socket,
      sessionKey,
      describedSession: `${sessionKey} at ${socket.describedPeer}`,
      deviceNodeIdsByConnectionString: new Map(),
      subscriptions: new Map(),
    });
    socket.sendText(handshakeMessage());
    console.log(
      `[service] session opened for ${socket.describedPeer}; handshake sent (protocol_version ${PROTOCOL_VERSION}, implementation ${HOST_IMPLEMENTATION_NAME} ${HOST_IMPLEMENTATION_VERSION}); ${this.sessions.size} session(s) live`,
    );
  }

  closeSession(socket: SessionSocket): void {
    const state = this.sessions.get(socket);
    if (!state) return;
    for (const subscriptionId of state.subscriptions.keys()) this.device.stopFrameDelivery(subscriptionId);
    // A lock outlives the request that took it, but not the session that holds
    // it: a socket that goes away leaving the device locked would leave every
    // other session facing read_only with no holder left to unlock it.
    const heldTheLock = this.device.lockRefusalFacing(state.sessionKey) === null && this.device.isLocked();
    if (heldTheLock) this.device.releaseLockHeldBy(state.sessionKey, state.describedSession);
    this.sessions.delete(socket);
    console.log(
      `[service] session closed for ${socket.describedPeer}: ${state.subscriptions.size} subscription(s) and ${state.deviceNodeIdsByConnectionString.size} device holding(s) dropped` +
        `${heldTheLock ? `, and the device lock ${state.describedSession} held was released` : ""}; ${this.sessions.size} session(s) still live`,
    );
  }

  answerRequest(socket: SessionSocket, method: string, params: Record<string, unknown>): RequestOutcome {
    try {
      return { ok: true, result: this.dispatch(socket, method, params) };
    } catch (e) {
      if (e instanceof ServiceRefusal) {
        console.log(`[service] ${method} refused with ${e.code}: ${e.detail}`);
        return { ok: false, code: e.code, detail: e.detail };
      }
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error(`[service] ${method} raised an unhandled failure, answered with internal: ${detail}`);
      return { ok: false, code: "internal", detail };
    }
  }

  private dispatch(socket: SessionSocket, method: string, params: Record<string, unknown>): unknown {
    const state = this.sessions.get(socket);
    if (!state) throw new ServiceRefusal("not_connected", "this WebSocket session is already closed");

    switch (method) {
      case "scan_available_devices":
        return this.scanAvailableDevices();
      case "connect_device":
        return this.connectDevice(state, params);
      case "disconnect_device":
        return this.disconnectDevice(state, params);
      case "list_function_block_types":
        return this.listFunctionBlockTypes(state);
      case "add_function_block":
        return this.addFunctionBlock(state, params);
      case "remove_function_block":
        return this.removeFunctionBlock(state, params);
      case "get_component_tree":
        return this.getComponentTree(state, params);
      case "get_property_descriptors":
        return this.device.getPropertyDescriptors(this.requireNodeReachableFromSession(state, params, "node_id"));
      case "get_property_value":
        return this.device.getPropertyValue(
          this.requireNodeReachableFromSession(state, params, "node_id"),
          requireStringParam(params, "property_id"),
        );
      case "set_property_value":
        return this.setPropertyValue(state, params);
      case "subscribe_signal":
        return this.subscribeSignal(state, params);
      case "unsubscribe_signal":
        return this.unsubscribeSignal(state, params);
      case "get_device_operation_modes":
        return this.getDeviceOperationModes(state, params);
      case "set_device_operation_mode":
        return this.setDeviceOperationMode(state, params);
      case "lock_device":
        return this.lockDevice(state, params);
      case "unlock_device":
        return this.unlockDevice(state, params);
      case "list_loaded_modules":
        return this.listLoadedModules();
      default:
        // A name that is in SERVED_WIRE_METHODS and has no case above is not
        // an unknown method: it is this file lying in its handshake, because
        // SERVED_WIRE_METHODS is what DECLARED_CAPABILITIES is computed from.
        // Refusing it "unsupported" would report a broken promise as an
        // unrecognised request and hide which of the two lists is wrong.
        if (SERVED_WIRE_METHODS.includes(method as WireMethodName)) {
          throw new ServiceRefusal(
            "internal",
            `"${method}" is listed in SERVED_WIRE_METHODS of ${REASON_TABLE_FILE}, so the handshake declares the ` +
              `capability that owns it, but dispatch() in that file has no case for it. The two have drifted; the ` +
              "handshake is claiming an operation this host cannot answer.",
          );
        }
        throw new ServiceRefusal(
          "unsupported",
          `unknown method "${method}"; ${HOST_IMPLEMENTATION_NAME} serves ${SERVED_WIRE_METHODS.join(", ")}`,
        );
    }
  }

  // --- the operations ------------------------------------------------------

  /**
   * Discovery over a process that has no discovery protocol: the one device
   * that exists here is the synthetic one, so the scan answers with exactly
   * that entry. It needs no connected device and touches no session state,
   * which is why it takes none -- contract section 5 gives
   * scan_available_devices no params and the single error `internal`.
   */
  private scanAvailableDevices(): unknown {
    const discovered = [this.device.describeItselfForDiscovery()];
    for (const entry of discovered) {
      console.log(
        `[service] scan_available_devices answered with ${discovered.length} device: ${entry.connection_string} ` +
          `(name "${entry.name}", serial ${entry.serial ?? "none"}); this host synthesises that device rather than ` +
          "sweeping a network, so the list is always exactly one entry long",
      );
    }
    return discovered;
  }

  private connectDevice(state: SessionState, params: Record<string, unknown>): unknown {
    const connectionString = requireStringParam(params, "connection_string");
    if (connectionString.length === 0) {
      throw new ServiceRefusal(
        "invalid_value",
        'params.connection_string is empty; it must name a device, e.g. "daqref://device0"',
      );
    }
    state.deviceNodeIdsByConnectionString.set(connectionString, DEVICE_NODE_ID);
    console.log(
      `[service] connect_device "${connectionString}" answered with the synthetic device ${DEVICE_NODE_ID} (${this.device.componentCount()} components); this host accepts any connection string`,
    );
    return this.device.getDeviceNode();
  }

  /**
   * The other half of device.connect. There is no SDK here to remove a device
   * from, so this is session bookkeeping and says so: the session forgets the
   * node id it connected with, every subscription it holds under that device is
   * torn down, and the components stop being addressable from this session.
   *
   * The synthetic device object itself survives, because it is shared by every
   * session -- so component_removed goes to THIS session only. Broadcasting it
   * would tell a second session that components it still holds had vanished,
   * which is not true. That is the same shape hosts/cpp answers with when
   * another session still holds the device (see disconnectDevice in
   * hosts/cpp/src/service/session.cpp): dropped here, untouched there.
   *
   * A node id this session did not connect with is refused not_found, which is
   * the entire error list contract section 5 gives disconnect_device.
   */
  private disconnectDevice(state: SessionState, params: Record<string, unknown>): null {
    const nodeId = requireStringParam(params, "node_id");

    let heldConnectionString: string | null = null;
    for (const [connectionString, deviceNodeId] of state.deviceNodeIdsByConnectionString) {
      if (deviceNodeId === nodeId) {
        heldConnectionString = connectionString;
        break;
      }
    }
    if (heldConnectionString === null) {
      const holdings = [...state.deviceNodeIdsByConnectionString.values()].join(", ");
      throw new ServiceRefusal(
        "not_found",
        `this session did not connect a device with id "${nodeId}"; it holds ` +
          `${holdings.length > 0 ? holdings : "no device at all"}. disconnect_device takes the node id ` +
          "connect_device answered with.",
      );
    }

    state.deviceNodeIdsByConnectionString.delete(heldConnectionString);

    const droppedSubscriptionIds: number[] = [];
    for (const [subscriptionId, subscription] of state.subscriptions) {
      if (subscription.signalId === nodeId || subscription.signalId.startsWith(`${nodeId}/`)) {
        state.subscriptions.delete(subscriptionId);
        this.device.stopFrameDelivery(subscriptionId);
        droppedSubscriptionIds.push(subscriptionId);
      }
    }

    const removedNodeIds = this.device.subtreeNodeIdsDeepestFirst(nodeId);
    for (const removedNodeId of removedNodeIds) {
      state.socket.sendText(JSON.stringify({ event: "component_removed", payload: { node_id: removedNodeId } }));
    }

    console.log(
      `[service] disconnect_device ${nodeId} (connected in this session as "${heldConnectionString}"): dropped from ` +
        `${state.socket.describedPeer}, ${droppedSubscriptionIds.length} subscription(s) torn down` +
        `${droppedSubscriptionIds.length > 0 ? ` (${droppedSubscriptionIds.join(", ")})` : ""}, ` +
        `${removedNodeIds.length} component_removed event(s) sent to this session only. The synthetic device is ` +
        `kept in this process: it is shared with ${this.sessions.size - 1} other session(s) and there is no SDK ` +
        "instance to remove it from. This session now holds " +
        `${state.deviceNodeIdsByConnectionString.size} device(s).`,
    );
    return null;
  }

  private listFunctionBlockTypes(state: SessionState): unknown {
    this.requireDeviceInSession(state);
    const typeIds = this.device.listFunctionBlockTypeIds();
    console.log(
      `[service] list_function_block_types answered with ${typeIds.length} type(s): ${this.device.describeFunctionBlockTypes()}`,
    );
    return typeIds;
  }

  // add_function_block and remove_function_block resolve their node ids
  // through requireNodeReachableOrNotFound rather than
  // requireNodeReachableFromSession, because contract section 5 gives them the
  // error lists [not_found, unsupported] and [not_found]: a session with no
  // device connected must be refused not_found here, never not_connected,
  // which is off both lists.

  private addFunctionBlock(state: SessionState, params: Record<string, unknown>): unknown {
    const parentId = this.requireNodeReachableOrNotFound(state, params, "parent_id");
    const typeId = requireStringParam(params, "type_id");
    return this.device.addFunctionBlock(parentId, typeId);
  }

  private removeFunctionBlock(state: SessionState, params: Record<string, unknown>): null {
    const nodeId = this.requireNodeReachableOrNotFound(state, params, "node_id");
    this.device.removeFunctionBlock(nodeId);
    return null;
  }

  private getComponentTree(state: SessionState, params: Record<string, unknown>): unknown {
    this.requireDeviceInSession(state);
    if (typeof params.root_id === "string") {
      return this.device.getComponentTree(this.requireNodeReachableFromSession(state, params, "root_id"));
    }
    const flattened: unknown[] = [];
    for (const deviceNodeId of state.deviceNodeIdsByConnectionString.values()) {
      flattened.push(...this.device.getComponentTree(deviceNodeId));
    }
    return flattened;
  }

  private setPropertyValue(state: SessionState, params: Record<string, unknown>): null {
    this.requireDeviceInSession(state);
    if (!("value" in params)) throw new ServiceRefusal("invalid_value", "params.value is required");
    const nodeId = this.requireNodeReachableFromSession(state, params, "node_id");
    const propertyId = requireStringParam(params, "property_id");
    // A lock that stopped nothing would be a fake lock. contract.yaml says so
    // in as many words on set_device_operation_mode: read_only is "the closed
    // error set's expression of 'openDAQ refused the write because the
    // component is protected', the same code set_property_value already uses
    // for a locked target".
    const lockRefusal = this.device.lockRefusalFacing(state.sessionKey);
    if (lockRefusal !== null) {
      throw new ServiceRefusal(
        "read_only",
        `${lockRefusal}, so the write of ${JSON.stringify(params.value)} to ${nodeId}.${propertyId} was refused and ` +
          "nothing was stored. unlock_device on the device row first, with force true if the lock is not this session's.",
      );
    }
    const stored = this.device.setPropertyValue(nodeId, propertyId, params.value);
    if (JSON.stringify(stored) !== JSON.stringify(params.value)) {
      console.log(
        `[service] set_property_value coerced ${nodeId}.${propertyId}: submitted ${JSON.stringify(params.value)}, stored ${JSON.stringify(stored)}`,
      );
    } else {
      console.log(`[service] set_property_value stored ${nodeId}.${propertyId} = ${JSON.stringify(stored)}`);
    }
    // The result is null by contract: the value on screen must come from the
    // property_changed event or a read-back, never from what was submitted.
    return null;
  }

  private subscribeSignal(state: SessionState, params: Record<string, unknown>): string {
    this.requireDeviceInSession(state);
    const signalId = this.requireNodeReachableFromSession(state, params, "signal_id");
    const pixelColumns = requirePositiveIntParam(params, "pixel_columns");
    this.device.requireSignal(signalId);

    if (state.subscriptions.size >= MAX_SUBSCRIPTIONS) {
      throw new ServiceRefusal(
        "unsupported",
        `this session already holds ${state.subscriptions.size} subscriptions and the advertised limit is max_subscriptions ${MAX_SUBSCRIPTIONS}; unsubscribe one first`,
      );
    }

    const subscriptionId = this.nextSubscriptionId++;
    state.subscriptions.set(subscriptionId, { signalId, pixelColumns });
    this.device.startFrameDelivery(signalId, subscriptionId, (id, domainStart, values) => {
      this.sendFrame(state, id, pixelColumns, domainStart, values);
    });
    console.log(
      `[service] subscribe_signal ${signalId} -> subscription ${subscriptionId}, decimating every block to ${pixelColumns} pixel columns for ${state.socket.describedPeer}`,
    );
    return String(subscriptionId);
  }

  private unsubscribeSignal(state: SessionState, params: Record<string, unknown>): null {
    const text = requireStringParam(params, "subscription_id");
    if (!/^[0-9]{1,10}$/.test(text) || Number(text) > 0xffffffff) {
      throw new ServiceRefusal(
        "invalid_value",
        `params.subscription_id must be the decimal text of a uint32, whole and with nothing else in it; got "${text}"`,
      );
    }
    const subscriptionId = Number(text);
    if (!state.subscriptions.has(subscriptionId)) {
      throw new ServiceRefusal("not_found", `no subscription "${text}" on this session`);
    }
    state.subscriptions.delete(subscriptionId);
    this.device.stopFrameDelivery(subscriptionId);
    console.log(`[service] unsubscribe_signal ${subscriptionId} torn down for ${state.socket.describedPeer}`);
    return null;
  }

  // --- device operation mode, device lock, modules -------------------------

  /**
   * The four device-row operations answer a malformed node_id with not_found
   * and not with invalid_value, because invalid_value is not in the error list
   * contract section 5 gives get_device_operation_modes, lock_device or
   * unlock_device, and a host that answers off its declared list is defective.
   * "not a string" and "a string naming nothing" are the same fact to a
   * caller: no such node.
   */
  private requireNodeIdNamesSomethingOrNotFound(params: Record<string, unknown>, wireMethod: string): void {
    if (typeof params.node_id !== "string") {
      throw new ServiceRefusal(
        "not_found",
        `params.node_id of ${wireMethod} must be the string id of a device row; got ${JSON.stringify(params.node_id)}, ` +
          `which names no component on this host (the one device here is "${DEVICE_NODE_ID}")`,
      );
    }
  }

  private getDeviceOperationModes(state: SessionState, params: Record<string, unknown>): string[] {
    this.requireNodeIdNamesSomethingOrNotFound(params, "get_device_operation_modes");
    // errors [not_found, not_connected, unsupported]: not_connected is on this
    // operation's list, so a session holding no device is told that.
    const nodeId = this.requireNodeReachableFromSession(state, params, "node_id");
    this.device.requireDeviceRow(nodeId, "get_device_operation_modes");
    const modes = this.device.availableOperationModes();
    console.log(
      `[service] get_device_operation_modes ${nodeId} answered with ${modes.length} mode(s): ${modes.join(", ")}; ` +
        `the device is in "${this.device.currentOperationMode()}", which every device row also carries as Node.operation_mode`,
    );
    return modes;
  }

  private setDeviceOperationMode(state: SessionState, params: Record<string, unknown>): null {
    this.requireNodeIdNamesSomethingOrNotFound(params, "set_device_operation_mode");
    // errors [not_found, invalid_value, read_only, unsupported]: not_connected
    // is NOT on this operation's list, so a session holding no device is
    // refused not_found, the same rule add_function_block follows.
    const nodeId = this.requireNodeReachableOrNotFound(state, params, "node_id");
    const mode = requireStringParam(params, "mode");
    this.device.requireDeviceRow(nodeId, "set_device_operation_mode");
    const lockRefusal = this.device.lockRefusalFacing(state.sessionKey);
    if (lockRefusal !== null) {
      throw new ServiceRefusal(
        "read_only",
        `${lockRefusal}, so its operation mode cannot be moved to "${mode}"; it stays in ` +
          `"${this.device.currentOperationMode()}". unlock_device first.`,
      );
    }
    const nowInForce = this.device.setOperationMode(nodeId, mode);
    console.log(
      `[service] set_device_operation_mode ${nodeId} = "${nowInForce}" for ${state.describedSession}; re-read the tree to ` +
        "see it, the contract pushes no event for an operation mode change",
    );
    return null;
  }

  private lockDevice(state: SessionState, params: Record<string, unknown>): null {
    this.requireNodeIdNamesSomethingOrNotFound(params, "lock_device");
    // errors [not_found, read_only, unsupported].
    const nodeId = this.requireNodeReachableOrNotFound(state, params, "node_id");
    this.device.lockDevice(nodeId, state.sessionKey, state.describedSession);
    console.log(
      `[service] lock_device ${nodeId} held by ${state.describedSession}; every row of that subtree now reports ` +
        "Node.locked true, and a property write or a mode change from another session is refused read_only",
    );
    return null;
  }

  private unlockDevice(state: SessionState, params: Record<string, unknown>): null {
    this.requireNodeIdNamesSomethingOrNotFound(params, "unlock_device");
    // errors [not_found, read_only, unsupported]. force is an OPTIONAL bool;
    // anything other than a bool is ignored rather than refused, because
    // invalid_value is not on this operation's list.
    const nodeId = this.requireNodeReachableOrNotFound(state, params, "node_id");
    const force = params.force === true;
    this.device.unlockDevice(nodeId, state.sessionKey, state.describedSession, force);
    console.log(
      `[service] unlock_device ${nodeId} by ${state.describedSession} (force ${force}); the device now reports ` +
        `Node.locked ${this.device.isLocked()}`,
    );
    return null;
  }

  /**
   * errors [not_connected, internal], params none. It needs no connected
   * device and touches no session state: the module list is a fact about the
   * PROCESS, exactly as the reference reads instance.module_manager.modules
   * rather than asking a device, so a session that has connected nothing still
   * gets an answer and not_connected is never emitted.
   */
  private listLoadedModules(): unknown {
    const modules = this.device.describeLoadedModules();
    console.log(
      `[service] list_loaded_modules answered with ${modules.length} module: ${this.device.describeLoadedModulesForTheLog()}. ` +
        "No openDAQ module is loaded in this process; that entry describes the synthetic component types this host itself " +
        `builds, and its function block rows are the same catalogue list_function_block_types answers with ` +
        `(${this.device.listFunctionBlockTypeIds().join(", ")}).`,
    );
    return modules;
  }

  // --- session scoping -----------------------------------------------------

  private requireDeviceInSession(state: SessionState): void {
    if (state.deviceNodeIdsByConnectionString.size === 0) {
      throw new ServiceRefusal(
        "not_connected",
        "this session has connected no device; call connect_device first (a device another session connected is not visible here)",
      );
    }
  }

  private requireNodeReachableFromSession(
    state: SessionState,
    params: Record<string, unknown>,
    key: string,
  ): string {
    const nodeId = requireStringParam(params, key);
    for (const deviceNodeId of state.deviceNodeIdsByConnectionString.values()) {
      if (nodeId === deviceNodeId || nodeId.startsWith(`${deviceNodeId}/`)) return nodeId;
    }
    if (state.deviceNodeIdsByConnectionString.size === 0) {
      throw new ServiceRefusal(
        "not_connected",
        `this session has connected no device, so "${nodeId}" is not addressable; call connect_device first`,
      );
    }
    throw new ServiceRefusal(
      "not_found",
      `no component with id "${nodeId}" in this session; it holds ${[...state.deviceNodeIdsByConnectionString.values()].join(", ")}`,
    );
  }

  /**
   * The same session scoping as requireNodeReachableFromSession, except that a
   * session holding no device is refused not_found instead of not_connected.
   * The two operations that use it -- add_function_block and
   * remove_function_block -- do not have not_connected in their contract error
   * lists, and a host that answers off the list is defective.
   */
  private requireNodeReachableOrNotFound(
    state: SessionState,
    params: Record<string, unknown>,
    key: string,
  ): string {
    const nodeId = requireStringParam(params, key);
    for (const deviceNodeId of state.deviceNodeIdsByConnectionString.values()) {
      if (nodeId === deviceNodeId || nodeId.startsWith(`${deviceNodeId}/`)) return nodeId;
    }
    throw new ServiceRefusal(
      "not_found",
      `no component with id "${nodeId}" in this session; it holds ` +
        `${[...state.deviceNodeIdsByConnectionString.values()].join(", ") || "no device at all (call connect_device first)"}`,
    );
  }

  // --- data plane and server push -----------------------------------------

  private sendFrame(
    state: SessionState,
    subscriptionId: number,
    pixelColumns: number,
    domainStart: bigint,
    values: Float64Array,
  ): void {
    const columns = decimateToPixelColumns(values, pixelColumns);
    if (columns.sampleCount === 0) return;
    const frame = encodeDataFrame(subscriptionId, domainStart, columns.sampleCount, columns.encoding, columns.payload);
    if (frame.length > MAX_FRAME_BYTES) {
      console.error(
        `[service] subscription ${subscriptionId} produced a ${frame.length} byte frame, above the advertised max_frame_bytes ${MAX_FRAME_BYTES}; dropped rather than sent`,
      );
      return;
    }
    state.socket.sendBinary(frame);
  }

  private publish(event: DeviceEvent): void {
    const text = JSON.stringify(event);
    for (const state of this.sessions.values()) state.socket.sendText(text);
    if (event.event === "device_disconnected") {
      for (const state of this.sessions.values()) state.deviceNodeIdsByConnectionString.clear();
    }
    console.log(`[service] published ${event.event} to ${this.sessions.size} session(s): ${text}`);
  }
}

function requireStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") {
    throw new ServiceRefusal("invalid_value", `params.${key} must be a string; got ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePositiveIntParam(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ServiceRefusal("invalid_value", `params.${key} must be an integer; got ${JSON.stringify(value)}`);
  }
  if (value <= 0 || value > 1000000) {
    throw new ServiceRefusal("invalid_value", `params.${key} must be in [1, 1000000]; got ${value}`);
  }
  return value;
}
