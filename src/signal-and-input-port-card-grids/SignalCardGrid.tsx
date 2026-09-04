import { useMemo, useState } from "react";
import { CardGrid } from "../card-grid/CardGrid";
import { FlockForOperation } from "../inspect/FlockColumns";
import type { CardGridField, CardGridItemFacts } from "../card-grid/card-grid-model";
import { cardStateMark } from "../card-grid/card-states";
import type { Node, TransportClient } from "../transport";
import {
  describeTheRowInOneLine,
  GET_SIGNAL_LAST_VALUE_ROW,
} from "./contract-rows-these-grids-wait-on";
import { SignalCard } from "./SignalCard";
import {
  localIdOf,
  signalSectionBannerFor,
  signalsForTheOutputSignalGrid,
} from "./signals-and-input-ports-from-the-component-tree";
import { THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE } from "./ReadOnlyDefinitionListWithPerRowCopy";

/**
 * §2.15 — `output_signals_view.py` becomes the signal card grid.
 *
 * "One card = one signal. Grid `--card-min` 300 px in the right stack, which at
 * 45 % of 1 155 px ≈ 520 px gives 1 column — so signal cards are effectively a
 * list, which matches the reference's own one-row-per-signal shape."
 *
 * The grid is populated by `get_component_tree`, which has already run: a signal
 * is a component, so §2.15's list is a filter over nodes in hand rather than a
 * call of its own. That is why this grid works today and the two beside it do
 * not.
 *
 * The reference's banner text is kept — `Signal info` for a signal node,
 * `Output signals` for a device or function block — because it is the one thing
 * that tells a reader whether they are looking at the selected signal or at the
 * signals a component produces.
 */

const SIGNAL_GRID_ID = "output-signals";

const SIGNAL_FIELDS: readonly CardGridField<Node>[] = [
  {
    id: "name",
    label: "name",
    valueOf: (signal) => signal.name,
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: "local-id",
    label: "local id",
    valueOf: (signal) => localIdOf(signal),
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: "global-id",
    label: "global id",
    valueOf: (signal) => signal.id,
    onCardFaceByDefault: false,
    searchedByFilter: true,
  },
  {
    id: "last-value",
    label: "last value",
    // Every signal's last value is the same absent word, for the same reason,
    // and the field says so rather than being left out: it is the field the
    // reference's row is built around, and a chooser that pretends it does not
    // exist would hide the gap instead of teaching it.
    valueOf: () => THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE,
    onCardFaceByDefault: true,
    searchedByFilter: false,
  },
  {
    id: "property-count",
    label: "properties",
    valueOf: (signal) => String(signal.property_ids.length),
    compare: (a, b) => a.property_ids.length - b.property_ids.length,
    onCardFaceByDefault: false,
    searchedByFilter: false,
  },
];

export function SignalCardGrid({
  client,
  nodes,
  component,
}: {
  client: TransportClient;
  nodes: readonly Node[];
  component: Node;
}) {
  const signals = useMemo(
    () => signalsForTheOutputSignalGrid(nodes, component),
    [nodes, component],
  );
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);

  const factsOf = (signal: Node): CardGridItemFacts => ({
    id: signal.id,
    title: signal.name,
    states: [
      cardStateMark(
        "gapped",
        describeTheRowInOneLine(GET_SIGNAL_LAST_VALUE_ROW),
        "undeclared",
      ),
    ],
    hiddenByDescriptor: false,
  });

  // output_signals_view.py expands the first chartable signal on its own. The
  // chartability test needs O15, so "first chartable" is not knowable here and
  // this is "first". Which signal that is, and the subscribe_signal /
  // unsubscribe_signal an expand and a collapse send, are on the card's own
  // quack strip; the grid does not narrate them in a paragraph of its own.
  const firstSignalId = signals.length > 0 ? signals[0].id : null;

  return (
    <section className="right-stack-section" aria-label={signalSectionBannerFor(component)}>
      <h3 className="right-stack-banner">{signalSectionBannerFor(component)}</h3>

      {signals.length === 0 ? (
        <NoSignalsUnderThisComponent nodes={nodes} component={component} />
      ) : (
        <CardGrid
          gridId={SIGNAL_GRID_ID}
          entityNounSingular="signal"
          entityNounPlural="signals"
          items={signals}
          factsOf={factsOf}
          fields={SIGNAL_FIELDS}
          cardMinWidth="standard"
          hostOrderLabel="tree order"
          titleColumnLabel="Signal name"
          operationIdsOf={() => ["streaming.decimated", "tree.read"]}
          populatedBy={{ wireMethod: "get_component_tree" }}
          selectedCardId={selectedSignalId}
          onSelect={(signal) => setSelectedSignalId(signal.id)}
          renderCard={(signal, view) => (
            <SignalCard
              key={signal.id}
              client={client}
              signal={signal}
              view={view}
              chartExpandedByDefault={signal.id === firstSignalId}
              selected={signal.id === selectedSignalId}
              onSelect={() => setSelectedSignalId(signal.id)}
            />
          )}
        />
      )}
    </section>
  );
}

/**
 * §3.6 asks that an empty grid show "the call that would have populated the
 * grid… with a sentence saying it returned an empty list". The call here is
 * `get_component_tree` and it did NOT return an empty list — it returned the
 * whole tree — so the shared grid's own empty state would have printed a
 * sentence that is not true of this grid, and this one is written instead.
 *
 * What is true, and what it prints, is the count that was actually taken: the
 * component has no signals of its own. On the C++ host's reference device that
 * is the literal shape of the tree — the root device's `Sig` folder is empty and
 * every signal lives under a channel — and the sentence says so with the numbers
 * it counted rather than with a guess about why.
 */
function NoSignalsUnderThisComponent({
  nodes,
  component,
}: {
  nodes: readonly Node[];
  component: Node;
}) {
  const signalsAnywhere = nodes.filter((node) => node.kind === "signal").length;
  return (
    <div className="card-grid-empty card-grid-empty--flock" role="status">
      <p className="card-grid-empty-sentence">
        <code className="mono">get_component_tree</code> answered with{" "}
        {nodes.length} node{nodes.length === 1 ? "" : "s"}, of which{" "}
        {signalsAnywhere} {signalsAnywhere === 1 ? "is a signal" : "are signals"}{" "}
        — and none of those sits under {component.name}.
      </p>
      <FlockForOperation operationId="tree.read" />
    </div>
  );
}
