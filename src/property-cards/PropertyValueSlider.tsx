import { useEffect, useMemo, useRef } from "react";
import type { PropertyDescriptor } from "../transport";
import { OpInput } from "../ui/op";
import {
  decideSliderTrackScale,
  roundDraggedValueForTheProperty,
  sliderSnapPointsOf,
  snapDraggedValue,
  trackFractionOfValue,
  TRACK_POSITIONS,
  type SliderSnapPoint,
  type SliderTrackScale,
} from "./slider-track-scale";
import { numericSuggestedValues } from "./property-widget-shape";
import { SuggestedValuesDropdown } from "./SuggestedValuesDropdown";
import {
  draggedDraft,
  keystrokeCommitsTheDraft,
  keystrokeRevertsTheDraft,
  typedDraft,
  type PropertyDraft,
} from "./property-draft";

/**
 * A bounded numeric property: ONE value, TWO views, on ONE line.
 *
 *     [ 1000 ] Hz ▐──────●──────────▌
 *
 * The user's ruling, implemented literally: a numeric with BOTH min and max is a
 * slider whose number stays directly editable. The card says none of this in
 * prose — the reader can see a number and a track, and the quack strip names the
 * call the release makes.
 *
 * Four behaviours live in this file, none of them printed on the card:
 *
 * 1. One value, two views. The number field and the range share `draft` and
 *    `hostValue`; typing 700 moves the handle just as dragging fills the field.
 *
 * 2. No write per pixel. The range's continuous `input` event only ever calls
 *    `onDraftChange`. The write is fired from the native `change` event, which a
 *    range input fires once, on release — mouse, touch or keyboard. React's own
 *    `onChange` is wired to `input` for a range and would therefore fire per
 *    pixel, which is exactly the defect the ruling names (and which wedges the
 *    C++ host on NumberOfChannels = 4096), so the commit listener is attached
 *    natively rather than through React. That is the one piece of machinery here
 *    and it is the reason this file exists.
 *
 * 3. The handle follows the DEVICE. The settled position is
 *    `trackFractionOfValue(scale, hostValue)` — the value the host reports,
 *    after any coercion. A drag moves it meanwhile, and the device's own value
 *    stays drawn on the track as a separate mark. On release the draft is
 *    dropped and the handle takes whatever came back. When `precheck` refuses a
 *    draft, nothing is sent and the device never moved, so the handle falls back
 *    to `hostValue` while the number field keeps the refused text, marked
 *    aria-invalid.
 *
 * 4. `suggested_values` are snap points on the track AND a list beside the
 *    number field, so a suggestion can be dragged onto, typed, or picked by
 *    name — the ruling's "type into OR pick from", not snap points alone.
 */

/** Half the thumb's width, so a tick at fraction f lines up with the handle at f. */
const THUMB_WIDTH_PX = 12;

function trackOffsetStyle(fraction: number): { left: string } {
  return {
    left: `calc(${THUMB_WIDTH_PX / 2}px + (100% - ${THUMB_WIDTH_PX}px) * ${fraction})`,
  };
}

