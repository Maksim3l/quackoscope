import { useMemo, useState } from "react";
import type { PropertyDescriptor } from "../transport";
import {
  describeGapInOneLine,
  gapPresentationOf,
  shortTagForGap,
} from "../session/CapabilityGapNotice";
import { HostSessionProvider } from "../session/host-capability-context";
import {
  InspectorModeControls,
  QuackInspectorProvider,
} from "../inspect/QuackInspector";
import {
  computeCapabilityStandings,
  type CapabilityStanding,
  type HandshakeReading,
  type HostHandshake,
} from "../session/host-handshake";
import { BASELINE_CAPABILITY_IDS } from "../session/capability-baseline";
import { OpInput, OpSelect, type OperationId } from "../ui/op";
import { Card } from "./Card";
import { CardGrid } from "./CardGrid";
import { CardQuackStripPondProvider, type CardCall } from "./CardQuackStrip";
import {
  CARD_STATES_IN_SPECIFICATION_TABLE_ORDER,
  cardStateMark,
  type CardState,
  type CardStateMark,
} from "./card-states";
import type { CardFaceView, CardGridField, CardGridItemFacts } from "./card-grid-model";
import "./card-grid.css";

/**
 * Every card state and every grid width on one page.
 *
 * A standalone surface, not part of App.tsx: another agent owns App.tsx right
 * now, and the card system has to be looked at before it can be wired into
 * anything. It renders one card per row of §1.8's state table, then the same
 * generic CardGrid over 24 synthetic properties so the column count of §2.0 can
 * be read off the count line at any window width.
 *
 * The properties below are synthetic and are stated as such on the page. No
 * socket is opened here: the point is the card system, and §3.2's whole argument
 * is that the teaching layer works with the host down.
 */

const SYNTHETIC_HOST_NAME = "quackoscope-host-mock";

const HANDSHAKE_BASE: HostHandshake = {
  protocol_version: "1.0",
  implementation: { name: SYNTHETIC_HOST_NAME, version: "0.1.0" },
  sdk: { version: "none: the gallery opens no socket", commit: "0000000" },
  declaredCapabilityIds: BASELINE_CAPABILITY_IDS,
  declaredGapReasons: [],
  limits: { max_subscriptions: 8, max_frame_bytes: 262144 },
  ordinalInSession: 1,
};

/** A handshake that serves every baseline capability: the ordinary case. */
const HANDSHAKE_SERVING_EVERY_CAPABILITY: HandshakeReading = {
  read: true,
  handshake: HANDSHAKE_BASE,
};

/** The same host with property.write withheld, so the gapped card is a real gap. */
const HANDSHAKE_WITHHOLDING_PROPERTY_WRITE_HANDSHAKE: HostHandshake = {
  ...HANDSHAKE_BASE,
  declaredCapabilityIds: BASELINE_CAPABILITY_IDS.filter(
    (id) => id !== "property.write",
  ),
  declaredGapReasons: [
    {
      capability: "property.write",
      kind: "host",
      kindAsDeclared: "host",
      // The gallery's own fixture text. It says what a host is supposed to say
      // when nobody has enumerated the binding's API surface: the neutral
      // default, "currently not available". It used to read "the openDAQ
      // binding it is built on exposes IProperty::setValue", which taught the
      // gallery's reader that a gap notice is a place to assert an unchecked
      // fact about a binding.
      reason: "set_property_value is currently not available",
    },
  ],
};

const HANDSHAKE_WITHHOLDING_PROPERTY_WRITE: HandshakeReading = {
  read: true,
  handshake: HANDSHAKE_WITHHOLDING_PROPERTY_WRITE_HANDSHAKE,
};

function propertyWriteStanding(): CapabilityStanding {
  const reading = computeCapabilityStandings(
    HANDSHAKE_WITHHOLDING_PROPERTY_WRITE_HANDSHAKE,
  );
  const standing = reading.standingByCapabilityId.get("property.write");
  if (standing === undefined) {
    throw new Error(
      "property.write is not in generated/wire/capability-baseline.json, so the gapped card cannot be built",
    );
  }
  return standing;
}

