import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TransportClient,
  WireError,
  type Node,
  type PropertyDescriptor,
} from "../transport";
import { CardGrid } from "../card-grid/CardGrid";
import { Card } from "../card-grid/Card";
import { CapabilityGapNotice } from "../session/CapabilityGapNotice";
import {
  useCapabilityStanding,
  useHostProcessName,
} from "../session/host-capability-context";
import { precheck } from "./precheck-a-value-against-its-descriptor";
import { PropertyCard } from "./PropertyCard";
import { PropertyContainerRows } from "./PropertyContainerRows";
import { PROPERTY_CARD_FIELDS } from "./property-card-fields";
import {
  buildPropertyOnACard,
  type PropertyOnACard,
} from "./property-on-a-card";
import {
  unconfirmedWriteSentence,
  valuesAreTheSame,
  type PropertyWriteOutcome,
} from "./property-card-states";
import type { PropertyDraft } from "./property-draft";
import {
  describeContainerPath,
  type ContainerPath,
} from "./nested-container-path";

/**
 * T3 — the properties treeview becomes the property card grid. §2.2 of
 * quackoscope-gui-design-specification-logger-added-look-with-card-grids-replacing-dialogs-and-tables.md
 *
 * "The most-used surface in the reference, and the one the user looks at all
 * day." One card per property, at any depth; the `PropertyDescriptor` is the
 * whole input; nothing about a property name or a device is hard-coded anywhere.
 *
 * The data discipline is `PropertyGrid.tsx`'s, unchanged, because §2.2 says so
 * in as many words — "Coalescing: unchanged... Card grids do not change that,
 * and the `key={d.id}` identity discipline carries straight over":
 *
 *   - after `set_property_value` the displayed value is taken from the resulting
 *     `property_changed` event or a read-back, never from what was submitted,
 *     because a coercer may have changed it;
 *   - `property_changed` refreshes DESCRIPTORS as well as values, because
 *     visible / read_only / min / max can be EvalValue expressions over other
 *     properties, so writing A can reshape B's widget;
 *   - every refresh trigger inside 50 ms collapses into one refresh.
 *
 * What this grid adds on top of that discipline is the one thing the row grid
 * could not do: it notices when the value that came back is not the value that
 * went out, and says so on the card in §1.8's `coerced` words.
 */

const REFRESH_COALESCE_WINDOW_MS = 50;

/** §2.9: per grid, not per component. "Show me the unit on properties" is one question. */
const PROPERTY_GRID_ID = "properties";

