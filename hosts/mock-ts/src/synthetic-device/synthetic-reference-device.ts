// quackoscope-host-mock -- device layer.
//
// The synthetic stand-in for openDAQ's reference device. This is the only file
// that knows what a channel, a waveform or a coercer is; it never sees a
// socket, and the service layer above it speaks only wire DTOs.
//
// It exists so the app runs with no SDK on the machine, and so cases the real
// hosts cannot produce on demand -- a coerced write, a descriptor reshaped by
// another property's write, every code in the closed error set -- are one
// gesture away in the UI.

import { ServiceRefusal } from "../service/wire-errors.ts";

export type NodeComponentStatus = "ok" | "warning" | "error";
export type NodeConnectionStatus = "connected" | "reconnecting" | "unrecoverable" | "removed";
export type NodeOperationMode = "unknown" | "idle" | "operation" | "safe_operation";

export interface Node {
  id: string;
  name: string;
  kind: "device" | "channel" | "function_block" | "signal" | "folder";
  parent_id: string | null;
  child_ids: string[];
  property_ids: string[];
  // The six per-row state fields of contract types.Node. Null means "this host
  // does not report it", and the client then draws no label and no colour. This
  // device reports every field it honestly can, so the only nulls it writes are
  // the two the contract confines to device rows -- connection_status and
  // operation_mode are null on every channel, signal, folder and function block.
  active: boolean | null;
  /** EFFECTIVE lock, inheritance already applied: every component under the
   *  synthetic device reports that device's lock, which is what lock_device and
   *  unlock_device move. */
  locked: boolean | null;
  component_status: NodeComponentStatus | null;
  component_status_message: string | null;
  connection_status: NodeConnectionStatus | null;
  operation_mode: NodeOperationMode | null;
}

/** contract types.ComponentTypeInfo: one component type a module offers. */
export interface ComponentTypeInfo {
  id: string;
  name: string;
  kind: "device" | "function_block" | "server" | "streaming";
  description: string | null;
  connection_string_prefix: string | null;
}

/** contract types.ModuleInfo: one loaded module and the types it offers. */
export interface ModuleInfo {
  id: string;
  name: string;
  version: string | null;
  component_types: ComponentTypeInfo[];
}

export interface PropertyDescriptor {
  id: string;
  name: string;
  value_type: "bool" | "int" | "float" | "string" | "selection" | "struct";
  unit: string | null;
  description: string | null;
  read_only: boolean;
  visible: boolean;
  default: unknown;
  selection_values: string[] | null;
  suggested_values: unknown[] | null;
  min: number | null;
  max: number | null;
  validator: string | null;
  coercer: string | null;
}

export type DeviceEvent =
  | { event: "component_added"; payload: { node: Node } }
  | { event: "component_removed"; payload: { node_id: string } }
  | { event: "property_changed"; payload: { node_id: string; property_id: string; value: unknown } }
  | { event: "property_descriptor_changed"; payload: { node_id: string; descriptor: PropertyDescriptor } }
  | { event: "device_disconnected"; payload: { node_id: string; reason: string } };

/** contract 1.5 DeviceInfo, the record scan_available_devices answers with. */
export interface DeviceInfo {
  connection_string: string;
  name: string;
  serial: string | null;
}

export const DEVICE_NODE_ID = "mock_device0";
const DEACTIVATED_CHANNEL_ID = `${DEVICE_NODE_ID}/io/ai2`;
const OPEN_INPUT_CHANNEL_ID = `${DEVICE_NODE_ID}/io/ai3`;
const SPARE_CHANNEL_ID = `${DEVICE_NODE_ID}/io/ai4`;
const FUNCTION_BLOCK_FOLDER_ID = `${DEVICE_NODE_ID}/fb`;

/**
 * The connection string this synthetic device answers scan_available_devices
 * with. It is deliberately NOT "daqref://device0": nothing in this process
 * loads an openDAQ module, so a string that named openDAQ's reference device
 * would say something untrue about what is behind it. connect_device still
 * accepts any string -- this is the one it advertises.
 *
 * The prefix is split out because list_loaded_modules publishes it as the
 * device type's connection_string_prefix, and the two must be the same string
 * or the Modules view would advertise a prefix no discovery result carries.
 */
export const SYNTHETIC_DEVICE_CONNECTION_STRING_PREFIX = "mock://";
export const SYNTHETIC_DEVICE_CONNECTION_STRING = `${SYNTHETIC_DEVICE_CONNECTION_STRING_PREFIX}synthetic-reference-device0`;

/** The id and name of the one synthetic device type list_loaded_modules
 *  publishes, and what add-device would build if this host served one. */
const SYNTHETIC_DEVICE_TYPE_ID = "mock_synthetic_reference_device";

/**
 * The one module list_loaded_modules answers with. It describes THIS PROCESS:
 * the synthetic component types built in this file, under an id and a name that
 * say "mock" and "synthetic" out loud. It is not an openDAQ module, does not
 * carry an openDAQ module's id, and nothing here was loaded from a .dll.
 */
const SYNTHETIC_MODULE_ID = "mock_synthetic_component_module";
const SYNTHETIC_MODULE_NAME = "Quackoscope mock synthetic component module";
const SYNTHETIC_MODULE_VERSION = "0.1.0";

/**
 * The operation modes this synthetic device offers, which is what
 * get_device_operation_modes answers with. "unknown" is deliberately NOT
 * offered: contract types.Node.operation_mode carries it because openDAQ's
 * OperationModeType has it as the state of a device whose mode could not be
 * read, and a device that knows its own mode never offers it as a destination.
 * A write of "unknown" is refused invalid_value for exactly that reason.
 */
const OFFERED_OPERATION_MODES: readonly NodeOperationMode[] = ["idle", "operation", "safe_operation"];
const OPERATION_MODE_AT_STARTUP: NodeOperationMode = "operation";

const WAVEFORM_SHAPES = ["sine", "square", "triangle", "noise"];

/** Raw samples produced per pump tick, before decimation to pixel_columns. */
const RAW_SAMPLES_PER_TICK = 4096;
const PUMP_INTERVAL_MS = 100;

