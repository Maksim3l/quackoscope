import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PropertyDescriptor } from "../transport";
import { OpInput, OpSelect } from "../ui/op";
import { decidePropertyWidgetShape } from "./property-widget-shape";
import { PropertyValueSlider } from "./PropertyValueSlider";
import { PropertyValueSwitch } from "./PropertyValueSwitch";
import { SuggestedValuesComboBox } from "./SuggestedValuesComboBox";
import { precheck } from "./precheck-a-value-against-its-descriptor";
import {
  hostValueAsText,
  keystrokeCommitsTheDraft,
  keystrokeRevertsTheDraft,
  typedDraft,
  type PropertyDraft,
} from "./property-draft";
import type { ContainerPath } from "./nested-container-path";

/**
 * The value cell of a property card: the reference's `value` column, rebuilt.
 *
 * generic_properties_treeview.py does not keep a live control in every row. The
 * row shows text; a DOUBLE-CLICK on a row that is not read_only places an
 * overlay editor over the cell's bbox, and the editor is chosen by what the
 * descriptor is:
 *
 *   selection_values  ->  _make_combobox(editable=False) — pick only
 *   suggested_values  ->  _make_combobox(editable=True)  — pick OR type
 *   bool              ->  a Checkbutton overlay
 *   struct            ->  an Entry overlay
 *
 * That is reconstructed here, with the user's two rulings overriding it where
 * they differ: a bool is a SWITCH and a numeric with both bounds is a SLIDER
 * with the number still editable. Those two are direct controls rather than
 * overlays, because a switch you must double-click first is not a switch.
 *
 * Everything else rests as text and becomes an editor when double-clicked, which
 * is what makes a card three lines tall instead of ten.
 */