export function PropertyCardGrid({
  client,
  node,
}: {
  client: TransportClient;
  node: Node;
}) {
  const [descriptors, setDescriptors] = useState<PropertyDescriptor[] | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [drafts, setDrafts] = useState<Record<string, PropertyDraft | null>>({});
  const [outcomes, setOutcomes] = useState<Record<string, PropertyWriteOutcome>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);
  const [containerFocus, setContainerFocus] = useState<{
    propertyId: string;
    path: ContainerPath;
  } | null>(null);
  const generation = useRef(0);

  const readStanding = useCapabilityStanding("property.read");
  const writeStanding = useCapabilityStanding("property.write");
  const hostProcessName = useHostProcessName();
  const readIsGapped =
    readStanding !== null && !readStanding.served && readStanding.gap !== null;
  const writeIsGapped =
    writeStanding !== null && !writeStanding.served && writeStanding.gap !== null;

  const readDescriptorsAndValuesFromHost = useCallback(async () => {
    if (readIsGapped) return;
    const gen = ++generation.current;
    try {
      const ds = await client.call("get_property_descriptors", {
        node_id: node.id,
      });
      const vs = await Promise.all(
        ds.map(async (d) => {
          try {
            return [
              d.id,
              await client.call("get_property_value", {
                node_id: node.id,
                property_id: d.id,
              }),
            ] as const;
          } catch {
            return [d.id, undefined] as const;
          }
        }),
      );
      if (gen !== generation.current) return; // a newer reload won
      const held = Object.fromEntries(vs);
      setDescriptors(ds);
      setValues(held);
      setLoadError(null);

      // §1.8's `coerced` row, decided here because this is the only place both
      // numbers are in hand at once: what was submitted, and what the host
      // reports afterwards. A write is only ever called coerced against the
      // host's own read-back — never against an optimistic local value.
      setOutcomes((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const [propertyId, outcome] of Object.entries(previous)) {
          if (outcome.kind !== "in-flight") continue;
          if (!(propertyId in held)) continue;
          const nowHeld = held[propertyId];
          next[propertyId] = valuesAreTheSame(outcome.submitted, nowHeld)
            ? { kind: "settled" }
            : { kind: "coerced", submitted: outcome.submitted, held: nowHeld };
          changed = true;
        }
        return changed ? next : previous;
      });
    } catch (e) {
      if (gen !== generation.current) return;
      setDescriptors([]);
      setValues({});
      setLoadError(e instanceof WireError ? `${e.code}: ${e.detail}` : String(e));
    }
  }, [client, node.id, readIsGapped]);

  const coalesceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Asks for one refresh; every ask inside REFRESH_COALESCE_WINDOW_MS shares it. */
  const refreshFromHostSoon = useCallback(() => {
    if (coalesceTimer.current !== null) clearTimeout(coalesceTimer.current);
    coalesceTimer.current = setTimeout(() => {
      coalesceTimer.current = null;
      void readDescriptorsAndValuesFromHost();
    }, REFRESH_COALESCE_WINDOW_MS);
  }, [readDescriptorsAndValuesFromHost]);

  useEffect(
    () => () => {
      if (coalesceTimer.current !== null) clearTimeout(coalesceTimer.current);
    },
    [],
  );

  useEffect(() => {
    setDescriptors(null);
    setValues({});
    setDrafts({});
    setOutcomes({});
    setLoadError(null);
    setContainerFocus(null);
    void readDescriptorsAndValuesFromHost();
  }, [readDescriptorsAndValuesFromHost]);

  useEffect(() => {
    const offValue = client.on("property_changed", (p) => {
      if (p.node_id === node.id) refreshFromHostSoon();
    });
    const offDescriptor = client.on("property_descriptor_changed", (p) => {
      if (p.node_id === node.id) refreshFromHostSoon();
    });
    return () => {
      offValue();
      offDescriptor();
    };
  }, [client, node.id, refreshFromHostSoon]);

  const setDraftFor = useCallback(
    (propertyId: string, draft: PropertyDraft | null) => {
      setDrafts((previous) => ({ ...previous, [propertyId]: draft }));
    },
    [],
  );

  const write = useCallback(
    async (d: PropertyDescriptor, value: unknown) => {
      // §1.8's out-of-range row: the client precheck is limited by contract to
      // min, max and membership in selection_values, and a value it refuses is
      // NOT sent. The typed text stays in the field and the card already carries
      // the exact sentence precheck returned, so nothing is announced twice.
      if (precheck(d, value) !== null) return;

      setDrafts((previous) => ({ ...previous, [d.id]: null }));
      setOutcomes((previous) => ({
        ...previous,
        [d.id]: { kind: "in-flight", submitted: value },
      }));
      setPending((previous) => ({ ...previous, [d.id]: true }));
      try {
        await client.call("set_property_value", {
          node_id: node.id,
          property_id: d.id,
          value,
        });
      } catch (e) {
        // A timeout is not a refusal: the deadline is the client's, and a slow
        // host may still apply the write afterwards.
        setOutcomes((previous) => ({
          ...previous,
          [d.id]:
            e instanceof WireError && e.code === "timeout"
              ? {
                  kind: "unconfirmed",
                  sentence: unconfirmedWriteSentence(d, value, e.code, e.detail),
                }
              : {
                  kind: "rejected",
                  code: e instanceof WireError ? e.code : "internal",
                  detail: e instanceof WireError ? e.detail : String(e),
                },
        }));
      } finally {
        setPending((previous) => {
          const next = { ...previous };
          delete next[d.id];
          return next;
        });
      }
      // Read back unconditionally, including after a timeout, so the grid
      // resynchronises instead of sitting on a value nothing confirmed.
      refreshFromHostSoon();
    },
    [client, node.id, refreshFromHostSoon],
  );

  const items = useMemo<PropertyOnACard[]>(
    () =>
      (descriptors ?? []).map((descriptor) =>
        buildPropertyOnACard({
          descriptor,
          value: values[descriptor.id],
          draft: drafts[descriptor.id] ?? null,
          outcome: outcomes[descriptor.id] ?? { kind: "settled" },
          pending: pending[descriptor.id] === true,
          writeGapStanding: writeIsGapped ? writeStanding : null,
          hostProcessName,
        }),
      ),
    [
      descriptors,
      values,
      drafts,
      outcomes,
      pending,
      writeIsGapped,
      writeStanding,
      hostProcessName,
    ],
  );

  if (readIsGapped && readStanding !== null) {
    return (
      <div className="pad">
        <CapabilityGapNotice
          standing={readStanding}
          hostProcessName={hostProcessName}
          whatIsBlocked={`The properties of ${node.name} cannot be read from ${hostProcessName}, so this grid asked for nothing. get_property_descriptors and get_property_value were never sent.`}
        />
      </div>
    );
  }
  if (loadError !== null) {
    return (
      <div className="pad">
        <p className="error" role="alert">
          {loadError}
        </p>
      </div>
    );
  }
  if (descriptors === null) {
    return (
      <p className="muted pad">
        Reading descriptors for {node.id} with get_property_descriptors…
      </p>
    );
  }

  const focusedItem =
    containerFocus === null
      ? null
      : (items.find((item) => item.descriptor.id === containerFocus.propertyId) ??
        null);

  return (
    <div className="property-card-grid-holder">
      {writeIsGapped && writeStanding !== null && (
        <CapabilityGapNotice
          standing={writeStanding}
          hostProcessName={hostProcessName}
          whatIsBlocked={`No value can be written back: the ${items.length} property cards below still show what ${hostProcessName} reports, and every control on them is dead.`}
        />
      )}

      {containerFocus !== null && focusedItem !== null ? (
        <NestedContainerBoard
          item={focusedItem}
          path={containerFocus.path}
          disabled={focusedItem.descriptor.read_only || focusedItem.pending}
          onLeave={() => setContainerFocus(null)}
          onNavigate={(path) =>
            setContainerFocus({ propertyId: focusedItem.descriptor.id, path })
          }
          onCommitWholeContainer={(whole) =>
            void write(focusedItem.descriptor, whole)
          }
        />
      ) : (
        <CardGrid<PropertyOnACard>
          gridId={PROPERTY_GRID_ID}
          entityNounSingular="property"
          entityNounPlural="properties"
          items={items}
          factsOf={(item) => ({
            id: item.descriptor.id,
            title: item.descriptor.name,
            states: item.states,
            hiddenByDescriptor: !item.descriptor.visible,
          })}
          fields={PROPERTY_CARD_FIELDS}
          cardMinWidth="standard"
          hostOrderLabel="descriptor order"
          titleColumnLabel="Property name"
          operationIdsOf={() => ["property.read", "property.write"]}
          populatedBy={{ wireMethod: "get_property_descriptors" }}
          selectedCardId={selectedPropertyId}
          onSelect={(item) => setSelectedPropertyId(item.descriptor.id)}
          renderCard={(item, view) => (
            <PropertyCard
              key={item.descriptor.id}
              nodeId={node.id}
              item={item}
              view={view}
              onDraftChange={(draft) => setDraftFor(item.descriptor.id, draft)}
              onWrite={(value) => void write(item.descriptor, value)}
              onRereadFromHost={() => {
                setOutcomes((previous) => ({
                  ...previous,
                  [item.descriptor.id]: { kind: "settled" },
                }));
                refreshFromHostSoon();
              }}
              onNavigateIntoNestedContainer={(descriptor, path) =>
                setContainerFocus({ propertyId: descriptor.id, path })
              }
              selected={selectedPropertyId === item.descriptor.id}
              onSelect={() => setSelectedPropertyId(item.descriptor.id)}
            />
          )}
        />
      )}
    </div>
  );
}

