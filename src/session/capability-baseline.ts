import capabilityBaselineArtifact from "../../generated/wire/capability-baseline.json";

/**
 * The contract's capability baseline, as static frontend data.
 *
 * generated/wire/capability-baseline.json is compiled from contract/contract.yaml
 * by tools/contract-compiler. It is imported into the bundle, not fetched, so
 * the subtraction that produces a gap list —
 *
 *     gaps = baseline capability ids  minus  the ids the host declared
 *
 * has its baseline half available before any socket opens and with no host of
 * any language running. A host never supplies the gap list; the only thing the
 * frontend takes from a host's `gaps` array is the kind and the reason text for
 * a gap the frontend already computed.
 */

/** Printed in the UI so a reader can go look at the file the baseline came from. */
export const CAPABILITY_BASELINE_ARTIFACT_PATH =
  "generated/wire/capability-baseline.json";

/** Exactly two kinds, per contract/contract.yaml gap_generation.kinds. */
export type GapKind = "binding" | "host";
export const GAP_KINDS: readonly GapKind[] = ["binding", "host"];

export function isGapKind(value: unknown): value is GapKind {
  return value === "binding" || value === "host";
}

/** The contract's own one-line meaning of each kind, quoted from the artifact. */
export const CONTRACT_MEANING_OF_GAP_KIND: Readonly<Record<GapKind, string>> = {
  binding: capabilityBaselineArtifact.gap_kinds.binding,
  host: capabilityBaselineArtifact.gap_kinds.host,
};

export const BASELINE_CONTRACT_NAME: string =
  capabilityBaselineArtifact.contract_name;
export const BASELINE_PROTOCOL_VERSION: string =
  capabilityBaselineArtifact.protocol_version;
export const GAP_IS_COMPUTED_AS: string =
  capabilityBaselineArtifact.gap_computed_as;
export const HOST_MAY_DECLARE_GAP_LIST: boolean =
  capabilityBaselineArtifact.host_may_declare_gap_list;

/** The capability ids, in the order contract/contract.yaml declares them. */
export const BASELINE_CAPABILITY_IDS: readonly string[] =
  capabilityBaselineArtifact.capabilities.map((capability) => capability.id);

/** Which wire methods a capability owns. Printed beside a gap so the reader sees what is lost. */
const WIRE_METHODS_BY_CAPABILITY_ID: ReadonlyMap<string, readonly string[]> =
  new Map(
    capabilityBaselineArtifact.capabilities.map((capability) => [
      capability.id,
      capability.wire_methods as readonly string[],
    ]),
  );

export function wireMethodsForCapabilityId(
  capabilityId: string,
): readonly string[] {
  return WIRE_METHODS_BY_CAPABILITY_ID.get(capabilityId) ?? [];
}

export function isBaselineCapabilityId(capabilityId: string): boolean {
  return WIRE_METHODS_BY_CAPABILITY_ID.has(capabilityId);
}

/** "8 capability ids and 13 wire methods, read from generated/wire/capability-baseline.json" */
export function describeCapabilityBaseline(): string {
  return (
    `${BASELINE_CAPABILITY_IDS.length} capability ids covering ` +
    `${capabilityBaselineArtifact.wire_method_count} wire methods, read from ` +
    `${CAPABILITY_BASELINE_ARTIFACT_PATH} (contract ${BASELINE_CONTRACT_NAME}, ` +
    `protocol_version ${BASELINE_PROTOCOL_VERSION})`
  );
}
