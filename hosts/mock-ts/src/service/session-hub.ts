// quackoscope-host-mock -- service layer.
//
// Twenty-nine of the contract's thirty-one operations, the five events and the
// closed error set. The two not answered here are read_samples_raw and
// load_module_from_host_path, and GAP_KIND_AND_REASON_BY_CAPABILITY below says
// why for each. This file knows nothing about sockets: it is handed an object
// that can send text and binary, and hands back an outcome the transport turns
// into an envelope.

import { encodeDataFrame, encodeResult, type RequestOutcome } from "../transport/wire-envelope.ts";
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
  /** For the log only. Two sessions can share a peer address, so this
   *  distinguishes them; NOTHING branches on it. The device lock in particular
   *  does not: openDAQ has no session concept for a lock. */
  sessionKey: string;
  describedSession: string;
  /**
   * The openDAQ user this socket counts as, which is the only thing
   * IDevicePrivate::lock and ::unlock are ever given
   * (config_server_device.h:78 passes `context.user`).
   *
   * "" IS THE DEFAULT AND IS THE CORRECT ONE: with no AuthenticationProvider
   * configured, authentication_provider_impl.cpp:23,56 hands every connection
   * the same anonymous User("", ""), and user_lock_impl.cpp:19-20 collapses
   * that to nullptr. Only --give-every-socket-its-own-named-opendaq-user makes
   * these differ, and that flag says in its own name that it is configuring an
   * authentication provider this app does not have.
   */
  openDaqUserName: string;
  /** connection_string -> device node id, exactly the C++ host's session scoping. */
  deviceNodeIdsByConnectionString: Map<string, string>;
  subscriptions: Map<number, { signalId: string; pixelColumns: number }>;
}

/** The wire methods dispatch() below actually answers. Every name here is one
 *  of the wire methods in generated/typescript/contract-types.ts; adding a case
 *  to dispatch() and a name here is what grows the declared capability list. */
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
// make. The ruling is explicit that "binding" is earned only by enumerating an
// API surface, and there is no API surface here to enumerate.
//
// THE EIGHT CAPABILITY IDS THAT ARRIVED WITH THE ATTRIBUTE, SERVER, RECORDER,
// BATCHED-UPDATE AND CONFIGURATION ROWS ADD NOTHING TO THIS TABLE, because all
// eleven of those operations have a case in dispatch(). A synthetic device can
// serve them honestly and the synthetic device now does: it carries attributes
// that are not properties, server rows of NodeKind `server`, one recorder row
// with a non-null Node.recording, a real batch depth that really holds writes,
// and a configuration round trip. Two of those five carry a consequence that is
// reported upward rather than buried, and neither is a gap:
//
//   * configuration.save/load round trip THIS HOST'S OWN format, stamped
//     "quackoscope_mock_synthetic_instance_configuration" in the string's own
//     first field. There is no openDAQ instance here to call saveConfiguration
//     on, so a configuration saved here is not loadable by an SDK host and one
//     saved there is refused here with invalid_value naming the format found.
//     The capability is declared because the control it gates -- File > Save
//     configuration and File > Load configuration -- genuinely works against
//     this host end to end.
//   * server.discovery is declared, and the flag it moves is readable only as
//     that server row's component_status_message, because the contract states
//     there is no getter and no Node field for it. Nothing is advertised in
//     either state: these servers bind no socket.
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

/**
 * The two openDAQ mechanisms this host can be asked to switch on, neither of
 * which openDAQ performs in the configuration this app actually runs. Both
 * default to false, and with both false this host's device lock is
 * daq::UserLockImpl driven by the anonymous user, which is what an in-process
 * openDAQ host with no authentication does.
 *
 * NEITHER IS AN INVENTION OF THIS HOST. Each names one real openDAQ code path
 * and turns exactly that path on, so a snippet shown beside it still describes
 * calls that produce what was seen. What they change is openDAQ's
 * CONFIGURATION, not its semantics.
 */
