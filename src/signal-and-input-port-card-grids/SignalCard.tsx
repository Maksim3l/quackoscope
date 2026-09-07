import type { ReactNode } from "react";
import { Card } from "../card-grid/Card";
import type { CardCall } from "../card-grid/CardQuackStrip";
import { cardStateMark } from "../card-grid/card-states";
import type { CardFaceView } from "../card-grid/card-grid-model";
import { ComponentIcon } from "../component-tree/component-icon-sprite";
import { SignalPlot } from "../components/SignalPlot";
import { CapabilityGapNotice } from "../session/CapabilityGapNotice";
import {
  useCapabilityStanding,
  useHostProcessName,
} from "../session/host-capability-context";
import type { TransportClient, CallLogEntry, Node } from "../transport";
import {
  describeTheRowInOneLine,
  GET_SIGNAL_LAST_VALUE_ROW,
  SUBSCRIBE_SIGNAL_HAS_NO_WINDOW_PARAMETER,
} from "./contract-rows-these-grids-wait-on";
import { localIdOf } from "./signals-and-input-ports-from-the-component-tree";
import {
  ReadOnlyDefinitionListWithPerRowCopy,
  THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE,
} from "./ReadOnlyDefinitionListWithPerRowCopy";

/**
 * §2.15's signal card. One card = one signal.
 *
 * Face, as §2.15 writes it: "`signal` icon · name · last value, right-aligned,
 * truncated, mono · a `right`/`down` expander when the signal is chartable ·
 * quack strip."
 *
 * Three of those five are built from the tree that is already in hand. The last
 * value is not: nothing on this wire returns one, so the slot renders the
 * neutral word and the row it is waiting on (O16 `get_signal_last_value`)
 * instead of a number nobody measured.
 *
 * **"when the signal is chartable" is a test this app cannot run.** The
 * reference's `OutputSignalGraph._is_chartable` reads six things off the
 * descriptor and the domain descriptor — sample type, dimensions, struct
 * fields, the domain unit's symbol, the tick resolution and the data rule — and
 * `get_signal_descriptor` (O15) is not in the contract, so not one of the six is
 * knowable here. The expander is therefore offered on every signal and the host
 * answers: `subscribe_signal` either streams frames or returns an error, and
 * whichever it does is printed. Guessing chartability from a name would be
 * inventing the answer to the exact question the row exists to answer.
 *
 * ## What this card does NOT do to SignalPlot
 *
 * Nothing. `src/components/SignalPlot.tsx` is imported and mounted, unmodified.
 * Its whole discipline — the uPlot instance, the column buffers, the frame
 * counter and every sample living in refs and effect-local closures, never in
 * React state — is preserved by not touching it: expanding the card mounts the
 * component, which subscribes; collapsing unmounts it, and its own cleanup
 * sends `unsubscribe_signal` and destroys the plot. There is one plotting path
 * in this app and this card uses it.
 */

/** §2.15: "the reference's display-duration presets 0.01 / 0.05 / 0.1 / 0.2 / 0.5 / 1 s, default 0.2 s." */
export const DISPLAY_DURATION_PRESETS_SECONDS = [
  0.01, 0.05, 0.1, 0.2, 0.5, 1,
] as const;
export const DEFAULT_DISPLAY_DURATION_SECONDS = 0.2;

