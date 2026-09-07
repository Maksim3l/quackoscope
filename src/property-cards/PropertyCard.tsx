import type { CallLogEntry, PropertyDescriptor } from "../transport";
import { Card } from "../card-grid/Card";
import type { CardCall } from "../card-grid/CardQuackStrip";
import type { CardFaceView } from "../card-grid/card-grid-model";
import { OpButton } from "../ui/op";
import { PropertyValueCell } from "./PropertyValueCell";
import { hostValueAsText, type PropertyDraft } from "./property-draft";
import type { PropertyOnACard } from "./property-on-a-card";
import type { ContainerPath } from "./nested-container-path";
import {
  describeBounds,
  PROPERTY_CARD_FIELD_IDS,
  propertyKindGlyph,
} from "./property-card-fields";

/**
 * One card = one property, at any depth.
 *
 * Three lines: the property, its value, and the openDAQ call the value makes.
 *
 *   ⇹ GlobalSampleRate            [ 1000 ] Hz ▐───●────▌   ▸
 *   float · [1, 1000000] · default 1000
 *   🦆 set_property_value · property.write                 ×0
 *
 * Name and value share the top row, which is what the reference's Treeview does
 * with its two stretching columns `#0` and `value`. The meta line under them
 * carries descriptor FACTS and nothing else — no sentence on this card explains
 * how the card works, why a slider's track is scaled the way it is, or when a
 * write will be sent. The quack strip is where this app teaches; it names the
 * call, and pressing it shows the openDAQ source in every language. Prose on
 * every card would be saying badly, eight times over, what the strip says once.
 *
 * Nothing here is property-name-specific or device-specific. The descriptor is
 * the only input that decides shape, bounds, enablement and visibility.
 */

export interface PropertyCardProps {
  nodeId: string;
  /**
   * The descriptor, the host's value, the uncommitted edit and the §1.8 states
   * they add up to — all built by the grid, so the grid's count line can name
   * every state on the screen (§1.9 item 6).
   */
  item: PropertyOnACard;
  view: CardFaceView;
  onDraftChange: (draft: PropertyDraft | null) => void;
  onWrite: (value: unknown) => void;
  onRereadFromHost: () => void;
  onNavigateIntoNestedContainer: (
    descriptor: PropertyDescriptor,
    path: ContainerPath,
  ) => void;
  selected: boolean;
  onSelect: () => void;
}

export function PropertyCard({
  nodeId,
  item,
  view,
  onDraftChange,
  onWrite,
  onRereadFromHost,
  onNavigateIntoNestedContainer,
  selected,
  onSelect,
}: PropertyCardProps) {
  const d = item.descriptor;
  const outcome = item.outcome;
  const disabled = d.read_only || item.pending;
  const states = item.states;

  const onFace = (fieldId: string) => view.fieldIsOnTheCardFace(fieldId);

  // Facts, one line, in the descriptor's own values. Which of them appear is
  // §2.9's chooser; what they say is the descriptor.
  const metaFacts: string[] = [];
  if (onFace(PROPERTY_CARD_FIELD_IDS.valueType)) metaFacts.push(d.value_type);
  if (onFace(PROPERTY_CARD_FIELD_IDS.bounds) && (d.min !== null || d.max !== null)) {
    metaFacts.push(describeBounds(d));
  }
  const defaultAsText = hostValueAsText(d.default);
  if (onFace(PROPERTY_CARD_FIELD_IDS.default) && defaultAsText !== "") {
    metaFacts.push(`default ${defaultAsText}`);
  }
  if (onFace(PROPERTY_CARD_FIELD_IDS.id) && d.id !== d.name) metaFacts.push(d.id);
  if (onFace(PROPERTY_CARD_FIELD_IDS.validator) && d.validator !== null) {
    metaFacts.push(`validator ${d.validator}`);
  }
  if (onFace(PROPERTY_CARD_FIELD_IDS.coercer) && d.coercer !== null) {
    metaFacts.push(`coercer ${d.coercer}`);
  }

  // §1.8's gapped row: the CapabilityGapNotice one-liner in place of the meta
  // line — the capability, the gap kind, and the host's own reason.
  const gappedMark = states.find((mark) => mark.state === "gapped");
  const metaLineReplacement =
    gappedMark === undefined ? undefined : (
      <span
        className={`card-gap-one-liner card-gap-one-liner--${gappedMark.gapPresentation ?? "undeclared"}`}
      >
        <span className={`gap-tag gap-tag--${gappedMark.gapPresentation ?? "undeclared"}`}>
          {gappedMark.gapPresentation ?? "undeclared"} gap
        </span>{" "}
        {gappedMark.words}
      </span>
    );

  // §3.2: one line on the strip, naming the call THIS card makes. A writable
  // property's card writes; a read-only card can only re-read.
  const call: CardCall = {
    wireMethod: d.read_only ? "get_property_value" : "set_property_value",
    pondEntryIsThisCards: (entry) => entryIsForThisProperty(entry, nodeId, d.id),
  };

  const description = d.description ?? "";

  return (
    <Card
      cardId={d.id}
      glyph={propertyKindGlyph(d)}
      title={d.name}
      titleTooltip={
        description === "" ? `${d.id} on ${nodeId}` : `${d.id} — ${description}`
      }
      headerValue={
        <PropertyValueCell
          descriptor={d}
          value={item.value}
          disabled={disabled}
          draft={item.draft}
          precheckRefusal={item.precheckRefusal}
          onDraftChange={onDraftChange}
          onCommit={onWrite}
          onNavigateIntoNestedContainer={onNavigateIntoNestedContainer}
          showUnit={onFace(PROPERTY_CARD_FIELD_IDS.unit)}
        />
      }
      metaFacts={metaFacts}
      metaLineReplacement={metaLineReplacement}
      description={onFace(PROPERTY_CARD_FIELD_IDS.description) ? d.description : null}
      states={states}
      operationIds={["property.read", "property.write"]}
      calls={[call]}
      expandedColumnSpan={view.expandedColumnSpan}
      selected={selected}
      onSelect={onSelect}
      back={{
        reveals: `all ${DESCRIPTOR_FIELD_COUNT} PropertyDescriptor fields`,
        operationIds: ["property.read"],
        content: <PropertyDescriptorBack descriptor={d} nodeId={nodeId} />,
      }}
    >
      {outcome.kind === "unconfirmed" ? (
        <OpButton
          op={["property.read"]}
          className="property-card-reread"
          onClick={onRereadFromHost}
        >
          Re-read {d.name} from the host
        </OpButton>
      ) : null}
    </Card>
  );
}

