import type { PropertyDescriptor } from "../transport";
import type { CardGridField } from "../card-grid/card-grid-model";
import { decidePropertyWidgetShape } from "./property-widget-shape";
import { hostValueAsText } from "./property-draft";
import type { PropertyOnACard } from "./property-on-a-card";

/**
 * The card face's candidate fields — §2.9's chooser, the sort menu's options,
 * what the filter searches, and the rows renderer's columns, all from one list.
 *
 * §2.9: "the candidate list is the `PropertyDescriptor` field list, which is
 * declared in `contract/contract.yaml` and therefore known statically — no
 * reflection, no throwaway builder." The reference derives its list at runtime by
 * building a `StringPropertyBuilder` and reading every non-callable public
 * attribute off the resulting `IProperty`; nothing like that happens here.
 *
 * The defaults are the facts that fit on one meta line: value_type, unit,
 * bounds and default. `description`, `id`, `validator`, `coercer`, `read_only`
 * and `visible` are candidates the reader can turn on — they are on the card's
 * back either way, and the description is also the name's tooltip, so turning
 * one on is a scanning choice rather than the only way to see it. The reference
 * does the same: its metadata columns are picked from "Select columns", and it
 * starts with none of them.
 */

export const PROPERTY_CARD_FIELD_IDS = {
  value: "value",
  valueType: "value_type",
  unit: "unit",
  bounds: "bounds",
  default: "default",
  description: "description",
  id: "id",
  readOnly: "read_only",
  visible: "visible",
  validator: "validator",
  coercer: "coercer",
  widget: "widget",
} as const;

/**
 * §1.5's sprite is a separate lane; until it lands a property card takes the
 * same kind of single-character glyph `ComponentTree.tsx` already uses for a
 * node, chosen by `value_type` so the glyph says which widget the body holds.
 */
export function propertyKindGlyph(descriptor: PropertyDescriptor): string {
  switch (decidePropertyWidgetShape(descriptor).kind) {
    case "switch":
      return "⏻";
    case "bounded-number-on-a-slider":
      return "⇹";
    case "number-without-both-bounds":
      return "#";
    case "selection-list":
    case "selection-with-one-option-is-read-only":
      return "≡";
    case "text-with-suggested-values":
    case "text":
      return "A";
    case "container-rows":
      return "⧉";
  }
}

/** `[0, 10]`, `[0, ∞)`, `unbounded` — the meta line's and the rows column's bounds. */
export function describeBounds(descriptor: PropertyDescriptor): string {
  if (descriptor.min === null && descriptor.max === null) return "unbounded";
  return `[${descriptor.min ?? "−∞"}, ${descriptor.max ?? "∞"}]`;
}

export const PROPERTY_CARD_FIELDS: readonly CardGridField<PropertyOnACard>[] = [
  {
    id: PROPERTY_CARD_FIELD_IDS.value,
    label: "Value",
    valueOf: (item) => hostValueAsText(item.value),
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: PROPERTY_CARD_FIELD_IDS.valueType,
    label: "Type",
    valueOf: (item) => item.descriptor.value_type,
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: PROPERTY_CARD_FIELD_IDS.unit,
    label: "Unit",
    valueOf: (item) => item.descriptor.unit ?? "",
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: PROPERTY_CARD_FIELD_IDS.bounds,
    label: "Bounds",
    valueOf: (item) => describeBounds(item.descriptor),
    // A bounds column sorted as text puts [0, 10000] before [0, 2]. Sorting by
    // the minimum, then the maximum, is what a reader scanning bounds means.
    compare: (a, b) =>
      (a.descriptor.min ?? Number.NEGATIVE_INFINITY) -
        (b.descriptor.min ?? Number.NEGATIVE_INFINITY) ||
      (a.descriptor.max ?? Number.POSITIVE_INFINITY) -
        (b.descriptor.max ?? Number.POSITIVE_INFINITY),
    onCardFaceByDefault: true,
    searchedByFilter: false,
  },
  {
    id: PROPERTY_CARD_FIELD_IDS.default,
    label: "Default",
    valueOf: (item) => hostValueAsText(item.descriptor.default),
    onCardFaceByDefault: true,
    searchedByFilter: false,
  },
  {
    id: PROPERTY_CARD_FIELD_IDS.description,
    label: "Description",
    valueOf: (item) => item.descriptor.description ?? "",
    onCardFaceByDefault: false,
    searchedByFilter: true,
  },
  {
    id: PROPERTY_CARD_FIELD_IDS.id,
    label: "Property id",
    valueOf: (item) => item.descriptor.id,
    onCardFaceByDefault: false,
    searchedByFilter: true,
  },
  {
    id: PROPERTY_CARD_FIELD_IDS.readOnly,
    label: "Read only",
    valueOf: (item) => String(item.descriptor.read_only),
    onCardFaceByDefault: false,
    searchedByFilter: false,
  },
  {
    id: PROPERTY_CARD_FIELD_IDS.visible,
    label: "Visible",
    valueOf: (item) => String(item.descriptor.visible),
    onCardFaceByDefault: false,
    searchedByFilter: false,
  },
  {
    id: PROPERTY_CARD_FIELD_IDS.validator,
    label: "Validator",
    valueOf: (item) => item.descriptor.validator ?? "",
    onCardFaceByDefault: false,
    searchedByFilter: false,
  },
  {
    id: PROPERTY_CARD_FIELD_IDS.coercer,
    label: "Coercer",
    valueOf: (item) => item.descriptor.coercer ?? "",
    onCardFaceByDefault: false,
    searchedByFilter: false,
  },
  {
    id: PROPERTY_CARD_FIELD_IDS.widget,
    label: "Widget",
    valueOf: (item) => decidePropertyWidgetShape(item.descriptor).kind,
    onCardFaceByDefault: false,
    searchedByFilter: true,
  },
];