export function SignalCard({
  client,
  signal,
  view,
  chartExpandedByDefault,
  selected,
  onSelect,
}: {
  client: TransportClient;
  signal: Node;
  view: CardFaceView;
  /**
   * `output_signals_view.py` expands the first chartable signal by itself
   * (`_auto_expanded`), and this grid keeps that behaviour for the first card.
   * It is a subscription the reader did not ask for, so it is passed in by the
   * grid rather than decided here, and the grid says so on screen.
   */
  chartExpandedByDefault: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const streamingStanding = useCapabilityStanding("streaming.decimated");
  const hostProcessName = useHostProcessName();
  const streamingIsGapped =
    streamingStanding !== null &&
    !streamingStanding.served &&
    streamingStanding.gap !== null;

  const subscribeCall: CardCall = {
    wireMethod: "subscribe_signal",
    pondEntryIsThisCards: (entry: CallLogEntry) =>
      typeof entry.params === "object" &&
      entry.params !== null &&
      (entry.params as { signal_id?: unknown }).signal_id === signal.id,
  };
  const treeCall: CardCall = { wireMethod: "get_component_tree" };

  const metaFacts = [
    `local id ${localIdOf(signal)}`,
    ...(view.fieldIsOnTheCardFace("global-id") ? [signal.id] : []),
    ...(view.fieldIsOnTheCardFace("property-count")
      ? [
          `${signal.property_ids.length} propert${signal.property_ids.length === 1 ? "y" : "ies"}`,
        ]
      : []),
  ];

  return (
    <Card
      cardId={signal.id}
      glyph={<ComponentIcon name="signal" />}
      title={signal.name}
      titleTooltip={signal.id}
      headerChips={[{ label: "signal", tone: "value-type" }]}
      states={[
        cardStateMark(
          "gapped",
          describeTheRowInOneLine(GET_SIGNAL_LAST_VALUE_ROW),
          "undeclared",
        ),
      ]}
      metaLineReplacement={
        <span className="card-gap-one-liner card-gap-one-liner--undeclared">
          <span className="gap-tag gap-tag--undeclared">contract gap</span>
          {metaFacts.join(" · ")} — the last value is{" "}
          {THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE}:{" "}
          <code className="mono">
            {GET_SIGNAL_LAST_VALUE_ROW.wireMethodThatDoesNotExist}
          </code>{" "}
          is not one of contract/contract.yaml&apos;s thirteen operations.
        </span>
      }
      operationIds={["streaming.decimated", "tree.read"]}
      calls={[subscribeCall, treeCall]}
      selected={selected}
      onSelect={onSelect}
      expandedColumnSpan={view.expandedColumnSpan}
      defaultExpanded={chartExpandedByDefault}
      back={{
        reveals:
          "the chart, the display-duration presets and the read-only value view",
        operationIds: ["streaming.decimated"],
        content: (
          <SignalCardBack
            client={client}
            signal={signal}
            streamingIsGapped={streamingIsGapped}
            gapNotice={
              streamingIsGapped && streamingStanding !== null ? (
                <CapabilityGapNotice
                  standing={streamingStanding}
                  hostProcessName={hostProcessName}
                  whatIsBlocked={`${signal.name} cannot be plotted: subscribe_signal was never sent, so no sample frame arrives and no canvas is created.`}
                />
              ) : null
            }
          />
        ),
      }}
    >
      <div className="signal-card-value-row">
        <span className="signal-card-value-label">last value</span>
        <span className="signal-card-value mono signal-card-value--absent">
          {THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE}
        </span>
      </div>
    </Card>
  );
}

/**
 * The card's back: §2.15's chart and §2.8's value view, behind one expander.
 *
 * §2.8 collapses four reference dialogs into one control — "One expander
 * control, one animation, four dialogs deleted" — and §2.15 puts the chart
 * behind the same gesture. So the back holds both, in the order the reference
 * shows them: duration controls, then the graph, then the value the *View*
 * button opened.
 */
function SignalCardBack({
  client,
  signal,
  streamingIsGapped,
  gapNotice,
}: {
  client: TransportClient;
  signal: Node;
  streamingIsGapped: boolean;
  gapNotice: ReactNode;
}) {
  return (
    <div className="signal-card-back">
      <DisplayDurationPresets />

      <section className="signal-card-chart">
        {/* The gate is here and not inside SignalPlot so that SignalPlot's
            imperative lifecycle stays untouched: when streaming.decimated is a
            gap the component is never mounted, no subscription is opened and no
            canvas is created. */}
        {streamingIsGapped ? gapNotice : (
          <SignalPlot client={client} signal={signal} />
        )}
      </section>

      <section className="signal-card-value-view">
        <h4 className="signal-card-back-heading">Value view, read-only</h4>
        <p className="muted signal-card-back-note">
          {describeTheRowInOneLine(GET_SIGNAL_LAST_VALUE_ROW)} What follows is
          the whole of what the wire does say about this signal — the{" "}
          <code className="mono">Node</code> record{" "}
          <code className="mono">get_component_tree</code> answered with, read-only.
        </p>
        <ReadOnlyDefinitionListWithPerRowCopy
          describedAs={`the Node record for ${signal.name}`}
          entries={[
            { name: "id", value: signal.id },
            { name: "name", value: signal.name },
            { name: "kind", value: signal.kind },
            { name: "parent_id", value: signal.parent_id },
            {
              name: "child_ids",
              value:
                signal.child_ids.length === 0
                  ? "[]"
                  : signal.child_ids.join(", "),
            },
            {
              name: "property_ids",
              value:
                signal.property_ids.length === 0
                  ? "[]"
                  : signal.property_ids.join(", "),
              note: "the property ids get_property_descriptors would be asked for",
            },
          ]}
        />
      </section>
    </div>
  );
}

/**
 * §2.15's duration presets, disabled, naming what they are waiting for.
 *
 * The presets and the 0.2 s default are the reference's, taken verbatim from
 * `output_signal_row.py`. What is not the reference's is a way to ask for them:
 * `subscribe_signal` takes `signal_id` and `pixel_columns` and nothing else, so
 * a preset that appeared to work would be a control that silently changed
 * nothing. It renders, it is focusable, it says why it cannot act, and it names
 * the parameter that would let it — which is what §3.7 asks a dead control to do.
 */
function DisplayDurationPresets() {
  return (
    <section className="display-duration-presets" data-gapped="">
      <span className="display-duration-label">Display duration</span>
      <div className="display-duration-buttons" role="group" aria-label="display duration presets">
        {DISPLAY_DURATION_PRESETS_SECONDS.map((seconds) => (
          <button
            key={seconds}
            type="button"
            className={
              "chrome-button" +
              (seconds === DEFAULT_DISPLAY_DURATION_SECONDS
                ? " chrome-button--on"
                : "")
            }
            disabled
            data-gapped=""
            aria-pressed={seconds === DEFAULT_DISPLAY_DURATION_SECONDS}
            title={describeTheRowInOneLine(
              SUBSCRIBE_SIGNAL_HAS_NO_WINDOW_PARAMETER,
            )}
          >
            {seconds}s
          </button>
        ))}
      </div>
      <p className="muted display-duration-why">
        {DEFAULT_DISPLAY_DURATION_SECONDS}s is the reference&apos;s default and
        these six are its presets. None of them can be sent:{" "}
        <code className="mono">subscribe_signal</code> takes{" "}
        <code className="mono">signal_id</code> and{" "}
        <code className="mono">pixel_columns</code>, so the host alone decides how
        much time a frame covers. There is no parameter in contract/contract.yaml
        that would carry a duration.
      </p>
    </section>
  );
}
