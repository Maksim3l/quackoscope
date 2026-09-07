import {
  CAPABILITY_BASELINE_ARTIFACT_PATH,
  CONTRACT_MEANING_OF_GAP_KIND,
} from "./capability-baseline";
import type { CapabilityStanding } from "./host-handshake";

/**
 * How a gap is shown.
 *
 * The two kinds are two different DECLARATIONS the host made, and they are
 * written and styled as two different things. They are distinguished by what
 * contract/contract.yaml says each kind means — the strings in
 * generated/wire/capability-baseline.json, quoted through
 * CONTRACT_MEANING_OF_GAP_KIND — and by nothing else:
 *
 *   binding — "the SDK binding for this host language lacks the feature"
 *   host    — "the handler has not been written yet"
 *
 * This file states no opinion about what any openDAQ binding can or cannot do.
 * It used to: every kind:host gap printed the fixed sentence "The openDAQ
 * binding it is built on can do this; the host has simply not been asked to."
 * Nobody enumerated any binding's surface, so that sentence asserted a cause
 * that had not been established — about every host, for every capability, at
 * once. It is deleted. What a gap means beyond the contract's one line is the
 * host's to say, and the host's own `reason` is printed verbatim below.
 *
 * A third rendering exists for the case the contract does not name: the
 * capability is absent from the handshake's capabilities array and the host
 * declared no reason for it. That is not a kind — it is the absence of one, and
 * it is said as such rather than guessed into "host".
 */

export type GapPresentation = "binding" | "host" | "undeclared";

export function gapPresentationOf(standing: CapabilityStanding): GapPresentation {
  if (standing.gap === null) throw new Error("gapPresentationOf on a served capability");
  return standing.gap.kind ?? "undeclared";
}

/**
 * The one line beside the tag. For the two declared kinds it is the CONTRACT'S
 * own meaning of the kind the host declared, quoted from the baseline artifact
 * and attributed to the host that declared it — never this app's own reading of
 * what a binding can do.
 */
const HEADLINE_BY_PRESENTATION: Record<GapPresentation, string> = {
  binding: `the host declared kind binding — ${CONTRACT_MEANING_OF_GAP_KIND.binding}`,
  host: `the host declared kind host — ${CONTRACT_MEANING_OF_GAP_KIND.host}`,
  undeclared: "the host left this out and said nothing about it",
};

const SHORT_TAG_BY_PRESENTATION: Record<GapPresentation, string> = {
  binding: "binding gap",
  host: "host gap",
  undeclared: "undeclared gap",
};

export function headlineForGap(standing: CapabilityStanding): string {
  return HEADLINE_BY_PRESENTATION[gapPresentationOf(standing)];
}

export function shortTagForGap(standing: CapabilityStanding): string {
  return SHORT_TAG_BY_PRESENTATION[gapPresentationOf(standing)];
}

/**
 * What is ESTABLISHED about this gap, in words, for the host that is actually
 * connected. Two kinds, two different sentences — never one sentence with the
 * kind substituted into it.
 *
 * Three facts are established and all three are stated: the capability is
 * missing from the handshake's capabilities array, the host declared this kind
 * for it, and the contract defines that kind as this. Anything past those three
 * would be a cause this app did not establish, so this app does not say it —
 * the host's own reason follows verbatim in the block below.
 */