function entryIsForThisProperty(
  entry: CallLogEntry,
  nodeId: string,
  propertyId: string,
): boolean {
  const params = entry.params;
  if (typeof params !== "object" || params === null) return false;
  const held = params as Record<string, unknown>;
  return held.node_id === nodeId && held.property_id === propertyId;
}

/** Every field `PropertyDescriptor` declares, in the order types.ts declares them. */
const DESCRIPTOR_FIELD_COUNT = 14;

/**
 * §2.8's D8: the property metadata dialog, which the reference opens as a
 * 600 × 800 modal, is this — the card expanded in place. It is a render of data
 * the grid already has, so it costs no call.
 */
function PropertyDescriptorBack({
  descriptor,
  nodeId,
}: {
  descriptor: PropertyDescriptor;
  nodeId: string;
}) {
  const d = descriptor;
  const evalValueTooltip =
    "an openDAQ EvalValue expression; the contract sets " +
    "eval_value_strings.interpret_client_side: false, so this is the device's source text";
  const rows: { field: string; value: string; tooltip?: string }[] = [
    { field: "id", value: d.id },
    { field: "name", value: d.name },
    { field: "value_type", value: d.value_type },
    { field: "unit", value: d.unit ?? "null" },
    { field: "description", value: d.description ?? "null" },
    { field: "read_only", value: String(d.read_only) },
    { field: "visible", value: String(d.visible) },
    { field: "default", value: hostValueAsText(d.default) || "null" },
    {
      field: "selection_values",
      value: d.selection_values === null ? "null" : JSON.stringify(d.selection_values),
    },
    {
      field: "suggested_values",
      value: d.suggested_values === null ? "null" : JSON.stringify(d.suggested_values),
    },
    { field: "min", value: d.min === null ? "null" : String(d.min) },
    { field: "max", value: d.max === null ? "null" : String(d.max) },
    { field: "validator", value: d.validator ?? "null", tooltip: evalValueTooltip },
    { field: "coercer", value: d.coercer ?? "null", tooltip: evalValueTooltip },
  ];

  return (
    <div className="property-card-back">
      <dl>
        {rows.map((row) => (
          <div key={row.field} className="property-card-back-row">
            <dt className="mono" title={row.tooltip}>
              {row.field}
            </dt>
            <dd className="mono">{row.value}</dd>
          </div>
        ))}
      </dl>

      <p className="property-card-back-provenance muted mono">
        get_property_descriptors(node_id: &quot;{nodeId}&quot;)
      </p>
    </div>
  );
}
