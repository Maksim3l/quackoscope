import type { PropertyDescriptor } from "../transport";
import { numericSuggestedValues } from "./property-widget-shape";

/**
 * How a bounded numeric property's slider track maps track position to value.
 *
 * The user's ruling, which this file exists to obey:
 *
 *   "A linear track is useless on a wide range (GlobalSampleRate is min 1, max
 *    1000000). Decide the track's scale per descriptor."
 *
 * So the scale is a decision, made here, from the descriptor alone. It used to
 * come with a `reason` sentence that the card printed on its face; the user
 * called that an info dump, and they were right — a reader wants the value, not
 * an essay about the track under it. The decision stayed; the sentence went.
 *
 * Three scales, and no others:
 *
 *   linear                  value = min + f * (max - min)
 *   logarithmic             min > 0, so log is defined across the whole range
 *   logarithmic-from-zero   min = 0, so the log is taken of (value + offset)
 *                           with a positive offset that puts 0 at f = 0
 *
 * Everything below is pure: no React, no DOM, no descriptor mutation.
 */

/**
 * A range spanning two decades or more earns a logarithmic track. At 100x, a
 * linear track gives the whole bottom decade 1 % of its length — one pixel in
 * a hundred — which is what "useless on a wide range" means concretely.
 */
export const DYNAMIC_RANGE_THAT_EARNS_A_LOGARITHMIC_TRACK = 100;

/**
 * With min = 0 there is no ratio to take, so the test is how many of the
 * property's own smallest steps fit in the range. A thousand steps or more and
 * a 300 px track cannot address the low end at all: 1 px is 33 steps.
 */
export const STEP_COUNT_THAT_EARNS_A_LOGARITHMIC_TRACK_FROM_ZERO = 1000;

export type SliderTrackScaleKind =
  | "linear"
  | "logarithmic"
  | "logarithmic-from-zero";

export interface SliderTrackScale {
  kind: SliderTrackScaleKind;
  min: number;
  max: number;
  /**
   * Only for `logarithmic-from-zero`: the positive offset added before the
   * logarithm, so that value 0 maps to track fraction 0. It is the property's
   * own smallest meaningful step, never an arbitrary epsilon.
   */
  offset: number;
}

/**
 * The smallest step the property can meaningfully move by.
 *
 * An int moves by 1 and there is nothing to guess. A float has no declared step,
 * so the descriptor's own numbers are asked in order: the smallest positive
 * magnitude among `suggested_values`, then the default, then a thousandth of the
 * range. Each is a real number the host published about this property; none of
 * them is a constant chosen because it looked small.
 */
export function smallestMeaningfulStepOf(descriptor: PropertyDescriptor): number {
  if (descriptor.value_type === "int") return 1;
  const positiveSuggestions = numericSuggestedValues(descriptor).filter(
    (each) => each > 0,
  );
  if (positiveSuggestions.length > 0) return Math.min(...positiveSuggestions);
  if (typeof descriptor.default === "number" && descriptor.default > 0) {
    return descriptor.default / 10;
  }
  const span = (descriptor.max ?? 1) - (descriptor.min ?? 0);
  return span > 0 ? span / 1000 : 1;
}

/**
 * The per-descriptor decision the user asked for.
 *
 * `min` and `max` are taken from the caller rather than re-read from the
 * descriptor, because the only caller is the widget shape that already proved
 * both are present and finite and max > min.
 */
export function decideSliderTrackScale(
  descriptor: PropertyDescriptor,
  min: number,
  max: number,
): SliderTrackScale {
  const span = max - min;

  // A range that crosses or touches negative values has no logarithm. Say so
  // rather than reaching for a signed-log that would put the handle somewhere
  // no reader could predict.
  if (min < 0) {
    return {
      kind: "linear",
      min,
      max,
      offset: 0,
    };
  }

  if (min > 0) {
    const dynamicRange = max / min;
    if (dynamicRange >= DYNAMIC_RANGE_THAT_EARNS_A_LOGARITHMIC_TRACK) {
      return {
        kind: "logarithmic",
        min,
        max,
        offset: 0,
      };
    }
    return {
      kind: "linear",
      min,
      max,
      offset: 0,
    };
  }

  // min === 0.
  const step = smallestMeaningfulStepOf(descriptor);
  const stepCount = span / step;
  if (stepCount >= STEP_COUNT_THAT_EARNS_A_LOGARITHMIC_TRACK_FROM_ZERO) {
    return {
      kind: "logarithmic-from-zero",
      min,
      max,
      offset: step,
    };
  }
  return {
    kind: "linear",
    min,
    max,
    offset: 0,
  };
}

