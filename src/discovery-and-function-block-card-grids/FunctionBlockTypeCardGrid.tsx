import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "../card-grid/Card";
import { CardGrid } from "../card-grid/CardGrid";
import type { CardGridField } from "../card-grid/card-grid-model";
import type { CallLogEntry, Node, PropertyDescriptor, TransportClient } from "../transport";
import {
  addFunctionBlock,
  getPropertyDescriptors,
  listFunctionBlockTypes,
  removeFunctionBlock,
} from "./send-a-contract-row-and-decode-what-the-host-answered";
import {
  ADD_FUNCTION_BLOCK,
  FUNCTION_BLOCK_ADD,
  GET_PROPERTY_DESCRIPTORS,
  LIST_FUNCTION_BLOCK_TYPES,
  PROPERTY_READ,
  REMOVE_FUNCTION_BLOCK,
} from "./wire-methods-and-capability-ids-these-grids-name";
import {
  TheCallThatWouldHavePopulatedThisGridCard,
  useGapOnThisCapability,
} from "./a-gapped-card-teaches-more-than-a-working-one";
import {
  cardStateMarksForDraftCallOutcome,
  describeSendFailure,
  DraftCallCommit,
  NEVER_SENT,
  quackStripLineForDraftedCall,
  type DraftCallOutcome,
  type DraftedCall,
} from "./the-draft-card-is-the-call-preview";

/**
 * §2.7 of the design specification, D3 + T7: the Add function block dialog
 * becomes a type card grid.
 *
 * The reference is a 1 000 x 400 modal over a `Name | Description | Id` table
 * whose middle column is a paragraph, plus a bare 600 x 400 `-topmost` Toplevel
 * for the configuration of the type you selected. Here: one card per available
 * type, `--card-min-wide` 360 px, `add_function_block` committed on the card,
 * and the card becomes the configuration card when the add answers.
 *
 * Two things the contract settles, and this file prints both rather than
 * drawing a field with nothing behind it:
 *
 *   * `list_function_block_types` returns `{type: array, items: string}` — a
 *     type id and nothing else. The reference's Name and Description columns
 *     have no field on this wire. The card title is the id.
 *   * `add_function_block` takes `parent_id` and `type_id` and nothing else.
 *     There is no `configuration` parameter, so the reference's configure-before-add
 *     window cannot be sent. What CAN be sent, and is, is the configuration of
 *     the block AFTER it exists: `get_property_descriptors` on the Node the add
 *     returned. §2.7's "the add_function_block button moves onto the
 *     configuration card" happens — one commit control on screen at a time —
 *     with the honest ordering the contract allows, and the card says which
 *     ordering it is using and why.
 */

const FUNCTION_BLOCK_GLYPH = "⛭";

function addDraftFor(parentId: string, typeId: string): DraftedCall {
  return {
    wireMethod: ADD_FUNCTION_BLOCK,
    capability: FUNCTION_BLOCK_ADD,
    params: { parent_id: parentId, type_id: typeId },
    refusalBeforeSending:
      parentId.trim().length === 0
        ? "select the parent node first — add_function_block's parent_id is required and references Node.id"
        : "",
  };
}

function pondEntryNamesThisTypeId(
  parentId: string,
  typeId: string,
): (entry: CallLogEntry) => boolean {
  return (entry) => {
    const params = entry.params as Record<string, unknown> | null;
    return (
      typeof params === "object" &&
      params !== null &&
      params.type_id === typeId &&
      params.parent_id === parentId
    );
  };
}

type TypeListReading =
  | { state: "not-started" }
  | { state: "listing" }
  | { state: "answered"; typeIds: string[] }
  | { state: "refused"; code: string; detail: string };

