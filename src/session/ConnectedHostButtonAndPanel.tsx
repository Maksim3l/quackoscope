import { useState } from "react";
import type { LinkStatus } from "../transport";
import type { ConfiguredBackend } from "./backend-choices";
import {
  displayNameForBackend,
  type BackendNamesSeen,
} from "./backend-display-name";
import {
  CAPABILITY_BASELINE_ARTIFACT_PATH,
  describeCapabilityBaseline,
  GAP_IS_COMPUTED_AS,
  HOST_MAY_DECLARE_GAP_LIST,
} from "./capability-baseline";
import {
  CapabilityGapNotice,
  gapPresentationOf,
  headlineForGap,
  shortTagForGap,
} from "./CapabilityGapNotice";
import { ChooseWhichHostToTalkTo } from "./ChooseWhichHostToTalkTo";
import {
  describeSdk,
  hostProcessNameOf,
  type CapabilityStanding,
} from "./host-handshake";
import { useHostSession } from "./host-capability-context";

/**
 * The one thing the top bar says about the host, and the one panel behind it.
 *
 * WHAT THE BAR USED TO CARRY, and where each piece went. The bar had eight
 * children: the brand, a monospace identity span 401 px wide reading
 * "quackoscope-host-cpp 0.2.0 · openDAQ 3.41.0_bec37b44 @ bec37b4", a chip
 * reading "gaps 1/11", a "backend C++ :7955" button, a spacer, "pond 11",
 * "inspector mode off" and a pill reading "open". Three of those named the same
 * host, and two of them named it in jargon.
 *
 *   implementation name/version, openDAQ version and commit  -> this panel
 *   "gaps 1/11"                                              -> deleted from the
 *       bar; the button below carries "1 unavailable" ONLY while something is,
 *       and the detail is in this panel's second section
 *   the socket pill                                          -> the dot on this
 *       button, since the socket's state is a fact about this host
 *   choosing another backend                                 -> this panel's
 *       third section, which was its own button and its own panel before
 *
 * What is left in the bar for the host is one control: the host's short name,
 * its port, whether it is answering, and — only when true — how many things it
 * cannot do. Everything printed here still comes from the handshake that host
 * actually sent; implementation.name is DISPLAY ONLY and this file is display.
 *
 * And it says it only while the socket is open. A handshake is the first message
 * of ONE session; when that session's socket drops, App drops the handshake with
 * it, and this button falls back to the name the browser remembers for the URL.
 */

/** "connected" / "connecting" / "not connected", never a socket state name. */
const PLAIN_WORDS_FOR_SOCKET_STATE: Record<string, string> = {
  open: "connected",
  connecting: "connecting",
  closed: "not connected",
  idle: "not connected",
};

export function ConnectedHostButton({
  backends,
  chosenUrl,
  link,
  namesSeen,
  onChoose,
  onAdd,
  onRemove,
}: {
  backends: readonly ConfiguredBackend[];
  chosenUrl: string;
  link: LinkStatus;
  namesSeen: BackendNamesSeen;
  onChoose: (url: string) => void;
  onAdd: (url: string) => void;
  onRemove: (url: string) => void;
}) {
  const session = useHostSession();
  const [panelOpen, setPanelOpen] = useState(false);

  const reading = session?.handshakeReading ?? null;
  const capabilityReading = session?.capabilityReading ?? null;
  const handshake = reading !== null && reading.read ? reading.handshake : null;
  const socketState = session?.socketState ?? "idle";
  const linkInPlainWords = PLAIN_WORDS_FOR_SOCKET_STATE[socketState] ?? socketState;

  const unavailableCount = capabilityReading?.gappedCapabilityIds.length ?? 0;
  const askableCount = capabilityReading?.standings.length ?? 0;
  const unavailableIds = capabilityReading?.gappedCapabilityIds ?? [];

  const chosen = backends.find((backend) => backend.url === chosenUrl) ?? null;
  const displayed = displayNameForBackend({
    url: chosenUrl,
    implementationNameFromThisSessionsHandshake:
      handshake?.implementation.name ?? null,
    nameSeenEarlier: namesSeen[chosenUrl] ?? null,
    shippedDefaultName: chosen?.defaultDisplayName ?? null,
  });

  // The whole title, built from the values it is talking about. A reader who
  // hovers gets the identity that used to sit permanently in the bar.
  const title =
    (handshake === null
      ? reading !== null && !reading.read
        ? `the first message on ${chosenUrl} was not a handshake, so nothing is known about what is answering there`
        : `no host has identified itself on ${chosenUrl} yet`
      : `${handshake.implementation.name} ${handshake.implementation.version} on ${chosenUrl}, built on ${describeSdk(handshake)}`) +
    `. The socket is ${linkInPlainWords}` +
    (unavailableCount === 0
      ? handshake === null
        ? ""
        : `, and it does every one of the ${askableCount} things quackoscope can ask a host for`
      : `, and it does not do ${unavailableCount} of the ${askableCount} things quackoscope can ask a host for: ${unavailableIds.join(", ")}`) +
    `. Opens the host panel.`;

  return (
    <>
      <button
        className={
          "chrome-button host-button" +
          (unavailableCount > 0 ? " host-button--something-unavailable" : "")
        }
        data-quack-chrome=""
        aria-expanded={panelOpen}
        title={title}
        onClick={() => setPanelOpen((open) => !open)}
      >
        <span
          className={`host-link-dot host-link-dot--${socketState}`}
          aria-hidden="true"
        />
        <span className="host-button-name">{displayed.name}</span>
        {/* When nothing has ever answered on this URL the name IS the port —
            "port 7969" — and printing ":7969" beside it says the same number
            twice. */}
        {displayed.source !== "the port, because nothing has answered here yet" && (
          <span className="host-button-port mono">{displayed.portText}</span>
        )}
        {socketState !== "open" && (
          <span className="host-button-link">{linkInPlainWords}</span>
        )}
        {unavailableCount > 0 && (
          <span className="host-button-unavailable">
            {unavailableCount} unavailable
          </span>
        )}
      </button>

      {panelOpen && (
        <aside
          className="host-panel"
          data-quack-chrome=""
          role="dialog"
          aria-label="the host this app is talking to"
        >
          <header className="host-panel-head">
            <h2>host</h2>
            <span className="muted mono">
              {chosenUrl} — {linkInPlainWords}
            </span>
            <span className="spacer" />
            <button
              className="chrome-button"
              data-quack-chrome=""
              onClick={() => setPanelOpen(false)}
            >
              close
            </button>
          </header>

          <div className="host-panel-body">
            <WhatThisHostIs />
            <WhatIsNotAvailableOnThisHost />
            <ChooseWhichHostToTalkTo
              backends={backends}
              chosenUrl={chosenUrl}
              link={link}
              namesSeen={namesSeen}
              onChoose={onChoose}
              onAdd={onAdd}
              onRemove={onRemove}
              onChosen={() => setPanelOpen(false)}
            />
          </div>
        </aside>
      )}
    </>
  );
}