/** The write deadline the synthetic device claims for its range relay. */
const RANGE_RELAY_DEADLINE_MILLIS = 20000;

function descriptor(partial: Partial<PropertyDescriptor> & Pick<PropertyDescriptor, "id" | "name" | "value_type">): PropertyDescriptor {
  return {
    unit: null,
    description: null,
    read_only: false,
    visible: true,
    default: null,
    selection_values: null,
    suggested_values: null,
    min: null,
    max: null,
    validator: null,
    coercer: null,
    ...partial,
  };
}

/**
 * Builds one tree row with its contract state fields filled in.
 *
 * The defaults are the honest ones for a synthetic component: it is active, it
 * reports ComponentStatus ok with a message saying why, and its two device-only
 * fields are null. connection_status and operation_mode are left null here even
 * for the device row, because both are live values -- they are filled in by
 * nodeAsItCrossesTheWire() at read time, not frozen into the stored row.
 * locked is likewise recomputed there from the device's current lock.
 */
function componentNode(
  partial: Pick<Node, "id" | "name" | "kind" | "parent_id"> &
    Partial<Pick<Node, "active" | "component_status" | "component_status_message">>,
): Node {
  // Written key by key, in the order contract types.Node lists them, so a
  // logged or captured envelope reads in the contract's own order.
  return {
    id: partial.id,
    name: partial.name,
    kind: partial.kind,
    parent_id: partial.parent_id,
    child_ids: [],
    property_ids: [],
    active: partial.active ?? true,
    locked: false,
    component_status: partial.component_status ?? "ok",
    component_status_message: partial.component_status_message ?? null,
    connection_status: null,
    operation_mode: null,
  };
}

/**
 * One row of what this synthetic device knows how to build when
 * add_function_block asks for a type.
 *
 * These ids are the mock's own and are prefixed "synthetic_" on purpose. They
 * are NOT openDAQ's reference function block type ids (RefFBModuleStatistics
 * and friends): no openDAQ module is loaded in this process, so publishing
 * openDAQ's ids here would teach a reader that this device is openDAQ's.
 */
interface SyntheticFunctionBlockType {
  id: string;
  name: string;
  whatItComputes: string;
  buildDescriptors: () => PropertyDescriptor[];
}

const SYNTHETIC_FUNCTION_BLOCK_TYPES: readonly SyntheticFunctionBlockType[] = [
  {
    id: "synthetic_statistics",
    name: "Statistics",
    whatItComputes: "a running mean, RMS or peak-to-peak over a window of the synthetic waveform",
    buildDescriptors: () => [
      descriptor({
        id: "averaging_window_samples",
        name: "Averaging window",
        value_type: "int",
        unit: "samples",
        min: 1,
        max: 4096,
        default: 64,
      }),
      descriptor({
        id: "statistics_output_mode",
        name: "Output mode",
        value_type: "selection",
        selection_values: ["mean", "rms", "peak_to_peak"],
        default: 1,
      }),
    ],
  },
  {
    id: "synthetic_scaling",
    name: "Scaling",
    whatItComputes: "value * scale_factor + offset, relabelled into another unit",
    buildDescriptors: () => [
      descriptor({
        id: "scale_factor",
        name: "Scale factor",
        value_type: "float",
        min: -1000,
        max: 1000,
        default: 1,
        suggested_values: [0.1, 1, 10],
      }),
      descriptor({
        id: "offset_volts",
        name: "Offset",
        value_type: "float",
        unit: "V",
        min: -100,
        max: 100,
        default: 0,
      }),
      descriptor({
        id: "output_unit_symbol",
        name: "Output unit",
        value_type: "string",
        default: "V",
        description: "Free text; the scaled output is relabelled with it.",
      }),
    ],
  },
];

interface ComponentState {
  node: Node;
  descriptors: Map<string, PropertyDescriptor>;
  values: Map<string, unknown>;
}

export class SyntheticReferenceDevice {
  private components = new Map<string, ComponentState>();
  private emit: (event: DeviceEvent) => void = () => {};
  private waveformPhase = 0;
  private domainSampleCounter = 0n;
  private frameSinks = new Map<
    number,
    { signalId: string; deliver: (subscriptionId: number, domainStart: bigint, values: Float64Array) => void }
  >();
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  /** The current device operation mode, which every device row reports as
   *  Node.operation_mode and set_device_operation_mode moves. */
  private operationMode: NodeOperationMode = OPERATION_MODE_AT_STARTUP;
  /** Who holds the device lock, or null when it is unlocked. The token is an
   *  opaque session key handed down by the service layer; this file never
   *  learns what a session is, only that two tokens are or are not equal. */
  private lockHolderToken: string | null = null;
  private lockHolderDescription: string | null = null;

  constructor() {
    this.buildTree();
  }

  setEventSink(sink: (event: DeviceEvent) => void): void {
    this.emit = sink;
  }

  // --- tree ----------------------------------------------------------------

  private addComponent(node: Node, descriptors: PropertyDescriptor[]): void {
    node.property_ids = descriptors.map((d) => d.id);
    const state: ComponentState = {
      node,
      descriptors: new Map(descriptors.map((d) => [d.id, d])),
      values: new Map(descriptors.map((d) => [d.id, d.default])),
    };
    this.components.set(node.id, state);
    if (node.parent_id !== null) {
      const parent = this.components.get(node.parent_id);
      if (parent && !parent.node.child_ids.includes(node.id)) parent.node.child_ids.push(node.id);
    }
  }