export function FunctionBlockTypeCardGrid({
  client,
  parentNodeId,
  parentNodeName,
}: {
  client: TransportClient;
  /** add_function_block's parent_id. The node the tree has selected. */
  parentNodeId: string;
  parentNodeName: string;
}) {
  const addGap = useGapOnThisCapability(FUNCTION_BLOCK_ADD);
  const [reading, setReading] = useState<TypeListReading>({ state: "not-started" });
  const generation = useRef(0);

  const listTypes = useCallback(() => {
    const thisGeneration = ++generation.current;
    setReading({ state: "listing" });
    listFunctionBlockTypes(client).then(
      (typeIds) => {
        if (thisGeneration !== generation.current) return;
        setReading({ state: "answered", typeIds });
      },
      (error: unknown) => {
        if (thisGeneration !== generation.current) return;
        setReading({ state: "refused", ...describeSendFailure(error) });
      },
    );
  }, [client]);

  useEffect(() => {
    if (addGap !== null) return;
    listTypes();
  }, [addGap, listTypes]);

  if (addGap !== null) {
    return (
      <section className="function-block-type-surface">
        <FunctionBlockTypeHeading
          reading={reading}
          parentNodeName={parentNodeName}
          parentNodeId={parentNodeId}
          listIsGapped
          onRelist={listTypes}
        />
        <TheCallThatWouldHavePopulatedThisGridCard
          standing={addGap.standing}
          hostProcessName={addGap.hostProcessName}
          capability={FUNCTION_BLOCK_ADD}
          wireMethod={LIST_FUNCTION_BLOCK_TYPES}
          whatIsBlocked={`Listing the function block types this host can instantiate, and adding one to ${parentNodeName}.`}
          whatTheGridWouldHaveHeld="one card per available function block type, each with its own add_function_block button"
        />
        <p className="muted function-block-capability-note">
          <code className="mono">function_block.add</code> owns three wire
          methods — <code className="mono">list_function_block_types</code>,{" "}
          <code className="mono">add_function_block</code> and{" "}
          <code className="mono">remove_function_block</code>. A capability is
          declared only when a host serves every method it owns, so one missing
          handler takes all three cards with it. That rule is the contract&apos;s,
          not this grid&apos;s.
        </p>
      </section>
    );
  }

  if (reading.state === "refused") {
    return (
      <section className="function-block-type-surface">
        <FunctionBlockTypeHeading
          reading={reading}
          parentNodeName={parentNodeName}
          parentNodeId={parentNodeId}
          onRelist={listTypes}
        />
        <Card
          cardId="list-function-block-types-refused"
          glyph="⚠"
          title={LIST_FUNCTION_BLOCK_TYPES}
          states={[{ state: "rejected", words: `${reading.code}: ${reading.detail}` }]}
          operationIds={[FUNCTION_BLOCK_ADD]}
          calls={[
            {
              wireMethod: LIST_FUNCTION_BLOCK_TYPES,
            },
          ]}
        >
          <p>
            The host declares <code className="mono">function_block.add</code> as
            served and then refused the call. The code and the host&apos;s own
            detail are printed above, verbatim.
          </p>
        </Card>
      </section>
    );
  }

  if (reading.state !== "answered") {
    return (
      <section className="function-block-type-surface">
        <FunctionBlockTypeHeading
          reading={reading}
          parentNodeName={parentNodeName}
          parentNodeId={parentNodeId}
          onRelist={listTypes}
        />
      </section>
    );
  }

  return (
    <section className="function-block-type-surface">
      <FunctionBlockTypeHeading
        reading={reading}
        parentNodeName={parentNodeName}
        parentNodeId={parentNodeId}
        onRelist={listTypes}
      />
      <CardGrid<string>
        gridId="function-block-types"
        entityNounSingular="function block type"
        entityNounPlural="function block types"
        items={reading.typeIds}
        factsOf={(typeId) => ({
          id: typeId,
          title: typeId,
          states: [],
          hiddenByDescriptor: false,
        })}
        fields={FUNCTION_BLOCK_TYPE_FIELDS}
        cardMinWidth="wide"
        hostOrderLabel="list order"
        operationIdsOf={() => [
          FUNCTION_BLOCK_ADD,
        ]}
        titleColumnLabel="Type id"
        populatedBy={{
          wireMethod: LIST_FUNCTION_BLOCK_TYPES,
        }}
        renderCard={(typeId, view) => (
          <FunctionBlockTypeCard
            key={typeId}
            typeId={typeId}
            client={client}
            parentNodeId={parentNodeId}
            parentNodeName={parentNodeName}
            expandedColumnSpan={view.expandedColumnSpan}
          />
        )}
      />
    </section>
  );
}

function FunctionBlockTypeHeading({
  reading,
  parentNodeName,
  parentNodeId,
  listIsGapped = false,
  onRelist,
}: {
  reading: TypeListReading;
  parentNodeName: string;
  parentNodeId: string;
  listIsGapped?: boolean;
  onRelist: () => void;
}) {
  return (
    <header className="function-block-type-heading">
      <h3>Function block types</h3>
      <span className="function-block-parent mono">
        parent_id = {JSON.stringify(parentNodeId)} ({parentNodeName})
      </span>
      <span className="function-block-list-state">
        {listIsGapped
          ? "list_function_block_types was never sent: function_block.add is a gap on this host"
          : reading.state === "not-started"
            ? "list_function_block_types has not been sent yet"
            : reading.state === "listing"
              ? "listing… list_function_block_types is in flight"
              : reading.state === "refused"
                ? `list_function_block_types was refused with ${reading.code}`
                : `list_function_block_types answered with ${reading.typeIds.length} type id${reading.typeIds.length === 1 ? "" : "s"}`}
      </span>
      <button
        type="button"
        className="function-block-relist mono"
        data-op={FUNCTION_BLOCK_ADD}
        disabled={listIsGapped || reading.state === "listing"}
        onClick={onRelist}
        title="send list_function_block_types again"
      >
        list_function_block_types
      </button>
    </header>
  );
}

