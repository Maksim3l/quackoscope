import { useId, useMemo, useState } from "react";
import { Card } from "../card-grid/Card";
import { CardGrid } from "../card-grid/CardGrid";
import type { CardGridField, CardGridItemFacts } from "../card-grid/card-grid-model";
import { cardStateMark } from "../card-grid/card-states";
import { ComponentIcon } from "../component-tree/component-icon-sprite";
import type { Node } from "../transport";
import {
  CONNECT_INPUT_PORT_ROW,
  DISCONNECT_INPUT_PORT_ROW,
  describeTheRowInOneLine,
  GET_INPUT_PORTS_ROW,
  INPUT_PORT_CONNECTION_CHANGED_EVENT,
} from "./contract-rows-these-grids-wait-on";
import { CardWaitingOnAContractRow } from "./the-card-that-names-the-contract-row-it-is-waiting-on";
import { THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE } from "./ReadOnlyDefinitionListWithPerRowCopy";
import {
  everySignalInTheTree,
  inputPortsOfComponent,
  localIdOf,
  signalChoiceText,
} from "./signals-and-input-ports-from-the-component-tree";

/**
 * §2.7's input port card grid — `input_ports_view.py`, one card per port.
 *
 * "Face: `input_port` icon · port name · a `<select>` of every signal on the
 * root device plus `none`, with type-ahead · a `link` / `unlink` glyph showing
 * connection state · the connected signal's id in mono · quack strip listing
 * `connect_input_port` and `disconnect_input_port`."
 *
 * Exactly one of those six is reachable today, and §2.7 is the section that says
 * which: "The candidate signal list needs no contract row — the frontend already
 * holds every `Node` and filters `kind === "signal"`." Everything else — the
 * ports themselves, the connection state, the connected signal's id, and both
 * commits — needs rows O8, O9 and O10, which contract/contract.yaml does not
 * have.
 *
 * So this grid renders the candidate list for real, from real tree data, inside
 * a card that names the four rows it is waiting on. That is §3.7's whole
 * argument put on screen at once: the half that is already possible is shown
 * working, and the half that is not is named, not mimed.
 *
 * The port branch below is not dead code and is not decoration: the search in
 * `inputPortsOfComponent` really looks for `kind === "input_port"` in the tree,
 * so the day the contract grows the node kind, this grid fills with port cards
 * without another edit. The commits stay gapped until O9 and O10 land with it.
 */

const INPUT_PORT_GRID_ID = "input-ports";

const INPUT_PORT_FIELDS: readonly CardGridField<Node>[] = [
  {
    id: "name",
    label: "name",
    valueOf: (port) => port.name,
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: "local-id",
    label: "local id",
    valueOf: (port) => localIdOf(port),
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: "connected-signal",
    label: "connected signal",
    valueOf: () => THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE,
    onCardFaceByDefault: true,
    searchedByFilter: false,
  },
];