export interface OpenDaqMechanismsToSwitchOn {
  /**
   * Give every socket its own named openDAQ user instead of the anonymous one,
   * as an AuthenticationProvider(allowAnonymous = false) with one account per
   * client would. This is the ONLY way the named-user branches of
   * user_lock_impl.cpp become reachable: lock by a second user then answers
   * OPENDAQ_ERR_DEVICE_LOCKED and unlock by a second user answers
   * OPENDAQ_ERR_ACCESSDENIED, which is the refusal the reference GUI reacts to
   * by offering the forced unlock (gui_demo.py:1394-1407).
   */
  giveEverySocketItsOwnNamedOpenDaqUser: boolean;
  /**
   * Refuse exactly the three writes ConfigServerAccessControl::protectLockedComponent
   * refuses (config_server_access_control.h:75-81) when they arrive over the
   * NATIVE CONFIG PROTOCOL, and no others:
   *
   *   set_property_value                     config_server_component.h:78
   *   set_component_attribute                config_server_component.h:298
   *   load_instance_configuration_from_string  config_server_component.h:319 (Update)
   *
   * NOT set_device_operation_mode: ConfigServerDevice::setOperationMode
   * (config_server_device.h:289-297) carries protectObject and no
   * protectLockedComponent, so even the config-protocol server lets a locked
   * device change mode. This host refused it until the audit that wrote this
   * comment, which was a rule openDAQ has in neither of its two forms.
   *
   * Note what protectLockedComponent checks: `device.isLocked()` and nothing
   * else -- it takes no user, so the session that holds the lock is refused
   * too. openDAQ's core refuses none of these, so an in-process host must not,
   * and with this false none of them is refused here either.
   */
  refuseWritesToALockedDeviceAsTheConfigProtocolServerDoes: boolean;
}

export const NO_OPENDAQ_MECHANISMS_SWITCHED_ON: OpenDaqMechanismsToSwitchOn = {
  giveEverySocketItsOwnNamedOpenDaqUser: false,
  refuseWritesToALockedDeviceAsTheConfigProtocolServerDoes: false,
};

/** Says, at startup, exactly which device lock this process will serve and
 *  which openDAQ source the answer comes from. Printed on every start, in both
 *  configurations, because a lock that behaves differently without saying so is
 *  the defect this whole change exists to remove. */
export function printTheDeviceLockItWillServe(switchedOn: OpenDaqMechanismsToSwitchOn): void {
  console.log(
    "[lock] the device lock is daq::UserLockImpl (openDAQ core/opendaq/device/src/user_lock_impl.cpp), translated: " +
      "lock() and unlock() take no session, because openDAQ has no session concept for a lock",
  );
  if (switchedOn.giveEverySocketItsOwnNamedOpenDaqUser) {
    console.log(
      '[lock] --give-every-socket-its-own-named-opendaq-user is ON: socket N locks as the named user "quackoscope-session-N", ' +
        "as an AuthenticationProvider(allowAnonymous = false) with one account per client would. A second user's " +
        "lock_device is then refused read_only (OPENDAQ_ERR_DEVICE_LOCKED) and its unlock_device read_only " +
        "(OPENDAQ_ERR_ACCESSDENIED); unlock_device force true still succeeds, because that is IDevicePrivate::forceUnlock. " +
        "THE APP DOES NOT RUN THIS WAY: quackoscope configures no authentication provider.",
    );
  } else {
    console.log(
      '[lock] every socket locks as the anonymous openDAQ User("", ""), which is what every connection gets when no ' +
        "AuthenticationProvider is configured (authentication_provider_impl.cpp:23,56). user_lock_impl.cpp:19-20 " +
        "collapses that to nullptr, so the lock is HELD BY NOBODY: a second socket's lock_device succeeds, and its " +
        "unlock_device succeeds, exactly as openDAQ's own LockUnlockAnonymous test asserts (test_device.cpp:399-430). " +
        "Start with --give-every-socket-its-own-named-opendaq-user to reach the named-user refusals instead.",
    );
  }
  if (switchedOn.refuseWritesToALockedDeviceAsTheConfigProtocolServerDoes) {
    console.log(
      "[lock] --refuse-writes-to-a-locked-device-as-the-config-protocol-server-does is ON: exactly three operations " +
        "are refused while the device is locked -- set_property_value (config_server_component.h:78), " +
        "set_component_attribute (:298) and load_instance_configuration_from_string (:319, the Update RPC) -- because " +
        "those are the three that carry ConfigServerAccessControl::protectLockedComponent " +
        "(config_server_access_control.h:75-81). set_device_operation_mode is NOT among them: " +
        "ConfigServerDevice::setOperationMode (config_server_device.h:289-297) carries protectObject and no " +
        "protectLockedComponent, so even the config-protocol server lets a locked device change mode. That check " +
        "takes no user, so the session holding the lock is refused too. THE APP DOES NOT RUN THIS WAY: quackoscope's " +
        "hosts hold an in-process Instance and never cross the native config protocol.",
    );
  } else {
    console.log(
      "[lock] a locked device refuses NO write here: openDAQ's core consults no lock anywhere " +
        "(GenericPropertyObjectImpl::setPropertyValue and ComponentImpl::setName/setActive/setVisible read none), and " +
        "an in-process device.setPropertyValue on a locked device succeeds. Start with " +
        "--refuse-writes-to-a-locked-device-as-the-config-protocol-server-does to switch the config-protocol server's " +
        "guard on instead.",
    );
  }
}

