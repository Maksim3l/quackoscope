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
  /** `server` is the value NodeKind grew for add_server. This device builds
   *  server rows (see SYNTHETIC_SERVER_TYPES), so the value is not decoration
   *  here: a tree read from this host returns rows carrying it. */
  kind: "device" | "channel" | "function_block" | "signal" | "folder" | "server";
  parent_id: string | null;
  child_ids: string[];
  property_ids: string[];
  // The eight per-row state fields of contract types.Node. Null means "this host
  // does not report it", and the client then draws no label and no colour. This
  // device reports every field it honestly can, so the only nulls it writes are
  // the three the contract confines to particular kinds -- connection_status and
  // operation_mode are null on every non-device row, and recording is null on
  // every row that is not one of this device's synthetic recorder blocks.
  active: boolean | null;
  /** EFFECTIVE lock, inheritance already applied: every component under the
   *  synthetic device reports that device's lock, which is what lock_device and
   *  unlock_device move. */
  locked: boolean | null;
  component_status: NodeComponentStatus | null;
  component_status_message: string | null;
  connection_status: NodeConnectionStatus | null;
  operation_mode: NodeOperationMode | null;
  /** IPropertyObject::getUpdating: true between begin_batched_property_update
   *  and end_batched_property_update. Never null on this host -- every
   *  synthetic component here is a property object and this device knows its
   *  own batch depth for every one of them. */
  updating: boolean | null;
  /** IRecorder::getIsRecording. Non-null only on the synthetic recorder
   *  function block rows; null everywhere else, which is what tells a client
   *  "this node is not a recorder, draw no Start/Stop control". */
  recording: boolean | null;
}

/** contract types.ComponentAttribute: one row of the ATTRIBUTES panel, which is
 *  a different surface from the properties grid and reads a different thing --
 *  a fixed member of the openDAQ interface, not an entry in a property bag. */
export interface ComponentAttribute {
  id: string;
  name: string;
  value: unknown;
  value_type: "bool" | "int" | "float" | "string" | "string_list";
  read_only: boolean;
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
const SERVER_FOLDER_ID = `${DEVICE_NODE_ID}/srv`;
const RECORDER_NODE_ID = `${FUNCTION_BLOCK_FOLDER_ID}/recorder`;

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
 * The self-description save_instance_configuration_to_string stamps into every
 * string it writes, and the one string
 * load_instance_configuration_from_string will accept.
 *
 * It is deliberately not the word "opendaq": this host has no openDAQ instance
 * to serialise, so what it saves is its own synthetic state, and a reader who
 * has only the string must be able to tell that from the string.
 */
const MOCK_CONFIGURATION_FORMAT = "quackoscope_mock_synthetic_instance_configuration";
const MOCK_CONFIGURATION_FORMAT_VERSION = 1;
const CONFIGURATION_PRODUCER = "quackoscope-host-mock synthetic reference device";

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
 * reports ComponentStatus ok with a message saying why, and its kind-restricted
 * fields are null. connection_status and operation_mode are left null here even
 * for the device row, because both are live values -- they are filled in by
 * nodeAsItCrossesTheWire() at read time, not frozen into the stored row.
 * locked, updating and recording are likewise recomputed there, from the
 * device's current lock, its batch depths and its recorder states.
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
    updating: false,
    recording: null,
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
  /** A verb phrase, so every message that quotes it reads as a sentence:
   *  "it computes a running mean...". */
  whatItDoes: string;
  /** true on the one type whose blocks answer start_recording and
   *  stop_recording and report a non-null Node.recording. This is this host's
   *  stand-in for daq.IRecorder.can_cast_from(node), the cast
   *  block_view.py:169-171 makes to decide whether the Start/Stop control
   *  exists at all: there is no openDAQ interface here to cast to, so the
   *  catalogue entry that built the block carries the answer instead. */
  isRecorder?: boolean;
  buildDescriptors: () => PropertyDescriptor[];
}

/** The property whose emptiness makes start_recording answer `internal`. The
 *  contract's own error note for that row names "no writable path" as one of
 *  the causes; this is that cause, made reachable from the UI in one write. */
const RECORDING_FILE_PATH_PROPERTY_ID = "recording_file_path";

