import type {
  ComponentTypeInfo,
  MethodName,
  ModuleInfo,
  TransportClient,
} from "../transport";
import { WireError } from "../transport";
import type { OperationId } from "../ui/op";
import {
  BASELINE_CAPABILITY_IDS,
  WIRE_METHOD_NAMES,
} from "../../generated/typescript/contract-types";
import { CAPABILITY_IDS_BY_WIRE_METHOD } from "../inspect/capability-ids-for-wire-method";
import { COMPONENT_TYPE_KINDS_IN_THE_REFERENCE_BAND_ORDER } from "./component-type-kinds-in-the-reference-band-order";

/**
 * The one contract row this view sends, and the shape check applied to what
 * comes back.
 *
 * `list_loaded_modules` takes no parameters and answers with `array of
 * ModuleInfo`. One call fills the whole surface — contract/contract.yaml says
 * why in its own comment: the reference reads `instance.module_manager.modules`
 * in-process and then reads four type dictionaries off each module, which over a
 * socket would be 1 + 4N calls, so the component types ride inside ModuleInfo.
 *
 * `TransportClient.call` is typed on `MethodContract`, so the call below is the
 * ordinary typed call and lands in the call log like any other. What `call` does
 * NOT do is verify that the host kept the promise, which is what the decoding
 * here is for: a host that answers with something other than ModuleInfo[] must
 * produce a sentence naming what it actually sent.
 */

export const LIST_LOADED_MODULES: MethodName = "list_loaded_modules";
export const MODULE_READ: OperationId = "module.read";
export const GENERATED_CONTRACT_TYPES_PATH =
  "generated/typescript/contract-types.ts";

/** Refuses at import time if this file has drifted from the generated contract. */
function refuseIfTheGeneratedContractDoesNotCarryThisRow(): void {
  const wireMethodNames: readonly string[] = WIRE_METHOD_NAMES;
  const capabilityIds: readonly string[] = BASELINE_CAPABILITY_IDS;
  if (!wireMethodNames.includes(LIST_LOADED_MODULES)) {
    throw new Error(
      `wire method "${LIST_LOADED_MODULES}" is named by ` +
        "src/loaded-modules-card-grid/ask-the-host-for-its-loaded-modules.ts but is not one of the " +
        `${WIRE_METHOD_NAMES.length} wire methods in ${GENERATED_CONTRACT_TYPES_PATH}: ` +
        WIRE_METHOD_NAMES.join(", "),
    );
  }
  if (!capabilityIds.includes(MODULE_READ)) {
    throw new Error(
      `capability "${MODULE_READ}" is not one of the ${BASELINE_CAPABILITY_IDS.length} baseline ` +
        `capability ids in ${GENERATED_CONTRACT_TYPES_PATH}: ` +
        BASELINE_CAPABILITY_IDS.join(", "),
    );
  }
  const filedUnder = CAPABILITY_IDS_BY_WIRE_METHOD[LIST_LOADED_MODULES];
  if (!filedUnder.includes(MODULE_READ)) {
    throw new Error(
      `src/inspect/capability-ids-for-wire-method.ts files ${LIST_LOADED_MODULES} under ` +
        `${filedUnder.join(", ")}, but contract/contract.yaml files it under ${MODULE_READ}`,
    );
  }
}

refuseIfTheGeneratedContractDoesNotCarryThisRow();

/** What a host sent back when it did not send back what the contract says. */
export class HostAnsweredListLoadedModulesOffContract extends Error {
  constructor(
    readonly complaint: string,
    readonly received: unknown,
  ) {
    super(
      `${LIST_LOADED_MODULES} answered off contract: ${complaint}. ` +
        `${GENERATED_CONTRACT_TYPES_PATH} is the shape it was checked against. ` +
        `Received: ${JSON.stringify(received)?.slice(0, 400) ?? String(received)}`,
    );
    this.name = "HostAnsweredListLoadedModulesOffContract";
  }
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  where: string,
  received: unknown,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new HostAnsweredListLoadedModulesOffContract(
      `${where} has ${field} of type ${typeof value}, and contract/contract.yaml makes it a required string`,
      received,
    );
  }
  return value;
}

function nullableString(
  record: Record<string, unknown>,
  field: string,
  where: string,
  received: unknown,
): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new HostAnsweredListLoadedModulesOffContract(
      `${where} has ${field} of type ${typeof value}, and contract/contract.yaml makes it a nullable string`,
      received,
    );
  }
  return value;
}

function decodeComponentType(
  element: unknown,
  where: string,
  received: unknown,
): ComponentTypeInfo {
  if (typeof element !== "object" || element === null) {
    throw new HostAnsweredListLoadedModulesOffContract(
      `${where} is ${element === null ? "null" : typeof element} and the contract makes it a ComponentTypeInfo record`,
      received,
    );
  }
  const record = element as Record<string, unknown>;
  const kind = requiredString(record, "kind", where, received);
  const knownKinds = COMPONENT_TYPE_KINDS_IN_THE_REFERENCE_BAND_ORDER.map(
    (each) => each.kind,
  );
  if (!(knownKinds as readonly string[]).includes(kind)) {
    throw new HostAnsweredListLoadedModulesOffContract(
      `${where} has kind "${kind}", which is outside the closed set ${knownKinds.join(", ")}`,
      received,
    );
  }
  return {
    id: requiredString(record, "id", where, received),
    name: requiredString(record, "name", where, received),
    kind: kind as ComponentTypeInfo["kind"],
    description: nullableString(record, "description", where, received),
    connection_string_prefix: nullableString(
      record,
      "connection_string_prefix",
      where,
      received,
    ),
  };
}

export function decodeLoadedModules(received: unknown): ModuleInfo[] {
  if (!Array.isArray(received)) {
    throw new HostAnsweredListLoadedModulesOffContract(
      `the contract's returns is an array of ModuleInfo and the host sent ${typeof received}`,
      received,
    );
  }
  return received.map((element, index) => {
    const where = `element ${index}`;
    if (typeof element !== "object" || element === null) {
      throw new HostAnsweredListLoadedModulesOffContract(
        `${where} is ${element === null ? "null" : typeof element} and the contract makes it a ModuleInfo record`,
        received,
      );
    }
    const record = element as Record<string, unknown>;
    const componentTypes = record.component_types;
    if (!Array.isArray(componentTypes)) {
      throw new HostAnsweredListLoadedModulesOffContract(
        `${where} has component_types of type ${typeof componentTypes}, and the contract makes it a required array`,
        received,
      );
    }
    return {
      id: requiredString(record, "id", where, received),
      name: requiredString(record, "name", where, received),
      version: nullableString(record, "version", where, received),
      component_types: componentTypes.map((type, typeIndex) =>
        decodeComponentType(
          type,
          `${where} component_types[${typeIndex}]`,
          received,
        ),
      ),
    };
  });
}

export async function listLoadedModules(
  client: TransportClient,
): Promise<ModuleInfo[]> {
  return decodeLoadedModules(await client.call("list_loaded_modules", {}));
}

/** The host's own refusal, taken apart into the two things it said. */
export function describeSendFailure(error: unknown): {
  code: string;
  detail: string;
} {
  if (error instanceof WireError) {
    return { code: error.code, detail: error.detail };
  }
  if (error instanceof HostAnsweredListLoadedModulesOffContract) {
    return { code: "off contract", detail: error.message };
  }
  return { code: "internal", detail: String(error) };
}
