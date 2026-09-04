import type { MethodName, ModuleInfo, TransportClient } from "../transport";
import type { OperationId } from "../ui/op";
import {
  BASELINE_CAPABILITY_IDS,
  WIRE_METHOD_NAMES,
} from "../../generated/typescript/contract-types";
import { CAPABILITY_IDS_BY_WIRE_METHOD } from "../inspect/capability-ids-for-wire-method";

/**
 * The contract row that loads a module the host has NOT loaded, and the one
 * fact about it a control must never hide.
 *
 * `list_loaded_modules` lists what IS loaded. This is a different operation
 * under a different capability, and the two are not blurred anywhere: the grid
 * says `module.read`, this says `module.load`, and a host can serve either
 * without the other.
 *
 * THE PATH IS ON THE HOST'S FILESYSTEM. contract/contract.yaml puts that in the
 * row's own name and in the parameter's name so no signature can lose it, and it
 * chose a host-side path over uploading bytes on three grounds: openDAQ's
 * `IModuleManager::loadModule` takes a path and has no bytes-in sibling, this
 * contract's request envelope carries JSON only and its binary frame is defined
 * server-to-client with no correlation id, and `max_frame_bytes` defaults to
 * 262144 while a module binary is megabytes. What that obliges a control to be
 * is written in the same comment and is not optional: a path FIELD, never a
 * local file picker, because a browser file input yields a path on the machine
 * the reader is sitting at and the host may have no such file.
 *
 * The extension is decided by the HOST's platform — `.module.dll` on Windows,
 * `.dylib` on Darwin, `.module.so` elsewhere — and openDAQ's compile-time
 * `OPENDAQ_MODULE_SUFFIX` is not exported to the install headers, so no host can
 * read it back out of the SDK and no client can be told it in advance. A wrong
 * extension is refused `invalid_value` with openDAQ's own message, which names
 * the suffix; that refusal is the honest way to learn it, and it is why nothing
 * here filters the field by the platform the BROWSER is running on.
 */

export const LOAD_MODULE_FROM_HOST_PATH: MethodName =
  "load_module_from_host_path";
export const MODULE_LOAD: OperationId = "module.load";
export const GENERATED_CONTRACT_TYPES_PATH =
  "generated/typescript/contract-types.ts";

/** Refuses at import time if this file has drifted from the generated contract. */
function refuseIfTheGeneratedContractDoesNotCarryThisRow(): void {
  const wireMethodNames: readonly string[] = WIRE_METHOD_NAMES;
  const capabilityIds: readonly string[] = BASELINE_CAPABILITY_IDS;
  if (!wireMethodNames.includes(LOAD_MODULE_FROM_HOST_PATH)) {
    throw new Error(
      `wire method "${LOAD_MODULE_FROM_HOST_PATH}" is named by ` +
        "src/loaded-modules-card-grid/load-a-module-from-a-path-on-the-hosts-own-filesystem.ts " +
        `but is not one of the ${WIRE_METHOD_NAMES.length} wire methods in ` +
        `${GENERATED_CONTRACT_TYPES_PATH}: ${WIRE_METHOD_NAMES.join(", ")}`,
    );
  }
  if (!capabilityIds.includes(MODULE_LOAD)) {
    throw new Error(
      `capability "${MODULE_LOAD}" is not one of the ${BASELINE_CAPABILITY_IDS.length} baseline ` +
        `capability ids in ${GENERATED_CONTRACT_TYPES_PATH}: ` +
        BASELINE_CAPABILITY_IDS.join(", "),
    );
  }
  const filedUnder = CAPABILITY_IDS_BY_WIRE_METHOD[LOAD_MODULE_FROM_HOST_PATH];
  if (!filedUnder.includes(MODULE_LOAD)) {
    throw new Error(
      `src/inspect/capability-ids-for-wire-method.ts files ${LOAD_MODULE_FROM_HOST_PATH} under ` +
        `${filedUnder.join(", ")}, but contract/contract.yaml files it under ${MODULE_LOAD}`,
    );
  }
}

refuseIfTheGeneratedContractDoesNotCarryThisRow();

/** What one `load_module_from_host_path` did, in the host's own terms. */
export interface ModuleLoadOutcome {
  /** The call as it was sent, with the literal path. */
  call: string;
  /** The `ModuleInfo` the row answers with, or null when it was refused. */
  loaded: ModuleInfo | null;
  /** One of not_found, not_connected, invalid_value, internal. Null on success. */
  errorCode: string | null;
  /** The host's own detail, verbatim. Empty on success. */
  detail: string;
}

export async function loadModuleFromHostPath(
  client: TransportClient,
  hostPath: string,
): Promise<ModuleInfo> {
  // The literal, not the LOAD_MODULE_FROM_HOST_PATH constant: `call` is generic
  // over the method NAME, so a widened `MethodName` widens the result to the
  // union of every row's result and the ModuleInfo is lost. The constant above
  // is checked against the generated contract at import time and is what every
  // string the reader sees is built from.
  return client.call("load_module_from_host_path", { host_path: hostPath });
}

/**
 * Why this path cannot be sent yet, in words — or the empty string when it can.
 *
 * It refuses one thing and one thing only: an empty field. Everything else the
 * host decides, because everything else is a fact about the host's filesystem
 * and the host's platform. A client that rejected a path for its extension would
 * be guessing which operating system the host runs on, and a client that
 * demanded an absolute path would be guessing what absolute means there.
 */
export function whyThisPathCannotBeSentYet(typed: string): string {
  if (typed.trim().length === 0) {
    return "type a path first — host_path is required and the contract gives it no default";
  }
  return "";
}