export class SessionHub {
  private device: SyntheticReferenceDevice;
  private sessions = new Map<SessionSocket, SessionState>();
  private nextSubscriptionId = 1;
  private nextSessionOrdinal = 1;
  private readonly switchedOn: OpenDaqMechanismsToSwitchOn;

  constructor(device: SyntheticReferenceDevice, switchedOn: OpenDaqMechanismsToSwitchOn = NO_OPENDAQ_MECHANISMS_SWITCHED_ON) {
    this.device = device;
    this.switchedOn = switchedOn;
    this.device.setEventSink((event) => this.publish(event));
  }

  openSession(socket: SessionSocket): void {
    const sessionKey = `session-${this.nextSessionOrdinal++}`;
    const openDaqUserName = this.switchedOn.giveEverySocketItsOwnNamedOpenDaqUser ? `quackoscope-${sessionKey}` : "";
    this.sessions.set(socket, {
      socket,
      sessionKey,
      describedSession: `${sessionKey} at ${socket.describedPeer}`,
      openDaqUserName,
      deviceNodeIdsByConnectionString: new Map(),
      subscriptions: new Map(),
    });
    console.log(
      `[service] ${sessionKey} counts as openDAQ user ` +
        (openDaqUserName === ""
          ? '"" -- the anonymous User("", "") every connection gets when no AuthenticationProvider is configured, ' +
            "which user_lock_impl.cpp:19-20 collapses to nullptr"
          : `"${openDaqUserName}", because --give-every-socket-its-own-named-opendaq-user is on`),
    );
    socket.sendText(handshakeMessage());
    console.log(
      `[service] session opened for ${socket.describedPeer}; handshake sent (protocol_version ${PROTOCOL_VERSION}, implementation ${HOST_IMPLEMENTATION_NAME} ${HOST_IMPLEMENTATION_VERSION}); ${this.sessions.size} session(s) live`,
    );
  }