// --- the synthetic entities ------------------------------------------------

function descriptor(
  over: Partial<PropertyDescriptor> & Pick<PropertyDescriptor, "id" | "name">,
): PropertyDescriptor {
  return {
    value_type: "float",
    unit: null,
    description: null,
    read_only: false,
    visible: true,
    default: null,
    selection_values: null,
    suggested_values: null,
    min: null,
    max: null,
    validator: null,
    coercer: null,
    ...over,
  };
}

interface GalleryProperty {
  descriptor: PropertyDescriptor;
  /** What the host reports. Never what was typed. */
  hostValue: unknown;
  /** Keystrokes not yet committed, for the uncommitted state only. */
  draftText?: string;
  states: readonly CardStateMark[];
}

const SAMPLE_RATE = descriptor({
  id: "SampleRate",
  name: "Sample rate",
  value_type: "float",
  unit: "Hz",
  min: 100,
  max: 100000,
  default: 1000,
  description: "Rate at which the channel samples.",
});

/** One card per row of §1.8's table, in the table's own order. */
const ONE_PROPERTY_PER_STATE: readonly GalleryProperty[] = [
  {
    descriptor: SAMPLE_RATE,
    hostValue: 1000,
    states: [cardStateMark("normal", "")],
  },
  {
    descriptor: descriptor({
      id: "SerialNumber",
      name: "Serial number",
      value_type: "string",
      read_only: true,
      description: "Set by the manufacturer and fixed for the life of the device.",
    }),
    hostValue: "DEV-0044-7A",
    states: [cardStateMark("read-only", "read-only")],
  },
  {
    descriptor: descriptor({
      id: "InternalCalibrationOffset",
      name: "Internal calibration offset",
      visible: false,
      value_type: "float",
      default: 0,
      description: "Marked invisible by the descriptor; shown because show hidden is on.",
    }),
    hostValue: 0.0125,
    states: [
      cardStateMark(
        "invisible",
        "visible: false on the descriptor — this card is rendered only because show hidden is on",
      ),
    ],
  },
  {
    descriptor: descriptor({
      id: "NumberOfChannels",
      name: "Number of channels",
      value_type: "int",
      min: 1,
      max: 4096,
      default: 4,
      description: "How many channels the reference device synthesises.",
    }),
    hostValue: 4,
    states: [
      cardStateMark(
        "gapped",
        "property.write is a host gap on quackoscope-host-mock",
        "host",
      ),
    ],
  },
  {
    descriptor: SAMPLE_RATE,
    hostValue: 1000,
    draftText: "40",
    states: [cardStateMark("out-of-range", "below minimum 100")],
  },
  {
    descriptor: descriptor({
      id: "GlobalSampleRate",
      name: "Global sample rate",
      value_type: "float",
      unit: "Hz",
      min: 1,
      max: 1000000,
      default: 1000,
      description: "Applies to every channel of the device at once.",
    }),
    hostValue: 1000,
    states: [
      cardStateMark(
        "rejected",
        "invalid_value: GlobalSampleRate must divide the device clock of 10 MHz without remainder",
      ),
    ],
  },
  {
    descriptor: SAMPLE_RATE,
    hostValue: 1000,
    states: [
      cardStateMark(
        "unconfirmed",
        "timeout: no answer within 5000 ms. Writing Sample rate = 2000 may still have been applied by the host — the value shown was re-read from the host after the deadline passed, not taken from what was typed.",
      ),
    ],
  },
  {
    descriptor: SAMPLE_RATE,
    hostValue: 1000,
    draftText: "2500",
    states: [
      cardStateMark(
        "uncommitted",
        "uncommitted: the device still holds 1000. Enter commits, Escape reverts.",
      ),
    ],
  },
  {
    descriptor: descriptor({
      id: "SampleRateCoerced",
      name: "Sample rate",
      value_type: "float",
      unit: "Hz",
      min: 100,
      max: 100000,
      default: 1000,
      coercer: "if(Value < 2000, 2000, Value)",
      description: "Rate at which the channel samples.",
    }),
    hostValue: 2000,
    states: [cardStateMark("coerced", "you wrote 1700, the device holds 2000")],
  },
];