  private buildTree(): void {
    this.addComponent(
      componentNode({
        id: DEVICE_NODE_ID,
        name: "Mock Reference Device",
        kind: "device",
        parent_id: null,
        component_status: "ok",
        component_status_message: "the synthetic device was built in memory at process start; every synthetic channel is present",
      }),
      [
        descriptor({
          id: "device_label",
          name: "Device label",
          value_type: "string",
          default: "Mock Reference Device",
          description: "Free text, 1 to 32 characters. A longer label is refused with invalid_value.",
          validator: "len(%Value) >= 1 and len(%Value) <= 32",
        }),
        descriptor({
          id: "serial_number",
          name: "Serial number",
          value_type: "string",
          default: "MOCK-0000-SYNTHETIC",
          read_only: true,
          description: "Burned in at manufacture. Writing it is refused with read_only.",
        }),
        descriptor({
          id: "acquisition_block_size_samples",
          name: "Acquisition block size",
          value_type: "int",
          unit: "samples",
          // The minimum is 0 and not 10 on purpose: the frontend pre-checks min
          // and max locally, so a coercer whose input range sat below its own
          // minimum would never reach the host and the coerced write could not
          // be exercised at all.
          min: 0,
          max: 10000,
          default: 100,
          description:
            "The device rounds every write UP to the next multiple of 10, so writing 7 stores 10. The value on screen must come from the read-back, never from what was submitted.",
          coercer: "10 * ceil(%Value / 10)",
          suggested_values: [10, 100, 1000],
        }),
        descriptor({
          id: "waveform_shape",
          name: "Waveform shape",
          value_type: "selection",
          selection_values: [...WAVEFORM_SHAPES],
          default: 0,
          description:
            "Reshapes two other descriptors: the amplitude bounds and unit, and whether the duty cycle is visible at all.",
        }),
        descriptor({
          id: "waveform_amplitude_volts",
          name: "Waveform amplitude",
          value_type: "float",
          unit: "V",
          min: 0,
          max: 10,
          default: 4,
          description: "Bounds are reshaped by waveform_shape.",
          validator: "%Value >= 0 and %Value <= EvalValue('amplitude ceiling for the current shape')",
        }),
        descriptor({
          id: "waveform_duty_cycle_percent",
          name: "Waveform duty cycle",
          value_type: "float",
          unit: "%",
          min: 1,
          max: 99,
          default: 50,
          visible: false,
          description: "Visible only while waveform_shape is square.",
        }),
        descriptor({
          id: "waveform_frequency_hz",
          name: "Waveform frequency",
          value_type: "float",
          unit: "Hz",
          min: 0.1,
          max: 200,
          default: 3,
          description: "Cycles across one full plot window.",
        }),
        descriptor({
          id: "frame_emission_enabled",
          name: "Emit frames",
          value_type: "bool",
          default: true,
          description: "While false the data plane goes quiet and no binary frame is sent for any subscription.",
        }),
        descriptor({
          id: "spare_channel_present",
          name: "Spare channel fitted",
          value_type: "bool",
          default: false,
          description: `Writing true adds ${SPARE_CHANNEL_ID} and its signal (component_added); writing false removes them (component_removed).`,
        }),
        descriptor({
          id: "device_disconnect_simulation_switch",
          name: "Simulate a device disconnect",
          value_type: "bool",
          default: false,
          description: "Writing true emits device_disconnected and drops the device out of every session.",
        }),
        descriptor({
          id: "internal_error_injection_switch",
          name: "Inject an internal error",
          value_type: "bool",
          default: false,
          description: "Writing true is answered with the internal error code and stores nothing.",
        }),
        descriptor({
          id: "unsupported_operation_example_struct",
          name: "Trigger condition (struct)",
          value_type: "struct",
          default: { edge: "rising", level_volts: 2.5 },
          description: "Structs are display-only in M1: writing this is answered with unsupported.",
        }),
        descriptor({
          id: "factory_calibration_seed",
          name: "Factory calibration seed",
          value_type: "int",
          default: 8419,
          visible: false,
          read_only: true,
          description: "Invisible in the grid on purpose; get_property_descriptors still reports it.",
        }),
      ],
    );

    this.addComponent(
      componentNode({
        id: `${DEVICE_NODE_ID}/io`,
        name: "IO",
        kind: "folder",
        parent_id: DEVICE_NODE_ID,
        component_status_message: "the IO folder holds every synthetic analog input channel this device fits",
      }),
      [],
    );
    this.addComponent(
      componentNode({
        id: FUNCTION_BLOCK_FOLDER_ID,
        name: "Function blocks",
        kind: "folder",
        parent_id: DEVICE_NODE_ID,
        component_status_message: "the function block folder holds the block fitted at startup and every block add_function_block fits",
      }),
      [],
    );

    // Four channels at startup rather than two, because three of the six
    // contract Node state fields have no other way to be seen. A real openDAQ
    // reference device is active, unlocked and ComponentStatus ok on every row
    // it has, and will not produce a warning or an error on demand -- so this
    // device carries one of each, permanently, and says in each row's
    // component_status_message that the state is synthesised.
    this.addChannelWithSignal(`${DEVICE_NODE_ID}/io/ai0`, "AnalogInput 0", "AI0", {
      componentStatus: "ok",
      componentStatusMessage: "self test passed at process start; the synthetic calibration is valid",
    });
    this.addChannelWithSignal(`${DEVICE_NODE_ID}/io/ai1`, "AnalogInput 1", "AI1", {
      componentStatus: "warning",
      componentStatusMessage:
        "the synthetic input auto-ranged 3 times in the last minute; the source sits near full scale. This warning is " +
        "permanent and synthesised: it exists so the tree's warning colour can be seen without waiting for a real device to misbehave.",
    });
    this.addChannelWithSignal(DEACTIVATED_CHANNEL_ID, "AnalogInput 2 (deactivated)", "AI2", {
      active: false,
      componentStatus: "ok",
      componentStatusMessage:
        "switched off at process start, so one row draws the [inactive] label with no write. Nothing is wrong with it: " +
        "IComponent.active is false and ComponentStatus is still ok.",
      enabledForAcquisition: false,
    });
    this.addChannelWithSignal(OPEN_INPUT_CHANNEL_ID, "AnalogInput 3 (open input)", "AI3", {
      componentStatus: "error",
      componentStatusMessage:
        "no source is wired to this synthetic input: the front end reads open circuit and this channel produces nothing. " +
        "This error is permanent and synthesised, so the tree's error colour can be seen on demand.",
      enabledForAcquisition: false,
    });

    // The one function block fitted at startup is built from the same
    // catalogue entry add_function_block builds from, so what
    // list_function_block_types names is exactly what this device can make.
    const statisticsType = SYNTHETIC_FUNCTION_BLOCK_TYPES[0];
    this.addComponent(
      componentNode({
        id: `${FUNCTION_BLOCK_FOLDER_ID}/statistics`,
        name: statisticsType.name,
        kind: "function_block",
        parent_id: FUNCTION_BLOCK_FOLDER_ID,
        component_status_message: `fitted at process start from catalogue type "${statisticsType.id}"; it computes ${statisticsType.whatItComputes}`,
      }),
      statisticsType.buildDescriptors(),
    );
  }

