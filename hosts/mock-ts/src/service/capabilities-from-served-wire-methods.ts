// quackoscope-host-mock -- capability derivation for the section 1.6 handshake.
//
// Two settled rules of contract/contract.yaml section 4 live here:
//
//   * `capabilities` is a list of CAPABILITY IDS -- the ids of section 4 and
//     nothing else; the count is whatever BASELINE_CAPABILITY_IDS carries, and
//     is deliberately not written down here, because a number written down is a
//     number that goes stale (it has already gone from 8 to 12 to 20). Wire
//     method names and event names are not capability ids and must never appear
//     in that field.
//   * `gap_generation.host_may_declare_gap_list: false`. The gap list is
//     COMPUTED as baseline minus declared capabilities. A host writes only the
//     reason per capability it does not serve.
//
// The baseline and the closed wire method table are read from
// generated/typescript/contract-types.ts, which tools/contract-compiler emits
// from contract/contract.yaml, rather than retyped here. The operation ->
// capability table below is hand-written, so it is cross-checked against that
// generated file at module load and throws naming the offending entry if the
// two ever disagree.

import {
  BASELINE_CAPABILITY_IDS,
  WIRE_METHOD_NAMES,
  type CapabilityId,
  type WireMethodName,
} from "../../../../generated/typescript/contract-types.ts";

/** One row of the contract's closed operation table (section 5): the wire
 *  method name and the capability id that owns it. */
export interface ContractOperation {
  wireMethod: WireMethodName;
  capability: CapabilityId;
}

// The 30 rows of contract/contract.yaml section 5, in the order that file
// lists them. The verification below is what forces each new one in: it throws
// at module load naming any wire method that contract-types.ts has and this
// table does not.
//
// It has now caught four contract growths nobody announced to this host. The
// most recent was the eleven rows below the module pair -- the two attribute
// rows, the three server rows, the two recorder rows, the two batched-update
// rows and the two configuration rows -- which arrived with eight new
// capability ids and stopped this process at import with:
//
//   Error: wire method "get_component_attributes" is in
//   generated/typescript/contract-types.ts but missing from the operation table
//   of hosts/mock-ts/src/service/capabilities-from-served-wire-methods.ts
//
// That is the guard working: the alternative is a host whose handshake silently
// keeps describing an older contract.
const CONTRACT_OPERATION_TABLE: readonly ContractOperation[] = [
  { wireMethod: "scan_available_devices", capability: "device.scan" },
  { wireMethod: "connect_device", capability: "device.connect" },
  { wireMethod: "disconnect_device", capability: "device.connect" },
  { wireMethod: "get_component_tree", capability: "tree.read" },
  { wireMethod: "get_property_value", capability: "property.read" },
  { wireMethod: "get_property_descriptors", capability: "property.read" },
  { wireMethod: "set_property_value", capability: "property.write" },
  { wireMethod: "list_function_block_types", capability: "function_block.add" },
  { wireMethod: "add_function_block", capability: "function_block.add" },
  { wireMethod: "remove_function_block", capability: "function_block.add" },
  { wireMethod: "subscribe_signal", capability: "streaming.decimated" },
  { wireMethod: "unsubscribe_signal", capability: "streaming.decimated" },
  { wireMethod: "read_samples_raw", capability: "streaming.raw" },
  { wireMethod: "get_device_operation_modes", capability: "device.mode" },
  { wireMethod: "set_device_operation_mode", capability: "device.mode" },
  { wireMethod: "lock_device", capability: "device.lock" },
  { wireMethod: "unlock_device", capability: "device.lock" },
  { wireMethod: "list_loaded_modules", capability: "module.read" },
  { wireMethod: "load_module_from_host_path", capability: "module.load" },
  { wireMethod: "get_component_attributes", capability: "attribute.read" },
  { wireMethod: "set_component_attribute", capability: "attribute.write" },
  { wireMethod: "list_server_types", capability: "server.add" },
  { wireMethod: "add_server", capability: "server.add" },
  { wireMethod: "set_server_discovery_enabled", capability: "server.discovery" },
  { wireMethod: "start_recording", capability: "recorder.control" },
  { wireMethod: "stop_recording", capability: "recorder.control" },
  { wireMethod: "begin_batched_property_update", capability: "property.batched_update" },
  { wireMethod: "end_batched_property_update", capability: "property.batched_update" },
  { wireMethod: "save_instance_configuration_to_string", capability: "configuration.save" },
  { wireMethod: "load_instance_configuration_from_string", capability: "configuration.load" },
];

const GENERATED_CONTRACT_FILE = "generated/typescript/contract-types.ts";
const OPERATION_TABLE_FILE = "hosts/mock-ts/src/service/capabilities-from-served-wire-methods.ts";

