import { Card } from "../card-grid/Card";
import { cardStateMark } from "../card-grid/card-states";
import { ComponentIcon } from "../component-tree/component-icon-sprite";
import { FlockForOperation } from "../inspect/FlockColumns";
import type { Node, SignalDescriptor } from "../transport";
import {
  describeTheRowInOneLine,
  GET_SIGNAL_DESCRIPTOR_ROW,
  NOTHING_RETURNS_A_DEVICE_DOMAIN,
  type ContractRowThisGridIsWaitingOn,
} from "./contract-rows-these-grids-wait-on";
import {
  ReadOnlyDefinitionListWithPerRowCopy,
  type DefinitionListEntry,
} from "./ReadOnlyDefinitionListWithPerRowCopy";

/**
 * §2.4 — the data descriptor view becomes one card per descriptor, with a
 * definition list inside, read-only.
 *
 * "**One card = one descriptor**, not one card per field. `Signal descriptor`
 * and `Domain signal descriptor` are two cards… Body: a `<dl>` of `name :
 * value`… Read-only throughout — the reference has no editing here either."
 *
 * The card layout is built and the field list is real. The values are not, and
 * the reason is unusually precise, which is why these cards are worth having at
 * all:
 *
 * **contract/contract.yaml declares the `SignalDescriptor` record and no
 * operation returns it.** It is there in §3's type list with five fields — `id`,
 * `name`, `sample_type`, `unit`, `domain_id` — it is generated into
 * generated/typescript/contract-types.ts, and none of the thirteen operations in
 * §5 has it as a return type. The type exists; the row does not. So each field
 * below is named from the contract itself, exhaustively, and every value is the
 * neutral word until O15 `get_signal_descriptor` lands.
 *
 * That is a stronger teaching object than an empty panel: the reader sees
 * exactly which five facts a descriptor carries, and exactly which one row would
 * fill them.
 */

/**
 * The five fields of the contract's `SignalDescriptor`, with what each one is.
 *
 * A `Record<keyof SignalDescriptor, string>`, so it is exhaustive by
 * construction: a field added to the contract's record makes this object stop
 * compiling, and a field removed makes the extra key an error. The descriptor
 * card can therefore never drift from the contract it is describing.
 */
const WHAT_EACH_SIGNAL_DESCRIPTOR_FIELD_IS: Record<
  keyof SignalDescriptor,
  string
> = {
  id: "the descriptor's own id, required",
  name: "the descriptor's name, required",
  sample_type:
    "one of float32, float64, int32, int64 — the closed enum the contract declares",
  unit: "the unit string, nullable",
  domain_id:
    "the id of this signal's domain signal, nullable, referencing Node.id — the only place a domain signal is named anywhere in contract/contract.yaml",
};

function descriptorFieldEntries(): DefinitionListEntry[] {
  return (
    Object.keys(WHAT_EACH_SIGNAL_DESCRIPTOR_FIELD_IS) as (keyof SignalDescriptor)[]
  ).map((field) => ({
    name: field,
    value: null,
    note: WHAT_EACH_SIGNAL_DESCRIPTOR_FIELD_IS[field],
  }));
}

/**
 * The four label rows `output_signals_view.make_device_domain_section` draws,
 * and what each one reads off `device.domain`. Written out because §2.15 asks
 * for the card and nothing in the contract or in §4B proposes a row for it — so
 * this list is the reference's, not the contract's, and it is labelled as such
 * on the card.
 */
const WHAT_THE_REFERENCE_READS_OFF_A_DEVICE_DOMAIN: DefinitionListEntry[] = [
  {
    name: "unit.quantity",
    value: null,
    note: "the row's label in the reference; when it is absent the reference falls back to \"<device name> Domain\"",
  },
  {
    name: "tick_resolution",
    value: null,
    note: "numerator and denominator; without both, the reference prints \"Ticks: <n>\" instead of a timestamp",
  },
  { name: "origin", value: null, note: "parsed by utils.parse_origin" },
  {
    name: "ticks_since_origin",
    value: null,
    note: "polled by the reference every 200 ms and turned into a timestamp",
  },
];