/**
 * The identity that used to sit in the bar, in full: the handshake's own fields,
 * labelled, with the whole commit rather than seven characters of it.
 */
function WhatThisHostIs() {
  const session = useHostSession();
  const reading = session?.handshakeReading ?? null;

  if (reading === null) {
    return (
      <section className="host-panel-section">
        <h3>what this host is</h3>
        <p className="muted">
          No handshake is being held for {session?.backendUrl ?? "the socket"},
          whose state is <code className="mono">{session?.socketState ?? "idle"}</code>
          . The contract puts the handshake at ordinal 1 of every session, so
          either nothing that is neither a result nor an event has arrived yet,
          this host sends none, or the session that carried one ended — a
          handshake is dropped the moment its socket leaves{" "}
          <code className="mono">open</code>, because it describes that session
          and no other.
        </p>
      </section>
    );
  }

  if (!reading.read) {
    return (
      <section className="host-panel-section handshake-facts--refused">
        <h3>what this host is</h3>
        <p className="error" role="alert">
          The first non-envelope message was not a handshake: {reading.refusal}
        </p>
        <p className="muted">
          It arrived as message {reading.ordinalInSession} of the session. Verbatim:
        </p>
        <pre className="mono handshake-raw">{reading.rawText}</pre>
      </section>
    );
  }

  const handshake = reading.handshake;
  return (
    <section className="host-panel-section">
      <h3>what this host is</h3>
      <dl className="handshake-fields">
        <dt>implementation</dt>
        <dd className="mono">
          {handshake.implementation.name} {handshake.implementation.version}
          <span className="muted"> — display only; nothing branches on it</span>
        </dd>
        <dt>openDAQ</dt>
        <dd className="mono">
          {describeSdk(handshake)}
          <span className="muted"> — full commit {handshake.sdk.commit}</span>
        </dd>
        <dt>protocol_version</dt>
        <dd className="mono">{handshake.protocol_version}</dd>
        <dt>limits</dt>
        <dd className="mono">
          max_subscriptions {handshake.limits.max_subscriptions}, max_frame_bytes{" "}
          {handshake.limits.max_frame_bytes}
        </dd>
        <dt>ordinal</dt>
        <dd className="mono">
          message {handshake.ordinalInSession} of the session
          {handshake.ordinalInSession === 1
            ? ""
            : " — the contract requires ordinal 1, so this host answered something before it greeted"}
        </dd>
      </dl>
    </section>
  );
}

/**
 * The section the bar's "gaps 1/11" chip pointed at without saying so. The
 * capability standings are unchanged — this is where kinds and reasons are
 * explained properly — only the headings are said in words a reader who has
 * never opened contract/contract.yaml can follow.
 */