  closeSession(socket: SessionSocket): void {
    const state = this.sessions.get(socket);
    if (!state) return;
    for (const subscriptionId of state.subscriptions.keys()) this.device.stopFrameDelivery(subscriptionId);
    // THE LOCK IS NOT RELEASED HERE, and this host used to release it. openDAQ
    // does not: the lock is a field on the device's UserLock, nothing in
    // config_protocol_server.cpp unhooks it when a connection drops, and grep
    // over the SDK finds forceUnlock called from exactly one place -- the
    // "ForceUnlock" RPC a client asks for on purpose. A lock therefore outlives
    // the socket that took it, and the next session finds the device locked.
    // That is not a trap: with no authentication configured the holder is
    // nullptr, so the next session's own unlock_device clears it
    // (user_lock_impl.cpp:31).
    const lockSurvives = this.device.isLocked();
    this.sessions.delete(socket);
    // An open batched update is NOT ended here, and that is a decision this
    // host declines to make rather than one it makes quietly. contract.yaml's
    // begin_batched_property_update row says whether a host must end an
    // abandoned batch on disconnect is unruled, that it is the same question
    // already escalated for device.lock, and that a host must not invent an
    // answer. So the depths stay where they are and this line prints them:
    // Node.updating is what the contract gives the next session to see the
    // abandoned batch with, and it will.
    const openBatchNodeIds = this.device.nodeIdsInsideAnOpenBatch();
    console.log(
      `[service] session closed for ${socket.describedPeer}: ${state.subscriptions.size} subscription(s) and ${state.deviceNodeIdsByConnectionString.size} device holding(s) dropped` +
        `${lockSurvives ? `, and the device lock was LEFT IN PLACE as openDAQ leaves it -- ${this.device.describeLockForTheLog()}` : ""}; ${this.sessions.size} session(s) still live`,
    );
    if (openBatchNodeIds.length > 0) {
      console.log(
        `[service]   ${openBatchNodeIds.length} component(s) are still inside an open batched update and were LEFT ` +
          `there, holding ${this.device.heldPropertyWriteCount()} unapplied property write(s): ` +
          `${openBatchNodeIds.join(", ")}. Every one of them reports Node.updating true, so the next session can see ` +
          "it. Whether a disconnect should have ended those batches, and whether another session may end them, is " +
          "open in contract/contract.yaml and is not answered here.",
      );
    }
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
      case "get_component_attributes":
        return this.getComponentAttributes(state, params);
      case "set_component_attribute":
        return this.setComponentAttribute(state, params);
      case "list_server_types":
        return this.listServerTypes(state);
      case "add_server":
        return this.addServer(state, params);
      case "remove_server":
        return this.removeServer(state, params);
      case "set_server_discovery_enabled":
        return this.setServerDiscoveryEnabled(state, params);
      case "start_recording":
        return this.startRecording(state, params);
      case "stop_recording":
        return this.stopRecording(state, params);
      case "begin_batched_property_update":
        return this.beginBatchedPropertyUpdate(state, params);
      case "end_batched_property_update":
        return this.endBatchedPropertyUpdate(state, params);
      case "save_instance_configuration_to_string":
        return this.saveInstanceConfigurationToString(state);
      case "load_instance_configuration_from_string":
        return this.loadInstanceConfigurationFromString(state, params);
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

  /**
   * ConfigServerAccessControl::protectLockedComponent, and only when this host
   * was told to be a config-protocol server. Returns null when the write may
   * proceed, or the refusal detail when it may not.
   *
   * With the flag off -- the default, and the configuration every SDK host in
   * this repo runs in -- this returns null on a locked device too, because
   * openDAQ's core refuses nothing: GenericPropertyObjectImpl::setPropertyValue
   * consults no lock, and an in-process device.setPropertyValue("X", 3) on a
   * locked device succeeds. A host that refused here would show a lock doing
   * something no openDAQ call in the snippet beside it performs.
   */
  private refusalForAWriteToALockedDevice(what: string): string | null {
    if (!this.switchedOn.refuseWritesToALockedDeviceAsTheConfigProtocolServerDoes) return null;
    if (!this.device.isLocked()) return null;
    return (
      `${this.device.describeLockForTheLog()}, and this host was started with ` +
      "--refuse-writes-to-a-locked-device-as-the-config-protocol-server-does, so " +
      `${what} takes the path config_server_component.h sends every native-config-protocol request down: ` +
      "ConfigServerAccessControl::protectLockedComponent (config_server_access_control.h:75-81) throws " +
      "DeviceLockedException. That function reads device.isLocked() and takes no user, so the session holding the " +
      "lock is refused as well. WITHOUT that flag openDAQ refuses none of this in process, and neither does this host"
    );
  }

  private setPropertyValue(state: SessionState, params: Record<string, unknown>): null {
    this.requireDeviceInSession(state);
    if (!("value" in params)) throw new ServiceRefusal("invalid_value", "params.value is required");
    const nodeId = this.requireNodeReachableFromSession(state, params, "node_id");
    const propertyId = requireStringParam(params, "property_id");
    const lockRefusal = this.refusalForAWriteToALockedDevice(`the write of ${JSON.stringify(params.value)} to ${nodeId}.${propertyId}`);
    if (lockRefusal !== null) {
      throw new ServiceRefusal("read_only", `${lockRefusal}. Nothing was stored; unlock_device on the device row first.`);
    }
    const { stored, appliedNow } = this.device.setPropertyValue(nodeId, propertyId, params.value);
    const coercion =
      JSON.stringify(stored) !== JSON.stringify(params.value)
        ? `coerced: submitted ${JSON.stringify(params.value)}, stored ${JSON.stringify(stored)}`
        : `stored ${JSON.stringify(stored)}`;
    if (appliedNow) {
      console.log(`[service] set_property_value ${nodeId}.${propertyId} ${coercion}`);
    } else {
      console.log(
        `[service] set_property_value ${nodeId}.${propertyId} ${coercion}, but HELD rather than applied: that ` +
          "component is inside an open batched update, so it reports Node.updating true and " +
          "end_batched_property_update is what will apply it. No property_changed event was emitted.",
      );
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
    // errors [not_found, invalid_value, unsupported]: not_connected is NOT on
    // this operation's list, so a session holding no device is refused
    // not_found, the same rule add_function_block follows.
    //
    // THE DEVICE LOCK IS NOT CONSULTED HERE AT ALL, not even behind
    // --refuse-writes-to-a-locked-device-as-the-config-protocol-server-does,
    // and this host used to consult it twice over. Two separate openDAQ facts
    // say not to. (1) Core: GenericDevice::setOperationMode
    // (device_impl.h:1257-1281) reads onGetAvailableOperationModes, takes the
    // tree lock guard and writes -- it consults no user lock. (2) The config
    // protocol server, which is the ONE place in openDAQ a lock refuses
    // anything, does not guard this call either:
    // ConfigServerDevice::setOperationMode (config_server_device.h:289-297) is
    // `protectObject(device, context.user, Permission::Write)` and then
    // `device.setOperationMode(...)`, with NO protectLockedComponent, unlike
    // ConfigServerComponent::setPropertyValue (:78), ::setAttributeValue (:298)
    // and ::update (:319), which all carry it. So there is no configuration of
    // openDAQ, in-process or over the wire, in which a locked device refuses an
    // operation-mode change -- which is why contract.yaml's row no longer
    // carries read_only, and why refusalForAWriteToALockedDevice is not called
    // from here.
    const nodeId = this.requireNodeReachableOrNotFound(state, params, "node_id");
    const mode = requireStringParam(params, "mode");
    this.device.requireDeviceRow(nodeId, "set_device_operation_mode");
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
    this.device.lockDeviceAsUser(nodeId, state.openDaqUserName, state.describedSession);
    console.log(
      `[service] lock_device ${nodeId} for ${state.describedSession}: ${this.device.describeLockForTheLog()}. Every row ` +
        "of that subtree now reports Node.locked true. " +
        (this.switchedOn.refuseWritesToALockedDeviceAsTheConfigProtocolServerDoes
          ? "--refuse-writes-to-a-locked-device-as-the-config-protocol-server-does is on, so set_property_value, " +
            "set_component_attribute and load_instance_configuration_from_string are now refused, THIS SESSION " +
            "INCLUDED. set_device_operation_mode is not: the config-protocol server does not guard it either"
          : "Writes are NOT refused, from this session or any other: openDAQ's core consults no lock, and " +
            "protectLockedComponent lives only in the native config-protocol server"),
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
    this.device.unlockDeviceAsUser(nodeId, state.openDaqUserName, state.describedSession, force);
    console.log(
      `[service] unlock_device ${nodeId} by ${state.describedSession} (force ${force}, which is ` +
        `${force ? "IDevicePrivate::forceUnlock" : "IDevice::unlock"}); the device now reports Node.locked ${this.device.isLocked()}`,
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

  // --- component attributes ------------------------------------------------

  /**
   * errors [not_found, not_connected] -- the same subset
   * get_property_descriptors declares, so the same resolver serves it.
   */
  private getComponentAttributes(state: SessionState, params: Record<string, unknown>): unknown {
    this.requireNodeIdNamesSomethingOrNotFound(params, "get_component_attributes");
    const nodeId = this.requireNodeReachableFromSession(state, params, "node_id");
    const attributes = this.device.getComponentAttributes(nodeId);
    const writable = attributes.filter((attribute) => !attribute.read_only);
    console.log(
      `[service] get_component_attributes ${nodeId} answered with ${attributes.length} attribute(s), ` +
        `${writable.length} of them writable: ` +
        attributes
          .map((attribute) => `${attribute.id}=${JSON.stringify(attribute.value)} (${attribute.value_type}${attribute.read_only ? ", read only" : ""})`)
          .join(", ") +
        ". These are members of the component itself, not entries in its property bag: no PropertyDescriptor on this " +
        "node names any of them.",
    );
    return attributes;
  }

  /**
   * errors [not_found, read_only, invalid_value]. not_connected is NOT on the
   * list, so a session holding no device is refused not_found -- the same rule
   * add_function_block follows.
   */
  private setComponentAttribute(state: SessionState, params: Record<string, unknown>): null {
    if (!("value" in params)) throw new ServiceRefusal("invalid_value", "params.value is required");
    const nodeId = this.requireNodeReachableOrNotFound(state, params, "node_id");
    const attributeId = requireStringParam(params, "attribute_id");
    // config_server_component.h:298 guards setAttributeValue with the same
    // protectLockedComponent call it guards setPropertyValue with, so the two
    // rows answer alike: nothing by default, both refused when this host was
    // told to be a config-protocol server.
    const lockRefusal = this.refusalForAWriteToALockedDevice(`the write of ${JSON.stringify(params.value)} to the attribute ${nodeId}.${attributeId}`);
    if (lockRefusal !== null) {
      throw new ServiceRefusal("read_only", `${lockRefusal}. Nothing was changed; unlock_device on the device row first.`);
    }
    const whatChanged = this.device.setComponentAttribute(nodeId, attributeId, params.value);
    console.log(`[service] set_component_attribute ${nodeId}.${attributeId} for ${state.describedSession}: ${whatChanged}`);
    return null;
  }

  // --- servers ---------------------------------------------------------------

  /** errors [not_connected] only, exactly as list_function_block_types. */
  private listServerTypes(state: SessionState): unknown {
    this.requireDeviceInSession(state);
    const types = this.device.describeServerTypes();
    console.log(
      `[service] list_server_types answered with ${types.length} ComponentTypeInfo row(s), kind "server" on every ` +
        `one: ${this.device.describeServerTypesForTheLog()}. This is what the INSTANCE will accept, and it is not ` +
        "read off list_loaded_modules -- that answers what each module offers, which is only accidentally the same list.",
    );
    return types;
  }

  /**
   * errors [not_connected, unsupported, invalid_value, internal]. There is no
   * parent_id on this row: contract.yaml records that the reference's
   * AddServerDialog stores the selected component and then always calls
   * add_server on the instance, so a parent_id would have exactly one legal
   * value.
   */
  private addServer(state: SessionState, params: Record<string, unknown>): unknown {
    this.requireDeviceInSession(state);
    const typeId = requireStringParam(params, "type_id");
    const node = this.device.addServer(typeId);
    console.log(
      `[service] add_server "${typeId}" for ${state.describedSession} answered with ${node.id} (kind ${node.kind}); ` +
        `component_added was published to ${this.sessions.size} session(s). No socket was bound and no port was ` +
        "opened: the only listening port in this process is the one this WebSocket arrived on.",
    );
    return node;
  }

  /**
   * errors [not_found, unsupported, internal]. not_connected is NOT on the
   * list, so a session holding no device is refused not_found -- the same rule
   * remove_function_block follows.
   */
  private removeServer(state: SessionState, params: Record<string, unknown>): null {
    this.requireNodeIdNamesSomethingOrNotFound(params, "remove_server");
    const nodeId = this.requireNodeReachableOrNotFound(state, params, "node_id");
    this.device.removeServer(nodeId);
    console.log(
      `[service] remove_server ${nodeId} for ${state.describedSession}; component_removed was published to ` +
        `${this.sessions.size} session(s)`,
    );
    return null;
  }

  /**
   * errors [not_found, unsupported, internal].
   *
   * A NON-BOOLEAN `enabled` IS A HOLE IN THE CONTRACT AND IS REPORTED AS ONE.
   * params.enabled is `presence: required, type: bool`, and this row's declared
   * error list carries no code for a request that violates that: not_found
   * would be a claim about a node id that is perfectly good, unsupported is
   * this row's word for "the component is not a server", and internal is for a
   * native failure. This host answers invalid_value, which is in the contract's
   * closed set and is what its own envelope layer already answers for a
   * malformed request (see decodeRequest in ../transport/wire-envelope.ts), and
   * it does not silently coerce a non-boolean into false the way unlock_device
   * is allowed to do with its OPTIONAL force. It is flagged rather than hidden:
   * a sweep that drove this row with a non-boolean would record the refusal as
   * outside the declared subset, and it would be right to.
   */
  private setServerDiscoveryEnabled(state: SessionState, params: Record<string, unknown>): null {
    this.requireNodeIdNamesSomethingOrNotFound(params, "set_server_discovery_enabled");
    const nodeId = this.requireNodeReachableOrNotFound(state, params, "node_id");
    if (typeof params.enabled !== "boolean") {
      throw new ServiceRefusal(
        "invalid_value",
        `params.enabled of set_server_discovery_enabled is a required bool and this request carries ` +
          `${JSON.stringify(params.enabled)}. Nothing was changed. Note that invalid_value is NOT in this ` +
          "operation's declared error list [not_found, unsupported, internal]; the contract gives this row no code " +
          "for a malformed enabled, and this host will not answer not_found about a node id that is fine, nor " +
          "guess a boolean.",
      );
    }
    const whatChanged = this.device.setServerDiscoveryEnabled(nodeId, params.enabled);
    console.log(`[service] set_server_discovery_enabled ${nodeId} by ${state.describedSession}: ${whatChanged}`);
    return null;
  }

  // --- the recorder ----------------------------------------------------------

  /** errors [not_found, unsupported, internal] on both rows. */
  private startRecording(state: SessionState, params: Record<string, unknown>): null {
    this.requireNodeIdNamesSomethingOrNotFound(params, "start_recording");
    const nodeId = this.requireNodeReachableOrNotFound(state, params, "node_id");
    console.log(`[service] start_recording ${nodeId} for ${state.describedSession}: ${this.device.startRecording(nodeId)}`);
    return null;
  }

  private stopRecording(state: SessionState, params: Record<string, unknown>): null {
    this.requireNodeIdNamesSomethingOrNotFound(params, "stop_recording");
    const nodeId = this.requireNodeReachableOrNotFound(state, params, "node_id");
    console.log(`[service] stop_recording ${nodeId} for ${state.describedSession}: ${this.device.stopRecording(nodeId)}`);
    return null;
  }

  // --- batched property updates ----------------------------------------------

  /**
   * errors [not_found, not_connected] on begin, plus invalid_value on end.
   * Neither carries unsupported, because every openDAQ component is an
   * IPropertyObject -- which is why the reference casts unconditionally instead
   * of testing can_cast_from as it does for IRecorder and IServer.
   */
  private beginBatchedPropertyUpdate(state: SessionState, params: Record<string, unknown>): null {
    this.requireNodeIdNamesSomethingOrNotFound(params, "begin_batched_property_update");
    const nodeId = this.requireNodeReachableFromSession(state, params, "node_id");
    console.log(
      `[service] begin_batched_property_update by ${state.describedSession}: ${this.device.beginBatchedPropertyUpdate(nodeId)}`,
    );
    return null;
  }

  private endBatchedPropertyUpdate(state: SessionState, params: Record<string, unknown>): null {
    this.requireNodeIdNamesSomethingOrNotFound(params, "end_batched_property_update");
    const nodeId = this.requireNodeReachableFromSession(state, params, "node_id");
    console.log(
      `[service] end_batched_property_update by ${state.describedSession}: ${this.device.endBatchedPropertyUpdate(nodeId)}`,
    );
    return null;
  }

  // --- instance configuration ------------------------------------------------

  /**
   * errors [not_connected, internal], params none.
   *
   * THE FRAME LIMIT IS CHECKED HERE, BEFORE THE STRING IS SENT, which
   * contract.yaml assigns to the host on this direction: "a result it cannot
   * fit inside its own declared limit is answered internal, whose detail states
   * both numbers". What is measured is the RESULT ENVELOPE the transport will
   * put on the socket, not the bare configuration -- the envelope is what the
   * limit is about - and it is measured with the widest correlation id the wire
   * can carry, so the answer never depends on which request asked.
   */
  private saveInstanceConfigurationToString(state: SessionState): string {
    this.requireDeviceInSession(state);
    const configuration = this.device.saveInstanceConfigurationToString();
    const configurationBytes = Buffer.byteLength(configuration, "utf8");
    const envelopeBytes = Buffer.byteLength(encodeResult(Number.MAX_SAFE_INTEGER, configuration), "utf8");
    if (envelopeBytes > MAX_FRAME_BYTES) {
      throw new ServiceRefusal(
        "internal",
        `the saved configuration does not fit this host's own declared frame limit, so it was not sent: the ` +
          `configuration is ${configurationBytes} bytes, the result envelope carrying it would be ${envelopeBytes} ` +
          `bytes, and handshake.limits.max_frame_bytes is ${MAX_FRAME_BYTES}. Nothing is wrong with the device. On ` +
          `this host the padding is deliberate: ${DEVICE_NODE_ID}.saved_configuration_padding_bytes is ` +
          `${JSON.stringify(this.device.getPropertyValue(DEVICE_NODE_ID, "saved_configuration_padding_bytes"))}; ` +
          "write 0 to it and save again.",
      );
    }
    console.log(
      `[service] save_instance_configuration_to_string answered with ${configurationBytes} bytes ` +
        `(${envelopeBytes} bytes as a result envelope, against max_frame_bytes ${MAX_FRAME_BYTES}). It is NOT an ` +
        "openDAQ saveConfiguration string and says so in its own first two fields: there is no openDAQ instance in " +
        "this process, so this host serialises its synthetic device instead and stamps the format into the value.",
    );
    return configuration;
  }

  /**
   * errors [not_connected, invalid_value, internal].
   *
   * THE DEVICE LOCK IS CHECKED, and answered `internal`, which is one of the
   * two codes contract.yaml names for exactly this: "a locked device inside the
   * instance is a refusal openDAQ raises during the load, which arrives as
   * invalid_value or internal with the native text in detail". read_only is not
   * on this row's list. The check runs before anything is applied, so a refusal
   * here leaves the device untouched rather than half loaded.
   */
  private loadInstanceConfigurationFromString(state: SessionState, params: Record<string, unknown>): null {
    this.requireDeviceInSession(state);
    const configuration = requireStringParam(params, "configuration");
    const lockRefusal = this.refusalForAWriteToALockedDevice(
      `loading a ${configuration.length}-character configuration, which is the Update RPC -- ` +
        "ConfigServerComponent::update at config_server_component.h:317, whose first line, :319, is the guard",
    );
    if (lockRefusal !== null) {
      throw new ServiceRefusal(
        "internal",
        `${lockRefusal}. The check ran before anything was applied, so the device is unchanged; unlock_device first.`,
      );
    }
    const whatHappened = this.device.loadInstanceConfigurationFromString(configuration);
    console.log(`[service] load_instance_configuration_from_string by ${state.describedSession}: ${whatHappened}`);
    return null;
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
