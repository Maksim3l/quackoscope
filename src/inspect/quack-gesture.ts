import { useEffect } from "react";
import type { OperationId } from "../ui/op";

/**
 * The quack gesture: how a person asks what openDAQ calls a control makes.
 *
 * Three paths, all of them landing on the same onQuack callback:
 *   1. middle click              — the default, always armed, no setup
 *   2. a modifier chord + click  — configurable, defaults to Alt + Shift
 *   3. inspector mode            — a persistent toggle that badges every
 *                                  quackable control and turns a plain tap into
 *                                  a quack. This is the touch path: no middle
 *                                  button and no modifier keys exist there.
 *
 * The gesture keeps its name — a quack is a quack. Only the MODE is called
 * inspector mode, which is what it is called on screen.
 *
 * A control is quackable when it carries data-op, which src/ui/op.tsx mirrors
 * onto the DOM from the `op` prop. Elements inside the inspect layer's own
 * chrome carry data-quack-chrome and are never quackable — the panel must stay
 * operable while inspector mode is on.
 */

export const MODIFIER_KEY_NAMES = ["ctrl", "alt", "shift", "meta"] as const;
export type ModifierKeyName = (typeof MODIFIER_KEY_NAMES)[number];

/** The chord is the set of modifiers that must be held, exactly, with a left click. */
export type QuackChord = readonly ModifierKeyName[];

/**
 * Alt + Shift: two modifiers, so it cannot fire by accident, and neither the
 * browser nor Windows claims Alt+Shift+click for anything else.
 */
export const DEFAULT_QUACK_CHORD: QuackChord = ["alt", "shift"];

export const QUACK_CHORD_STORAGE_KEY = "quackoscope.quack-chord";
export const INSPECTOR_MODE_STORAGE_KEY = "quackoscope.inspector-mode-on";

const MODIFIER_LABEL: Record<ModifierKeyName, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Meta",
};

function inDeclaredOrder(chord: QuackChord): ModifierKeyName[] {
  return MODIFIER_KEY_NAMES.filter((name) => chord.includes(name));
}

export function describeQuackChord(chord: QuackChord): string {
  const held = inDeclaredOrder(chord);
  if (held.length === 0) {
    return "no modifier selected, so the chord gesture is off";
  }
  return `${held.map((name) => MODIFIER_LABEL[name]).join(" + ")} + left click`;
}

/** localStorage may be unavailable or hold something stale; either way, fall back loudly-in-code, quietly on screen. */
export function readQuackChordFromBrowserStorage(): QuackChord {
  try {
    const stored = window.localStorage.getItem(QUACK_CHORD_STORAGE_KEY);
    if (stored === null) return DEFAULT_QUACK_CHORD;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return DEFAULT_QUACK_CHORD;
    return MODIFIER_KEY_NAMES.filter((name) => parsed.includes(name));
  } catch {
    return DEFAULT_QUACK_CHORD;
  }
}

export function writeQuackChordToBrowserStorage(chord: QuackChord): void {
  try {
    window.localStorage.setItem(
      QUACK_CHORD_STORAGE_KEY,
      JSON.stringify(inDeclaredOrder(chord)),
    );
  } catch {
    /* a browser with storage denied still quacks; it just forgets the chord */
  }
}

