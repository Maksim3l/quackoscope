import type { PropertyDescriptor } from "../transport";
import type { CardStateMark } from "../card-grid/card-states";
import type { CapabilityStanding } from "../session/host-handshake";
import { precheck } from "./precheck-a-value-against-its-descriptor";
import {
  propertyCardStateMarks,
  type PropertyWriteOutcome,
} from "./property-card-states";
import { hostValueAsText, type PropertyDraft } from "./property-draft";

/**
 * One property, as the grid sees it: the descriptor, the host's value, the
 * uncommitted edit, and the §1.8 states all four of those add up to.
 *
 * Why the uncommitted edit lives up here in the grid rather than inside the card
 * that shows it: §1.9 item 6 says the count line "prints literal counts of every
 * state in §1.8, so the answer to 'is anything wrong on this component' is one
 * line of text". Two of those nine states — `uncommitted` and `out of range` —
 * exist only because of what is in a field right now. A grid that could not see
 * them would print a count line that quietly omitted the two states a reader is
 * most likely to be looking for.
 */
export interface PropertyOnACard {
  descriptor: PropertyDescriptor;
  /** What the HOST reports. Never what was submitted. */
  value: unknown;
  /** Keystrokes or a drag not yet committed. */
  draft: PropertyDraft | null;
  /** What `precheck()` says about the draft, or null. Drives §1.8's out-of-range. */
  precheckRefusal: string | null;
  states: CardStateMark[];
  outcome: PropertyWriteOutcome;
  pending: boolean;
}

export function buildPropertyOnACard({
  descriptor,
  value,
  draft,
  outcome,
  pending,
  writeGapStanding,
  hostProcessName,
}: {
  descriptor: PropertyDescriptor;
  value: unknown;
  draft: PropertyDraft | null;
  outcome: PropertyWriteOutcome;
  pending: boolean;
  writeGapStanding: CapabilityStanding | null;
  hostProcessName: string;
}): PropertyOnACard {
  const hostText = hostValueAsText(value);
  // A draft whose text is what the host already holds is not an edit. Dropping
  // it here keeps `uncommitted` honest when a reader types a character and
  // deletes it again.
  const liveDraft = draft !== null && draft.text !== hostText ? draft : null;
  const precheckRefusal =
    liveDraft === null || liveDraft.parsed === null
      ? null
      : precheck(descriptor, liveDraft.parsed);

  return {
    descriptor,
    value,
    draft: liveDraft,
    precheckRefusal,
    outcome,
    pending,
    states: propertyCardStateMarks({
      descriptor,
      hostValueAsText: hostText,
      uncommittedDraftAsText: liveDraft?.text ?? null,
      precheckRefusal,
      outcome,
      writeGapStanding,
      hostProcessName,
    }),
  };
}