export function PropertyValueCell({
  descriptor,
  value,
  disabled,
  draft,
  precheckRefusal,
  onDraftChange,
  onCommit,
  onNavigateIntoNestedContainer,
  showUnit,
}: {
  descriptor: PropertyDescriptor;
  value: unknown;
  disabled: boolean;
  draft: PropertyDraft | null;
  precheckRefusal: string | null;
  onDraftChange: (draft: PropertyDraft | null) => void;
  onCommit: (value: unknown) => void;
  onNavigateIntoNestedContainer: (
    descriptor: PropertyDescriptor,
    path: ContainerPath,
  ) => void;
  /** §2.9's chooser: whether the descriptor's `unit` rides beside the value. */
  showUnit: boolean;
}) {
  const d = descriptor;
  const shape = decidePropertyWidgetShape(d);
  const [editing, setEditing] = useState(false);
  const shownText = draft !== null ? draft.text : hostValueAsText(value);
  const unit = showUnit ? d.unit : null;

  // The reference binds <Double-1> only when the property is not read_only
  // (generic_properties_treeview.py line 70-72). A refused value keeps the
  // editor open, because §1.8's out-of-range row says the input keeps the typed
  // text — closing it would throw away the very thing the reader must correct.
  const leaveTheEditor = () => setEditing(false);
  const commitAndCloseUnlessRefused = (candidate: unknown) => {
    onCommit(candidate);
    if (precheck(d, candidate) === null) setEditing(false);
  };

  if (d.read_only || shape.kind === "selection-with-one-option-is-read-only") {
    const text =
      shape.kind === "selection-with-one-option-is-read-only"
        ? shape.onlyOption
        : hostValueAsText(value);
    return (
      <span className="property-value property-value--read-only">
        <span className="property-value-lock" aria-hidden="true">
          🔒
        </span>
        <span className="mono property-value-text">{text}</span>
        {unit !== null && <span className="property-value-unit">{unit}</span>}
      </span>
    );
  }

  switch (shape.kind) {
    // --- the user's two rulings: direct controls, not overlays ---------------
    case "switch":
      return (
        <PropertyValueSwitch
          propertyName={d.name}
          propertyId={d.id}
          value={value}
          disabled={disabled}
          onCommit={onCommit}
        />
      );

    case "bounded-number-on-a-slider":
      return (
        <PropertyValueSlider
          descriptor={d}
          min={shape.min}
          max={shape.max}
          hostValue={value}
          draft={draft}
          disabled={disabled}
          onDraftChange={onDraftChange}
          onCommit={onCommit}
          precheckRefusal={precheckRefusal}
          unit={unit}
        />
      );

    // --- struct: the container is a board of its own, reached from the cell ---
    case "container-rows":
      return (
        <button
          type="button"
          className="property-value property-value--container"
          disabled={disabled}
          title={`open ${d.name} as its own board`}
          onClick={(event) => {
            event.stopPropagation();
            onNavigateIntoNestedContainer(d, []);
          }}
        >
          <span className="mono property-value-text">{shownText || "{}"}</span>
          <span className="property-value-container-arrow" aria-hidden="true">
            ›
          </span>
        </button>
      );

    // --- everything else: text at rest, an editor on double-click ------------
    default:
      break;
  }

  if (!editing) {
    // A selection's value on the wire may be the index or the label; the cell
    // shows the LABEL either way, because "0" is not what the device is set to.
    const restingText =
      shape.kind === "selection-list" && typeof value === "number"
        ? (shape.options[value] ?? shownText)
        : shownText;
    return (
      <RestingValue
        propertyName={d.name}
        text={restingText}
        unit={unit}
        uncommitted={draft !== null}
        invalid={precheckRefusal !== null}
        disabled={disabled}
        onOpenTheEditor={() => setEditing(true)}
      />
    );
  }

  switch (shape.kind) {
    case "selection-list": {
      // The wire contract does not fix whether a selection value is the index or
      // the label, so echo back whatever shape the host currently reports.
      const useIndex = typeof value === "number";
      const current = useIndex
        ? String(value)
        : String(shape.options.indexOf(String(value ?? "")));
      return (
        <AutoFocusedEditor className="property-value-editor">
          <OpSelect
            op={["property.write"]}
            className="property-value-select"
            disabled={disabled}
            value={current}
            aria-label={d.name}
            onBlur={leaveTheEditor}
            onChange={(e) => {
              const index = Number(e.currentTarget.value);
              commitAndCloseUnlessRefused(useIndex ? index : shape.options[index]);
            }}
            onKeyDown={(e) => {
              if (keystrokeRevertsTheDraft(e)) leaveTheEditor();
            }}
          >
            {current === "-1" && (
              <option value="-1">{hostValueAsText(value)}</option>
            )}
            {shape.options.map((label, i) => (
              <option key={`${label}:${i}`} value={String(i)}>
                {label}
              </option>
            ))}
          </OpSelect>
        </AutoFocusedEditor>
      );
    }

    case "text-with-suggested-values":
      return (
        <SuggestedValuesComboBox
          propertyName={d.name}
          suggestions={shape.suggestions}
          shownText={shownText}
          disabled={disabled}
          invalid={precheckRefusal !== null}
          uncommitted={draft !== null}
          onDraftChange={onDraftChange}
          onCommitText={(text) => commitAndCloseUnlessRefused(text)}
          onLeaveTheEditor={leaveTheEditor}
        />
      );

    case "number-without-both-bounds":
      return (
        <AutoFocusedEditor className="property-value-editor">
          <OpInput
            op={["property.write"]}
            className="property-value-field"
            type="number"
            inputMode="decimal"
            disabled={disabled}
            step={d.value_type === "int" ? 1 : "any"}
            min={d.min ?? undefined}
            max={d.max ?? undefined}
            value={shownText}
            aria-label={d.name}
            aria-invalid={precheckRefusal !== null ? true : undefined}
            data-uncommitted={draft !== null ? "true" : undefined}
            onChange={(e) => {
              const text = e.currentTarget.value;
              const parsed = Number(text);
              onDraftChange(
                text.trim().length === 0 || Number.isNaN(parsed)
                  ? typedDraft(
                      text,
                      null,
                      `"${text}" is not a number; ${d.id} is a ${d.value_type}`,
                    )
                  : typedDraft(text, parsed),
              );
            }}
            onBlur={() => {
              if (draft !== null && draft.parsed !== null) onCommit(draft.parsed);
              leaveTheEditor();
            }}
            onKeyDown={(e) => {
              if (keystrokeCommitsTheDraft(e)) {
                e.preventDefault();
                if (draft !== null && draft.parsed !== null) {
                  commitAndCloseUnlessRefused(draft.parsed);
                } else {
                  leaveTheEditor();
                }
              } else if (keystrokeRevertsTheDraft(e)) {
                e.preventDefault();
                onDraftChange(null);
                leaveTheEditor();
              }
            }}
          />
          {unit !== null && <span className="property-value-unit">{unit}</span>}
        </AutoFocusedEditor>
      );

    case "text":
      return (
        <AutoFocusedEditor className="property-value-editor">
          <OpInput
            op={["property.write"]}
            className="property-value-field"
            type="text"
            disabled={disabled}
            value={shownText}
            aria-label={d.name}
            data-uncommitted={draft !== null ? "true" : undefined}
            onChange={(e) =>
              onDraftChange(
                typedDraft(e.currentTarget.value, e.currentTarget.value),
              )
            }
            onBlur={() => {
              if (draft !== null) onCommit(draft.text);
              leaveTheEditor();
            }}
            onKeyDown={(e) => {
              if (keystrokeCommitsTheDraft(e)) {
                e.preventDefault();
                if (draft !== null) commitAndCloseUnlessRefused(draft.text);
                else leaveTheEditor();
              } else if (keystrokeRevertsTheDraft(e)) {
                e.preventDefault();
                onDraftChange(null);
                leaveTheEditor();
              }
            }}
          />
        </AutoFocusedEditor>
      );

    default:
      // switch, slider, container and read-only all returned above; nothing
      // reaches here, and if a new shape is added TypeScript says so.
      return null;
  }
}

