/**
 * What each grid remembers between visits.
 *
 * §1.9: "Cards are the default; rows is one click away and is remembered per
 * grid." §2.9: "The choice persists per grid in `localStorage`." Per grid, not
 * globally — the reference's `metadata_fields` list is one global list and every
 * table in that app grows the same columns, which §2.9 calls out as a confusion
 * not to inherit.
 *
 * Storage may be denied; every read falls back to the grid's declared defaults
 * and every write is allowed to fail. A browser with storage off still renders
 * the grid, it just forgets the choice.
 */

export type CardGridRenderer = "cards" | "rows";

/** The sort option that is the host's own order, not any field. Always available. */
export const HOST_ORDER_SORT_ID = "__host-order__";

export interface CardGridViewPreferences {
  renderer: CardGridRenderer;
  fieldIdsOnTheCardFace: readonly string[];
  /** A field id, or HOST_ORDER_SORT_ID. */
  sortId: string;
  sortDirection: "ascending" | "descending";
  /** §1.9 item 5: View ▸ show hidden components, relocated to where it acts. */
  showHiddenByDescriptor: boolean;
}

export function cardGridStorageKey(gridId: string): string {
  return `quackoscope.card-grid.${gridId}`;
}

export function readCardGridViewPreferences(
  gridId: string,
  defaults: CardGridViewPreferences,
): CardGridViewPreferences {
  try {
    const stored = window.localStorage.getItem(cardGridStorageKey(gridId));
    if (stored === null) return defaults;
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return defaults;
    const held = parsed as Partial<Record<keyof CardGridViewPreferences, unknown>>;
    return {
      renderer: held.renderer === "rows" || held.renderer === "cards"
        ? held.renderer
        : defaults.renderer,
      fieldIdsOnTheCardFace: Array.isArray(held.fieldIdsOnTheCardFace)
        ? held.fieldIdsOnTheCardFace.filter(
            (id): id is string => typeof id === "string",
          )
        : defaults.fieldIdsOnTheCardFace,
      sortId:
        typeof held.sortId === "string" ? held.sortId : defaults.sortId,
      sortDirection:
        held.sortDirection === "descending" || held.sortDirection === "ascending"
          ? held.sortDirection
          : defaults.sortDirection,
      showHiddenByDescriptor:
        typeof held.showHiddenByDescriptor === "boolean"
          ? held.showHiddenByDescriptor
          : defaults.showHiddenByDescriptor,
    };
  } catch {
    return defaults;
  }
}

export function writeCardGridViewPreferences(
  gridId: string,
  preferences: CardGridViewPreferences,
): void {
  try {
    window.localStorage.setItem(
      cardGridStorageKey(gridId),
      JSON.stringify(preferences),
    );
  } catch {
    /* a browser with storage denied still renders the grid; it forgets the choice */
  }
}
