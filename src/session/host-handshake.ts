import {
  BASELINE_CAPABILITY_IDS,
  isBaselineCapabilityId,
  isGapKind,
  wireMethodsForCapabilityId,
  type GapKind,
} from "./capability-baseline";

/**
 * The handshake: the first message the host sends on every session, before it
 * answers anything.
 *
 * Two rules from contract/contract.yaml are load-bearing in this file.
 *
 *  1. implementation.name is DISPLAY ONLY. Nothing here branches on it, and
 *     nothing that imports this module may. The only place a name influences
 *     anything is src/inspect/snippet-bundle.ts, which uses the contract's own
 *     `quackoscope-host-<lang>` pattern to decide which snippet column to put a
 *     "running host" tag on — a label, not a behaviour.
 *
 *  2. host_may_declare_gap_list is false. The gap list is COMPUTED here as
 *     baseline-minus-declared-capabilities. A host's `gaps` array is read for
 *     one thing only: the kind and the reason text of a gap this file already
 *     computed. A gap entry naming a capability outside the baseline is not
 *     added to the list; it is reported separately as something the host should
 *     not have sent.
 */

export interface DeclaredGapReason {
  capability: string;
  /** null when the host sent a kind outside the closed set {binding, host}. */
  kind: GapKind | null;
  /** Verbatim, so an out-of-set kind can be printed rather than hidden. */
  kindAsDeclared: string;
  reason: string;
}

export interface HostHandshake {
  protocol_version: string;
  implementation: { name: string; version: string };
  sdk: { version: string; commit: string };
  /** Verbatim. Read for membership only: is capability X in this array. */
  declaredCapabilityIds: readonly string[];
  /** Verbatim. Read only to look up a kind and a reason for a computed gap. */
  declaredGapReasons: readonly DeclaredGapReason[];
  limits: { max_subscriptions: number; max_frame_bytes: number };
  /** Which message of the session this was. The contract requires 1. */
  ordinalInSession: number;
}

export type HandshakeReading =
  | { read: true; handshake: HostHandshake }
  | { read: false; refusal: string; rawText: string; ordinalInSession: number };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  holder: Record<string, unknown>,
  key: string,
): string | null {
  const value = holder[key];
  return typeof value === "string" ? value : null;
}