const SYNTHETIC_FUNCTION_BLOCK_TYPES: readonly SyntheticFunctionBlockType[] = [
  {
    id: "synthetic_statistics",
    name: "Statistics",
    whatItDoes: "computes a running mean, RMS or peak-to-peak over a window of the synthetic waveform",
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
    whatItDoes: "computes value * scale_factor + offset and relabels the result into another unit",
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
  {
    id: "synthetic_sample_recorder",
    name: "Sample recorder",
    whatItDoes:
      "answers start_recording and stop_recording and reports Node.recording; it writes no file, because nothing in " +
      "this process opens one",
    isRecorder: true,
    buildDescriptors: () => [
      descriptor({
        id: RECORDING_FILE_PATH_PROPERTY_ID,
        name: "Recording file path",
        value_type: "string",
        default: "recordings/synthetic-capture.csv",
        description:
          "The path this block would write to if it wrote anything. Set it to the empty string and start_recording " +
          "is answered with the internal code naming the missing path, which is one of the causes the contract's own " +
          "error note for that row lists. No file is ever created.",
      }),
      descriptor({
        id: "recorded_channel_count",
        name: "Recorded channels",
        value_type: "int",
        min: 1,
        max: 64,
        default: 4,
        description: "Display only: this block records nothing, so the count is a number it carries, not a number it uses.",
      }),
    ],
  },
];

/** The catalogue entry with this id, or a throw naming every id there is. Used
 *  where the id is written in this file rather than arriving off the wire, so a
 *  renamed catalogue entry fails at process start instead of at first request. */
function requireFunctionBlockType(typeId: string): SyntheticFunctionBlockType {
  const type = SYNTHETIC_FUNCTION_BLOCK_TYPES.find((candidate) => candidate.id === typeId);
  if (!type) {
    throw new Error(
      `hosts/mock-ts/src/synthetic-device/synthetic-reference-device.ts asks for function block type "${typeId}", ` +
        `which SYNTHETIC_FUNCTION_BLOCK_TYPES does not define; it defines ` +
        SYNTHETIC_FUNCTION_BLOCK_TYPES.map((candidate) => candidate.id).join(", "),
    );
  }
  return type;
}

/**
 * One row of what list_server_types answers with, and what add_server builds.
 *
 * These ids are the mock's own and say "synthetic" and "unbound" out loud, for
 * the same reason the function block type ids say "synthetic": no openDAQ
 * module is loaded in this process, so publishing openDAQ's server type ids
 * (OpenDAQNativeStreaming and friends) would teach a reader that connecting a
 * client to one of these would reach an openDAQ server. It would not. A server
 * this host adds binds no socket, speaks no openDAQ protocol and advertises on
 * no network; what it IS is a real component in this device's tree, of
 * NodeKind `server`, that the row menu and the attributes panel can be drawn
 * against.
 */
interface SyntheticServerType {
  id: string;
  name: string;
  /** A verb phrase, as SyntheticFunctionBlockType.whatItDoes is. */
  whatItDoes: string;
  buildDescriptors: () => PropertyDescriptor[];
}

const SYNTHETIC_SERVER_TYPES: readonly SyntheticServerType[] = [
  {
    id: "synthetic_unbound_control_server",
    name: "Synthetic control server (binds no socket)",
    whatItDoes:
      "stands in for a control-plane server row: it holds properties, carries NodeKind server and accepts " +
      "set_server_discovery_enabled, and it listens on no port",
    buildDescriptors: () => [
      descriptor({
        id: "advertised_service_name",
        name: "Advertised service name",
        value_type: "string",
        default: "Quackoscope synthetic control server",
        description: "The name this server would announce if it announced anything. Nothing is announced.",
      }),
      descriptor({
        id: "advertised_port_number",
        name: "Advertised port",
        value_type: "int",
        min: 1,
        max: 65535,
        default: 7420,
        description:
          "Display only. This host does not bind it and does not check whether anything else has: writing it changes " +
          "a number in the tree and nothing on the machine.",
      }),
    ],
  },
  {
    id: "synthetic_unbound_streaming_server",
    name: "Synthetic streaming server (binds no socket)",
    whatItDoes:
      "stands in for a streaming server row; it publishes none of this device's signals to anyone, because it opens " +
      "no connection",
    buildDescriptors: () => [
      descriptor({
        id: "advertised_service_name",
        name: "Advertised service name",
        value_type: "string",
        default: "Quackoscope synthetic streaming server",
        description: "The name this server would announce if it announced anything. Nothing is announced.",
      }),
      descriptor({
        id: "published_signal_count",
        name: "Published signals",
        value_type: "int",
        min: 0,
        max: 1024,
        default: 0,
        description: "Zero, and it stays zero: this server publishes nothing. Writing it changes the number on screen only.",
      }),
    ],
  },
];

interface ComponentState {
  node: Node;
  descriptors: Map<string, PropertyDescriptor>;
  values: Map<string, unknown>;
  /** The attribute values this device STORES, keyed by ComponentAttribute.id.
   *  Only the attributes that are not derived from something else live here:
   *  `name` and `active` are read off the Node, `global_id` off the id, and so
   *  on -- see SYNTHETIC_COMPONENT_ATTRIBUTES, where each row says where its
   *  value comes from. */
  attributeValues: Map<string, unknown>;
  /** This component's IComponent.locked_attributes: the attribute ids openDAQ
   *  itself refuses a write to, as opposed to the ones the reference hardcodes
   *  as Locked for every component. get_component_attributes folds these into
   *  ComponentAttribute.read_only, which is the fold
   *  generic_attributes_treeview.py:168-178 performs. */
  lockedAttributeIds: Set<string>;
  /** The catalogue id the block was built from, on function block rows only.
   *  It is what tells start_recording whether this node is a recorder. */
  functionBlockTypeId?: string;
  /** The catalogue id the server was built from, on server rows only. */
  serverTypeId?: string;
}

/**
 * One row of the attributes panel this device can serve.
 *
 * `appliesTo` is this host's stand-in for the reference's casts: the reference
 * starts from seven IComponent attributes and adds five more if ISignal casts
 * (generic_attributes_treeview.py:126-166). Here the node kind decides, so a
 * signal reports twelve rows and everything else reports seven -- fewer rows,
 * never a row with a null value standing in for an attribute that is not there.
 *
 * WHAT THIS DEVICE CANNOT REPORT, and does not pretend to: the three IInputPort
 * attributes (signal_id, requires_signal, and the input port's own public).
 * contract types.Node.kind has no `input_port` value, so no tree row here is an
 * input port, so no node can be asked for them. That is the contract's own
 * stated hole, written into Node.kind's comment, and not a gap in this host.
 */
interface SyntheticComponentAttribute {
  id: string;
  /** The label the reference prints in its '#0' column. Carried rather than
   *  derived, because 'Global ID' and 'Domain Signal ID' are not a mechanical
   *  transform of the id. */
  name: string;
  valueType: ComponentAttribute["value_type"];
  appliesTo: "every_component" | "signal_rows_only";
  /**
   * The reference's own hardcoded Locked flag, which it sets for global_id,
   * local_id, streamed, last_value, the domain and related signal ids,
   * signal_id and requires_signal. It is NOT this host saying "I have no
   * writer": that would be a capability gap, and contract
   * ComponentAttribute.read_only says in as many words that it must never be
   * used for it.
   */
  readOnlyOnEveryComponent: boolean;
  read: (device: SyntheticReferenceDevice, state: ComponentState) => unknown;
  /** Absent exactly when readOnlyOnEveryComponent is true. */
  write?: (device: SyntheticReferenceDevice, state: ComponentState, value: unknown) => string;
}

function requireAttributeString(state: ComponentState, attributeId: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new ServiceRefusal(
      "invalid_value",
      `attribute "${attributeId}" on "${state.node.id}" is a string; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireAttributeBoolean(state: ComponentState, attributeId: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new ServiceRefusal(
      "invalid_value",
      `attribute "${attributeId}" on "${state.node.id}" is a bool; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function requireAttributeStringList(state: ComponentState, attributeId: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ServiceRefusal(
      "invalid_value",
      `attribute "${attributeId}" on "${state.node.id}" is a string_list, so it takes an array of strings; got ` +
        JSON.stringify(value),
    );
  }
  return value as string[];
}

const SYNTHETIC_COMPONENT_ATTRIBUTES: readonly SyntheticComponentAttribute[] = [
  {
    id: "name",
    name: "Name",
    valueType: "string",
    appliesTo: "every_component",
    readOnlyOnEveryComponent: false,
    // Read off the Node, not out of attributeValues: IComponent.name IS the
    // name the tree draws, and storing a second copy would let the two differ.
    read: (_device, state) => state.node.name,
    write: (_device, state, value) => {
      const name = requireAttributeString(state, "name", value);
      if (name.length === 0) {
        throw new ServiceRefusal("invalid_value", `attribute "name" on "${state.node.id}" cannot be set to the empty string`);
      }
      const previous = state.node.name;
      state.node.name = name;
      return `renamed "${state.node.id}" from "${previous}" to "${name}"; the tree row's label changes on the next get_component_tree, because the contract has no attribute_changed event`;
    },
  },
  {
    id: "description",
    name: "Description",
    valueType: "string",
    appliesTo: "every_component",
    readOnlyOnEveryComponent: false,
    read: (_device, state) => state.attributeValues.get("description") ?? null,
    write: (_device, state, value) => {
      const description = requireAttributeString(state, "description", value);
      const previous = state.attributeValues.get("description");
      state.attributeValues.set("description", description);
      return `set description of "${state.node.id}" from ${JSON.stringify(previous ?? null)} to ${JSON.stringify(description)}`;
    },
  },
  {
    id: "active",
    name: "Active",
    valueType: "bool",
    appliesTo: "every_component",
    readOnlyOnEveryComponent: false,
    // THIS is the row that shows an attribute is not a property. Node.active
    // draws the [inactive] suffix in the tree, it is reachable from no
    // PropertyDescriptor on any component here, and it is written through
    // set_component_attribute rather than set_property_value -- exactly the
    // split the reference makes with setattr(node, 'active', ...) instead of
    // the property API.
    read: (_device, state) => state.node.active,
    write: (_device, state, value) => {
      const active = requireAttributeBoolean(state, "active", value);
      const previous = state.node.active;
      state.node.active = active;
      return `set IComponent.active of "${state.node.id}" from ${previous} to ${active}; that row now draws ${active ? "no [inactive] label" : "the [inactive] label"} on the next get_component_tree. No property was written: `.concat(
        `"${state.node.id}" has ${state.descriptors.size} propert(ies) and none of them is active`,
      );
    },
  },
  {
    id: "global_id",
    name: "Global ID",
    valueType: "string",
    appliesTo: "every_component",
    readOnlyOnEveryComponent: true,
    read: (_device, state) => state.node.id,
  },
  {
    id: "local_id",
    name: "Local ID",
    valueType: "string",
    appliesTo: "every_component",
    readOnlyOnEveryComponent: true,
    read: (_device, state) => state.node.id.slice(state.node.id.lastIndexOf("/") + 1),
  },
  {
    id: "tags",
    name: "Tags",
    valueType: "string_list",
    appliesTo: "every_component",
    readOnlyOnEveryComponent: false,
    read: (_device, state) => [...((state.attributeValues.get("tags") as string[] | undefined) ?? [])],
    // The reference marks Tags unlocked and then never writes it: its
    // handle_double_click has no list branch, so new_value stays None and the
    // write silently does not happen (generic_attributes_treeview.py:107-110).
    // That is a fall-through in the reference, not a policy, so this host does
    // write it -- a string_list attribute that accepts a write is the only way
    // a client can be developed against one.
    write: (_device, state, value) => {
      const tags = requireAttributeStringList(state, "tags", value);
      const previous = (state.attributeValues.get("tags") as string[] | undefined) ?? [];
      state.attributeValues.set("tags", [...tags]);
      return `set tags of "${state.node.id}" from [${previous.join(", ")}] to [${tags.join(", ")}]`;
    },
  },
  {
    id: "visible",
    name: "Visible",
    valueType: "bool",
    appliesTo: "every_component",
    readOnlyOnEveryComponent: false,
    // IComponent.visible, which contract types.Node does NOT carry -- so this
    // attribute is visible on this surface and nowhere else in the contract.
    read: (_device, state) => state.attributeValues.get("visible") ?? true,
    write: (_device, state, value) => {
      const visible = requireAttributeBoolean(state, "visible", value);
      const previous = state.attributeValues.get("visible") ?? true;
      state.attributeValues.set("visible", visible);
      return `set IComponent.visible of "${state.node.id}" from ${previous} to ${visible}; contract types.Node carries no visible field, so this value is readable through get_component_attributes only and changes no tree row`;
    },
  },
  {
    id: "public",
    name: "Public",
    valueType: "bool",
    appliesTo: "signal_rows_only",
    readOnlyOnEveryComponent: false,
    read: (_device, state) => state.attributeValues.get("public") ?? true,
    write: (_device, state, value) => {
      const isPublic = requireAttributeBoolean(state, "public", value);
      const previous = state.attributeValues.get("public") ?? true;
      state.attributeValues.set("public", isPublic);
      return `set ISignal.public of "${state.node.id}" from ${previous} to ${isPublic}; this host publishes to no server, so the value is carried and not acted on`;
    },
  },
  {
    id: "domain_signal_id",
    name: "Domain Signal ID",
    valueType: "string",
    appliesTo: "signal_rows_only",
    readOnlyOnEveryComponent: true,
    // null, and honestly so: this device builds one signal per channel and no
    // domain signal beside it, so ISignal.domain_signal has nothing to name.
    // The row is present because the cast succeeded -- this IS a signal -- and
    // a present row with a null value says "this signal has no domain signal",
    // which is different from the row being absent.
    read: () => null,
  },
  {
    id: "related_signal_ids",
    name: "Related Signals",
    valueType: "string_list",
    appliesTo: "signal_rows_only",
    readOnlyOnEveryComponent: true,
    // Empty, for the same reason: this device relates no signal to any other.
    read: () => [],
  },
  {
    id: "streamed",
    name: "Streamed",
    valueType: "bool",
    appliesTo: "signal_rows_only",
    readOnlyOnEveryComponent: true,
    // Live, not stored: true exactly while some session holds a subscription on
    // this signal, which is the one fact in this process that "streamed" can
    // honestly mean. Subscribe to a signal and re-read its attributes and this
    // row flips.
    read: (device, state) => device.isSignalBeingStreamed(state.node.id),
  },
  {
    id: "last_value",
    name: "Last Value",
    valueType: "float",
    appliesTo: "signal_rows_only",
    readOnlyOnEveryComponent: true,
    // The last sample the waveform pump produced on this signal, or null when
    // the pump has never run for it. ISignal.last_value is live in openDAQ too.
    read: (device, state) => device.lastSampleValueOf(state.node.id),
  },
];

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
  /**
   * IPropertyObject's update depth per component id, absent meaning zero.
   *
   * begin_batched_property_update increments it on the named component AND on
   * every descendant, because openDAQ's beginUpdate is recursive over child
   * property objects (property_object.h:335); end decrements the same set. A
   * component whose depth is above zero reports Node.updating true and HOLDS
   * every property write instead of applying it.
   *
   * WHOSE BATCH THIS IS: the component's, not the session's, and this host does
   * not decide otherwise. contract.yaml states in the begin row's own comment
   * that who may end a batch somebody else began is UNRULED and is the same
   * open question already escalated for device.lock, and that a host "must not
   * quietly invent a policy and call it the contract". So this map is keyed on
   * the component alone: any session may end any batch, which is what an
   * in-process IPropertyObject does, since openDAQ has no sessions at all. That
   * is not an answer to the open question -- it is the absence of one, and it
   * is printed at every begin, at every end and at every session close rather
   * than left to be discovered.
   */
  private batchUpdateDepthByNodeId = new Map<string, number>();
  /** Property writes accepted while a component is updating, applied by
   *  end_batched_property_update. node id -> property id -> coerced value. */
  private heldPropertyWritesByNodeId = new Map<string, Map<string, unknown>>();
  /** Which synthetic recorder blocks are recording. Absent means false. */
  private recordingByNodeId = new Map<string, boolean>();
  /** Which synthetic servers were last told to advertise. Absent means false.
   *  There is no getter for this on the wire and there cannot be one -- see
   *  setServerDiscoveryEnabled. */
  private discoveryEnabledByServerNodeId = new Map<string, boolean>();
  /** The last sample the pump produced per signal id, which is what the
   *  last_value attribute reports. Absent until the pump has run for it. */
  private lastSampleValueBySignalId = new Map<string, number>();
  private nextServerOrdinal = 1;

  constructor() {
    this.buildTree();
  }

  setEventSink(sink: (event: DeviceEvent) => void): void {
    this.emit = sink;
  }

  // --- tree ----------------------------------------------------------------

  private addComponent(
    node: Node,
    descriptors: PropertyDescriptor[],
    extra: {
      description?: string;
      tags?: string[];
      lockedAttributeIds?: string[];
      functionBlockTypeId?: string;
      serverTypeId?: string;
    } = {},
  ): void {
    node.property_ids = descriptors.map((d) => d.id);
    const state: ComponentState = {
      node,
      descriptors: new Map(descriptors.map((d) => [d.id, d])),
      values: new Map(descriptors.map((d) => [d.id, d.default])),
      attributeValues: new Map<string, unknown>([
        ["description", extra.description ?? null],
        ["tags", [...(extra.tags ?? [])]],
        ["visible", true],
        ["public", true],
      ]),
      lockedAttributeIds: new Set(extra.lockedAttributeIds ?? []),
      functionBlockTypeId: extra.functionBlockTypeId,
      serverTypeId: extra.serverTypeId,
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
          id: "saved_configuration_padding_bytes",
          name: "Saved configuration padding",
          value_type: "int",
          unit: "bytes",
          min: 0,
          max: 2000000,
          default: 0,
          description:
            "Pads the string save_instance_configuration_to_string returns by this many bytes, so the frame limit " +
            "that row declares can actually be reached. Write more than about 262000 and the save is answered with " +
            "the internal code naming the measured envelope length and this host's max_frame_bytes. Nothing else " +
            "reads the padding: load_instance_configuration_from_string ignores it.",
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
      {
        description:
          "The synthetic reference device this host builds in memory at process start. No openDAQ SDK is loaded in " +
          "this process and no hardware is behind any of it.",
        tags: ["synthetic", "reference-device", "no-sdk"],
      },
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
        component_status_message: "the function block folder holds the blocks fitted at startup and every block add_function_block fits",
      }),
      [],
    );
    this.addComponent(
      componentNode({
        id: SERVER_FOLDER_ID,
        name: "Servers",
        kind: "folder",
        parent_id: DEVICE_NODE_ID,
        component_status_message:
          "the server folder holds the server published at startup and every server add_server publishes. Every one of " +
          "them binds no socket: this host has exactly one listening port, the WebSocket the app is talking on, and " +
          "these components are not it",
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
      // The one component here with a non-empty IComponent.locked_attributes.
      // Every other row's read_only flags come from the reference's hardcoded
      // per-attribute Locked list, which is the same on every component; these
      // two are per-COMPONENT, so this is the only row where the attributes
      // panel shows `name` and `active` locked while the identical rows on AI0
      // are writable. Without it, ComponentAttribute.read_only would look like
      // a constant of the attribute rather than a fact about the component.
      lockedAttributeIds: ["name", "active"],
      channelDescription:
        "AnalogInput 3 on the synthetic backplane. Its name and active attributes are in this component's " +
        "locked_attributes, so set_component_attribute answers read_only for both.",
    });

    // The function blocks fitted at startup are built from the same catalogue
    // entries add_function_block builds from, so what list_function_block_types
    // names is exactly what this device can make.
    const statisticsType = requireFunctionBlockType("synthetic_statistics");
    this.addComponent(
      componentNode({
        id: `${FUNCTION_BLOCK_FOLDER_ID}/statistics`,
        name: statisticsType.name,
        kind: "function_block",
        parent_id: FUNCTION_BLOCK_FOLDER_ID,
        component_status_message: `fitted at process start from catalogue type "${statisticsType.id}"; it ${statisticsType.whatItDoes}`,
      }),
      statisticsType.buildDescriptors(),
      {
        description: `Fitted at process start from catalogue type ${statisticsType.id}.`,
        tags: ["fitted-at-startup", "synthetic"],
        functionBlockTypeId: statisticsType.id,
      },
    );

    // A recorder block is fitted at startup for the same reason a deactivated
    // channel and an error channel are: it is the ONLY row on this host where
    // contract types.Node.recording is not null, so it is the only row where
    // the Start/Stop control can be drawn at all. Without it a client would
    // have to call add_function_block before it could see the control exist.
    const recorderType = requireFunctionBlockType("synthetic_sample_recorder");
    this.addComponent(
      componentNode({
        id: RECORDER_NODE_ID,
        name: recorderType.name,
        kind: "function_block",
        parent_id: FUNCTION_BLOCK_FOLDER_ID,
        component_status_message:
          `fitted at process start from catalogue type "${recorderType.id}"; it ${recorderType.whatItDoes}. It is the ` +
          "one row on this host that reports a non-null Node.recording",
      }),
      recorderType.buildDescriptors(),
      {
        description: `Fitted at process start from catalogue type ${recorderType.id}.`,
        tags: ["fitted-at-startup", "recorder", "synthetic"],
        functionBlockTypeId: recorderType.id,
      },
    );

    // One server published at startup, for the same reason: it is the only row
    // carrying NodeKind "server" until a client calls add_server, so it is what
    // lets a tree read show a server row and the row menu draw the discovery
    // items on a host nobody has added anything to yet.
    this.publishSyntheticServer(SYNTHETIC_SERVER_TYPES[0].id, "at process start");
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
      /** This channel's IComponent.locked_attributes, which
       *  get_component_attributes folds into ComponentAttribute.read_only. */
      lockedAttributeIds?: string[];
      channelDescription?: string;
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
      {
        description: state.channelDescription ?? `${channelName} on the synthetic backplane.`,
        tags: ["analog-input", "synthetic"],
        lockedAttributeIds: state.lockedAttributeIds,
      },
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
      {
        description: `${signalName}, the synthetic waveform carried by ${channelName}.`,
        tags: ["waveform", "synthetic"],
      },
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
    const state = this.requireComponent(nodeId);
    const stored = state.node;
    const isDeviceRow = stored.kind === "device";
    return {
      ...stored,
      child_ids: [...stored.child_ids],
      property_ids: [...stored.property_ids],
      locked: this.lockHolderToken !== null,
      connection_status: isDeviceRow ? "connected" : null,
      operation_mode: isDeviceRow ? this.operationMode : null,
      updating: (this.batchUpdateDepthByNodeId.get(nodeId) ?? 0) > 0,
      recording: this.isRecorderComponent(state) ? (this.recordingByNodeId.get(nodeId) ?? false) : null,
    };
  }

  /** Whether this component answers start_recording and stop_recording, which
   *  is also whether Node.recording is non-null on it. */
  private isRecorderComponent(state: ComponentState): boolean {
    if (state.functionBlockTypeId === undefined) return false;
    return SYNTHETIC_FUNCTION_BLOCK_TYPES.some((type) => type.id === state.functionBlockTypeId && type.isRecorder === true);
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
   * The SERVER rows are mapped from SYNTHETIC_SERVER_TYPES, the same array
   * list_server_types and add_server use, for exactly the reason the function
   * block rows are mapped from their catalogue: the Modules view and the
   * add-server card grid must not be able to drift apart. This entry used to
   * say "no server or streaming type is listed, because this device offers
   * none"; the server rows arrived with add_server and that sentence had to go
   * with them.
   *
   * No STREAMING type is listed, and that sentence stands: the WebSocket in
   * hosts/mock-ts/src/transport/ is this host's own control plane, not an
   * openDAQ streaming type, and listing it as one would be the invention this
   * entry is careful not to make.
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
        description: `A function block that ${type.whatItDoes}.`,
        connection_string_prefix: null,
      })),
      ...this.describeServerTypes(),
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
    return SYNTHETIC_FUNCTION_BLOCK_TYPES.map((type) => `${type.id} (${type.name}: it ${type.whatItDoes})`).join(", ");
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
        component_status_message: `fitted by add_function_block from catalogue type "${type.id}"; it ${type.whatItDoes}`,
      }),
      type.buildDescriptors(),
      {
        description: `Fitted by add_function_block from catalogue type ${type.id}.`,
        tags: ["fitted-at-runtime", "synthetic"],
        functionBlockTypeId: type.id,
      },
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
   * Accepts one write and says what became of it.
   *
   * `stored` is the value the device took, which is not necessarily the value
   * submitted -- the coercer runs here. `appliedNow` is false when the
   * component is inside a batched update: contract.yaml says that between
   * begin_batched_property_update and end_batched_property_update "every
   * set_property_value against the component is HELD rather than applied", so
   * the value goes into heldPropertyWritesByNodeId, no property_changed event
   * is emitted, get_property_value keeps answering the old value, and
   * end_batched_property_update is what finally applies it.
   *
   * Coercion, validation and this device's synthetic refusals (the injected
   * internal, the range relay timeout) all run at ACCEPT time, batch or no
   * batch: the request is answered when it arrives, and only the application of
   * the value is deferred.
   */
  setPropertyValue(nodeId: string, propertyId: string, submitted: unknown): { stored: unknown; appliedNow: boolean } {
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

    const batchDepth = this.batchUpdateDepthByNodeId.get(nodeId) ?? 0;
    if (batchDepth > 0) {
      let held = this.heldPropertyWritesByNodeId.get(nodeId);
      if (!held) {
        held = new Map<string, unknown>();
        this.heldPropertyWritesByNodeId.set(nodeId, held);
      }
      const replacing = held.has(propertyId);
      held.set(propertyId, stored);
      console.log(
        `[device] set_property_value on "${nodeId}" is HELD, not applied: that component is at batch update depth ` +
          `${batchDepth}, so Node.updating is true for it. ${propertyId} = ${JSON.stringify(stored)} joins ` +
          `${held.size} held write(s)${replacing ? ` (it replaced an earlier held value for the same property)` : ""}. ` +
          `get_property_value still answers ${JSON.stringify(state.values.get(propertyId) ?? null)} and no ` +
          "property_changed event was emitted; end_batched_property_update applies it.",
      );
      return { stored, appliedNow: false };
    }

    this.applyStoredPropertyValue(nodeId, propertyId, stored);
    return { stored, appliedNow: true };
  }

  /**
   * Puts an already coerced and validated value into the component and raises
   * everything that follows from it: the property_changed event, and this
   * device's descriptor reshaping, channel fitting and disconnect simulation.
   *
   * Both paths end here -- an ordinary write, and a write released by
   * end_batched_property_update -- so a batched write has exactly the same
   * consequences as an unbatched one, only later.
   */
  private applyStoredPropertyValue(nodeId: string, propertyId: string, stored: unknown): void {
    const state = this.requireComponent(nodeId);
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

  // --- component attributes ------------------------------------------------

  /**
   * The attribute rows this component has, in SYNTHETIC_COMPONENT_ATTRIBUTES
   * order.
   *
   * A signal gets twelve rows and every other kind gets seven, which is this
   * host's version of "a host that cannot perform a cast returns fewer rows".
   * No row is ever emitted with a null value standing in for an attribute the
   * component does not have; a null value here means the attribute exists and
   * is genuinely null, which is only ever domain_signal_id and last_value.
   */
  getComponentAttributes(nodeId: string): ComponentAttribute[] {
    const state = this.requireComponent(nodeId);
    return this.attributeDefinitionsFor(state).map((definition) => ({
      id: definition.id,
      name: definition.name,
      value: definition.read(this, state) ?? null,
      value_type: definition.valueType,
      read_only: definition.readOnlyOnEveryComponent || state.lockedAttributeIds.has(definition.id),
    }));
  }

  private attributeDefinitionsFor(state: ComponentState): SyntheticComponentAttribute[] {
    return SYNTHETIC_COMPONENT_ATTRIBUTES.filter(
      (definition) => definition.appliesTo === "every_component" || state.node.kind === "signal",
    );
  }

  /**
   * Writes one attribute and returns a sentence saying what it did, which the
   * service layer logs.
   *
   * THE DEVICE LOCK IS NOT CONSULTED HERE, deliberately, and it is the one
   * thing about this row this host will not decide on its own.
   * set_property_value and set_device_operation_mode both refuse read_only
   * while another session holds the lock. contract.yaml's error note for
   * set_component_attribute names exactly two sources for read_only -- the
   * reference's hardcoded per-attribute Locked flag and
   * IComponent.locked_attributes -- and the device lock is neither. Answering
   * read_only because of the lock would assert that openDAQ locked the
   * attribute, which is a cause this host has not established, and
   * ComponentAttribute.read_only's own comment forbids exactly that. The
   * consequence, stated rather than hidden: on this host a locked device's
   * attributes are writable while its properties are not. That is reported
   * upward as an open question, not settled here.
   */
  setComponentAttribute(nodeId: string, attributeId: string, value: unknown): string {
    const state = this.requireComponent(nodeId);
    const available = this.attributeDefinitionsFor(state);
    const definition = available.find((candidate) => candidate.id === attributeId);
    if (!definition) {
      throw new ServiceRefusal(
        "not_found",
        `component "${nodeId}" (a ${state.node.kind}) has no attribute "${attributeId}"; get_component_attributes ` +
          `reports ${available.length} attribute(s) for it: ${available.map((candidate) => candidate.id).join(", ")}`,
      );
    }
    if (definition.readOnlyOnEveryComponent || definition.write === undefined) {
      throw new ServiceRefusal(
        "read_only",
        `attribute "${attributeId}" on "${nodeId}" is read only on every component: it is one of the attributes the ` +
          "reference hardcodes as Locked (global_id, local_id, streamed, last_value, the domain and related signal " +
          `ids). It holds ${JSON.stringify(definition.read(this, state) ?? null)}.`,
      );
    }
    if (state.lockedAttributeIds.has(attributeId)) {
      throw new ServiceRefusal(
        "read_only",
        `attribute "${attributeId}" is in the locked_attributes of "${nodeId}" -- this component's own set, not a ` +
          `blanket rule -- so the write was refused and nothing changed. That set is ` +
          `{${[...state.lockedAttributeIds].join(", ")}}; the same attribute on another component of the same kind ` +
          "is writable.",
      );
    }
    const whatChanged = definition.write(this, state, value);
    console.log(`[device] set_component_attribute ${nodeId}.${attributeId}: ${whatChanged}`);
    return whatChanged;
  }

  /** What the startup log prints about the attribute surface: the two row
   *  counts and the one component that carries a locked_attributes set. */
  describeAttributeSurfaceForTheLog(): string {
    const everyComponent = SYNTHETIC_COMPONENT_ATTRIBUTES.filter((a) => a.appliesTo === "every_component");
    const signalOnly = SYNTHETIC_COMPONENT_ATTRIBUTES.filter((a) => a.appliesTo === "signal_rows_only");
    const withLockedSet = [...this.components.values()].filter((state) => state.lockedAttributeIds.size > 0);
    return (
      `${everyComponent.length} attribute(s) on every component (${everyComponent.map((a) => a.id).join(", ")}) plus ` +
      `${signalOnly.length} more on signal rows (${signalOnly.map((a) => a.id).join(", ")}); ` +
      `${withLockedSet.length} component(s) carry a locked_attributes set of their own: ` +
      (withLockedSet.map((state) => `${state.node.id} {${[...state.lockedAttributeIds].join(", ")}}`).join("; ") || "none") +
      ". No input port attributes are reported anywhere, because contract types.Node.kind has no input_port value, so " +
      "no row here is one"
    );
  }

  // --- servers ---------------------------------------------------------------

  serverFolderId(): string {
    return SERVER_FOLDER_ID;
  }

  /** What list_server_types answers with: ComponentTypeInfo, kind `server` on
   *  every row, mapped from the same catalogue add_server builds from. */
  describeServerTypes(): ComponentTypeInfo[] {
    return SYNTHETIC_SERVER_TYPES.map((type) => ({
      id: type.id,
      name: type.name,
      kind: "server",
      description: `A server component that ${type.whatItDoes}.`,
      connection_string_prefix: null,
    }));
  }

  describeServerTypesForTheLog(): string {
    return SYNTHETIC_SERVER_TYPES.map((type) => `${type.id} (${type.name}: it ${type.whatItDoes})`).join(", ");
  }

  /** Publishes one server of the named type under the server folder. */
  addServer(typeId: string): Node {
    const type = SYNTHETIC_SERVER_TYPES.find((candidate) => candidate.id === typeId);
    if (!type) {
      throw new ServiceRefusal(
        "unsupported",
        `no server type "${typeId}" on this synthetic device; list_server_types answers with ` +
          `${this.describeServerTypesForTheLog()}`,
      );
    }
    const node = this.publishSyntheticServer(typeId, "by add_server");
    this.emit({ event: "component_added", payload: { node } });
    console.log(
      `[device] add_server published ${node.id} from type "${typeId}" under ${SERVER_FOLDER_ID}, with ` +
        `${node.property_ids.length} propert(ies): ${node.property_ids.join(", ")}. It binds no socket and ` +
        `advertises nothing; its discovery flag starts false and only set_server_discovery_enabled moves it.`,
    );
    return node;
  }

  private publishSyntheticServer(typeId: string, whenPhrase: string): Node {
    const type = SYNTHETIC_SERVER_TYPES.find((candidate) => candidate.id === typeId);
    if (!type) {
      throw new Error(
        `hosts/mock-ts/src/synthetic-device/synthetic-reference-device.ts asks for server type "${typeId}", which ` +
          `SYNTHETIC_SERVER_TYPES does not define; it defines ` +
          SYNTHETIC_SERVER_TYPES.map((candidate) => candidate.id).join(", "),
      );
    }
    let ordinal = this.nextServerOrdinal;
    while (this.components.has(`${SERVER_FOLDER_ID}/${typeId}_${ordinal}`)) ordinal++;
    this.nextServerOrdinal = ordinal + 1;
    const nodeId = `${SERVER_FOLDER_ID}/${typeId}_${ordinal}`;

    this.addComponent(
      componentNode({
        id: nodeId,
        name: `${type.name} ${ordinal}`,
        kind: "server",
        parent_id: SERVER_FOLDER_ID,
        component_status_message: this.describeServerDiscoveryState(nodeId, false, `published ${whenPhrase}`),
      }),
      type.buildDescriptors(),
      {
        description: `Published ${whenPhrase} from catalogue type ${type.id}. It ${type.whatItDoes}.`,
        tags: ["server", "synthetic", "binds-no-socket"],
        serverTypeId: type.id,
      },
    );
    this.discoveryEnabledByServerNodeId.set(nodeId, false);
    return this.nodeAsItCrossesTheWire(nodeId);
  }

  /**
   * Moves one server's discovery flag.
   *
   * WHERE THE RESULT IS VISIBLE, and why it is there. The contract has no
   * getter for this and states that there cannot be one -- neither openDAQ's
   * server.h nor the Python binding's IServer surface reports whether discovery
   * is on -- and contract types.Node has no field for it either. So the only
   * place this host can honestly show the flag it was handed is the server
   * row's component_status_message, which on every synthetic component here is
   * already the narration of what that component is. This host does not invent
   * a wire field and does not pretend the value is readable as state: a client
   * that wants to know what it last sent must remember what it last sent, which
   * is exactly why the contract says the control is two named actions and not a
   * switch.
   *
   * NOTHING IS ADVERTISED EITHER WAY. There is no mDNS responder in this
   * process and this server binds no socket, so `enabled` changes a recorded
   * flag and a sentence in the tree and nothing on the network. The row says so
   * in its own text rather than leaving a reader to assume otherwise.
   */
  setServerDiscoveryEnabled(nodeId: string, enabled: boolean): string {
    const state = this.requireComponent(nodeId);
    if (state.node.kind !== "server") {
      throw new ServiceRefusal(
        "unsupported",
        `"${nodeId}" is a ${state.node.kind}, not a server; set_server_discovery_enabled acts on server rows only. ` +
          `This device has ${this.serverNodeIds().length} server row(s): ${this.serverNodeIds().join(", ") || "none"}`,
      );
    }
    const previous = this.discoveryEnabledByServerNodeId.get(nodeId) ?? false;
    this.discoveryEnabledByServerNodeId.set(nodeId, enabled);
    state.node.component_status_message = this.describeServerDiscoveryState(
      nodeId,
      enabled,
      state.serverTypeId !== undefined ? `built from catalogue type ${state.serverTypeId}` : "a synthetic server",
    );
    return (
      `discovery on "${nodeId}" moved from ${previous} to ${enabled}. Nothing was announced or withdrawn: this ` +
      "process runs no mDNS responder and this server binds no socket. The new flag is readable only as that row's " +
      "component_status_message on the next get_component_tree -- the contract has no getter for it and no Node " +
      "field for it, and this host invents neither"
    );
  }

  private describeServerDiscoveryState(nodeId: string, enabled: boolean, provenance: string): string {
    return (
      `synthetic server ${nodeId}, ${provenance}. Discovery is ${enabled ? "ENABLED" : "DISABLED"} for it, which is ` +
      "the flag set_server_discovery_enabled last stored and not a network fact: this server binds no socket and " +
      "this process runs no mDNS responder, so nothing is advertised in either state"
    );
  }

  serverNodeIds(): string[] {
    return [...this.components.values()].filter((state) => state.node.kind === "server").map((state) => state.node.id);
  }

  describeServersForTheLog(): string {
    const ids = this.serverNodeIds();
    if (ids.length === 0) return "no server rows";
    return ids
      .map((id) => `${id} (discovery ${this.discoveryEnabledByServerNodeId.get(id) ?? false})`)
      .join(", ");
  }

  // --- the recorder ----------------------------------------------------------

  private requireRecorderRow(nodeId: string, wireMethod: string): ComponentState {
    const state = this.requireComponent(nodeId);
    if (!this.isRecorderComponent(state)) {
      throw new ServiceRefusal(
        "unsupported",
        `"${nodeId}" is a ${state.node.kind}${state.functionBlockTypeId !== undefined ? ` of type "${state.functionBlockTypeId}"` : ""} ` +
          `and is not a recorder, so ${wireMethod} does not apply to it. This host's recorder rows are the ones ` +
          `built from catalogue type "synthetic_sample_recorder", and they are exactly the rows that report a ` +
          `non-null Node.recording: ${this.recorderNodeIds().join(", ") || "none"}`,
      );
    }
    return state;
  }

  recorderNodeIds(): string[] {
    return [...this.components.values()].filter((state) => this.isRecorderComponent(state)).map((state) => state.node.id);
  }

  startRecording(nodeId: string): string {
    const state = this.requireRecorderRow(nodeId, "start_recording");
    const path = state.values.get(RECORDING_FILE_PATH_PROPERTY_ID);
    if (typeof path !== "string" || path.length === 0) {
      // The contract's own error note for this row lists "no writable path" as
      // one of the causes of `internal`. This is that cause, made reachable
      // with a single property write so the code can be exercised from the UI.
      throw new ServiceRefusal(
        "internal",
        `the recorder "${nodeId}" has no path to record to: its ${RECORDING_FILE_PATH_PROPERTY_ID} property holds ` +
          `${JSON.stringify(path ?? null)}. Recording was not started and Node.recording stays ` +
          `${this.recordingByNodeId.get(nodeId) ?? false}. Write a non-empty ${RECORDING_FILE_PATH_PROPERTY_ID} and ` +
          "send start_recording again.",
      );
    }
    const wasAlreadyRecording = this.recordingByNodeId.get(nodeId) === true;
    this.recordingByNodeId.set(nodeId, true);
    return (
      `"${nodeId}" is ${wasAlreadyRecording ? "still" : "now"} recording; Node.recording is true for that row on the ` +
      `next get_component_tree, and the contract pushes no event for it. It would have written to "${path}" -- no ` +
      "file was opened and no sample was written, because this block records nothing"
    );
  }

  stopRecording(nodeId: string): string {
    this.requireRecorderRow(nodeId, "stop_recording");
    const wasRecording = this.recordingByNodeId.get(nodeId) === true;
    this.recordingByNodeId.set(nodeId, false);
    return (
      `"${nodeId}" is ${wasRecording ? "no longer" : "still not"} recording; Node.recording is false for that row on ` +
      "the next get_component_tree. No file was closed, because none was ever opened"
    );
  }

  // --- batched property updates ----------------------------------------------

  /**
   * IPropertyObject::beginUpdate, recursive over the subtree, exactly as
   * property_object.h:335 describes it: one begin on the device puts every
   * component under it into batch mode at once.
   *
   * WHAT THIS DOES NOT DECIDE. contract.yaml's own comment on this row says who
   * may end a batch somebody else began is unruled, that it is the same open
   * question already escalated for device.lock, and that a host must not
   * quietly invent a policy and call it the contract. So the depth below is
   * keyed on the COMPONENT and on nothing else, and any session may end any
   * batch -- which is what an in-process IPropertyObject does, openDAQ having
   * no sessions to scope it to. That is the absence of a policy, not a policy,
   * and every begin, every end and every session close prints it.
   */
  beginBatchedPropertyUpdate(nodeId: string): string {
    const subtreeIds = this.getComponentTree(nodeId).map((node) => node.id);
    for (const id of subtreeIds) {
      this.batchUpdateDepthByNodeId.set(id, (this.batchUpdateDepthByNodeId.get(id) ?? 0) + 1);
    }
    const depthHere = this.batchUpdateDepthByNodeId.get(nodeId) ?? 0;
    return (
      `begin_batched_property_update on "${nodeId}" put ${subtreeIds.length} component(s) into batch mode ` +
      `(${subtreeIds.join(", ")}); "${nodeId}" is now at depth ${depthHere}. Every one of those rows reports ` +
      "Node.updating true, and set_property_value against any of them is held rather than applied until " +
      "end_batched_property_update. This host does not scope the batch to the session that opened it -- the contract " +
      "leaves who may end it open, and this host does not answer it"
    );
  }

  endBatchedPropertyUpdate(nodeId: string): string {
    const depthHere = this.batchUpdateDepthByNodeId.get(nodeId) ?? 0;
    if (depthHere === 0) {
      // The reference swallows exactly this with a bare `except RuntimeError:
      // pass` (gui_demo.py:1374-1378). contract.yaml says a host must not:
      // silence would tell a user their batch was applied.
      const open = this.nodeIdsInsideAnOpenBatch();
      throw new ServiceRefusal(
        "invalid_value",
        `end_batched_property_update on "${nodeId}" arrived with no begin_batched_property_update open on that ` +
          `component: its batch update depth is 0, and Node.updating is false for it. Nothing was applied and ` +
          `nothing was discarded. ${open.length} component(s) on this device are inside an open batch right now` +
          `${open.length > 0 ? `: ${open.join(", ")}` : ""}.`,
      );
    }

    const subtreeIds = this.getComponentTree(nodeId).map((node) => node.id);
    const applied: string[] = [];
    for (const id of subtreeIds) {
      const remaining = (this.batchUpdateDepthByNodeId.get(id) ?? 0) - 1;
      if (remaining > 0) {
        this.batchUpdateDepthByNodeId.set(id, remaining);
        continue;
      }
      this.batchUpdateDepthByNodeId.delete(id);
      const held = this.heldPropertyWritesByNodeId.get(id);
      if (!held) continue;
      this.heldPropertyWritesByNodeId.delete(id);
      for (const [propertyId, stored] of held) {
        this.applyStoredPropertyValue(id, propertyId, stored);
        applied.push(`${id}.${propertyId} = ${JSON.stringify(stored)}`);
      }
    }

    const stillOpen = this.nodeIdsInsideAnOpenBatch();
    return (
      `end_batched_property_update on "${nodeId}" closed one level over ${subtreeIds.length} component(s); ` +
      `${applied.length} held write(s) were applied and each raised its property_changed event` +
      `${applied.length > 0 ? ` (${applied.join(", ")})` : ""}. ` +
      `${stillOpen.length} component(s) remain inside an open batch${stillOpen.length > 0 ? `: ${stillOpen.join(", ")}` : ""}`
    );
  }

  nodeIdsInsideAnOpenBatch(): string[] {
    return [...this.batchUpdateDepthByNodeId.entries()].filter(([, depth]) => depth > 0).map(([id]) => id);
  }

  heldPropertyWriteCount(): number {
    let total = 0;
    for (const held of this.heldPropertyWritesByNodeId.values()) total += held.size;
    return total;
  }

  // --- instance configuration ------------------------------------------------

  /**
   * The whole state of this synthetic instance, as one string.
   *
   * THIS IS NOT AN openDAQ CONFIGURATION AND SAYS SO IN ITS OWN FIRST FIELDS.
   * contract.yaml gives this row the semantic opendaq_instance_configuration_json
   * and describes the value as "the string saveConfiguration returned". There is
   * no openDAQ instance in this process and no saveConfiguration to call, so
   * this host cannot return that string and does not pretend to. What it
   * returns instead is its own synthetic instance state, carrying `format` and
   * `what_this_is_not` as its first two keys, so that a reader, a log or
   * another host is told what it is holding by the value itself rather than by
   * a comment in this file.
   *
   * The consequence, stated: a configuration saved from this host is NOT
   * loadable by an SDK host, and one saved from an SDK host is not loadable
   * here -- load_instance_configuration_from_string below refuses it
   * invalid_value and names the format it found. contract.yaml's parameter
   * comment says a load takes a configuration "produced by
   * save_instance_configuration_to_string, on this host or another", and that
   * cross-host promise is one this host cannot keep. It is reported as a
   * finding rather than papered over with a made-up openDAQ document.
   */
  saveInstanceConfigurationToString(): string {
    const device = this.requireComponent(DEVICE_NODE_ID);
    const paddingBytes = Number(device.values.get("saved_configuration_padding_bytes") ?? 0);
    const document = {
      format: MOCK_CONFIGURATION_FORMAT,
      what_this_is_not:
        "This is NOT an openDAQ saveConfiguration string. quackoscope-host-mock loads no openDAQ SDK and has no " +
        "instance to serialise, so it serialises its own synthetic device instead. An openDAQ host will refuse it.",
      format_version: MOCK_CONFIGURATION_FORMAT_VERSION,
      produced_by: CONFIGURATION_PRODUCER,
      device_node_id: DEVICE_NODE_ID,
      operation_mode: this.operationMode,
      components: [...this.components.values()].map((state) => ({
        id: state.node.id,
        kind: state.node.kind,
        name: state.node.name,
        parent_id: state.node.parent_id,
        function_block_type_id: state.functionBlockTypeId ?? null,
        server_type_id: state.serverTypeId ?? null,
        active: state.node.active,
        recording: this.isRecorderComponent(state) ? (this.recordingByNodeId.get(state.node.id) ?? false) : null,
        discovery_enabled: state.node.kind === "server" ? (this.discoveryEnabledByServerNodeId.get(state.node.id) ?? false) : null,
        attribute_values: {
          description: state.attributeValues.get("description") ?? null,
          tags: [...((state.attributeValues.get("tags") as string[] | undefined) ?? [])],
          visible: state.attributeValues.get("visible") ?? true,
          public: state.attributeValues.get("public") ?? true,
        },
        property_values: Object.fromEntries(state.values),
      })),
      // Present only to make the frame limit on this row reachable; the loader
      // reads nothing from it. Its length is whatever
      // saved_configuration_padding_bytes holds.
      padding: paddingBytes > 0 ? "x".repeat(paddingBytes) : "",
    };
    return JSON.stringify(document);
  }

  /**
   * Applies a configuration this host produced. Validates the whole document
   * before it changes anything, so a refusal leaves the device untouched.
   */
  loadInstanceConfigurationFromString(text: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new ServiceRefusal(
        "invalid_value",
        `the configuration is ${text.length} character(s) and is not valid JSON, so nothing was loaded: ${String(e)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ServiceRefusal(
        "invalid_value",
        `the configuration parsed as ${Array.isArray(parsed) ? "an array" : typeof parsed}, not as a JSON object; ` +
          `${CONFIGURATION_PRODUCER} writes an object whose "format" is "${MOCK_CONFIGURATION_FORMAT}". Nothing was loaded.`,
      );
    }
    const document = parsed as Record<string, unknown>;
    if (document.format !== MOCK_CONFIGURATION_FORMAT) {
      throw new ServiceRefusal(
        "invalid_value",
        `this host loads only configurations it produced itself. The string's "format" is ` +
          `${JSON.stringify(document.format ?? null)} and this host writes "${MOCK_CONFIGURATION_FORMAT}". ` +
          "There is no openDAQ SDK in this process, so an openDAQ saveConfiguration document cannot be applied here " +
          "and is not guessed at. Nothing was loaded.",
      );
    }
    if (document.format_version !== MOCK_CONFIGURATION_FORMAT_VERSION) {
      throw new ServiceRefusal(
        "invalid_value",
        `the configuration is format_version ${JSON.stringify(document.format_version ?? null)} and this host writes ` +
          `and reads version ${MOCK_CONFIGURATION_FORMAT_VERSION}. Nothing was loaded.`,
      );
    }
    if (!Array.isArray(document.components)) {
      throw new ServiceRefusal(
        "invalid_value",
        `the configuration carries no "components" array (it carries ${JSON.stringify(document.components ?? null)}), ` +
          "so there is nothing to apply. Nothing was loaded.",
      );
    }
    const componentDocuments = document.components as Record<string, unknown>[];
    for (const componentDocument of componentDocuments) {
      if (typeof componentDocument?.id !== "string") {
        throw new ServiceRefusal(
          "invalid_value",
          `one entry of the configuration's components array has no string "id": ` +
            `${JSON.stringify(componentDocument)}. Nothing was loaded.`,
        );
      }
    }

    const changes: string[] = [];

    if (typeof document.operation_mode === "string" && document.operation_mode !== this.operationMode) {
      const previous = this.operationMode;
      if (!OFFERED_OPERATION_MODES.includes(document.operation_mode as NodeOperationMode)) {
        throw new ServiceRefusal(
          "invalid_value",
          `the configuration asks for operation mode "${document.operation_mode}", which this device does not offer ` +
            `(it offers ${OFFERED_OPERATION_MODES.join(", ")}). Nothing was loaded.`,
        );
      }
      this.operationMode = document.operation_mode as NodeOperationMode;
      changes.push(`operation_mode ${previous} -> ${this.operationMode}`);
    }

    // The device row first, because two of its properties BUILD components:
    // spare_channel_present fits and removes a channel, and waveform_shape
    // reshapes descriptors. Restoring it before the rest means the components
    // the rest of the document describes exist by the time they are reached.
    const deviceDocument = componentDocuments.find((entry) => entry.id === DEVICE_NODE_ID);
    if (deviceDocument) changes.push(...this.restoreOneComponentFromConfiguration(deviceDocument));

    changes.push(...this.reconcileAddedComponentsWithConfiguration(componentDocuments));

    let skipped = 0;
    for (const componentDocument of componentDocuments) {
      if (componentDocument.id === DEVICE_NODE_ID) continue;
      if (!this.components.has(componentDocument.id as string)) {
        skipped++;
        continue;
      }
      changes.push(...this.restoreOneComponentFromConfiguration(componentDocument));
    }

    return (
      `loaded a ${text.length}-character ${MOCK_CONFIGURATION_FORMAT} v${MOCK_CONFIGURATION_FORMAT_VERSION} ` +
      `configuration produced by ${JSON.stringify(document.produced_by ?? "an unnamed producer")}, describing ` +
      `${componentDocuments.length} component(s). ${changes.length} change(s) applied` +
      `${changes.length > 0 ? `: ${changes.join("; ")}` : " (the device already matched the configuration)"}. ` +
      `${skipped} component(s) in the configuration name nothing this device can build and were skipped.`
    );
  }

  /** Adds every function block and server the configuration has and this device
   *  does not, and removes every one this device has and it does not. */
  private reconcileAddedComponentsWithConfiguration(componentDocuments: Record<string, unknown>[]): string[] {
    const changes: string[] = [];
    const wantedIds = new Set(componentDocuments.map((entry) => entry.id as string));

    for (const state of [...this.components.values()]) {
      const isRemovable = state.node.kind === "function_block" || state.node.kind === "server";
      if (!isRemovable || wantedIds.has(state.node.id)) continue;
      const removedIds = this.subtreeNodeIdsDeepestFirst(state.node.id);
      for (const removedId of removedIds) {
        this.components.delete(removedId);
        this.emit({ event: "component_removed", payload: { node_id: removedId } });
      }
      const parent = this.components.get(state.node.parent_id ?? "");
      if (parent) parent.node.child_ids = parent.node.child_ids.filter((childId) => childId !== state.node.id);
      changes.push(`removed ${state.node.kind} ${state.node.id}, which the configuration does not carry`);
    }

    for (const componentDocument of componentDocuments) {
      const id = componentDocument.id as string;
      if (this.components.has(id)) continue;
      const functionBlockTypeId = componentDocument.function_block_type_id;
      const serverTypeId = componentDocument.server_type_id;
      if (typeof functionBlockTypeId === "string") {
        const type = SYNTHETIC_FUNCTION_BLOCK_TYPES.find((candidate) => candidate.id === functionBlockTypeId);
        if (!type) continue;
        this.addComponent(
          componentNode({
            id,
            name: typeof componentDocument.name === "string" ? componentDocument.name : type.name,
            kind: "function_block",
            parent_id: FUNCTION_BLOCK_FOLDER_ID,
            component_status_message: `rebuilt by load_instance_configuration_from_string from catalogue type "${type.id}"; it ${type.whatItDoes}`,
          }),
          type.buildDescriptors(),
          { functionBlockTypeId: type.id },
        );
        this.emit({ event: "component_added", payload: { node: this.nodeAsItCrossesTheWire(id) } });
        changes.push(`rebuilt function block ${id} from catalogue type ${type.id}`);
      } else if (typeof serverTypeId === "string") {
        const type = SYNTHETIC_SERVER_TYPES.find((candidate) => candidate.id === serverTypeId);
        if (!type) continue;
        this.addComponent(
          componentNode({
            id,
            name: typeof componentDocument.name === "string" ? componentDocument.name : type.name,
            kind: "server",
            parent_id: SERVER_FOLDER_ID,
            component_status_message: this.describeServerDiscoveryState(id, false, "rebuilt by load_instance_configuration_from_string"),
          }),
          type.buildDescriptors(),
          { serverTypeId: type.id },
        );
        this.discoveryEnabledByServerNodeId.set(id, false);
        this.emit({ event: "component_added", payload: { node: this.nodeAsItCrossesTheWire(id) } });
        changes.push(`rebuilt server ${id} from catalogue type ${type.id}`);
      }
    }
    return changes;
  }

  /** Restores one component's name, active flag, attributes and property values,
   *  emitting property_changed for every value that actually moved. */
  private restoreOneComponentFromConfiguration(componentDocument: Record<string, unknown>): string[] {
    const id = componentDocument.id as string;
    const state = this.components.get(id);
    if (!state) return [];
    const changes: string[] = [];

    if (typeof componentDocument.name === "string" && componentDocument.name !== state.node.name) {
      changes.push(`${id} name "${state.node.name}" -> "${componentDocument.name}"`);
      state.node.name = componentDocument.name;
    }
    if (typeof componentDocument.active === "boolean" && componentDocument.active !== state.node.active) {
      changes.push(`${id} active ${state.node.active} -> ${componentDocument.active}`);
      state.node.active = componentDocument.active;
    }
    if (typeof componentDocument.recording === "boolean" && this.isRecorderComponent(state)) {
      const previous = this.recordingByNodeId.get(id) ?? false;
      if (previous !== componentDocument.recording) {
        this.recordingByNodeId.set(id, componentDocument.recording);
        changes.push(`${id} recording ${previous} -> ${componentDocument.recording}`);
      }
    }
    if (typeof componentDocument.discovery_enabled === "boolean" && state.node.kind === "server") {
      const previous = this.discoveryEnabledByServerNodeId.get(id) ?? false;
      if (previous !== componentDocument.discovery_enabled) {
        this.discoveryEnabledByServerNodeId.set(id, componentDocument.discovery_enabled);
        state.node.component_status_message = this.describeServerDiscoveryState(
          id,
          componentDocument.discovery_enabled,
          "restored by load_instance_configuration_from_string",
        );
        changes.push(`${id} discovery ${previous} -> ${componentDocument.discovery_enabled}`);
      }
    }

    const attributeValues = componentDocument.attribute_values;
    if (typeof attributeValues === "object" && attributeValues !== null && !Array.isArray(attributeValues)) {
      for (const [attributeId, value] of Object.entries(attributeValues as Record<string, unknown>)) {
        const previous = state.attributeValues.get(attributeId);
        if (JSON.stringify(previous ?? null) === JSON.stringify(value ?? null)) continue;
        state.attributeValues.set(attributeId, value);
        changes.push(`${id} attribute ${attributeId} ${JSON.stringify(previous ?? null)} -> ${JSON.stringify(value ?? null)}`);
      }
    }

    const propertyValues = componentDocument.property_values;
    if (typeof propertyValues === "object" && propertyValues !== null && !Array.isArray(propertyValues)) {
      for (const [propertyId, value] of Object.entries(propertyValues as Record<string, unknown>)) {
        if (!state.descriptors.has(propertyId)) continue;
        const previous = state.values.get(propertyId);
        if (JSON.stringify(previous ?? null) === JSON.stringify(value ?? null)) continue;
        // Straight through applyStoredPropertyValue, not through
        // setPropertyValue: a configuration load is the instance restoring its
        // own state, not a user write, so read_only properties are restored too
        // and no value is coerced a second time. The property_changed event is
        // emitted exactly as it would be for a live write.
        this.applyStoredPropertyValue(id, propertyId, value);
        changes.push(`${id}.${propertyId} ${JSON.stringify(previous ?? null)} -> ${JSON.stringify(value ?? null)}`);
      }
    }
    return changes;
  }

  // --- data plane ----------------------------------------------------------

  /** true exactly while some subscription is delivering frames for this signal,
   *  which is what the `streamed` attribute reports. */
  isSignalBeingStreamed(signalId: string): boolean {
    for (const sink of this.frameSinks.values()) if (sink.signalId === signalId) return true;
    return false;
  }

  /** The last sample the pump produced on this signal, or null if it never ran
   *  for it. This is what the `last_value` attribute reports. */
  lastSampleValueOf(signalId: string): number | null {
    return this.lastSampleValueBySignalId.get(signalId) ?? null;
  }

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
      // The last sample of the block, kept so the `last_value` attribute has
      // something live to report. ISignal.last_value is live in openDAQ too.
      this.lastSampleValueBySignalId.set(sink.signalId, samples[RAW_SAMPLES_PER_TICK - 1]);
      sink.deliver(subscriptionId, this.domainSampleCounter, samples);
    }

    this.waveformPhase += cyclesPerBlock;
    if (this.waveformPhase > 1e9) this.waveformPhase = 0;
    this.domainSampleCounter += BigInt(RAW_SAMPLES_PER_TICK);
  }
}
