/**
 * The states a card must show, from the design specification's §1.8 table.
 *
 * The table in
 * quackoscope-gui-design-specification-logger-added-look-with-card-grids-replacing-dialogs-and-tables.md
 * lines 239-248 has NINE rows. Its own heading says "the six states a card must
 * show" and §4A's F1 line says "the eight states of §1.8". Three numbers, one
 * table. The table is the only one of the three that enumerates anything, so the
 * table is what this file implements, row for row, in the table's own order —
 * and the discrepancy is reported rather than resolved by guessing which three
 * rows the heading meant to drop.
 *
 * Every member below is one row of that table. Nothing here is invented and
 * nothing is left out.
 */

/** §1.8's rows, in the order the table prints them. */
export const CARD_STATES_IN_SPECIFICATION_TABLE_ORDER = [
  "normal",
  "read-only",
  "invisible",
  "gapped",
  "out-of-range",
  "rejected",
  "unconfirmed",
  "uncommitted",
  "coerced",
] as const;

export type CardState = (typeof CARD_STATES_IN_SPECIFICATION_TABLE_ORDER)[number];

/**
 * One state a card is currently in, with the exact sentence the card prints for
 * it. §1.8: "State is carried by the 3 px left border, plus one explicit word.
 * Never by colour alone." — so `words` is not optional for anything but
 * `normal`, and the card renders it verbatim.
 */
export interface CardStateMark {
  state: CardState;
  /**
   * What the card says, literally. `below minimum 100`, not "invalid".
   * Empty string only for `normal`, which says nothing because there is nothing
   * to say.
   */
  words: string;
  /**
   * For `gapped` only: which of the two gap colours the left border takes.
   * A gap whose kind the host did not declare is neither, and takes the muted
   * border — the same distinction src/session/CapabilityGapNotice.tsx draws.
   */
  gapPresentation?: "binding" | "host" | "undeclared";
}

export function cardStateMark(
  state: CardState,
  words: string,
  gapPresentation?: CardStateMark["gapPresentation"],
): CardStateMark {
  return gapPresentation === undefined
    ? { state, words }
    : { state, words, gapPresentation };
}

/**
 * A card can hold several marks at once — a read-only card whose capability is
 * also gapped is both — but it has one left border. This is the order that
 * border is decided in, most urgent first: a refusal outranks a warning,
 * a warning outranks a fact about the descriptor.
 */
const BORDER_PRECEDENCE: readonly CardState[] = [
  "rejected",
  "out-of-range",
  "unconfirmed",
  "uncommitted",
  "coerced",
  "gapped",
  "invisible",
  "read-only",
  "normal",
];

/** The state whose colour the card's 3 px left border takes. */
export function governingCardState(
  marks: readonly CardStateMark[],
): CardStateMark {
  for (const state of BORDER_PRECEDENCE) {
    const found = marks.find((mark) => mark.state === state);
    if (found !== undefined) return found;
  }
  return { state: "normal", words: "" };
}

/**
 * The class the card element carries for the governing state. The colours
 * themselves live in card-grid.css, one rule per state, so a reader can see all
 * nine in one place.
 */
export function cardStateClassName(mark: CardStateMark): string {
  if (mark.state === "gapped") {
    return `card--gapped-${mark.gapPresentation ?? "undeclared"}`;
  }
  return `card--${mark.state}`;
}

/** How each state is written in the count line and the rows renderer. */
export const CARD_STATE_LABEL: Readonly<Record<CardState, string>> = {
  normal: "normal",
  "read-only": "read-only",
  invisible: "hidden by descriptor",
  gapped: "gapped",
  "out-of-range": "out of range",
  rejected: "rejected",
  unconfirmed: "unconfirmed",
  uncommitted: "uncommitted",
  coerced: "coerced",
};

/**
 * §1.9's count line is "not decoration. It prints literal counts of every state
 * in §1.8". This is that count: every state present at least once, in the
 * table's order, with its real number. States with a count of zero are left out
 * — printing `0 rejected` on a healthy grid is noise, printing `1 rejected` on a
 * broken one is the whole point.
 */
export function countCardStates(
  markLists: readonly (readonly CardStateMark[])[],
): { state: CardState; count: number }[] {
  const counts = new Map<CardState, number>();
  for (const marks of markLists) {
    for (const mark of marks) {
      if (mark.state === "normal") continue;
      counts.set(mark.state, (counts.get(mark.state) ?? 0) + 1);
    }
  }
  return CARD_STATES_IN_SPECIFICATION_TABLE_ORDER.filter(
    (state) => (counts.get(state) ?? 0) > 0,
  ).map((state) => ({ state, count: counts.get(state) ?? 0 }));
}