function verifyOperationTableAgainstGeneratedContract(): void {
  const generatedMethods = new Set<string>(WIRE_METHOD_NAMES);
  const tableMethods = new Set<string>();

  for (const row of CONTRACT_OPERATION_TABLE) {
    if (tableMethods.has(row.wireMethod)) {
      throw new Error(`wire method "${row.wireMethod}" appears twice in the operation table of ${OPERATION_TABLE_FILE}`);
    }
    tableMethods.add(row.wireMethod);
    if (!BASELINE_CAPABILITY_IDS.includes(row.capability)) {
      throw new Error(
        `wire method "${row.wireMethod}" is mapped to capability "${row.capability}", which is not one of the ` +
          `${BASELINE_CAPABILITY_IDS.length} baseline capability ids in ${GENERATED_CONTRACT_FILE}: ` +
          BASELINE_CAPABILITY_IDS.join(", "),
      );
    }
  }

  for (const method of generatedMethods) {
    if (!tableMethods.has(method)) {
      throw new Error(
        `wire method "${method}" is in ${GENERATED_CONTRACT_FILE} but missing from the operation table of ${OPERATION_TABLE_FILE}`,
      );
    }
  }
  for (const method of tableMethods) {
    if (!generatedMethods.has(method)) {
      throw new Error(
        `wire method "${method}" is in the operation table of ${OPERATION_TABLE_FILE} but not in ${GENERATED_CONTRACT_FILE}`,
      );
    }
  }
  for (const capability of BASELINE_CAPABILITY_IDS) {
    const owned = CONTRACT_OPERATION_TABLE.some((row) => row.capability === capability);
    if (!owned) {
      throw new Error(
        `baseline capability "${capability}" owns no wire method in the operation table of ${OPERATION_TABLE_FILE}`,
      );
    }
  }
}

verifyOperationTableAgainstGeneratedContract();

/** The wire methods contract section 5 assigns to one capability id. */
export function wireMethodsOwnedBy(capability: CapabilityId): WireMethodName[] {
  return CONTRACT_OPERATION_TABLE.filter((row) => row.capability === capability).map((row) => row.wireMethod);
}

/**
 * A capability is declared only when EVERY wire method the contract assigns to
 * it has a handler.
 *
 * All-of, not any-of, and the reason is in the contract rather than in taste.
 * Section 4 defines a capability AS its operation list, and
 * lints.capability_operation_lists_agree calls capabilities[].operations and
 * operations[].capability "two views of one mapping [that] must agree exactly
 * in both directions" -- there is no partial reference to half a capability.
 * gap_generation.computed_as is baseline_capabilities_minus_host_capabilities,
 * so `capabilities` and `gaps` are exactly complementary over the baseline ids,
 * and gap_kinds.host is "the handler has not been written yet". Declare a
 * capability on a subset of its operations and the unwritten handler is stated
 * NOWHERE in the handshake: not in `capabilities`, which claims it works, and
 * not in `gaps`, which the id has been excluded from. All-of is the only rule
 * under which the handshake can express the fact the contract gives it words
 * for. hosts/cpp/src/service/handshake.cpp:capabilitiesFullyServedBy() and
 * hosts/python/service/handshake.py:capabilities_fully_served_by() apply the
 * same rule, so a frontend that enables a control on a capability id gets the
 * same promise from every backend.
 *
 * Result keeps the baseline order of contract/contract.yaml section 4.
 */
export function capabilitiesFullyServedBy(servedWireMethods: readonly WireMethodName[]): CapabilityId[] {
  const served = new Set<string>(servedWireMethods);
  for (const method of served) {
    if (!WIRE_METHOD_NAMES.includes(method as WireMethodName)) {
      throw new Error(
        `"${method}" was handed to capabilitiesFullyServedBy as a served wire method but is not one of the ` +
          `${WIRE_METHOD_NAMES.length} wire methods in ${GENERATED_CONTRACT_FILE}: ` +
          WIRE_METHOD_NAMES.join(", "),
      );
    }
  }
  return BASELINE_CAPABILITY_IDS.filter((capability) =>
    wireMethodsOwnedBy(capability).every((wireMethod) => served.has(wireMethod)),
  ).slice();
}

export interface Gap {
  capability: CapabilityId;
  /** Exactly the two kinds of contract section 4: "binding" or "host". */
  kind: "binding" | "host";
  reason: string;
}

/**
 * baseline minus declared, one Gap record each, reason looked up per id. The
 * caller supplies reasons only; it never supplies the list.
 *
 * Throws naming the capability if a gap has no reason: an undeclared gap would
 * reach the wire with an empty reason, and contract types.Gap.reason has
 * min_length 1.
 */
export function gapsAgainstBaseline(
  declaredCapabilities: readonly CapabilityId[],
  reasonsByCapability: Readonly<Partial<Record<CapabilityId, { kind: "binding" | "host"; reason: string }>>>,
  reasonTableFile: string,
): Gap[] {
  const gaps: Gap[] = [];
  for (const capability of BASELINE_CAPABILITY_IDS) {
    if (declaredCapabilities.includes(capability)) continue;
    const declared = reasonsByCapability[capability];
    if (!declared || declared.reason.length === 0) {
      throw new Error(
        `capability "${capability}" is a gap (this host does not serve every wire method it owns: ` +
          `${wireMethodsOwnedBy(capability).join(", ")}) but ${reasonTableFile} declares no reason for it; ` +
          "contract types.Gap.reason has min_length 1, so the handshake cannot be built",
      );
    }
    gaps.push({ capability, kind: declared.kind, reason: declared.reason });
  }
  return gaps;
}

export { BASELINE_CAPABILITY_IDS, WIRE_METHOD_NAMES };
export type { CapabilityId, WireMethodName };
