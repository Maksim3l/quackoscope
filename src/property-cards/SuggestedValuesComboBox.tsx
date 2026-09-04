import { useEffect, useRef } from "react";
import { OpInput } from "../ui/op";
import { SuggestedValuesDropdown } from "./SuggestedValuesDropdown";
import {
  keystrokeCommitsTheDraft,
  keystrokeRevertsTheDraft,
  typedDraft,
  type PropertyDraft,
} from "./property-draft";

/**
 * A string property whose descriptor carries `suggested_values`: TYPE a value,
 * or PICK one of the suggestions.
 *
 * The reference's `_make_combobox(editable=True)`, state 'normal', style
 * 'Editable.TCombobox' — the editor it places over the value cell on a
 * double-click when the descriptor has suggested values.
 */
export function SuggestedValuesComboBox({
  propertyName,
  suggestions,
  shownText,
  disabled,
  invalid,
  uncommitted,
  onDraftChange,
  onCommitText,
  onLeaveTheEditor,
}: {
  propertyName: string;
  suggestions: readonly string[];
  shownText: string;
  disabled: boolean;
  invalid: boolean;
  uncommitted: boolean;
  onDraftChange: (draft: PropertyDraft | null) => void;
  /** Commit whatever text is in the field, typed or picked. */
  onCommitText: (text: string) => void;
  onLeaveTheEditor: () => void;
}) {
  const holder = useRef<HTMLSpanElement | null>(null);

  // OpInput's props are InputHTMLAttributes, which carry no `ref`, so the field
  // is found inside this widget's own subtree rather than by threading a ref
  // through the shared control every input in the app is built from.
  useEffect(() => {
    const field = holder.current?.querySelector<HTMLInputElement>(
      "input.property-combo-field",
    );
    field?.focus();
    field?.select();
  }, []);

  return (
    <span
      className="property-combo"
      ref={holder}
      onBlur={(event) => {
        // Moving between the field, the arrow and an option is not leaving.
        if (holder.current?.contains(event.relatedTarget as globalThis.Node | null)) {
          return;
        }
        onLeaveTheEditor();
      }}
    >
      <OpInput
        op={["property.write"]}
        className="property-combo-field"
        type="text"
        role="combobox"
        aria-label={propertyName}
        aria-invalid={invalid ? true : undefined}
        data-uncommitted={uncommitted ? "true" : undefined}
        disabled={disabled}
        value={shownText}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) =>
          onDraftChange(typedDraft(e.currentTarget.value, e.currentTarget.value))
        }
        onKeyDown={(e) => {
          if (keystrokeCommitsTheDraft(e)) {
            e.preventDefault();
            onCommitText(e.currentTarget.value);
          } else if (keystrokeRevertsTheDraft(e)) {
            e.preventDefault();
            onDraftChange(null);
            onLeaveTheEditor();
          }
        }}
      />
      <SuggestedValuesDropdown
        propertyName={propertyName}
        suggestions={suggestions}
        currentText={shownText}
        disabled={disabled}
        onPick={(suggestion) => onCommitText(suggestion)}
      />
    </span>
  );
}