/** 24 properties, the number §1.7 measures the density trade against. */
const TWENTY_FOUR_PROPERTIES: readonly GalleryProperty[] = Array.from(
  { length: 24 },
  (_, index): GalleryProperty => {
    const n = index + 1;
    if (n === 7) {
      return {
        descriptor: descriptor({
          id: `Property${n}`,
          name: `Trigger level ${n}`,
          value_type: "float",
          unit: "V",
          min: -10,
          max: 10,
          default: 0,
          description: "Level the comparator fires at.",
        }),
        hostValue: 42,
        states: [cardStateMark("out-of-range", "above maximum 10")],
      };
    }
    if (n === 3 || n === 11 || n === 19) {
      return {
        descriptor: descriptor({
          id: `Property${n}`,
          name: `Firmware revision ${n}`,
          value_type: "string",
          read_only: true,
          description: "Reported by the device and not writable.",
        }),
        hostValue: `3.31.${n}`,
        states: [cardStateMark("read-only", "read-only")],
      };
    }
    if (n === 5 || n === 16) {
      return {
        descriptor: descriptor({
          id: `Property${n}`,
          name: `Internal tuning word ${n}`,
          visible: false,
          value_type: "int",
          default: 0,
          description: "Hidden by the descriptor.",
        }),
        hostValue: n * 17,
        states: [cardStateMark("invisible", "visible: false on the descriptor")],
      };
    }
    if (n === 9) {
      return {
        descriptor: descriptor({
          id: `Property${n}`,
          name: "Coupling",
          value_type: "selection",
          selection_values: ["DC", "AC", "GND"],
          default: 0,
          description: "Input coupling of the channel.",
        }),
        hostValue: 1,
        states: [cardStateMark("normal", "")],
      };
    }
    return {
      descriptor: descriptor({
        id: `Property${n}`,
        name: `Sample rate ${n}`,
        value_type: "float",
        unit: "Hz",
        min: 100,
        max: 100000,
        default: 1000,
        description: "Rate at which the channel samples.",
      }),
      hostValue: 1000 * n,
      states: [cardStateMark("normal", "")],
    };
  },
);

// --- the property card, one instantiation of the generic primitive ----------

const PROPERTY_CARD_OPERATION_IDS: readonly OperationId[] = [
  "property.read",
  "property.write",
];

const PROPERTY_CARD_CALLS: readonly CardCall[] = [
  { wireMethod: "set_property_value" },
  { wireMethod: "get_property_value" },
];

function displayString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function metaFactsOf(d: PropertyDescriptor): string[] {
  const facts: string[] = [];
  if (d.min !== null) facts.push(`min ${d.min}`);
  if (d.max !== null) facts.push(`max ${d.max}`);
  if (d.default !== null) facts.push(`default ${displayString(d.default)}`);
  if (d.coercer !== null) facts.push(`coercer ${d.coercer}`);
  return facts;
}

/**
 * The card face for a property.
 *
 * Deliberately thin: the widget table of §2.2 — the switch for bool, the
 * slider-plus-number for a property with both min and max, the datalist for
 * suggested_values, the container editors — belongs to the property lane. What
 * this gallery has to prove is that the primitive carries any of them, which is
 * why the body here is one plain widget and everything around it is the card.
 */