export function PropertyValueSlider({
  descriptor,
  min,
  max,
  hostValue,
  draft,
  disabled,
  onDraftChange,
  onCommit,
  precheckRefusal,
  unit,
}: {
  descriptor: PropertyDescriptor;
  min: number;
  max: number;
  /** What the HOST reports. The settled handle position and the device mark. */
  hostValue: unknown;
  draft: PropertyDraft | null;
  disabled: boolean;
  onDraftChange: (draft: PropertyDraft | null) => void;
  /** Called exactly once per commit. Never from a drag in progress. */
  onCommit: (value: unknown) => void;
  precheckRefusal: string | null;
  unit: string | null;
}) {
  const scale = useMemo(
    () => decideSliderTrackScale(descriptor, min, max),
    [descriptor, min, max],
  );
  const snapPoints = useMemo(
    () => sliderSnapPointsOf(descriptor, scale),
    [descriptor, scale],
  );
  const suggestedNumbers = useMemo(
    () => numericSuggestedValues(descriptor),
    [descriptor],
  );

  const hostNumber = typeof hostValue === "number" ? hostValue : null;
  const draftNumber =
    draft !== null && typeof draft.parsed === "number" ? draft.parsed : null;
  const shownNumber = draftNumber ?? hostNumber;
  const shownText = draft !== null ? draft.text : hostNumber === null ? "" : String(hostNumber);

  // The draft holds a value `precheck` refuses, so no frame was sent and the
  // device still holds hostValue. The handle takes the DEVICE's position; the
  // number field keeps the refused text.
  const theDraftIsAValueTheDeviceWasNeverSent = precheckRefusal !== null;
  const handleNumber = theDraftIsAValueTheDeviceWasNeverSent
    ? hostNumber
    : shownNumber;

  const handleFraction =
    handleNumber === null ? 0 : trackFractionOfValue(scale, handleNumber);
  const deviceFraction =
    hostNumber === null ? null : trackFractionOfValue(scale, hostNumber);

  // The commit listener. It reads the draft through a ref because the listener
  // is attached once and the draft changes on every pixel of a drag; re-attaching
  // it per render would drop the `change` that is already on its way.
  const commitTheCurrentDraft = useRef<() => void>(() => {});
  commitTheCurrentDraft.current = () => {
    if (draft === null) return;
    if (draft.parsed === null) return;
    onCommit(draft.parsed);
  };

  const trackHolder = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    // OpInput is a function component whose props are InputHTMLAttributes, which
    // carries no `ref`, so the range element is found by looking inside this
    // widget's own subtree rather than by threading a ref through the shared
    // component every control in the app uses.
    const range = trackHolder.current?.querySelector<HTMLInputElement>(
      'input[type="range"]',
    );
    if (!range) return;
    const commit = () => commitTheCurrentDraft.current();
    range.addEventListener("change", commit);
    return () => range.removeEventListener("change", commit);
  }, []);

  const draggedTo = (positionOnTheTrack: number) => {
    const fraction = positionOnTheTrack / TRACK_POSITIONS;
    const snapped = snapDraggedValue(scale, fraction, snapPoints);
    const value = roundDraggedValueForTheProperty(descriptor, snapped.value);
    onDraftChange(draggedDraft(String(value), value));
  };

  const typedInTheNumberField = (text: string) => {
    const parsed = Number(text);
    if (text.trim().length === 0 || Number.isNaN(parsed)) {
      onDraftChange(
        typedDraft(
          text,
          null,
          `"${text}" is not a number; ${descriptor.id} is a ${descriptor.value_type} in [${min}, ${max}]`,
        ),
      );
      return;
    }
    onDraftChange(typedDraft(text, parsed));
  };

  const commitTheTypedNumber = () => {
    if (draft === null || draft.parsed === null) return;
    onCommit(draft.parsed);
  };

  return (
    <span className="property-slider" ref={trackHolder}>
      <OpInput
        op={["property.write"]}
        className="property-slider-number"
        type="number"
        inputMode="decimal"
        disabled={disabled}
        step={descriptor.value_type === "int" ? 1 : "any"}
        min={min}
        max={max}
        value={shownText}
        aria-label={descriptor.name}
        aria-invalid={precheckRefusal !== null ? true : undefined}
        data-uncommitted={draft !== null ? "true" : undefined}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => typedInTheNumberField(e.currentTarget.value)}
        onBlur={() => commitTheTypedNumber()}
        onKeyDown={(e) => {
          if (keystrokeCommitsTheDraft(e)) {
            e.preventDefault();
            commitTheTypedNumber();
          } else if (keystrokeRevertsTheDraft(e)) {
            e.preventDefault();
            onDraftChange(null);
          }
        }}
      />
      {suggestedNumbers.length > 0 && (
        <SuggestedValuesDropdown
          propertyName={descriptor.name}
          suggestions={suggestedNumbers.map(String)}
          currentText={shownText}
          disabled={disabled}
          onPick={(suggestion) => onCommit(Number(suggestion))}
        />
      )}
      {unit !== null && <span className="property-value-unit">{unit}</span>}

      <span className="property-slider-track-holder">
        <OpInput
          op={["property.write"]}
          className="property-slider-range"
          type="range"
          disabled={disabled}
          min={0}
          max={TRACK_POSITIONS}
          step={1}
          value={Math.round(handleFraction * TRACK_POSITIONS)}
          aria-label={`${descriptor.name}, ${min} to ${max}`}
          aria-valuetext={
            handleNumber === null
              ? "no value"
              : `${handleNumber}${unit === null ? "" : " " + unit}`
          }
          data-uncommitted={
            draft !== null && !theDraftIsAValueTheDeviceWasNeverSent
              ? "true"
              : undefined
          }
          data-showing-the-device-value-after-a-refusal={
            theDraftIsAValueTheDeviceWasNeverSent ? "true" : undefined
          }
          title={`${descriptor.name}: ${min} to ${max}${unit === null ? "" : " " + unit}`}
          onClick={(e) => e.stopPropagation()}
          // The continuous event. It moves LOCAL STATE and nothing else: this
          // line is the whole of the user's "a drag must not write per pixel".
          onChange={(e) => draggedTo(Number(e.currentTarget.value))}
          onKeyDown={(e) => {
            if (keystrokeRevertsTheDraft(e)) {
              e.preventDefault();
              onDraftChange(null);
            }
          }}
        />

        <span className="property-slider-marks" aria-hidden="true">
          {deviceFraction !== null && (
            <span
              className="property-slider-device-mark"
              style={trackOffsetStyle(deviceFraction)}
              title={`the device holds ${hostNumber}${unit === null ? "" : " " + unit}`}
            />
          )}
          {snapPoints.map((point) => (
            <SnapTick
              key={`${point.origin}:${point.value}`}
              point={point}
              scale={scale}
              unit={unit}
            />
          ))}
        </span>
      </span>
    </span>
  );
}

/** `default` and each `suggested_values` entry, drawn on the track and named on hover. */
function SnapTick({
  point,
  scale,
  unit,
}: {
  point: SliderSnapPoint;
  scale: SliderTrackScale;
  unit: string | null;
}) {
  const fraction = trackFractionOfValue(scale, point.value);
  return (
    <span
      className={`property-slider-tick property-slider-tick--${
        point.origin === "default" ? "default" : "suggested"
      }`}
      style={trackOffsetStyle(fraction)}
      title={`${point.origin} ${point.value}${unit === null ? "" : " " + unit}`}
    />
  );
}
