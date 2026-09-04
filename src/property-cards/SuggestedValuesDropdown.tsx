import { useState } from "react";

/**
 * The PICK half of `suggested_values`: an arrow beside a field, and the
 * descriptor's own suggestions under it.
 *
 * `suggested_values` is a suggestion, not a constraint — a value outside the
 * list is legal — so it is always offered beside a field that stays free to
 * type into. That is the difference the reference draws between its two
 * comboboxes, `Selection.TCombobox` (readonly: pick only) and
 * `Editable.TCombobox` (normal: pick OR type), and it is the half this app was
 * missing: suggested_values used to be snap points on a slider track and
 * nothing else, which offers no way to choose one by name.
 *
 * The list is the app's own rather than a `<datalist>`, because a datalist's
 * popup is the browser's: it opens only on some gestures, it cannot be styled to
 * match, and it appears in neither a screenshot nor a driven test.
 */
export function SuggestedValuesDropdown({
  propertyName,
  suggestions,
  currentText,
  disabled,
  onPick,
}: {
  propertyName: string;
  /** `suggested_values`, as the strings the list offers. */
  suggestions: readonly string[];
  currentText: string;
  disabled: boolean;
  onPick: (suggestion: string) => void;
}) {
  const [listIsOpen, setListIsOpen] = useState(false);

  return (
    <span className="property-suggestions">
      <button
        type="button"
        className="property-suggestions-arrow"
        aria-expanded={listIsOpen}
        aria-label={`${suggestions.length} suggested values for ${propertyName}: ${suggestions.join(", ")}`}
        title={`suggested values for ${propertyName}: ${suggestions.join(", ")}`}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          setListIsOpen((open) => !open);
        }}
      >
        ▾
      </button>

      {listIsOpen && (
        <ul
          className="property-suggestions-list"
          role="listbox"
          aria-label={`suggested values for ${propertyName}`}
        >
          {suggestions.map((suggestion) => (
            <li key={suggestion}>
              <button
                type="button"
                className="property-suggestions-option mono"
                role="option"
                aria-selected={suggestion === currentText}
                data-suggested-value={suggestion}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  setListIsOpen(false);
                  onPick(suggestion);
                }}
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