  private addChannelWithSignal(
    channelId: string,
    channelName: string,
    signalName: string,
    state: {
      active?: boolean;
      componentStatus?: NodeComponentStatus;
      componentStatusMessage?: string;
      enabledForAcquisition?: boolean;
    } = {},
  ): Node {
    const active = state.active ?? true;
    this.addComponent(
      componentNode({
        id: channelId,
        name: channelName,
        kind: "channel",
        parent_id: `${DEVICE_NODE_ID}/io`,
        active,
        component_status: state.componentStatus ?? "ok",
        component_status_message: state.componentStatusMessage ?? `${channelName} is fitted and reports nothing unusual`,
      }),
      [
        descriptor({
          id: "channel_gain_volts_per_volt",
          name: "Gain",
          value_type: "float",
          unit: "V/V",
          min: 0.1,
          max: 100,
          default: 1,
          suggested_values: [0.1, 1, 10, 100],
        }),
        descriptor({
          id: "channel_coupling_mode",
          name: "Coupling",
          value_type: "selection",
          selection_values: ["dc", "ac", "ground"],
          default: 0,
        }),
        descriptor({
          id: "channel_enabled_for_acquisition",
          name: "Enabled for acquisition",
          value_type: "bool",
          default: true,
        }),
        descriptor({
          id: "range_relay_settling_millis",
          name: "Range relay settling time",
          value_type: "int",
          unit: "ms",
          min: 0,
          max: 60000,
          default: 5,
          description: `A write above ${RANGE_RELAY_DEADLINE_MILLIS} ms is answered with the timeout code, because the relay never reports settled.`,
        }),
        descriptor({
          id: "channel_hardware_identifier",
          name: "Hardware identifier",
          value_type: "string",
          default: `${channelName} @ synthetic backplane slot 0`,
          read_only: true,
        }),
      ],
    );

    const signalId = `${channelId}/signal`;
    this.addComponent(
      componentNode({
        id: signalId,
        name: signalName,
        kind: "signal",
        parent_id: channelId,
        // IComponent.active is per component, and openDAQ does not derive a
        // signal's from its channel's -- but a signal on a channel this device
        // switched off carries no samples either, so it is switched off with it
        // and says so rather than claiming to be running.
        active,
        component_status_message: active
          ? `${signalName} carries the synthetic waveform of ${channelName}`
          : `${signalName} carries nothing: its channel ${channelName} is deactivated`,
      }),
      [
        descriptor({ id: "signal_unit_symbol", name: "Unit", value_type: "string", default: "V", read_only: true }),
        descriptor({
          id: "signal_sample_rate_hz",
          name: "Sample rate",
          value_type: "float",
          unit: "Hz",
          default: 40960,
          read_only: true,
        }),
      ],
    );
    if (state.enabledForAcquisition === false) {
      // The stored value, not the descriptor default: the descriptor still
      // says the default is true, and this channel simply is not enabled now.
      this.components.get(channelId)!.values.set("channel_enabled_for_acquisition", false);
    }
    return this.components.get(channelId)!.node;
  }

  // --- reads ---------------------------------------------------------------

  private requireComponent(nodeId: string): ComponentState {
    const state = this.components.get(nodeId);
    if (!state) {
      throw new ServiceRefusal(
        "not_found",
        `no component with id "${nodeId}" on ${DEVICE_NODE_ID}; this synthetic device holds ${this.components.size} components`,
      );
    }
    return state;
  }

  /**
   * The row as the wire must see it: the stored component state, with the
   * three LIVE fields recomputed at read time rather than served from a copy
   * that could have gone stale.
   *
   *   locked            the device's current lock, applied to every row under
   *                     it, which is the "effective, inheritance applied"
   *                     contract types.Node.locked asks for.
   *   connection_status device rows only. This process holds the device in
   *                     memory and cannot lose it, so it is always "connected".
   *   operation_mode    device rows only; whatever set_device_operation_mode
   *                     last stored.
   */
  private nodeAsItCrossesTheWire(nodeId: string): Node {
    const stored = this.requireComponent(nodeId).node;
    const isDeviceRow = stored.kind === "device";
    return {
      ...stored,
      child_ids: [...stored.child_ids],
      property_ids: [...stored.property_ids],
      locked: this.lockHolderToken !== null,
      connection_status: isDeviceRow ? "connected" : null,
      operation_mode: isDeviceRow ? this.operationMode : null,
    };
  }

  getDeviceNode(): Node {
    return this.nodeAsItCrossesTheWire(DEVICE_NODE_ID);
  }

  componentCount(): number {
    return this.components.size;
  }

  /** The subtree rooted at rootId, depth-first, root first. */
  getComponentTree(rootId: string): Node[] {
    const root = this.requireComponent(rootId);
    const flattened: Node[] = [];
    const walk = (state: ComponentState): void => {
      flattened.push(this.nodeAsItCrossesTheWire(state.node.id));
      for (const childId of state.node.child_ids) {
        const child = this.components.get(childId);
        if (child) walk(child);
      }
    };
    walk(root);
    return flattened;
  }

  getPropertyDescriptors(nodeId: string): PropertyDescriptor[] {
    return [...this.requireComponent(nodeId).descriptors.values()];
  }

  /** Every node id of the subtree rooted at rootId, deepest first. */
  subtreeNodeIdsDeepestFirst(rootId: string): string[] {
    return this.getComponentTree(rootId)
      .map((node) => node.id)
      .reverse();
  }

  // --- discovery -----------------------------------------------------------