function PropertyCard({
  property,
  view,
  gapStanding,
}: {
  property: GalleryProperty;
  view: CardFaceView;
  gapStanding?: CapabilityStanding;
}) {
  const d = property.descriptor;
  const uncommitted = property.draftText !== undefined;
  const shown = property.draftText ?? displayString(property.hostValue);
  const outOfRange = property.states.some((mark) => mark.state === "out-of-range");

  const body =
    d.read_only ? (
      <span className="mono" title="read_only: true on the descriptor">
        🔒 {displayString(property.hostValue)}
      </span>
    ) : d.value_type === "selection" ? (
      <OpSelect
        op={["property.write"]}
        value={String(property.hostValue)}
        onChange={() => undefined}
      >
        {(d.selection_values ?? []).map((label, index) => (
          <option key={label} value={String(index)}>
            {label}
          </option>
        ))}
      </OpSelect>
    ) : (
      <OpInput
        op={["property.write"]}
        type="text"
        className={uncommitted ? "edited-not-yet-committed" : undefined}
        data-uncommitted={uncommitted ? "true" : undefined}
        aria-invalid={outOfRange ? true : undefined}
        value={shown}
        onChange={() => undefined}
      />
    );

  return (
    <Card
      cardId={d.id}
      glyph="⛭"
      title={d.name}
      titleTooltip={d.id}
      headerChips={[
        ...(d.unit !== null && view.fieldIsOnTheCardFace("unit")
          ? [{ label: d.unit, tone: "unit" as const }]
          : []),
        ...(view.fieldIsOnTheCardFace("value_type")
          ? [{ label: d.value_type, tone: "value-type" as const }]
          : []),
      ]}
      metaFacts={view.fieldIsOnTheCardFace("bounds") ? metaFactsOf(d) : []}
      metaLineReplacement={
        gapStanding === undefined ? undefined : (
          /* §1.8's gapped row: "the existing CapabilityGapNotice one-liner in
             place of the meta line", naming the capability, the gap kind and
             the host's own reason. The full CapabilityGapNotice block is four
             paragraphs tall and belongs where a whole pane is blocked, not on a
             300 px card; describeGapInOneLine is the same file's one-liner and
             is what §1.8 asks for. */
          <span className={`card-gap-one-liner card-gap-one-liner--${gapPresentationOf(gapStanding)}`}>
            <span className={`gap-tag gap-tag--${gapPresentationOf(gapStanding)}`}>
              {shortTagForGap(gapStanding)}
            </span>{" "}
            {describeGapInOneLine(gapStanding, SYNTHETIC_HOST_NAME)}
          </span>
        )
      }
      description={
        view.fieldIsOnTheCardFace("description") ? d.description : null
      }
      states={property.states}
      operationIds={PROPERTY_CARD_OPERATION_IDS}
      calls={PROPERTY_CARD_CALLS}
      expandedColumnSpan={view.expandedColumnSpan}
      back={{
        reveals: "all 14 PropertyDescriptor fields",
        operationIds: ["property.read"],
        content: <PropertyDescriptorDefinitionList descriptor={d} />,
      }}
    >
      {body}
    </Card>
  );
}