export function readInspectorModeFromBrowserStorage(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_MODE_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeInspectorModeToBrowserStorage(on: boolean): void {
  try {
    window.localStorage.setItem(INSPECTOR_MODE_STORAGE_KEY, on ? "on" : "off");
  } catch {
    /* see above */
  }
}

/** Exact match: every chord modifier held, and no other modifier held. */
export function mouseEventMatchesChord(
  event: MouseEvent,
  chord: QuackChord,
): boolean {
  if (chord.length === 0) return false;
  const held: Record<ModifierKeyName, boolean> = {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
  return MODIFIER_KEY_NAMES.every((name) => held[name] === chord.includes(name));
}

/** Which of the three paths produced a quack. Shown in the panel, verbatim. */
export type QuackGesture =
  | "middle click"
  | "modifier chord"
  | "inspector mode tap on the control"
  | "inspector mode badge"
  // Each member of this union is PRINTED — "quacked X via the call log" — so it
  // is a user-facing string, and "pond entry" was one of the places the word
  // survived on screen.
  | "the call log"
  | "card quack strip";

export interface QuackedControl {
  operationIds: OperationId[];
  /** What was quacked, in words: 'input[type=number] "Frequency"'. */
  controlDescription: string;
  gesture: QuackGesture;
}

const QUACKABLE_SELECTOR = "[data-op]";
const INSPECT_CHROME_SELECTOR = "[data-quack-chrome]";

export function quackableAncestorOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest(INSPECT_CHROME_SELECTOR) !== null) return null;
  return target.closest<HTMLElement>(QUACKABLE_SELECTOR);
}

export function operationIdsOf(element: HTMLElement): OperationId[] {
  const declared = element.getAttribute("data-op") ?? "";
  return declared.split(/\s+/).filter((id) => id.length > 0) as OperationId[];
}

/** Every quackable control on the page right now, for the badge layer. */
export function quackableControlsOnPage(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(QUACKABLE_SELECTOR)].filter(
    (element) => element.closest(INSPECT_CHROME_SELECTOR) === null,
  );
}

/**
 * Names the control the way a person would point at it: the tag, then the best
 * label the DOM actually carries, then — for a widget inside a card, which has
 * no label of its own — the card's title.
 */
export function describeControl(element: HTMLElement): string {
  const tag = element.tagName.toLowerCase();
  const type = element.getAttribute("type");
  const shape = type === null ? tag : `${tag}[type=${type}]`;

  const candidates = [
    element.getAttribute("aria-label"),
    // A widget inside a card has no label of its own; the card's title band
    // carries the property name.
    element.closest(".card-face")?.querySelector(".card-title")?.textContent ??
      null,
    element.textContent,
    element.getAttribute("title"),
  ];
  for (const candidate of candidates) {
    const label = candidate?.replace(/\s+/g, " ").trim() ?? "";
    if (label.length > 0) {
      return `${shape} "${label.length > 60 ? `${label.slice(0, 57)}...` : label}"`;
    }
  }
  return shape;
}

/**
 * Installs the two pointer paths. Capture phase throughout, so a control's own
 * onClick never runs for a click that was meant as a quack.
 */
export function useQuackGesture({
  chord,
  inspectorModeOn,
  onQuack,
}: {
  chord: QuackChord;
  inspectorModeOn: boolean;
  onQuack: (quacked: QuackedControl) => void;
}): void {
  useEffect(() => {
    const quack = (element: HTMLElement, gesture: QuackGesture) => {
      onQuack({
        operationIds: operationIdsOf(element),
        controlDescription: describeControl(element),
        gesture,
      });
    };

    // Middle button: Windows Chrome would otherwise start autoscroll, and it
    // starts on mousedown, so the suppression has to happen there.
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 1) return;
      if (quackableAncestorOf(event.target) === null) return;
      event.preventDefault();
    };

    const onAuxClick = (event: MouseEvent) => {
      if (event.button !== 1) return;
      const element = quackableAncestorOf(event.target);
      if (element === null) return;
      event.preventDefault();
      event.stopPropagation();
      quack(element, "middle click");
    };

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const element = quackableAncestorOf(event.target);
      if (element === null) return;
      const byChord = mouseEventMatchesChord(event, chord);
      // In inspector mode a plain tap quacks instead of acting: that is what
      // makes the toggle usable on a touch screen, where there is no third
      // button and no modifier key to hold.
      const byInspectorMode =
        inspectorModeOn && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (!byChord && !byInspectorMode) return;
      event.preventDefault();
      event.stopPropagation();
      quack(
        element,
        byChord ? "modifier chord" : "inspector mode tap on the control",
      );
    };

    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("auxclick", onAuxClick, true);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("auxclick", onAuxClick, true);
      window.removeEventListener("click", onClick, true);
    };
  }, [chord, inspectorModeOn, onQuack]);
}