  /**
   * What this host answers scan_available_devices with: itself, and nothing
   * else. There is no discovery protocol in this process and no network to
   * sweep -- the one device that exists here is the one synthesised in this
   * file, so the honest scan result is a single entry naming it.
   *
   * name and serial are read live rather than hard-coded, so a write to
   * device_label shows up in the next scan.
   */
  describeItselfForDiscovery(): DeviceInfo {
    const device = this.components.get(DEVICE_NODE_ID)!;
    const label = device.values.get("device_label");
    const serial = device.values.get("serial_number");
    return {
      connection_string: SYNTHETIC_DEVICE_CONNECTION_STRING,
      name: typeof label === "string" ? label : device.node.name,
      serial: typeof serial === "string" ? serial : null,
    };
  }

  // --- device operation mode -----------------------------------------------

  /**
   * Refuses `unsupported` when the id names a component that is not a device.
   * The node EXISTS -- not_found would be a lie about it -- and it has no
   * operation modes and no lock of its own, which is exactly what
   * contract.yaml says unsupported means on these four rows.
   */
  requireDeviceRow(nodeId: string, wireMethod: string): void {
    const state = this.requireComponent(nodeId);
    if (state.node.kind !== "device") {
      throw new ServiceRefusal(
        "unsupported",
        `"${nodeId}" is a ${state.node.kind}, not a device; ${wireMethod} acts on device rows only, and the one device ` +
          `on this host is "${DEVICE_NODE_ID}"`,
      );
    }
  }

  /** The modes get_device_operation_modes answers with, as the wire spells
   *  them: the values of contract types.Node.operation_mode. */
  availableOperationModes(): string[] {
    return [...OFFERED_OPERATION_MODES];
  }

  currentOperationMode(): NodeOperationMode {
    return this.operationMode;
  }

  describeOfferedOperationModes(): string {
    return OFFERED_OPERATION_MODES.join(", ");
  }

  /**
   * Moves the device operation mode and returns the mode now in force. The
   * caller has already checked the lock, because the lock is a fact about a
   * session and this file knows nothing about sessions.
   */
  setOperationMode(nodeId: string, mode: string): NodeOperationMode {
    this.requireDeviceRow(nodeId, "set_device_operation_mode");
    if (!OFFERED_OPERATION_MODES.includes(mode as NodeOperationMode)) {
      throw new ServiceRefusal(
        "invalid_value",
        `"${mode}" is not a mode this device offers; get_device_operation_modes on "${nodeId}" answers ` +
          `${this.describeOfferedOperationModes()}. The device is in "${this.operationMode}" and stays there.`,
      );
    }
    const previous = this.operationMode;
    this.operationMode = mode as NodeOperationMode;
    console.log(
      `[device] set_device_operation_mode moved ${nodeId} from "${previous}" to "${this.operationMode}"; ` +
        `every device row now reports operation_mode "${this.operationMode}"`,
    );
    return this.operationMode;
  }

  // --- device lock ---------------------------------------------------------

  isLocked(): boolean {
    return this.lockHolderToken !== null;
  }

  /** null when the caller may write, or the refusal detail when it may not. */
  lockRefusalFacing(sessionToken: string): string | null {
    if (this.lockHolderToken === null || this.lockHolderToken === sessionToken) return null;
    return `the device "${DEVICE_NODE_ID}" is locked by ${this.lockHolderDescription}, which is not this session`;
  }

  lockDevice(nodeId: string, sessionToken: string, sessionDescription: string): void {
    this.requireDeviceRow(nodeId, "lock_device");
    if (this.lockHolderToken !== null && this.lockHolderToken !== sessionToken) {
      throw new ServiceRefusal(
        "read_only",
        `"${nodeId}" is already locked by ${this.lockHolderDescription}; openDAQ permits an unlock only by the holder, ` +
          "so this session can neither take the lock nor drop it. unlock_device with force true is the way past it.",
      );
    }
    const wasAlreadyHeldHere = this.lockHolderToken === sessionToken;
    this.lockHolderToken = sessionToken;
    this.lockHolderDescription = sessionDescription;
    console.log(
      `[device] lock_device ${nodeId}: the lock is ${wasAlreadyHeldHere ? "still" : "now"} held by ${sessionDescription}; ` +
        `all ${this.components.size} rows under it report locked true`,
    );
  }

  unlockDevice(nodeId: string, sessionToken: string, sessionDescription: string, force: boolean): void {
    this.requireDeviceRow(nodeId, "unlock_device");
    if (this.lockHolderToken === null) {
      console.log(`[device] unlock_device ${nodeId}: it was not locked, so nothing changed`);
      return;
    }
    if (this.lockHolderToken !== sessionToken && !force) {
      throw new ServiceRefusal(
        "read_only",
        `"${nodeId}" is locked by ${this.lockHolderDescription}, not by this session, and openDAQ's IDevice.unlock() ` +
          "refuses an unlock by anyone else. Send unlock_device again with force true to take it anyway.",
      );
    }
    const takenFrom = this.lockHolderDescription;
    const wasForced = this.lockHolderToken !== sessionToken;
    this.lockHolderToken = null;
    this.lockHolderDescription = null;
    console.log(
      `[device] unlock_device ${nodeId}: the lock held by ${takenFrom} was ${wasForced ? "FORCED open" : "released"} by ` +
        `${sessionDescription}; all ${this.components.size} rows under it report locked false`,
    );
  }

  /** Drops the lock when the session that took it goes away. Does nothing if
   *  that session was not the holder. */
  releaseLockHeldBy(sessionToken: string, sessionDescription: string): void {
    if (this.lockHolderToken !== sessionToken) return;
    this.lockHolderToken = null;
    this.lockHolderDescription = null;
    console.log(
      `[device] the device lock held by ${sessionDescription} was released because that session closed; ` +
        `"${DEVICE_NODE_ID}" and every row under it report locked false again`,
    );
  }

  // --- modules -------------------------------------------------------------