export function InputPortCardGrid({
  nodes,
  component,
}: {
  nodes: readonly Node[];
  component: Node;
}) {
  const found = useMemo(
    () => inputPortsOfComponent(nodes, component),
    [nodes, component],
  );
  const candidates = useMemo(() => everySignalInTheTree(nodes), [nodes]);
  const [selectedPortId, setSelectedPortId] = useState<string | null>(null);

  const theSelect = (
    <TheConnectionSelectThatNeedsNoContractRow
      candidates={candidates}
      nodesInTheTree={nodes.length}
    />
  );

  return (
    <section className="right-stack-section" aria-label="Input ports">
      <h3 className="right-stack-banner">Input ports</h3>

      {found.ports.length === 0 ? (
        <>
          <p className="muted right-stack-note">{found.whyThereAreNone}</p>
          <CardWaitingOnAContractRow
            cardId={`input-ports-waiting:${component.id}`}
            title="get_input_ports"
            rows={[
              GET_INPUT_PORTS_ROW,
              CONNECT_INPUT_PORT_ROW,
              DISCONNECT_INPUT_PORT_ROW,
              INPUT_PORT_CONNECTION_CHANGED_EVENT,
            ]}
            whatThisSurfaceWouldShow={`one card per input port of ${component.name}, each with the signal it is connected to and a select that connects or disconnects it`}
            establishedBy={{ wireMethod: "get_component_tree" }}
            operationIds={["tree.read"]}
            theHalfThatWorksToday={theSelect}
          />
        </>
      ) : (
        <CardGrid
          gridId={INPUT_PORT_GRID_ID}
          entityNounSingular="input port"
          entityNounPlural="input ports"
          items={found.ports}
          factsOf={(port): CardGridItemFacts => ({
            id: port.id,
            title: port.name,
            states: [
              cardStateMark(
                "gapped",
                describeTheRowInOneLine(CONNECT_INPUT_PORT_ROW),
                "undeclared",
              ),
            ],
            hiddenByDescriptor: false,
          })}
          fields={INPUT_PORT_FIELDS}
          cardMinWidth="standard"
          hostOrderLabel="tree order"
          titleColumnLabel="Port name"
          operationIdsOf={() => ["tree.read"]}
          populatedBy={{ wireMethod: "get_component_tree" }}
          selectedCardId={selectedPortId}
          onSelect={(port) => setSelectedPortId(port.id)}
          renderCard={(port, view) => (
            <Card
              key={port.id}
              cardId={port.id}
              glyph={<ComponentIcon name="input_port" />}
              title={port.name}
              titleTooltip={port.id}
              headerChips={[{ label: "input port", tone: "value-type" }]}
              states={[
                cardStateMark(
                  "gapped",
                  describeTheRowInOneLine(CONNECT_INPUT_PORT_ROW),
                  "undeclared",
                ),
              ]}
              metaLineReplacement={
                <span className="card-gap-one-liner card-gap-one-liner--undeclared">
                  <span className="gap-tag gap-tag--undeclared">contract gap</span>
                  local id {localIdOf(port)} — the connected signal is{" "}
                  {THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE}, and choosing one
                  cannot be sent:{" "}
                  <code className="mono">
                    {CONNECT_INPUT_PORT_ROW.wireMethodThatDoesNotExist}
                  </code>{" "}
                  and{" "}
                  <code className="mono">
                    {DISCONNECT_INPUT_PORT_ROW.wireMethodThatDoesNotExist}
                  </code>{" "}
                  are not in contract/contract.yaml.
                </span>
              }
              operationIds={["tree.read"]}
              calls={[{ wireMethod: "get_component_tree" }]}
              selected={port.id === selectedPortId}
              onSelect={() => setSelectedPortId(port.id)}
              expandedColumnSpan={view.expandedColumnSpan}
            >
              <div className="input-port-connection">
                <span className="input-port-connection-state">
                  <ComponentIcon name="unlink" />
                  connection state: {THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE}
                </span>
                {theSelect}
              </div>
            </Card>
          )}
        />
      )}
    </section>
  );
}

/**
 * The one part of §2.7 that needs no contract row, built for real.
 *
 * "a `<select>` of every signal on the root device plus `none`" — the options
 * below are the actual signal nodes of the actual tree, named and identified
 * the way `input_port_row_view._display_text_for_signal` names them: the signal
 * name, then a short id.
 *
 * It is disabled, and the reason is on the control rather than in a comment:
 * choosing an option would have to send `connect_input_port` or
 * `disconnect_input_port`, and `MethodName` — the union `client.call` is typed
 * against — has thirteen members, neither of them among them. A select that
 * looked live and silently did nothing would be the one thing a teaching tool
 * must never ship.
 *
 * §2.7 also rules out the reference's `overrideredirect` suggestion popup sized
 * `width × (min(len,10) * 20 + 4)` px — "that is a `<datalist>`" — so the
 * type-ahead is a `<datalist>` beside the select, ready for the day the commits
 * exist.
 */
function TheConnectionSelectThatNeedsNoContractRow({
  candidates,
  nodesInTheTree,
}: {
  candidates: readonly Node[];
  nodesInTheTree: number;
}) {
  // One id per instance: several port cards can be on screen at once and two
  // <select>s sharing an id would make every <label> point at the first one.
  const selectId = useId();
  const typeAheadId = useId();
  const whyItIsDisabled =
    `${describeTheRowInOneLine(CONNECT_INPUT_PORT_ROW)} ` +
    `${describeTheRowInOneLine(DISCONNECT_INPUT_PORT_ROW)}`;

  return (
    <div className="input-port-candidate-list">
      <label className="input-port-candidate-label" htmlFor={selectId}>
        connect to
      </label>
      <select
        id={selectId}
        className="input-port-candidate-select mono"
        disabled
        data-gapped=""
        title={whyItIsDisabled}
        defaultValue="none"
      >
        <option value="none">none</option>
        {candidates.map((signal) => (
          <option key={signal.id} value={signal.id}>
            {signalChoiceText(signal)}
          </option>
        ))}
      </select>
      <datalist id={typeAheadId}>
        {candidates.map((signal) => (
          <option key={signal.id} value={signalChoiceText(signal)} />
        ))}
      </datalist>
      <p className="muted input-port-candidate-note">
        {candidates.length} signal{candidates.length === 1 ? "" : "s"} out of{" "}
        {nodesInTheTree} node{nodesInTheTree === 1 ? "" : "s"}{" "}
        <code className="mono">get_component_tree</code> returned, plus{" "}
        <code className="mono">none</code>. Choosing one would have to send{" "}
        <code className="mono">
          {CONNECT_INPUT_PORT_ROW.wireMethodThatDoesNotExist}
        </code>
        , which is not in contract/contract.yaml.
      </p>
    </div>
  );
}