/**
 * §2.2's breadcrumb, made real: "a breadcrumb (`Config › Streaming › Timeouts →`)
 * that navigates the grid rather than nesting a third time... Say so in the UI:
 * the breadcrumb is labelled, not implied."
 *
 * So the grid is replaced, not covered — there is no dialog anywhere in this
 * design — and the trail says exactly where the reader is and what happens when
 * they edit here: the write still carries the WHOLE property value, from the
 * root down, in one `set_property_value` (§2.14).
 */
function NestedContainerBoard({
  item,
  path,
  disabled,
  onLeave,
  onNavigate,
  onCommitWholeContainer,
}: {
  item: PropertyOnACard;
  path: ContainerPath;
  disabled: boolean;
  onLeave: () => void;
  onNavigate: (path: ContainerPath) => void;
  onCommitWholeContainer: (whole: unknown) => void;
}) {
  const d = item.descriptor;
  return (
    <section className="property-container-board">
      <nav className="property-container-trail" aria-label="container breadcrumb">
        <button
          type="button"
          className="property-container-trail-step"
          onClick={onLeave}
          data-quack-chrome=""
        >
          all properties of this component
        </button>
        <span className="property-container-trail-separator" aria-hidden="true">
          ›
        </span>
        <button
          type="button"
          className="property-container-trail-step"
          onClick={() => onNavigate([])}
          data-quack-chrome=""
        >
          {d.name}
        </button>
        {path.map((segment, index) => (
          <span key={`${String(segment)}:${index}`}>
            <span className="property-container-trail-separator" aria-hidden="true">
              ›
            </span>
            <button
              type="button"
              className="property-container-trail-step mono"
              onClick={() => onNavigate(path.slice(0, index + 1))}
              data-quack-chrome=""
            >
              {String(segment)}
            </button>
          </span>
        ))}
      </nav>

      <div className="card-grid card-grid--narrow">
        <Card
          cardId={`${d.id}:${path.map(String).join(".")}`}
          title={describeContainerPath(d.name, path)}
          titleTooltip={d.id}
          headerChips={[{ label: d.value_type, tone: "value-type" }]}
          states={item.states}
          operationIds={["property.read", "property.write"]}
          calls={[{ wireMethod: "set_property_value" }]}
          expandedColumnSpan={1}
        >
          <PropertyContainerRows
            propertyName={d.name}
            propertyId={d.id}
            rootValue={item.value}
            path={path}
            disabled={disabled}
            onCommitWholeContainer={onCommitWholeContainer}
            onNavigateIntoNestedContainer={onNavigate}
          />
        </Card>
      </div>
    </section>
  );
}