  /**
   * What list_loaded_modules answers with.
   *
   * This process loads no module: there is no ModuleManager and no .dll behind
   * any of this. What there IS is a real catalogue of component types this file
   * can build, and that catalogue is what one entry describes -- the device
   * type scan_available_devices advertises, and the function block types
   * list_function_block_types names. The function block rows are MAPPED from
   * SYNTHETIC_FUNCTION_BLOCK_TYPES, the same array add_function_block builds
   * from, so the Modules view and the add-function-block menu cannot drift
   * apart. No openDAQ module id appears here; the id, the name and every type
   * id say "mock" or "synthetic" out loud.
   *
   * No server or streaming type is listed, because this device offers none:
   * the WebSocket in hosts/mock-ts/src/transport/ is this host's own control
   * plane, not an openDAQ streaming type, and listing it as one would be the
   * invention this entry is careful not to make.
   */
  describeLoadedModules(): ModuleInfo[] {
    const componentTypes: ComponentTypeInfo[] = [
      {
        id: SYNTHETIC_DEVICE_TYPE_ID,
        name: "Mock Reference Device",
        kind: "device",
        description:
          "The synthetic device this host builds in memory at process start. scan_available_devices answers with exactly " +
          "one of these and connect_device hands back its root node.",
        connection_string_prefix: SYNTHETIC_DEVICE_CONNECTION_STRING_PREFIX,
      },
      ...SYNTHETIC_FUNCTION_BLOCK_TYPES.map((type): ComponentTypeInfo => ({
        id: type.id,
        name: type.name,
        kind: "function_block",
        description: `Computes ${type.whatItComputes}.`,
        connection_string_prefix: null,
      })),
    ];
    return [
      {
        id: SYNTHETIC_MODULE_ID,
        name: SYNTHETIC_MODULE_NAME,
        version: SYNTHETIC_MODULE_VERSION,
        component_types: componentTypes,
      },
    ];
  }

  describeLoadedModulesForTheLog(): string {
    return this.describeLoadedModules()
      .map(
        (module) =>
          `${module.id} "${module.name}" ${module.version ?? "no version"} offering ` +
          module.component_types.map((type) => `${type.id} (${type.kind})`).join(", "),
      )
      .join("; ");
  }

  // --- function blocks -----------------------------------------------------

  /** The type ids add_function_block accepts, in catalogue order. */
  listFunctionBlockTypeIds(): string[] {
    return SYNTHETIC_FUNCTION_BLOCK_TYPES.map((type) => type.id);
  }

  describeFunctionBlockTypes(): string {
    return SYNTHETIC_FUNCTION_BLOCK_TYPES.map((type) => `${type.id} (${type.name}: ${type.whatItComputes})`).join(", ");
  }

  functionBlockFolderId(): string {
    return FUNCTION_BLOCK_FOLDER_ID;
  }

  /**
   * Fits one function block of the named type and emits component_added.
   * Bookkeeping only: the block computes nothing, it holds the properties its
   * catalogue entry describes and appears in the tree.
   */
  addFunctionBlock(parentId: string, typeId: string): Node {
    const parent = this.requireComponent(parentId);
    if (parentId !== FUNCTION_BLOCK_FOLDER_ID && parentId !== DEVICE_NODE_ID) {
      throw new ServiceRefusal(
        "unsupported",
        `"${parentId}" is a ${parent.node.kind}; this synthetic device fits function blocks only under ` +
          `"${FUNCTION_BLOCK_FOLDER_ID}" (or under "${DEVICE_NODE_ID}", which means that folder)`,
      );
    }
    const type = SYNTHETIC_FUNCTION_BLOCK_TYPES.find((candidate) => candidate.id === typeId);
    if (!type) {
      throw new ServiceRefusal(
        "unsupported",
        `no function block type "${typeId}" on this synthetic device; it can build ${this.describeFunctionBlockTypes()}`,
      );
    }

    let ordinal = 1;
    while (this.components.has(`${FUNCTION_BLOCK_FOLDER_ID}/${typeId}_${ordinal}`)) ordinal++;
    const nodeId = `${FUNCTION_BLOCK_FOLDER_ID}/${typeId}_${ordinal}`;

    this.addComponent(
      componentNode({
        id: nodeId,
        name: `${type.name} ${ordinal}`,
        kind: "function_block",
        parent_id: FUNCTION_BLOCK_FOLDER_ID,
        component_status_message: `fitted by add_function_block from catalogue type "${type.id}"; it computes ${type.whatItComputes}`,
      }),
      type.buildDescriptors(),
    );
    const node = this.nodeAsItCrossesTheWire(nodeId);
    this.emit({ event: "component_added", payload: { node } });
    console.log(
      `[device] add_function_block built ${nodeId} from type "${typeId}" under ${FUNCTION_BLOCK_FOLDER_ID} ` +
        `(asked for parent "${parentId}"), with ${node.property_ids.length} propert(ies): ${node.property_ids.join(", ")}`,
    );
    return node;
  }

  /** Removes a function block and its subtree, emitting component_removed for each. */
  removeFunctionBlock(nodeId: string): void {
    const state = this.requireComponent(nodeId);
    if (state.node.kind !== "function_block") {
      throw new ServiceRefusal(
        "not_found",
        `"${nodeId}" is a ${state.node.kind}, not a function block; remove_function_block takes the node id ` +
          "add_function_block answered with",
      );
    }
    const removedIds = this.subtreeNodeIdsDeepestFirst(nodeId);
    for (const removedId of removedIds) {
      this.components.delete(removedId);
      this.emit({ event: "component_removed", payload: { node_id: removedId } });
    }
    const parent = this.components.get(state.node.parent_id ?? "");
    if (parent) parent.node.child_ids = parent.node.child_ids.filter((childId) => childId !== nodeId);
    console.log(
      `[device] remove_function_block took ${removedIds.length} component(s) out of the tree: ${removedIds.join(", ")}`,
    );
  }

  getPropertyValue(nodeId: string, propertyId: string): unknown {
    const state = this.requireComponent(nodeId);
    if (!state.descriptors.has(propertyId)) {
      throw new ServiceRefusal(
        "not_found",
        `component "${nodeId}" has no property "${propertyId}"; it has ${[...state.descriptors.keys()].join(", ") || "none"}`,
      );
    }
    return state.values.get(propertyId) ?? null;
  }