/** §2.8's D8: the card's back is a render of data the grid already has. */
function PropertyDescriptorDefinitionList({
  descriptor: d,
}: {
  descriptor: PropertyDescriptor;
}) {
  const rows: [string, string][] = [
    ["id", d.id],
    ["name", d.name],
    ["value_type", d.value_type],
    ["unit", d.unit ?? "null"],
    ["description", d.description ?? "null"],
    ["read_only", String(d.read_only)],
    ["visible", String(d.visible)],
    ["default", displayString(d.default) || "null"],
    ["selection_values", d.selection_values === null ? "null" : d.selection_values.join(", ")],
    ["suggested_values", d.suggested_values === null ? "null" : JSON.stringify(d.suggested_values)],
    ["min", d.min === null ? "null" : String(d.min)],
    ["max", d.max === null ? "null" : String(d.max)],
    ["validator", d.validator ?? "null"],
    ["coercer", d.coercer ?? "null"],
  ];
  return (
    <>
      <dl>
        {rows.map(([key, value]) => (
          <div key={key} style={{ display: "contents" }}>
            <dt className="mono">{key}</dt>
            <dd className="mono">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="muted" style={{ margin: "8px 0 0" }}>
        validator and coercer are openDAQ EvalValue expressions. They are printed
        as source text and evaluated on the device, never here — the contract
        sets eval_value_strings.interpret_client_side to false.
      </p>
    </>
  );
}

// --- the fields, shared by the card face, the filter, the sort and the rows --

const PROPERTY_FIELDS: readonly CardGridField<GalleryProperty>[] = [
  {
    id: "value",
    label: "Value",
    valueOf: (p) => displayString(p.hostValue),
    onCardFaceByDefault: true,
    searchedByFilter: false,
  },
  {
    id: "value_type",
    label: "Type",
    valueOf: (p) => p.descriptor.value_type,
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: "unit",
    label: "Unit",
    valueOf: (p) => p.descriptor.unit ?? "",
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: "bounds",
    label: "Bounds",
    valueOf: (p) =>
      p.descriptor.min === null && p.descriptor.max === null
        ? ""
        : `${p.descriptor.min ?? "−∞"} … ${p.descriptor.max ?? "∞"}`,
    compare: (a, b) => (a.descriptor.min ?? 0) - (b.descriptor.min ?? 0),
    onCardFaceByDefault: true,
    searchedByFilter: false,
  },
  {
    id: "description",
    label: "Description",
    valueOf: (p) => p.descriptor.description ?? "",
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: "id",
    label: "Property id",
    valueOf: (p) => p.descriptor.id,
    onCardFaceByDefault: false,
    searchedByFilter: true,
  },
];

function factsOf(property: GalleryProperty): CardGridItemFacts {
  return {
    id: property.descriptor.id,
    title: property.descriptor.name,
    states: property.states,
    hiddenByDescriptor: !property.descriptor.visible,
  };
}

// --- the page --------------------------------------------------------------

export function CardStateAndGridWidthGallery() {
  const gapStanding = useMemo(propertyWriteStanding, []);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  return (
    <HostSessionProvider
      backendUrl="none: the gallery opens no socket"
      socketState="open"
      handshakeReading={HANDSHAKE_SERVING_EVERY_CAPABILITY}
      strayNonEnvelopeMessageCount={0}
    >
      <QuackInspectorProvider
        pond={[]}
        hostProcessName={SYNTHETIC_HOST_NAME}
        socketUrl="none: the gallery opens no socket"
      >
      <CardQuackStripPondProvider pond={{ entries: [] }}>
        <div className="app">
          <header className="topbar">
            <span className="brand">quackoscope</span>
            <span className="muted">
              card state and grid width gallery — src/card-grid/, rendered
              without a socket
            </span>
            <span className="spacer" />
            {/* The real inspect layer's header controls. The provider
                wrapping this page publishes showQuack, which is what a card's
                quack strip calls when a strip line is clicked. */}
            <InspectorModeControls />
          </header>

          <main className="screen pad">
            <section className="card-grid-surface">
              <h3 className="card-grid-gallery-heading">
                Every state of §1.8, one card each
              </h3>
              <p className="muted">
                §1.8&apos;s state table has{" "}
                {CARD_STATES_IN_SPECIFICATION_TABLE_ORDER.length} rows, listed
                here in the table&apos;s own order:{" "}
                {CARD_STATES_IN_SPECIFICATION_TABLE_ORDER.join(", ")}. The
                section heading above that table says &quot;six&quot; and §4A&apos;s F1
                line says &quot;eight&quot;; the table is the only one of the three that
                enumerates anything, so all{" "}
                {CARD_STATES_IN_SPECIFICATION_TABLE_ORDER.length} are built.
              </p>
              <div className="card-grid card-grid--standard">
                {ONE_PROPERTY_PER_STATE.map((property, index) => (
                  <StateDemonstrationCell
                    key={`${property.descriptor.id}:${index}`}
                    state={CARD_STATES_IN_SPECIFICATION_TABLE_ORDER[index]}
                    property={property}
                    gapStanding={gapStanding}
                  />
                ))}
              </div>
            </section>

            <hr className="card-grid-gallery-rule" />

            <section>
              <h3 className="card-grid-gallery-heading">
                The property card grid — §2.2, --card-min 300 px
              </h3>
              <p className="muted">
                24 synthetic properties. The count line under the bar prints the
                measured container width and the column count §2.0&apos;s formula
                gives for it, so resizing this window is the whole test.
              </p>
              <CardGrid<GalleryProperty>
                gridId="card-state-and-grid-width-gallery.properties"
                entityNounSingular="property"
                entityNounPlural="properties"
                items={TWENTY_FOUR_PROPERTIES}
                factsOf={factsOf}
                fields={PROPERTY_FIELDS}
                cardMinWidth="standard"
                hostOrderLabel="descriptor order"
                operationIdsOf={() => PROPERTY_CARD_OPERATION_IDS}
                titleColumnLabel="Property name"
                populatedBy={{ wireMethod: "get_property_descriptors" }}
                selectedCardId={selectedCardId}
                onSelect={(property) =>
                  setSelectedCardId(property.descriptor.id)
                }
                renderCard={(property, view) => (
                  <PropertyCard property={property} view={view} />
                )}
              />
            </section>

            <hr className="card-grid-gallery-rule" />

            <section>
              <h3 className="card-grid-gallery-heading">
                An empty grid — §3.6, the empty state is a flock card
              </h3>
              <CardGrid<GalleryProperty>
                gridId="card-state-and-grid-width-gallery.empty"
                entityNounSingular="discovered device"
                entityNounPlural="discovered devices"
                items={[]}
                factsOf={factsOf}
                fields={PROPERTY_FIELDS}
                cardMinWidth="wide"
                hostOrderLabel="discovery order"
                operationIdsOf={() => ["device.connect"]}
                titleColumnLabel="Device name"
                populatedBy={{ wireMethod: "connect_device" }}
                renderCard={(property, view) => (
                  <PropertyCard property={property} view={view} />
                )}
              />
            </section>
          </main>
        </div>
      </CardQuackStripPondProvider>
      </QuackInspectorProvider>
    </HostSessionProvider>
  );
}

/**
 * One state, captioned with its own name so a screenshot of the section says
 * which card is which. The gapped one is wrapped in a second HostSessionProvider
 * whose handshake withholds property.write, so the gap on that card is a real
 * computed gap and its widget is disabled by op.tsx's own gate, not by a class.
 */
function StateDemonstrationCell({
  state,
  property,
  gapStanding,
}: {
  state: CardState;
  property: GalleryProperty;
  gapStanding: CapabilityStanding;
}) {
  const view: CardFaceView = {
    fieldIsOnTheCardFace: () => true,
    fieldIdsOnTheCardFace: PROPERTY_FIELDS.map((field) => field.id),
    expandedColumnSpan: 1,
  };

  const card =
    state === "gapped" ? (
      <HostSessionProvider
        backendUrl="none: the gallery opens no socket"
        socketState="open"
        handshakeReading={HANDSHAKE_WITHHOLDING_PROPERTY_WRITE}
        strayNonEnvelopeMessageCount={0}
      >
        <PropertyCard
          property={property}
          view={view}
          gapStanding={gapStanding}
        />
      </HostSessionProvider>
    ) : (
      <PropertyCard property={property} view={view} />
    );

  return (
    <div className="card-grid-gallery-cell" data-demonstrated-state={state}>
      <p className="card-grid-gallery-caption mono">{state}</p>
      {card}
    </div>
  );
}