function shortenForRefusal(text: string): string {
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

/**
 * Parses the first non-envelope text message of a session as a handshake.
 *
 * A refusal names the exact field that was missing or the wrong type and quotes
 * what arrived instead, because "invalid handshake" tells a reader nothing about
 * which host to go fix.
 */
export function readHandshakeMessage(
  raw: unknown,
  rawText: string,
  ordinalInSession: number,
): HandshakeReading {
  const refuse = (refusal: string): HandshakeReading => ({
    read: false,
    refusal,
    rawText: shortenForRefusal(rawText),
    ordinalInSession,
  });

  const message = asRecord(raw);
  if (message === null) {
    return refuse(
      `the message is not a JSON object, so it cannot be a handshake; it parsed to ${typeof raw}`,
    );
  }

  const protocolVersion = readString(message, "protocol_version");
  if (protocolVersion === null) {
    return refuse(
      `no "protocol_version" string; the message carries the keys [${Object.keys(message).join(", ")}]`,
    );
  }

  const implementation = asRecord(message.implementation);
  const implementationName =
    implementation === null ? null : readString(implementation, "name");
  const implementationVersion =
    implementation === null ? null : readString(implementation, "version");
  if (implementationName === null || implementationVersion === null) {
    return refuse(
      `"implementation" must be an object with string "name" and string "version"; got ${JSON.stringify(message.implementation)}`,
    );
  }

  const sdk = asRecord(message.sdk);
  const sdkVersion = sdk === null ? null : readString(sdk, "version");
  const sdkCommit = sdk === null ? null : readString(sdk, "commit");
  if (sdkVersion === null || sdkCommit === null) {
    return refuse(
      `"sdk" must be an object with string "version" and string "commit"; got ${JSON.stringify(message.sdk)}`,
    );
  }

  if (!Array.isArray(message.capabilities)) {
    return refuse(
      `"capabilities" must be an array of capability ids; got ${JSON.stringify(message.capabilities)}`,
    );
  }
  const declaredCapabilityIds = message.capabilities.filter(
    (id): id is string => typeof id === "string",
  );

  const declaredGapReasons: DeclaredGapReason[] = [];
  if (Array.isArray(message.gaps)) {
    for (const entry of message.gaps) {
      const gap = asRecord(entry);
      if (gap === null) continue;
      const capability = readString(gap, "capability");
      const reason = readString(gap, "reason");
      if (capability === null || reason === null) continue;
      const kindAsDeclared = readString(gap, "kind") ?? "";
      declaredGapReasons.push({
        capability,
        kind: isGapKind(kindAsDeclared) ? kindAsDeclared : null,
        kindAsDeclared,
        reason,
      });
    }
  }

  const limits = asRecord(message.limits);
  const maxSubscriptions = limits === null ? null : limits.max_subscriptions;
  const maxFrameBytes = limits === null ? null : limits.max_frame_bytes;
  if (typeof maxSubscriptions !== "number" || typeof maxFrameBytes !== "number") {
    return refuse(
      `"limits" must be an object with numeric "max_subscriptions" and "max_frame_bytes"; got ${JSON.stringify(message.limits)}`,
    );
  }

  return {
    read: true,
    handshake: {
      protocol_version: protocolVersion,
      implementation: { name: implementationName, version: implementationVersion },
      sdk: { version: sdkVersion, commit: sdkCommit },
      declaredCapabilityIds,
      declaredGapReasons,
      limits: {
        max_subscriptions: maxSubscriptions,
        max_frame_bytes: maxFrameBytes,
      },
      ordinalInSession,
    },
  };
}

// --- the computed gap list -------------------------------------------------

export type CapabilityStanding = {
  capabilityId: string;
  /** The wire methods this capability owns, from the baseline artifact. */
  wireMethods: readonly string[];
  /** True when the host listed this id in handshake.capabilities. */
  served: boolean;
  /**
   * Present exactly when served is false. kind and reason are null when the
   * host declared no reason for this gap: the absence is then stated as the
   * absence it is, never invented.
   */
  gap: {
    kind: GapKind | null;
    kindAsDeclared: string | null;
    reason: string | null;
  } | null;
};

export interface HostCapabilityReading {
  standings: readonly CapabilityStanding[];
  standingByCapabilityId: ReadonlyMap<string, CapabilityStanding>;
  servedCapabilityIds: readonly string[];
  gappedCapabilityIds: readonly string[];
  /** Ids the host declared that contract/contract.yaml does not define. */
  declaredCapabilityIdsOutsideTheBaseline: readonly string[];
  /** Gap reasons the host sent for capabilities outside the baseline: not gaps, reported as sent. */
  declaredGapReasonsOutsideTheBaseline: readonly DeclaredGapReason[];
  /** Gap reasons the host sent for capabilities it ALSO declares as served: a self-contradiction. */
  declaredGapReasonsContradictingDeclaredCapabilities: readonly DeclaredGapReason[];
}

/**
 * Computes the capability standing of every baseline id against one handshake.
 * The host's own gaps array is never the source of the list — only of the text.
 */
export function computeCapabilityStandings(
  handshake: HostHandshake,
): HostCapabilityReading {
  const declared = new Set(handshake.declaredCapabilityIds);
  const reasonByCapability = new Map<string, DeclaredGapReason>();
  for (const declaredGap of handshake.declaredGapReasons) {
    if (!reasonByCapability.has(declaredGap.capability)) {
      reasonByCapability.set(declaredGap.capability, declaredGap);
    }
  }

  const standings: CapabilityStanding[] = BASELINE_CAPABILITY_IDS.map(
    (capabilityId) => {
      const served = declared.has(capabilityId);
      if (served) {
        return {
          capabilityId,
          wireMethods: wireMethodsForCapabilityId(capabilityId),
          served: true,
          gap: null,
        };
      }
      const declaredReason = reasonByCapability.get(capabilityId);
      return {
        capabilityId,
        wireMethods: wireMethodsForCapabilityId(capabilityId),
        served: false,
        gap: {
          kind: declaredReason?.kind ?? null,
          kindAsDeclared: declaredReason?.kindAsDeclared ?? null,
          reason: declaredReason?.reason ?? null,
        },
      };
    },
  );

  return {
    standings,
    standingByCapabilityId: new Map(
      standings.map((standing) => [standing.capabilityId, standing]),
    ),
    servedCapabilityIds: standings.filter((s) => s.served).map((s) => s.capabilityId),
    gappedCapabilityIds: standings.filter((s) => !s.served).map((s) => s.capabilityId),
    declaredCapabilityIdsOutsideTheBaseline:
      handshake.declaredCapabilityIds.filter((id) => !isBaselineCapabilityId(id)),
    declaredGapReasonsOutsideTheBaseline: handshake.declaredGapReasons.filter(
      (declaredGap) => !isBaselineCapabilityId(declaredGap.capability),
    ),
    declaredGapReasonsContradictingDeclaredCapabilities:
      handshake.declaredGapReasons.filter((declaredGap) =>
        declared.has(declaredGap.capability),
      ),
  };
}

/**
 * What to call the host in a sentence when no handshake has been read. It is
 * never a guess at a name, and never the constant this app used to carry.
 */
export const NAME_FOR_A_HOST_THAT_HAS_NOT_IDENTIFIED_ITSELF =
  "the host (which has sent no handshake)";

/** The name to print for a session. Display only, by contract. */
export function hostProcessNameOf(reading: HandshakeReading | null): string {
  return reading !== null && reading.read
    ? reading.handshake.implementation.name
    : NAME_FOR_A_HOST_THAT_HAS_NOT_IDENTIFIED_ITSELF;
}

/** "openDAQ 3.41.0_bec37b44 @ bec37b4" — the sdk line the header prints. */
export function describeSdk(handshake: HostHandshake): string {
  return `openDAQ ${handshake.sdk.version} @ ${shortCommit(handshake.sdk.commit)}`;
}

/** Seven characters, the length git itself abbreviates to; the full hash stays in the title. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{8,}$/i.test(commit) ? commit.slice(0, 7) : commit;
}
