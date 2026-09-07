import type { PropertyDescriptor } from "../transport";
import { cardStateMark, type CardStateMark } from "../card-grid/card-states";
import {
  describeGapInOneLine,
  gapPresentationOf,
} from "../session/CapabilityGapNotice";
import type { CapabilityStanding } from "../session/host-handshake";
import { decidePropertyWidgetShape } from "./property-widget-shape";

/**
 * A property card's §1.8 state, computed from the descriptor, the host's value,
 * what is in the field and what the last write did.
 *
 * §1.8's own words are used verbatim wherever it gives them, because the whole
 * point of that table is that state is carried "by the 3 px left border, plus
 * one explicit word. Never by colour alone." A paraphrase of `below minimum 100`
 * is a worse sentence than `below minimum 100`.
 */

/** What the last `set_property_value` on this property did. */
export type PropertyWriteOutcome =
  /** No write has been made, or the last one landed exactly as submitted. */
  | { kind: "settled" }
  /** Sent; the read-back has not come back yet, so nothing is claimed about it. */
  | { kind: "in-flight"; submitted: unknown }
  /** §1.8 coerced: the host answered with a different value than was written. */
  | { kind: "coerced"; submitted: unknown; held: unknown }
  /** §1.8 rejected: the wire code, then the host's opaque detail verbatim. */
  | { kind: "rejected"; code: string; detail: string }
  /** §1.8 unconfirmed: the write timed out and may still have been applied. */
  | { kind: "unconfirmed"; sentence: string };

export interface PropertyCardStateInput {
  descriptor: PropertyDescriptor;
  /** The value the HOST reports. Never what was submitted. */
  hostValueAsText: string;
  /** Keystrokes or a drag not yet committed, or null when the field shows the host's value. */
  uncommittedDraftAsText: string | null;
  /**
   * What `precheck()` in src/components/PropertyField.tsx returned for the
   * uncommitted draft, or null when the draft passes or there is no draft.
   */
  precheckRefusal: string | null;
  outcome: PropertyWriteOutcome;
  /** The `property.write` standing, when it is a gap on the connected host. */
  writeGapStanding: CapabilityStanding | null;
  hostProcessName: string;
}

export function propertyCardStateMarks(
  input: PropertyCardStateInput,
): CardStateMark[] {
  const d = input.descriptor;
  const marks: CardStateMark[] = [];
  const shape = decidePropertyWidgetShape(d);

  // --- read-only ------------------------------------------------------------
  // §1.8: "read_only: true, OR a selection with exactly one option".
  if (d.read_only) {
    marks.push(cardStateMark("read-only", "read-only"));
  } else if (shape.kind === "selection-with-one-option-is-read-only") {
    marks.push(
      cardStateMark(
        "read-only",
        `read-only: selection_values holds exactly one option, "${shape.onlyOption}", so there is nothing to choose`,
      ),
    );
  }

  // --- invisible ------------------------------------------------------------
  if (!d.visible) {
    marks.push(
      cardStateMark(
        "invisible",
        `hidden by the descriptor: ${d.id} reports visible = false, and get_property_descriptors still returned it`,
      ),
    );
  }

  // --- gapped ---------------------------------------------------------------
  if (input.writeGapStanding !== null && input.writeGapStanding.gap !== null) {
    marks.push(
      cardStateMark(
        "gapped",
        describeGapInOneLine(input.writeGapStanding, input.hostProcessName),
        gapPresentationOf(input.writeGapStanding),
      ),
    );
  }

  // --- out of range ---------------------------------------------------------
  // §1.8: "the exact string precheck() already returns, plus the literal bound".
  // precheck's own strings already carry the bound; the descriptor's whole range
  // is added after it so the reader sees both ends without opening the back.
  if (input.precheckRefusal !== null) {
    marks.push(
      cardStateMark(
        "out-of-range",
        `${input.precheckRefusal} — ${d.id} accepts [${d.min ?? "−∞"}, ${d.max ?? "∞"}]`,
      ),
    );
  } else if (input.uncommittedDraftAsText !== null) {
    // --- uncommitted --------------------------------------------------------
    // §1.8's words, unchanged: an uncommitted edit is not device state and the
    // card must never let it read as one.
    marks.push(
      cardStateMark(
        "uncommitted",
        `the device still holds ${input.hostValueAsText}. Enter commits, Escape reverts.`,
      ),
    );
  }

  // --- what the last write did ---------------------------------------------
  switch (input.outcome.kind) {
    case "coerced":
      marks.push(
        cardStateMark(
          "coerced",
          `you wrote ${formatForTheCard(input.outcome.submitted)}, the device holds ` +
            `${formatForTheCard(input.outcome.held)}` +
            (d.coercer === null
              ? " — the descriptor declares no coercer, so the device changed it for a reason it did not publish"
              : ""),
        ),
      );
      break;
    case "rejected":
      marks.push(
        cardStateMark(
          "rejected",
          `${input.outcome.code}: ${input.outcome.detail}`,
        ),
      );
      break;
    case "unconfirmed":
      marks.push(cardStateMark("unconfirmed", input.outcome.sentence));
      break;
    case "in-flight":
    case "settled":
      break;
  }

  return marks;
}

/**
 * The sentence §1.8 fixes for a write that timed out, with this property's own
 * name and the value that was submitted in it. The vocabulary is
 * PropertyField.tsx's and §2.2 says it "must not be lost", so it is carried over
 * word for word rather than re-worded.
 */
export function unconfirmedWriteSentence(
  descriptor: PropertyDescriptor,
  submitted: unknown,
  code: string,
  detail: string,
): string {
  return (
    `${code}: ${detail}. Writing ${descriptor.name} = ${JSON.stringify(submitted)} ` +
    `may still have been applied by the host — the value shown was re-read from the host ` +
    `after the deadline passed, not taken from what was typed.`
  );
}

function formatForTheCard(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Whether two values are the same as far as "did the device store what I wrote"
 * is concerned. A structural comparison, because a struct write goes back as a
 * whole container and `===` would call every one of them coerced.
 */
export function valuesAreTheSame(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
