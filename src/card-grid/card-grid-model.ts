import type { CardStateMark } from "./card-states";
import { HOST_ORDER_SORT_ID } from "./card-grid-view-preferences";

/**
 * What a card grid needs to know about the things it shows, independently of
 * what those things are.
 *
 * The whole abstraction is here: a grid is given items of any type `T`, one
 * function that states the facts the grid bar needs about an item without
 * rendering it, and a list of fields. Properties, discovered devices, function
 * block types, modules, signals and input ports differ only in what they put in
 * those two.
 */

/**
 * One field of the entity — a candidate for the card face, a sort key, a filter
 * target and a column in the rows renderer, all at once. §2.9: what the
 * reference's *Visible columns* dialog chose is here "what is on the card face",
 * and the candidate list is declared rather than reflected out of a throwaway
 * builder.
 */
export interface CardGridField<T> {
  /** Stable: it is what localStorage remembers. */
  id: string;
  /** How the grid bar, the chooser and the rows renderer name it. */
  label: string;
  /** The field's value for one item, as text. Filter, sort and rows all read this. */
  valueOf: (item: T) => string;
  /**
   * Ordering for this field. Without one, `valueOf` is compared with
   * `localeCompare` and numeric fields sort as text — which is why every numeric
   * field should bring its own.
   */
  compare?: (a: T, b: T) => number;
  /** On the card face before anyone touches the chooser. */
  onCardFaceByDefault: boolean;
  /** Included in what the filter searches. Named in the filter's placeholder. */
  searchedByFilter: boolean;
}

/**
 * The facts the grid bar needs about an item without building its card: what to
 * call it, what states it is in (so the count line can print them) and whether
 * the descriptor hid it.
 */
export interface CardGridItemFacts {
  /** React key, DOM `data-card-id`, and the identity a re-sort keeps. */
  id: string;
  title: string;
  /** §1.8. The count line of §1.9 is built from these. */
  states: readonly CardStateMark[];
  /** §1.8's `invisible` row: not rendered at all unless *show hidden* is on. */
  hiddenByDescriptor: boolean;
}

/** What the grid hands each card so the card can respect the field chooser. */
export interface CardFaceView {
  fieldIsOnTheCardFace: (fieldId: string) => boolean;
  fieldIdsOnTheCardFace: readonly string[];
  /** §2.0's clamp: what `grid-column: span` an expanded card may take here. */
  expandedColumnSpan: number;
}

/** "Filter properties by name, unit or type" — the placeholder names what it searches. */
export function filterPlaceholder<T>(
  entityNounPlural: string,
  fields: readonly CardGridField<T>[],
): string {
  const searched = fields
    .filter((field) => field.searchedByFilter)
    .map((field) => field.label.toLowerCase());
  if (searched.length === 0) return `Filter ${entityNounPlural} by name`;
  const last = searched[searched.length - 1];
  return searched.length === 1
    ? `Filter ${entityNounPlural} by ${last}`
    : `Filter ${entityNounPlural} by ${searched.slice(0, -1).join(", ")} or ${last}`;
}

/**
 * The tree's search semantics, minus the hoisting a flat grid has no use for: a
 * case-insensitive substring over every field marked `searchedByFilter`, plus
 * the title. One filter idiom in the app, as §1.9 item 1 asks.
 */
export function itemMatchesFilter<T>(
  item: T,
  facts: CardGridItemFacts,
  fields: readonly CardGridField<T>[],
  filterText: string,
): boolean {
  const needle = filterText.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (facts.title.toLowerCase().includes(needle)) return true;
  return fields.some(
    (field) =>
      field.searchedByFilter &&
      field.valueOf(item).toLowerCase().includes(needle),
  );
}

/**
 * §1.9 item 2: sorting is the replacement for a clickable column header, and the
 * options are exactly the card's face fields plus the host's own order — which
 * is the default, because that is what the reference shows.
 *
 * The host order is the order `items` arrived in, so it is produced by not
 * sorting at all rather than by inventing a key.
 */
export function sortItemsForDisplay<T>(
  items: readonly T[],
  factsOf: (item: T) => CardGridItemFacts,
  fields: readonly CardGridField<T>[],
  sortId: string,
  sortDirection: "ascending" | "descending",
): readonly T[] {
  if (sortId === HOST_ORDER_SORT_ID) {
    return sortDirection === "ascending" ? items : [...items].reverse();
  }
  const field = fields.find((each) => each.id === sortId);
  if (field === undefined) return items;
  const compare =
    field.compare ??
    ((a: T, b: T) => field.valueOf(a).localeCompare(field.valueOf(b)));
  const sorted = [...items].sort((a, b) => {
    const byField = compare(a, b);
    return byField !== 0 ? byField : factsOf(a).title.localeCompare(factsOf(b).title);
  });
  return sortDirection === "ascending" ? sorted : sorted.reverse();
}
