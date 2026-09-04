import { useEffect, useState, type RefObject } from "react";

/**
 * The shared grid geometry of the design specification's §2.0.
 *
 * Three card widths and one gap, and every grid in the app picks one of the
 * three. The numbers are the specification's, and the substitution table of
 * §2.17 is what assigns them: 260 for chips, statuses, the field chooser and
 * module component types; 300 for properties, signals, input ports and
 * attributes; 360 for discovery, type cards and configuration cards.
 */

export const CARD_GAP_PX = 10;

export const CARD_MIN_WIDTH_PX = {
  narrow: 260,
  standard: 300,
  wide: 360,
} as const;

export type CardMinWidthName = keyof typeof CARD_MIN_WIDTH_PX;

/** The CSS custom property §2.0 names for each of the three widths. */
export const CARD_MIN_WIDTH_CSS_VARIABLE: Readonly<
  Record<CardMinWidthName, string>
> = {
  narrow: "--card-min-narrow",
  standard: "--card-min",
  wide: "--card-min-wide",
};

/**
 * §2.0's formula, verbatim: columns = floor((container + gap) / (min + gap)).
 *
 * It is computed in TypeScript as well as left to `repeat(auto-fill, …)` in CSS
 * because two things need the number and CSS cannot hand it to either: the count
 * line, which prints it, and the expansion span, which must be clamped to it —
 * `grid-column: span 2` in a one-column grid pushes a second implicit column and
 * the grid stops being one column wide.
 */
export function columnsThatFit(
  containerWidthPx: number,
  minWidthPx: number,
  gapPx: number = CARD_GAP_PX,
): number {
  if (containerWidthPx <= 0) return 1;
  return Math.max(
    1,
    Math.floor((containerWidthPx + gapPx) / (minWidthPx + gapPx)),
  );
}

export interface CardGridMeasurement {
  /** The grid element's own content width, in CSS pixels, as measured. */
  containerWidthPx: number;
  /** How many columns of `minWidthPx` fit in it, by §2.0's formula. */
  columns: number;
  /** How wide a single card actually is: the columns share what is left after the gaps. */
  columnWidthPx: number;
}

/**
 * Measures the grid element and recomputes §2.0's column count whenever it
 * changes size. Used by the count line and by the expansion clamp; the visual
 * layout itself is still done by `repeat(auto-fill, minmax(min, 1fr))`, so the
 * two never disagree about where a card sits.
 */
export function useCardGridMeasurement(
  gridElement: RefObject<HTMLElement | null>,
  minWidthPx: number,
  gapPx: number = CARD_GAP_PX,
): CardGridMeasurement {
  const [containerWidthPx, setContainerWidthPx] = useState(0);

  useEffect(() => {
    const element = gridElement.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidthPx(entry.contentRect.width);
      }
    });
    observer.observe(element);
    setContainerWidthPx(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [gridElement]);

  const columns = columnsThatFit(containerWidthPx, minWidthPx, gapPx);
  return {
    containerWidthPx,
    columns,
    columnWidthPx:
      columns > 0
        ? (containerWidthPx - gapPx * (columns - 1)) / columns
        : containerWidthPx,
  };
}

/**
 * §2.0: "a card that expands takes `grid-column: span 2`, clamped to the column
 * count". Below two columns there is nothing to span, so it stays 1.
 */
export function expandedCardColumnSpan(columns: number): number {
  return Math.min(2, Math.max(1, columns));
}

/*
 * There is deliberately no function here that renders this geometry as a
 * sentence. The column count, the container width, the `--card-min` custom
 * property and the gap are how this app lays itself out; they say nothing about
 * the device, the contract or the host, so they are not printed to the reader.
 * The count line beside the grid bar states the counts and nothing else.
 */