  // --- writes --------------------------------------------------------------

  /**
   * Applies one write and returns the value the device actually stored, which
   * is not necessarily the value submitted. Every event the write raises is
   * pushed through the event sink before this returns.
   */
  setPropertyValue(nodeId: string, propertyId: string, submitted: unknown): unknown {
    const state = this.requireComponent(nodeId);
    const property = state.descriptors.get(propertyId);
    if (!property) {
      throw new ServiceRefusal(
        "not_found",
        `component "${nodeId}" has no property "${propertyId}"; it has ${[...state.descriptors.keys()].join(", ") || "none"}`,
      );
    }
    if (property.value_type === "struct") {
      throw new ServiceRefusal(
        "unsupported",
        `property "${propertyId}" on "${nodeId}" is a struct; this host serves structs read-only in M1 and cannot write one`,
      );
    }
    if (property.read_only) {
      throw new ServiceRefusal(
        "read_only",
        `property "${propertyId}" on "${nodeId}" is read only; it holds ${JSON.stringify(state.values.get(propertyId))}`,
      );
    }

    if (nodeId === DEVICE_NODE_ID && propertyId === "internal_error_injection_switch" && submitted === true) {
      throw new ServiceRefusal(
        "internal",
        `internal_error_injection_switch was written true on ${nodeId}: this is the synthetic device raising the internal code on purpose, so the frontend's handling of it can be exercised. Nothing was stored.`,
      );
    }
    if (propertyId === "range_relay_settling_millis" && typeof submitted === "number" && submitted > RANGE_RELAY_DEADLINE_MILLIS) {
      throw new ServiceRefusal(
        "timeout",
        `the range relay on "${nodeId}" was asked to settle in ${submitted} ms and never reported settled within the device deadline of ${RANGE_RELAY_DEADLINE_MILLIS} ms; the write was abandoned`,
      );
    }

    const stored = this.coerceAndValidate(nodeId, property, submitted);
    state.values.set(propertyId, stored);
    this.emit({ event: "property_changed", payload: { node_id: nodeId, property_id: propertyId, value: stored } });

    if (nodeId === DEVICE_NODE_ID && propertyId === "waveform_shape") {
      this.reshapeWaveformDescriptorsFor(Number(stored));
    }
    if (nodeId === DEVICE_NODE_ID && propertyId === "spare_channel_present") {
      if (stored === true) this.fitSpareChannel();
      else this.removeSpareChannel();
    }
    if (nodeId === DEVICE_NODE_ID && propertyId === "device_disconnect_simulation_switch" && stored === true) {
      state.values.set(propertyId, false);
      this.emit({
        event: "device_disconnected",
        payload: {
          node_id: DEVICE_NODE_ID,
          reason: "device_disconnect_simulation_switch was written true on the synthetic device",
        },
      });
    }
    return stored;
  }

  private coerceAndValidate(nodeId: string, property: PropertyDescriptor, submitted: unknown): unknown {
    switch (property.value_type) {
      case "bool": {
        if (typeof submitted !== "boolean") {
          throw new ServiceRefusal(
            "invalid_value",
            `property "${property.id}" on "${nodeId}" is a bool; got ${JSON.stringify(submitted)}`,
          );
        }
        return submitted;
      }
      case "string": {
        if (typeof submitted !== "string") {
          throw new ServiceRefusal(
            "invalid_value",
            `property "${property.id}" on "${nodeId}" is a string; got ${JSON.stringify(submitted)}`,
          );
        }
        if (property.id === "device_label" && (submitted.length < 1 || submitted.length > 32)) {
          throw new ServiceRefusal(
            "invalid_value",
            `device_label must be 1 to 32 characters; "${submitted}" is ${submitted.length}`,
          );
        }
        return submitted;
      }
      case "selection": {
        const options = property.selection_values ?? [];
        let index: number;
        if (typeof submitted === "number") index = submitted;
        else if (typeof submitted === "string") index = options.indexOf(submitted);
        else index = -1;
        if (!Number.isInteger(index) || index < 0 || index >= options.length) {
          throw new ServiceRefusal(
            "invalid_value",
            `property "${property.id}" on "${nodeId}" accepts ${options.map((o, i) => `${i}=${o}`).join(", ")}; got ${JSON.stringify(submitted)}`,
          );
        }
        return index;
      }
      case "int":
      case "float": {
        if (typeof submitted !== "number" || Number.isNaN(submitted)) {
          throw new ServiceRefusal(
            "invalid_value",
            `property "${property.id}" on "${nodeId}" is a ${property.value_type}; got ${JSON.stringify(submitted)}`,
          );
        }
        let value = property.value_type === "int" ? Math.round(submitted) : submitted;

        // The one coercer in this device. It runs BEFORE the bounds are
        // enforced, so a write of 7 becomes 10 and lands inside [10, 10000]
        // instead of being refused.
        if (property.id === "acquisition_block_size_samples") {
          value = Math.ceil(value / 10) * 10;
        }

        if (property.min !== null && value < property.min) {
          throw new ServiceRefusal(
            "invalid_value",
            `property "${property.id}" on "${nodeId}" accepts [${property.min}, ${property.max}]; ${value} is below the minimum`,
          );
        }
        if (property.max !== null && value > property.max) {
          throw new ServiceRefusal(
            "invalid_value",
            `property "${property.id}" on "${nodeId}" accepts [${property.min}, ${property.max}]; ${value} is above the maximum`,
          );
        }
        return value;
      }
      default:
        throw new ServiceRefusal(
          "unsupported",
          `property "${property.id}" on "${nodeId}" has value_type "${property.value_type}", which this host cannot write`,
        );
    }
  }