export function DataDescriptorCardGrid({ component }: { component: Node }) {
  // §2.4's two descriptor cards belong to a signal; the Device domain card of
  // §2.15 belongs to a device. A component that is neither has no descriptor
  // surface in the reference either, so the section is not rendered at all
  // rather than rendered empty.
  const isSignal = component.kind === "signal";
  const isDevice = component.kind === "device";
  if (!isSignal && !isDevice) return null;

  return (
    <section className="right-stack-section" aria-label="Data descriptors">
      <h3 className="right-stack-banner">Data descriptors</h3>

      <div className="card-grid card-grid--standard">
        {isSignal && (
          <>
            <DescriptorCardWaitingOnItsRow
              cardId={`signal-descriptor:${component.id}`}
              title="Signal descriptor"
              subject={`${component.name}'s own descriptor`}
              entries={descriptorFieldEntries()}
              fieldsAreFrom="contract/contract.yaml's SignalDescriptor record"
            />
            <DescriptorCardWaitingOnItsRow
              cardId={`domain-signal-descriptor:${component.id}`}
              title="Domain signal descriptor"
              subject={`the descriptor of the signal ${component.name}'s domain_id points at`}
              entries={descriptorFieldEntries()}
              fieldsAreFrom="contract/contract.yaml's SignalDescriptor record"
              extraSentence={
                "Reaching this one needs O15 twice: once for this signal's descriptor, to read its " +
                "domain_id, and once for the descriptor that id names. The wire's Node record has " +
                "neither a domain_signal field nor a related_signals field, so there is no second " +
                "way round."
              }
            />
          </>
        )}

        {isDevice && (
          <DescriptorCardWaitingOnItsRow
            cardId={`device-domain:${component.id}`}
            title="Device domain"
            subject={`${component.name}'s domain — its unit quantity, tick resolution, origin and ticks since origin`}
            entries={WHAT_THE_REFERENCE_READS_OFF_A_DEVICE_DOMAIN}
            fieldsAreFrom="output_signals_view.make_device_domain_section in the reference — NOT the contract, which declares nothing about a device domain"
            row={NOTHING_RETURNS_A_DEVICE_DOMAIN}
          />
        )}
      </div>
    </section>
  );
}

/**
 * One §2.4 card: the descriptor's name, its definition list, and the row that
 * would fill the list.
 *
 * The card is `read-only` in §1.8's sense as well as in fact — there is no
 * input anywhere inside it — and `gapped` in the `undeclared` presentation,
 * because the capability it would need is not in the contract's baseline and no
 * host declared anything about it.
 */
function DescriptorCardWaitingOnItsRow({
  cardId,
  title,
  subject,
  entries,
  fieldsAreFrom,
  row = GET_SIGNAL_DESCRIPTOR_ROW,
  extraSentence,
}: {
  cardId: string;
  title: string;
  subject: string;
  entries: DefinitionListEntry[];
  fieldsAreFrom: string;
  row?: ContractRowThisGridIsWaitingOn;
  extraSentence?: string;
}) {
  return (
    <Card
      cardId={cardId}
      glyph={<ComponentIcon name="list" />}
      title={title}
      titleTooltip={subject}
      headerChips={[
        { label: "read-only", tone: "plain", title: "no operation in contract/contract.yaml writes a descriptor field" },
      ]}
      states={[
        cardStateMark("read-only", "read-only"),
        cardStateMark("gapped", describeTheRowInOneLine(row), "undeclared"),
      ]}
      metaLineReplacement={
        <span className="card-gap-one-liner card-gap-one-liner--undeclared">
          <span className="gap-tag gap-tag--undeclared">contract gap</span>
          {subject}. Field names from {fieldsAreFrom}.
        </span>
      }
      operationIds={["tree.read"]}
      calls={[{ wireMethod: "get_component_tree" }]}
      back={{
        reveals: `the tree.read flock: the call that did run, beside ${row.wireMethodThatDoesNotExist}, which did not`,
        operationIds: ["tree.read"],
        content: <FlockForOperation operationId="tree.read" />,
      }}
    >
      <div className="descriptor-card-body">
        <p className="muted descriptor-card-why">
          {describeTheRowInOneLine(row)}
          {extraSentence === undefined ? "" : ` ${extraSentence}`}
        </p>
        <ReadOnlyDefinitionListWithPerRowCopy
          describedAs={title}
          entries={entries}
        />
      </div>
    </Card>
  );
}
