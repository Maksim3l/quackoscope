import type { MethodName } from "../transport";
import type { OperationId } from "../ui/op";

/**
 * Which capability ids a wire method exercises.
 *
 * The pond logs wire calls, because the transport is what observes them; the
 * inspect layer talks in capability ids, because that is what the snippet
 * bundle is keyed by. This is the one place the two vocabularies meet.
 *
 * Typed as Record<MethodName, ...> on purpose: adding a method to the wire
 * contract without saying which capability it exercises is a compile error.
 */
export const CAPABILITY_IDS_BY_WIRE_METHOD: Record<MethodName, OperationId[]> = {
  scan_available_devices: ["device.scan"],
  connect_device: ["device.connect"],
  disconnect_device: ["device.connect"],
  get_component_tree: ["tree.read"],
  get_property_descriptors: ["property.read"],
  get_property_value: ["property.read"],
  set_property_value: ["property.write"],
  // contract/contract.yaml puts all three function-block rows under the one
  // capability function_block.add — listing the types is how a caller learns
  // what it may add, and removing one undoes an add.
  list_function_block_types: ["function_block.add"],
  add_function_block: ["function_block.add"],
  remove_function_block: ["function_block.add"],
  // The host chooses min/max envelope or raw per frame from pixel_columns, so
  // one subscribe call can serve either capability. The frontend asks for the
  // decimated form, which is the id it declares on the control.
  subscribe_signal: ["streaming.decimated"],
  unsubscribe_signal: ["streaming.decimated"],
  read_samples_raw: ["streaming.raw"],
  // The three capabilities that arrived with the per-row component state. Each
  // one gates exactly one control: the device row's operation mode menu, the
  // device row's lock/unlock pair, and the Modules view.
  get_device_operation_modes: ["device.mode"],
  set_device_operation_mode: ["device.mode"],
  lock_device: ["device.lock"],
  unlock_device: ["device.lock"],
  list_loaded_modules: ["module.read"],
  // A separate capability from module.read, and contract/contract.yaml says why
  // in its own words: enumerating the loaded modules is a read, while
  // load_module_from_host_path makes the host process dlopen a file off its own
  // disk and run that file's initialisation. Capability semantics are all-of,
  // so folding the two together would mean a host cannot offer the list without
  // also offering the loader.
  load_module_from_host_path: ["module.load"],
};

export function capabilityIdsForWireMethod(method: string): OperationId[] {
  const known = CAPABILITY_IDS_BY_WIRE_METHOD as Record<
    string,
    OperationId[] | undefined
  >;
  return known[method] ?? [];
}