function WhatIsNotAvailableOnThisHost() {
  const session = useHostSession();
  const reading = session?.capabilityReading ?? null;
  const hostProcessName = hostProcessNameOf(session?.handshakeReading ?? null);

  if (reading === null) {
    return (
      <section className="host-panel-section gap-list">
        <h3>what is not available here</h3>
        <p className="muted">
          No handshake has been read, so nothing has been worked out. The
          baseline half of the subtraction is present regardless —{" "}
          {describeCapabilityBaseline()} — but with no declared capability set to
          subtract, nothing is claimed and no control is blocked.
        </p>
      </section>
    );
  }

  const unavailable = reading.gappedCapabilityIds.length;
  const askable = reading.standings.length;

  return (
    <section className="host-panel-section gap-list">
      <h3>
        {unavailable === 0
          ? `what is not available here — nothing: ${hostProcessName} does all ${askable} things quackoscope can ask for`
          : `what is not available here — ${unavailable} of the ${askable} things quackoscope can ask ${hostProcessName} for`}
      </h3>
      <p className="muted gap-list-rule">
        Worked out here, not taken from the host: {GAP_IS_COMPUTED_AS}, against{" "}
        {describeCapabilityBaseline()}.{" "}
        {HOST_MAY_DECLARE_GAP_LIST
          ? "The contract allows a host-supplied gap list."
          : "A host may not supply a gap list; only a reason per gap, which is looked up and quoted below."}
      </p>

      <ul className="standing-rows">
        {reading.standings.map((standing) => (
          <StandingRow
            key={standing.capabilityId}
            standing={standing}
            hostProcessName={hostProcessName}
          />
        ))}
      </ul>

      {reading.declaredCapabilityIdsOutsideTheBaseline.length > 0 && (
        <p className="handshake-anomaly">
          {hostProcessName} declared{" "}
          {reading.declaredCapabilityIdsOutsideTheBaseline.length} capability id
          {reading.declaredCapabilityIdsOutsideTheBaseline.length === 1 ? "" : "s"}{" "}
          that {CAPABILITY_BASELINE_ARTIFACT_PATH} does not define, so they take
          part in nothing:{" "}
          <code className="mono">
            {reading.declaredCapabilityIdsOutsideTheBaseline.join(", ")}
          </code>
        </p>
      )}

      {reading.declaredGapReasonsOutsideTheBaseline.length > 0 && (
        <div className="handshake-anomaly">
          <p>
            {hostProcessName} sent {reading.declaredGapReasonsOutsideTheBaseline.length}{" "}
            gap entr
            {reading.declaredGapReasonsOutsideTheBaseline.length === 1 ? "y" : "ies"}{" "}
            for capabilities outside the baseline. A gap list is computed, never
            declared, so these named no gap and were not added to the list above.
            They are printed here rather than dropped:
          </p>
          <ul className="mono">
            {reading.declaredGapReasonsOutsideTheBaseline.map((declaredGap) => (
              <li key={declaredGap.capability}>
                {declaredGap.capability} ({declaredGap.kindAsDeclared || "no kind"})
              </li>
            ))}
          </ul>
        </div>
      )}

      {reading.declaredGapReasonsContradictingDeclaredCapabilities.length > 0 && (
        <p className="handshake-anomaly">
          {hostProcessName} declared a gap reason for{" "}
          <code className="mono">
            {reading.declaredGapReasonsContradictingDeclaredCapabilities
              .map((declaredGap) => declaredGap.capability)
              .join(", ")}
          </code>{" "}
          while also listing the same id as a capability it serves. The capability
          list wins, because that is what the gap list is computed from.
        </p>
      )}

      {(session?.strayNonEnvelopeMessageCount ?? 0) > 0 && (
        <p className="handshake-anomaly">
          {session?.strayNonEnvelopeMessageCount} further message
          {session?.strayNonEnvelopeMessageCount === 1 ? "" : "s"} arrived that
          were neither a result nor an event. The contract defines exactly one
          such message per session, the handshake, so these were ignored.
        </p>
      )}
    </section>
  );
}

function StandingRow({
  standing,
  hostProcessName,
}: {
  standing: CapabilityStanding;
  hostProcessName: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (standing.served) {
    return (
      <li className="standing-row standing-row--served">
        <span className="standing-mark standing-mark--served">available</span>
        <code className="mono standing-id">{standing.capabilityId}</code>
        <span className="muted mono standing-methods">
          {standing.wireMethods.join(", ")}
        </span>
      </li>
    );
  }

  const presentation = gapPresentationOf(standing);
  return (
    <li className={`standing-row standing-row--gap standing-row--${presentation}`}>
      {/* The mark is the answer to the same question the row above answers, so
          it is the same kind of word: available / not available. Which KIND of
          gap it is — the contract's word for it — is the headline beside it and
          the block under "why", where there is room to say what the kind means.
          The colour still carries the kind, through gap-tag--{presentation}. */}
      <span
        className={`standing-mark gap-tag gap-tag--${presentation}`}
        title={shortTagForGap(standing)}
      >
        not available
      </span>
      <code className="mono standing-id">{standing.capabilityId}</code>
      <span className="standing-headline">{headlineForGap(standing)}</span>
      <button
        className="chrome-button"
        data-quack-chrome=""
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? "less" : "why"}
      </button>
      {expanded && (
        <div className="standing-detail">
          <CapabilityGapNotice
            standing={standing}
            hostProcessName={hostProcessName}
            whatIsBlocked={`Every control in the app that declares ${standing.capabilityId} is disabled for this session.`}
          />
        </div>
      )}
    </li>
  );
}
