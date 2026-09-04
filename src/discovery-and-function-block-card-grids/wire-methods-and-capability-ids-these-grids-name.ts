import {
  BASELINE_CAPABILITY_IDS,
  WIRE_METHOD_NAMES,
} from "../../generated/typescript/contract-types";
import { CAPABILITY_IDS_BY_WIRE_METHOD } from "../inspect/capability-ids-for-wire-method";
import type { MethodName } from "../transport";
import type { OperationId } from "../ui/op";

/**
 * The six rows of contract/contract.yaml's operation table these two grids
 * name, and the capability id each one is filed under.
 *
 * This file used to cross two vocabularies: `MethodContract` in
 * src/transport/types.ts carried seven of the contract's thirteen wire methods
 * and `OperationId` in src/ui/op.tsx carried five of its eight capability ids,
 * so the grids had to cast into both and teach
 * src/inspect/capability-ids-for-wire-method.ts four keys at runtime. All three
 * files now carry the full contract, so nothing is cast and nothing is patched:
 * the constants below are typed directly as `MethodName` and `OperationId`, and
 * a name outside either union is a compile error.
 *
 * The check at the bottom stays, because the two hand-written unions are still
 * hand-written: it fails loudly at import time if one of them drifts from
 * generated/typescript/contract-types.ts.
 */

export const GENERATED_CONTRACT_TYPES_PATH =
  "generated/typescript/contract-types.ts";
export const HAND_WRITTEN_METHOD_CONTRACT_PATH = "src/transport/types.ts";
export const HAND_WRITTEN_OPERATION_ID_PATH = "src/ui/op.tsx";
export const WIRE_METHOD_CAPABILITY_MAP_PATH =
  "src/inspect/capability-ids-for-wire-method.ts";

export const SCAN_AVAILABLE_DEVICES: MethodName = "scan_available_devices";
export const CONNECT_DEVICE: MethodName = "connect_device";
export const LIST_FUNCTION_BLOCK_TYPES: MethodName = "list_function_block_types";
export const ADD_FUNCTION_BLOCK: MethodName = "add_function_block";
export const REMOVE_FUNCTION_BLOCK: MethodName = "remove_function_block";
export const GET_PROPERTY_DESCRIPTORS: MethodName = "get_property_descriptors";

export const DEVICE_SCAN: OperationId = "device.scan";
export const DEVICE_CONNECT: OperationId = "device.connect";
export const FUNCTION_BLOCK_ADD: OperationId = "function_block.add";
export const PROPERTY_READ: OperationId = "property.read";

export const OPERATION_TABLE_ROWS_THESE_GRIDS_NAME: readonly {
  wireMethod: MethodName;
  capability: OperationId;
}[] = [
  { wireMethod: SCAN_AVAILABLE_DEVICES, capability: DEVICE_SCAN },
  { wireMethod: CONNECT_DEVICE, capability: DEVICE_CONNECT },
  { wireMethod: LIST_FUNCTION_BLOCK_TYPES, capability: FUNCTION_BLOCK_ADD },
  { wireMethod: ADD_FUNCTION_BLOCK, capability: FUNCTION_BLOCK_ADD },
  { wireMethod: REMOVE_FUNCTION_BLOCK, capability: FUNCTION_BLOCK_ADD },
  { wireMethod: GET_PROPERTY_DESCRIPTORS, capability: PROPERTY_READ },
];

/**
 * Refuses at import time if a row named here is not in the generated contract,
 * or if src/inspect/capability-ids-for-wire-method.ts files it under a
 * different capability than contract/contract.yaml does.
 */
function refuseRowsTheGeneratedContractDoesNotCarry(): void {
  const wireMethodNames: readonly string[] = WIRE_METHOD_NAMES;
  const capabilityIds: readonly string[] = BASELINE_CAPABILITY_IDS;
  for (const row of OPERATION_TABLE_ROWS_THESE_GRIDS_NAME) {
    if (!wireMethodNames.includes(row.wireMethod)) {
      throw new Error(
        `wire method "${row.wireMethod}" is named by ` +
          "src/discovery-and-function-block-card-grids/wire-methods-and-capability-ids-these-grids-name.ts " +
          `but is not one of the ${WIRE_METHOD_NAMES.length} wire methods in ` +
          `${GENERATED_CONTRACT_TYPES_PATH}: ${WIRE_METHOD_NAMES.join(", ")}`,
      );
    }
    if (!capabilityIds.includes(row.capability)) {
      throw new Error(
        `wire method "${row.wireMethod}" is mapped to capability "${row.capability}", which is not one of ` +
          `the ${BASELINE_CAPABILITY_IDS.length} baseline capability ids in ` +
          `${GENERATED_CONTRACT_TYPES_PATH}: ${BASELINE_CAPABILITY_IDS.join(", ")}`,
      );
    }
    const filedUnder = CAPABILITY_IDS_BY_WIRE_METHOD[row.wireMethod];
    if (!filedUnder.includes(row.capability)) {
      throw new Error(
        `${WIRE_METHOD_CAPABILITY_MAP_PATH} files ${row.wireMethod} under ` +
          `${filedUnder.join(", ")}, but contract/contract.yaml files it under ` +
          `${row.capability}`,
      );
    }
  }
}

refuseRowsTheGeneratedContractDoesNotCarry();