/** Track fraction (0 at the left end, 1 at the right) -> the value under the handle. */
export function valueAtTrackFraction(
  scale: SliderTrackScale,
  fraction: number,
): number {
  const clamped = Math.min(1, Math.max(0, fraction));
  switch (scale.kind) {
    case "linear":
      return scale.min + clamped * (scale.max - scale.min);
    case "logarithmic":
      return scale.min * Math.pow(scale.max / scale.min, clamped);
    case "logarithmic-from-zero":
      return (
        scale.offset *
        (Math.pow(1 + (scale.max - scale.min) / scale.offset, clamped) - 1) +
        scale.min
      );
  }
}

/** A value -> where its handle sits on the track. The exact inverse of the above. */
export function trackFractionOfValue(
  scale: SliderTrackScale,
  value: number,
): number {
  const clamped = Math.min(scale.max, Math.max(scale.min, value));
  switch (scale.kind) {
    case "linear":
      return scale.max === scale.min
        ? 0
        : (clamped - scale.min) / (scale.max - scale.min);
    case "logarithmic":
      return (
        Math.log(clamped / scale.min) / Math.log(scale.max / scale.min)
      );
    case "logarithmic-from-zero":
      return (
        Math.log(1 + (clamped - scale.min) / scale.offset) /
        Math.log(1 + (scale.max - scale.min) / scale.offset)
      );
  }
}

/**
 * How many positions the `<input type="range">` under the track offers.
 *
 * The input's own value is the FRACTION, in these steps, never the property's
 * value: that is what makes one input serve all three scales without the input
 * knowing which one it is on. 1000 positions is finer than any track this app
 * draws is wide, so the scale, not the input, is what limits resolution.
 */
export const TRACK_POSITIONS = 1000;

/**
 * Snap points, per the user's ruling that "suggested_values become snap points
 * or ticks". The default joins them, because §1.8's card anatomy prints the
 * default on the meta line and §2.2's slider marks it on the track — a mark you
 * cannot land on exactly is a tease.
 *
 * Returned sorted, de-duplicated, and clipped to the track's own range: a
 * suggested value outside [min, max] is the host's inconsistency and drawing it
 * off the end of the track would hide that rather than show it, so it is
 * dropped and reported by the caller's count.
 */
export interface SliderSnapPoint {
  value: number;
  /** `suggested value` or `default` — printed under the tick. */
  origin: "suggested value" | "default";
}

export function sliderSnapPointsOf(
  descriptor: PropertyDescriptor,
  scale: SliderTrackScale,
): SliderSnapPoint[] {
  const points = new Map<number, SliderSnapPoint>();
  if (
    typeof descriptor.default === "number" &&
    Number.isFinite(descriptor.default) &&
    descriptor.default >= scale.min &&
    descriptor.default <= scale.max
  ) {
    points.set(descriptor.default, {
      value: descriptor.default,
      origin: "default",
    });
  }
  for (const value of numericSuggestedValues(descriptor)) {
    if (value < scale.min || value > scale.max) continue;
    // A suggested value that IS the default keeps the default's label: the mark
    // on the track answers "what does this device start at", which is the more
    // useful of the two facts.
    if (!points.has(value)) {
      points.set(value, { value, origin: "suggested value" });
    }
  }
  return [...points.values()].sort((a, b) => a.value - b.value);
}

/**
 * How close, as a fraction of the track's length, a dragged handle has to come
 * to a snap point before it lands on it exactly. 1.5 % of a 300 px track is
 * about 4 px, which is inside the handle itself.
 */
export const SNAP_DISTANCE_AS_A_FRACTION_OF_THE_TRACK = 0.015;

/**
 * The value a drag at this track fraction should take: the snap point it is
 * within reach of, or the raw value under the handle.
 */
export function snapDraggedValue(
  scale: SliderTrackScale,
  fraction: number,
  snapPoints: readonly SliderSnapPoint[],
): { value: number; snappedTo: SliderSnapPoint | null } {
  let nearest: SliderSnapPoint | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const point of snapPoints) {
    const distance = Math.abs(trackFractionOfValue(scale, point.value) - fraction);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = point;
    }
  }
  if (
    nearest !== null &&
    nearestDistance <= SNAP_DISTANCE_AS_A_FRACTION_OF_THE_TRACK
  ) {
    return { value: nearest.value, snappedTo: nearest };
  }
  return { value: valueAtTrackFraction(scale, fraction), snappedTo: null };
}

/**
 * A dragged value rounded to what the property can actually hold: an int holds
 * integers, and a float coming off a logarithmic track carries fifteen digits
 * nobody asked for. Four significant figures is finer than the track can
 * address and is what gets written.
 */
export function roundDraggedValueForTheProperty(
  descriptor: PropertyDescriptor,
  value: number,
): number {
  if (descriptor.value_type === "int") return Math.round(value);
  if (value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.max(0, 3 - magnitude);
  return Number(value.toFixed(Math.min(12, decimals)));
}