export function explainGap(
  standing: CapabilityStanding,
  hostProcessName: string,
): string {
  const presentation = gapPresentationOf(standing);
  if (presentation === "binding") {
    return (
      `${hostProcessName} left ${standing.capabilityId} out of the handshake's ` +
      `capabilities array and declared the kind of the gap as binding, which ` +
      `${CAPABILITY_BASELINE_ARTIFACT_PATH} defines as "` +
      `${CONTRACT_MEANING_OF_GAP_KIND.binding}". That is ${hostProcessName}'s ` +
      `claim about its own language binding, printed here as it was declared; ` +
      `this page enumerated no binding's API surface and adds nothing to it.`
    );
  }
  if (presentation === "host") {
    return (
      `${hostProcessName} left ${standing.capabilityId} out of the handshake's ` +
      `capabilities array and declared the kind of the gap as host, which ` +
      `${CAPABILITY_BASELINE_ARTIFACT_PATH} defines as "` +
      `${CONTRACT_MEANING_OF_GAP_KIND.host}". Nothing is claimed here about the ` +
      `openDAQ binding for ${hostProcessName}'s language — this page enumerated ` +
      `no API surface and will not assert a cause it did not establish.`
    );
  }
  return (
    `${hostProcessName} did not list ${standing.capabilityId} among its ` +
    `capabilities and declared no reason for leaving it out. The gap itself is ` +
    `computed from ${CAPABILITY_BASELINE_ARTIFACT_PATH}, which does not know why; ` +
    `the explanation was the host's to give and it gave none.`
  );
}

/** One line, for a title attribute on a control that is disabled by this gap. */
export function describeGapInOneLine(
  standing: CapabilityStanding,
  hostProcessName: string,
): string {
  const declaredReason = standing.gap?.reason;
  return (
    `disabled — ${standing.capabilityId} is a ${shortTagForGap(standing)} on ` +
    `${hostProcessName}: ${headlineForGap(standing)}` +
    (declaredReason ? `. ${hostProcessName} says: ${declaredReason}` : "")
  );
}

/**
 * The block shown where a gapped control would be. It carries data-op with the
 * gapped capability id so it can still be quacked: a disabled control cannot
 * receive a click, and "what would this have called" is exactly the question a
 * reader has when something is greyed out.
 */
export function CapabilityGapNotice({
  standing,
  hostProcessName,
  whatIsBlocked,
}: {
  standing: CapabilityStanding;
  hostProcessName: string;
  /** The concrete thing the reader cannot do here, in the app's own words. */
  whatIsBlocked: string;
}) {
  const presentation = gapPresentationOf(standing);
  const declaredKind = standing.gap?.kindAsDeclared ?? null;
  const declaredReason = standing.gap?.reason ?? null;

  return (
    <div
      className={`gap-notice gap-notice--${presentation}`}
      data-op={standing.capabilityId}
      role="note"
    >
      <div className="gap-notice-head">
        <span className={`gap-tag gap-tag--${presentation}`}>
          {SHORT_TAG_BY_PRESENTATION[presentation]}
        </span>
        <strong>{HEADLINE_BY_PRESENTATION[presentation]}</strong>
        <code className="mono">{standing.capabilityId}</code>
      </div>

      <p className="gap-notice-blocked">{whatIsBlocked}</p>
      <p className="gap-notice-meaning">{explainGap(standing, hostProcessName)}</p>

      {declaredReason !== null ? (
        <blockquote className="gap-notice-reason">
          <span className="muted">
            {hostProcessName} declared kind{" "}
            <code className="mono">{declaredKind}</code>
            {presentation === "undeclared" && declaredKind !== null
              ? ` — which is outside the closed set {binding, host}, so it is shown as declared and not acted on`
              : ""}
            . Its own reason for the gap, verbatim and unedited:
          </span>
          <span className="gap-notice-reason-text">{declaredReason}</span>
        </blockquote>
      ) : (
        <p className="muted gap-notice-reason gap-notice-reason--absent">
          {hostProcessName} declared no reason for this gap. The gap is computed
          from {CAPABILITY_BASELINE_ARTIFACT_PATH}; the absence of an explanation
          is the host's.
        </p>
      )}

      {standing.wireMethods.length > 0 && (
        <p className="muted gap-notice-methods mono">
          unavailable wire methods: {standing.wireMethods.join(", ")}
        </p>
      )}

      {presentation !== "undeclared" && (
        <p className="muted gap-notice-contract">
          The sentence above quotes{" "}
          <code className="mono">{CAPABILITY_BASELINE_ARTIFACT_PATH}</code>{" "}
          gap_kinds.<code className="mono">{presentation}</code>. That quoted
          line and {hostProcessName}&apos;s own reason are everything this page
          knows about why {standing.capabilityId} is missing.
        </p>
      )}
    </div>
  );
}