const FUNCTION_BLOCK_TYPE_FIELDS: readonly CardGridField<string>[] = [
  {
    id: "type_id",
    label: "Type id",
    valueOf: (typeId) => typeId,
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
];

type AddReading =
  | { state: "not-added" }
  | { state: "added"; node: Node }
  | {
      state: "configuring";
      node: Node;
      descriptors: PropertyDescriptor[];
    }
  | { state: "configuration-refused"; node: Node; code: string; detail: string };

/**
 * One available function block type, and — once its add answers — the
 * configuration card the commit control moved onto.
 *
 * §2.7: "the `add_function_block` button **moves onto the configuration card**,
 * so there is exactly one commit control on screen at a time and it sits with
 * the values it will send." That invariant is kept literally: while the card is
 * a type card it carries `add_function_block`; the moment the add answers, that
 * button is gone and the card's one control is `remove_function_block`, sitting
 * with the node id it will send.
 */
export function FunctionBlockTypeCard({
  typeId,
  client,
  parentNodeId,
  parentNodeName,
  expandedColumnSpan,
}: {
  typeId: string;
  client: TransportClient;
  parentNodeId: string;
  parentNodeName: string;
  expandedColumnSpan: number;
}) {
  const [outcome, setOutcome] = useState<DraftCallOutcome>(NEVER_SENT);
  const [added, setAdded] = useState<AddReading>({ state: "not-added" });
  const [removeOutcome, setRemoveOutcome] = useState<DraftCallOutcome>(NEVER_SENT);

  const addDraft = addDraftFor(parentNodeId, typeId);
  const addedNode =
    added.state === "not-added" ? null : added.node;
  const removeDraft: DraftedCall | null =
    addedNode === null
      ? null
      : {
          wireMethod: REMOVE_FUNCTION_BLOCK,
          capability: FUNCTION_BLOCK_ADD,
          params: { node_id: addedNode.id },
          refusalBeforeSending: "",
        };

  return (
    <Card
      cardId={typeId}
      glyph={FUNCTION_BLOCK_GLYPH}
      title={typeId}
      titleTooltip={`type_id as list_function_block_types returned it: ${JSON.stringify(typeId)}`}
      headerChips={[
        addedNode === null
          ? { label: "type", tone: "value-type", title: "one available function block type" }
          : {
              label: "added",
              tone: "value-type",
              title: `add_function_block answered with node ${addedNode.id}`,
            },
      ]}
      metaFacts={[
        `add_function_block parent_id ${JSON.stringify(parentNodeId)} (${parentNodeName})`,
        "no name and no description on the wire: list_function_block_types returns array of string",
      ]}
      states={[
        ...cardStateMarksForDraftCallOutcome(outcome),
        ...cardStateMarksForDraftCallOutcome(removeOutcome),
        ...(added.state === "configuration-refused"
          ? [
              {
                state: "rejected" as const,
                words: `${added.code}: ${added.detail}`,
              },
            ]
          : []),
      ]}
      operationIds={[
        FUNCTION_BLOCK_ADD,
        ...(addedNode === null
          ? []
          : [PROPERTY_READ]),
      ]}
      calls={
        removeDraft === null
          ? [
              {
                ...quackStripLineForDraftedCall(addDraft),
                pondEntryIsThisCards: pondEntryNamesThisTypeId(
                  parentNodeId,
                  typeId,
                ),
              },
            ]
          : [
              {
                ...quackStripLineForDraftedCall(removeDraft),
              },
              {
                wireMethod: GET_PROPERTY_DESCRIPTORS,
                parameterPreview: [`node_id = ${JSON.stringify(addedNode?.id)}`],
              },
            ]
      }
      expandedColumnSpan={expandedColumnSpan}
      back={{
        reveals:
          "what the contract carries about a function block type — and what the reference showed that it does not",
        operationIds: [FUNCTION_BLOCK_ADD],
        content: <FunctionBlockTypeBack typeId={typeId} />,
      }}
    >
      {removeDraft === null || addedNode === null ? (
        <>
          <DraftCallCommit
            call={addDraft}
            outcome={outcome}
            onSend={(sent) => {
              setOutcome({ state: "sending" });
              addFunctionBlock(
                client,
                sent.params.parent_id as string,
                sent.params.type_id as string,
              ).then(
                (node) => {
                  setOutcome({
                    state: "answered",
                    sentence: `add_function_block answered with node ${node.id} (${node.name}, kind ${node.kind}); this card is now that block's configuration card`,
                  });
                  setAdded({ state: "added", node });
                  getPropertyDescriptors(client, node.id).then(
                    (descriptors) =>
                      setAdded({ state: "configuring", node, descriptors }),
                    (error: unknown) =>
                      setAdded({
                        state: "configuration-refused",
                        node,
                        ...describeSendFailure(error),
                      }),
                  );
                },
                (error: unknown) =>
                  setOutcome({ state: "refused", ...describeSendFailure(error) }),
              );
            }}
          />
          <ConfigureBeforeAddIsBlockedByTheContract />
        </>
      ) : (
        <div className="function-block-configuration">
          <p className="function-block-configuration-lead">
            The commit control moved. This card is now the configuration card for{" "}
            <code className="mono">{addedNode.id}</code>, and its one commit
            control is <code className="mono">remove_function_block</code>.
          </p>

          {added.state === "configuring" ? (
            <>
              <p className="muted">
                <code className="mono">get_property_descriptors</code> answered
                with {added.descriptors.length} descriptor
                {added.descriptors.length === 1 ? "" : "s"} for this block. Each
                one is a card in §2.2&apos;s property card grid, which is a
                different lane; listed here by name and value_type so the
                configuration is visible from the card that created it.
              </p>
              <dl className="function-block-descriptor-list">
                {added.descriptors.map((descriptor) => (
                  <div key={descriptor.id}>
                    <dt>{descriptor.name}</dt>
                    <dd className="mono">
                      {descriptor.value_type}
                      {descriptor.unit === null ? "" : ` · ${descriptor.unit}`}
                      {descriptor.read_only ? " · read-only" : ""}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          ) : added.state === "configuration-refused" ? (
            <p className="muted">
              <code className="mono">get_property_descriptors</code> on{" "}
              <code className="mono">{addedNode.id}</code> was refused with{" "}
              {added.code}: {added.detail}
            </p>
          ) : (
            <p className="muted">
              <code className="mono">get_property_descriptors</code> is in flight
              for <code className="mono">{addedNode.id}</code>.
            </p>
          )}

          <DraftCallCommit
            call={removeDraft}
            outcome={removeOutcome}
            onSend={(sent) => {
              setRemoveOutcome({ state: "sending" });
              removeFunctionBlock(client, sent.params.node_id as string).then(
                () => {
                  setRemoveOutcome({
                    state: "answered",
                    sentence: `remove_function_block answered; node ${addedNode.id} is gone and this card is a type card again`,
                  });
                  setAdded({ state: "not-added" });
                  setOutcome(NEVER_SENT);
                },
                (error: unknown) =>
                  setRemoveOutcome({
                    state: "refused",
                    ...describeSendFailure(error),
                  }),
              );
            }}
          />
        </div>
      )}
    </Card>
  );
}

/**
 * §2.7's configure… action, present and refusing, with the reason — the same
 * treatment §2.6 gets on the discovery card, for the same kind of reason.
 */
function ConfigureBeforeAddIsBlockedByTheContract() {
  return (
    <p className="function-block-configure-blocked">
      <button
        type="button"
        className="function-block-configure"
        disabled
        title={
          "configure… would hold the type's default config before the add. add_function_block's parameters in " +
          "contract/contract.yaml are parent_id (required, references Node.id) and type_id (required, string); " +
          "there is no configuration parameter, and no operation returns a type's default config. Configuring " +
          "before the add needs an operation-table edit; configuring after it does not, and this card does that."
        }
      >
        configure…
      </button>
      <span className="muted">
        blocked before the add: <code className="mono">add_function_block</code>{" "}
        takes <code className="mono">parent_id</code> and{" "}
        <code className="mono">type_id</code> only. After the add, this card
        becomes the configuration card.
      </span>
    </p>
  );
}

function FunctionBlockTypeBack({ typeId }: { typeId: string }) {
  return (
    <>
      <dl>
        <dt>type_id</dt>
        <dd className="mono">{typeId}</dd>
        <dt>returned by</dt>
        <dd className="mono">list_function_block_types → array of string</dd>
        <dt>sent to</dt>
        <dd className="mono">add_function_block(parent_id, type_id) → Node</dd>
      </dl>
      <p className="muted">
        The reference&apos;s Add-function-block table has three columns —
        Name, Description, Id — and sets the description column&apos;s minwidth
        to 400 px to stop a paragraph being truncated. On this wire there is one
        field: the id. Name and Description would need DeviceInfo&apos;s
        treatment on a new FunctionBlockTypeInfo record, which is an
        operation-table change and not frontend work.
      </p>
    </>
  );
}