/**
 * The resting cell. Double-click opens the editor, which is the reference's
 * binding; Enter and F2 do the same from a keyboard, because <Double-1> is not
 * reachable without a pointer.
 */
function RestingValue({
  propertyName,
  text,
  unit,
  uncommitted,
  invalid,
  disabled,
  onOpenTheEditor,
}: {
  propertyName: string;
  text: string;
  unit: string | null;
  uncommitted: boolean;
  invalid: boolean;
  disabled: boolean;
  onOpenTheEditor: () => void;
}) {
  return (
    <span
      className="property-value property-value--resting"
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled ? true : undefined}
      aria-label={`${propertyName}: ${text === "" ? "empty" : text}`}
      data-uncommitted={uncommitted ? "true" : undefined}
      data-invalid={invalid ? "true" : undefined}
      title={`${propertyName} — double-click to edit`}
      onDoubleClick={(event) => {
        if (disabled) return;
        event.stopPropagation();
        onOpenTheEditor();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Enter" || event.key === "F2") {
          event.preventDefault();
          onOpenTheEditor();
        }
      }}
    >
      <span className="mono property-value-text">
        {text === "" ? " " : text}
      </span>
      {unit !== null && <span className="property-value-unit">{unit}</span>}
    </span>
  );
}

/** Puts the caret in the editor the moment it replaces the resting text. */
function AutoFocusedEditor({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const holder = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const control = holder.current?.querySelector<
      HTMLInputElement | HTMLSelectElement
    >("input, select");
    control?.focus();
    if (control instanceof HTMLInputElement) control.select();
  }, []);
  return (
    <span className={className} ref={holder} onClick={(e) => e.stopPropagation()}>
      {children}
    </span>
  );
}