  /**
   * Writing waveform_shape rewrites two other descriptors on the same node, so
   * the frontend's descriptor-refresh path has something real to react to: the
   * amplitude ceiling moves, and the duty cycle appears and disappears.
   */
  private reshapeWaveformDescriptorsFor(shapeIndex: number): void {
    const shape = WAVEFORM_SHAPES[shapeIndex] ?? "sine";
    const device = this.components.get(DEVICE_NODE_ID)!;

    const amplitudeCeilingByShape: Record<string, number> = { sine: 10, square: 5, triangle: 8, noise: 1 };
    const ceiling = amplitudeCeilingByShape[shape] ?? 10;

    const amplitude = { ...device.descriptors.get("waveform_amplitude_volts")! };
    amplitude.max = ceiling;
    amplitude.description = `Bounds reshaped by waveform_shape: a ${shape} wave on this device is limited to ${ceiling} V.`;
    device.descriptors.set(amplitude.id, amplitude);
    const heldAmplitude = Number(device.values.get(amplitude.id));
    if (heldAmplitude > ceiling) {
      device.values.set(amplitude.id, ceiling);
      this.emit({
        event: "property_changed",
        payload: { node_id: DEVICE_NODE_ID, property_id: amplitude.id, value: ceiling },
      });
    }
    this.emit({ event: "property_descriptor_changed", payload: { node_id: DEVICE_NODE_ID, descriptor: amplitude } });

    const dutyCycle = { ...device.descriptors.get("waveform_duty_cycle_percent")! };
    dutyCycle.visible = shape === "square";
    dutyCycle.description = dutyCycle.visible
      ? "Visible because waveform_shape is square."
      : `Hidden because waveform_shape is ${shape}; only a square wave has a duty cycle.`;
    device.descriptors.set(dutyCycle.id, dutyCycle);
    this.emit({ event: "property_descriptor_changed", payload: { node_id: DEVICE_NODE_ID, descriptor: dutyCycle } });
  }

  private fitSpareChannel(): void {
    if (this.components.has(SPARE_CHANNEL_ID)) return;
    this.addChannelWithSignal(SPARE_CHANNEL_ID, "AnalogInput 4 (spare)", "AI4", {
      componentStatusMessage: "fitted just now by writing spare_channel_present true on the device",
    });
    this.emit({ event: "component_added", payload: { node: this.nodeAsItCrossesTheWire(SPARE_CHANNEL_ID) } });
    this.emit({ event: "component_added", payload: { node: this.nodeAsItCrossesTheWire(`${SPARE_CHANNEL_ID}/signal`) } });
  }

  private removeSpareChannel(): void {
    if (!this.components.has(SPARE_CHANNEL_ID)) return;
    for (const id of [`${SPARE_CHANNEL_ID}/signal`, SPARE_CHANNEL_ID]) {
      this.components.delete(id);
      this.emit({ event: "component_removed", payload: { node_id: id } });
    }
    const io = this.components.get(`${DEVICE_NODE_ID}/io`)!;
    io.node.child_ids = io.node.child_ids.filter((id) => id !== SPARE_CHANNEL_ID);
  }

  // --- data plane ----------------------------------------------------------

  requireSignal(signalId: string): void {
    const state = this.requireComponent(signalId);
    if (state.node.kind !== "signal") {
      throw new ServiceRefusal(
        "invalid_value",
        `"${signalId}" is a ${state.node.kind}, not a signal; only a signal can be subscribed`,
      );
    }
  }

  startFrameDelivery(
    signalId: string,
    subscriptionId: number,
    deliver: (subscriptionId: number, domainStart: bigint, values: Float64Array) => void,
  ): void {
    this.frameSinks.set(subscriptionId, { signalId, deliver });
    if (this.pumpTimer === null) {
      this.pumpTimer = setInterval(() => this.emitOneWaveformBlockToEverySubscription(), PUMP_INTERVAL_MS);
      console.log(
        `[device] waveform pump started: ${RAW_SAMPLES_PER_TICK} raw samples every ${PUMP_INTERVAL_MS} ms per live subscription`,
      );
    }
  }

  stopFrameDelivery(subscriptionId: number): void {
    this.frameSinks.delete(subscriptionId);
    if (this.frameSinks.size === 0 && this.pumpTimer !== null) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
      console.log("[device] waveform pump stopped: no live subscription remains");
    }
  }

  private emitOneWaveformBlockToEverySubscription(): void {
    const device = this.components.get(DEVICE_NODE_ID)!;
    if (device.values.get("frame_emission_enabled") !== true) return;

    const shape = WAVEFORM_SHAPES[Number(device.values.get("waveform_shape")) ?? 0] ?? "sine";
    const amplitude = Number(device.values.get("waveform_amplitude_volts"));
    const dutyCycle = Number(device.values.get("waveform_duty_cycle_percent")) / 100;
    const cyclesPerBlock = Number(device.values.get("waveform_frequency_hz"));

    for (const [subscriptionId, sink] of this.frameSinks) {
      const channelId = sink.signalId.slice(0, sink.signalId.lastIndexOf("/"));
      const channel = this.components.get(channelId);
      if (!channel || channel.values.get("channel_enabled_for_acquisition") !== true) continue;
      const gain = Number(channel.values.get("channel_gain_volts_per_volt"));

      const samples = new Float64Array(RAW_SAMPLES_PER_TICK);
      for (let i = 0; i < RAW_SAMPLES_PER_TICK; i++) {
        const turns = this.waveformPhase + (cyclesPerBlock * i) / RAW_SAMPLES_PER_TICK;
        const withinCycle = turns - Math.floor(turns);
        let unitValue: number;
        if (shape === "square") unitValue = withinCycle < dutyCycle ? 1 : -1;
        else if (shape === "triangle") unitValue = 4 * Math.abs(withinCycle - 0.5) - 1;
        else if (shape === "noise") unitValue = Math.random() * 2 - 1;
        else unitValue = Math.sin(2 * Math.PI * withinCycle);
        // A little broadband noise on every shape, so min/max envelope columns
        // are visibly a band rather than a single line.
        samples[i] = amplitude * gain * unitValue + (Math.random() - 0.5) * 0.05 * amplitude;
      }
      sink.deliver(subscriptionId, this.domainSampleCounter, samples);
    }

    this.waveformPhase += cyclesPerBlock;
    if (this.waveformPhase > 1e9) this.waveformPhase = 0;
    this.domainSampleCounter += BigInt(RAW_SAMPLES_PER_TICK);
  }
}
