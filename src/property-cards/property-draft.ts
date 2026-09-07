import type { KeyboardEvent } from "react";

/**
 * An edit that has been made on a card but not yet sent to the device.
 *
 * The discipline this type exists to enforce is the one `PropertyField.tsx`
 * already keeps and §2.2 says carries over unchanged: what is on screen after a
 * commit comes from the HOST — the read-back or the `property_changed` event —
 * and never from what was submitted, because a coercer may have changed it. So a
 * draft holds keystrokes and drag positions only, it is marked in the markup and
 * in words as something the device does not hold, and it is thrown away the
 * moment the write settles.
 *
 * It is lifted out of the widget because three separate things need to agree
 * about it: the widget shows it, the card's §1.8 state marks name it
 * (`uncommitted`, `out of range`), and the commit path parses it.
 */
export interface PropertyDraft {
  /** What the field displays, exactly as typed or dragged. */
  text: string;
  /**
   * What committing this draft would put on the wire. `null` when the text does
   * not parse to the property's type at all, which is a different failure from a
   * value that parses and is out of range.
   */
  parsed: unknown;
  /** Set when `text` does not parse; the sentence names the shape expected. */
  parseRefusal: string | null;
  /** How the draft was made. A dragged draft is committed by releasing, not by Enter. */
  madeBy: "typing" | "dragging";
}

export function typedDraft(
  text: string,
  parsed: unknown,
  parseRefusal: string | null = null,
): PropertyDraft {
  return { text, parsed, parseRefusal, madeBy: "typing" };
}

export function draggedDraft(text: string, parsed: number): PropertyDraft {
  return { text, parsed, parseRefusal: null, madeBy: "dragging" };
}

/**
 * Enter is the commit gesture in a grid, and it must reach commit even from a
 * keyboard, IME or automation driver that fills in only some of the three key
 * identifications a KeyboardEvent carries. Carried over from PropertyField.tsx,
 * which learned this the hard way.
 */
export function keystrokeCommitsTheDraft(
  e: KeyboardEvent<HTMLElement>,
): boolean {
  return (
    e.key === "Enter" ||
    e.code === "Enter" ||
    e.code === "NumpadEnter" ||
    e.keyCode === 13
  );
}

/** Escape throws the uncommitted keystrokes away and shows the host's value again. */
export function keystrokeRevertsTheDraft(
  e: KeyboardEvent<HTMLElement>,
): boolean {
  return e.key === "Escape" || e.code === "Escape" || e.keyCode === 27;
}

/** The host's value as the text a field shows for it. */
export function hostValueAsText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
