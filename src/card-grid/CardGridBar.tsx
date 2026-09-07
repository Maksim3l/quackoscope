import { useState } from "react";
import type { CardGridField } from "./card-grid-model";
import { filterPlaceholder } from "./card-grid-model";
import {
  HOST_ORDER_SORT_ID,
  type CardGridRenderer,
  type CardGridViewPreferences,
} from "./card-grid-view-preferences";

/**
 * The grid bar of the design specification's §1.9 — what replaces column
 * headers, sorting and scanning when a table becomes a grid.
 *
 *   [ filter…                 ×]  sort: name ▾   fields ▾   ▦ cards ▤ rows   show hidden
 *   31 properties · 24 shown · 3 read-only · 1 out of range · 2 gapped
 *
 * Six things, and the sixth is not decoration: the count line prints literal
 * counts of every state in §1.8, so "is anything wrong on this component" is one
 * line of text, which no table of 60 rows gives you.
 *
 * The bar carries `data-quack-chrome`. Filtering, sorting, choosing fields and
 * switching renderer are client-side view state; not one of them reaches the
 * socket, so none of them has an openDAQ call to show and none should answer a
 * quack with an empty flock.
 */

export interface CardGridBarProps<T> {
  entityNounPlural: string;
  fields: readonly CardGridField<T>[];
  /** §1.9 item 2: the host's own order, named. "descriptor order" for properties. */
  hostOrderLabel: string;
  preferences: CardGridViewPreferences;
  onPreferencesChange: (next: CardGridViewPreferences) => void;
  filterText: string;
  onFilterTextChange: (next: string) => void;
  /** Already assembled by the grid, printed verbatim. */
  countLine: string;
  /**
   * §2.9: each field chip shows "the field name and a one-line example value
   * from the current node". Null when no item is in the grid to take one from.
   */
  exampleValueOfField: (fieldId: string) => string | null;
}

export function CardGridBar<T>({
  entityNounPlural,
  fields,
  hostOrderLabel,
  preferences,
  onPreferencesChange,
  filterText,
  onFilterTextChange,
  countLine,
  exampleValueOfField,
}: CardGridBarProps<T>) {
  const [fieldsChooserOpen, setFieldsChooserOpen] = useState(false);

  const setRenderer = (renderer: CardGridRenderer) =>
    onPreferencesChange({ ...preferences, renderer });

  const toggleFieldOnTheCardFace = (fieldId: string) => {
    const on = preferences.fieldIdsOnTheCardFace.includes(fieldId);
    onPreferencesChange({
      ...preferences,
      // Toggling is the commit (§2.9): the reference's Save button existed only
      // to close a modal, and there is no modal here.
      fieldIdsOnTheCardFace: on
        ? preferences.fieldIdsOnTheCardFace.filter((each) => each !== fieldId)
        : [...preferences.fieldIdsOnTheCardFace, fieldId],
    });
  };

  return (
    <div className="card-grid-bar" data-quack-chrome="">
      <div className="card-grid-bar-controls">
        <div className="card-grid-filter">
          <input
            type="search"
            className="card-grid-filter-input"
            placeholder={filterPlaceholder(entityNounPlural, fields)}
            value={filterText}
            onChange={(event) => onFilterTextChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onFilterTextChange("");
              }
            }}
          />
          {filterText.length > 0 && (
            <button
              type="button"
              className="card-grid-filter-clear"
              data-quack-chrome=""
              title={`clear the filter "${filterText}"`}
              onClick={() => onFilterTextChange("")}
            >
              ×
            </button>
          )}
        </div>

        <label className="card-grid-bar-label">
          sort
          <select
            className="card-grid-sort"
            value={preferences.sortId}
            onChange={(event) =>
              onPreferencesChange({
                ...preferences,
                sortId: event.currentTarget.value,
              })
            }
          >
            <option value={HOST_ORDER_SORT_ID}>{hostOrderLabel}</option>
            {fields.map((field) => (
              <option key={field.id} value={field.id}>
                {field.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="card-grid-sort-direction mono"
            data-quack-chrome=""
            title={
              preferences.sortDirection === "ascending"
                ? "sorting ascending — click to sort descending"
                : "sorting descending — click to sort ascending"
            }
            onClick={() =>
              onPreferencesChange({
                ...preferences,
                sortDirection:
                  preferences.sortDirection === "ascending"
                    ? "descending"
                    : "ascending",
              })
            }
          >
            {preferences.sortDirection === "ascending" ? "▲" : "▼"}
          </button>
        </label>

        <button
          type="button"
          className={
            "card-grid-bar-button" + (fieldsChooserOpen ? " card-grid-bar-button--on" : "")
          }
          data-quack-chrome=""
          aria-expanded={fieldsChooserOpen}
          title={`choose which of the ${fields.length} fields appear on the card face`}
          onClick={() => setFieldsChooserOpen((open) => !open)}
        >
          fields {preferences.fieldIdsOnTheCardFace.length}/{fields.length}{" "}
          {fieldsChooserOpen ? "▾" : "▸"}
        </button>

        <div className="card-grid-renderer-toggle" role="group" aria-label="renderer">
          <button
            type="button"
            className={
              "card-grid-bar-button" +
              (preferences.renderer === "cards" ? " card-grid-bar-button--on" : "")
            }
            data-quack-chrome=""
            aria-pressed={preferences.renderer === "cards"}
            title="cards"
            onClick={() => setRenderer("cards")}
          >
            ▦ cards
          </button>
          <button
            type="button"
            className={
              "card-grid-bar-button" +
              (preferences.renderer === "rows" ? " card-grid-bar-button--on" : "")
            }
            data-quack-chrome=""
            aria-pressed={preferences.renderer === "rows"}
            title="rows"
            onClick={() => setRenderer("rows")}
          >
            ▤ rows
          </button>
        </div>

        <button
          type="button"
          role="switch"
          className={
            "card-grid-switch" +
            (preferences.showHiddenByDescriptor ? " card-grid-switch--on" : "")
          }
          data-quack-chrome=""
          aria-checked={preferences.showHiddenByDescriptor}
          title="show the entities the host's descriptor marks invisible"
          onClick={() =>
            onPreferencesChange({
              ...preferences,
              showHiddenByDescriptor: !preferences.showHiddenByDescriptor,
            })
          }
        >
          <span className="card-grid-switch-track" aria-hidden="true">
            <span className="card-grid-switch-knob" />
          </span>
          show hidden
        </button>
      </div>

      {fieldsChooserOpen && (
        <FieldsOnTheCardFaceChooser
          fields={fields}
          fieldIdsOnTheCardFace={preferences.fieldIdsOnTheCardFace}
          exampleValueOfField={exampleValueOfField}
          onToggle={toggleFieldOnTheCardFace}
        />
      )}

      <p className="card-grid-count-line mono" role="status">
        {countLine}
      </p>
    </div>
  );
}

/**
 * §2.9: D9 / T11, the *Visible columns* dialog, relocated. A grid of togglable
 * field chips at `--card-min-narrow`, each showing the field name and a one-line
 * example value from the current data.
 *
 * These chips are the one thing in this system built on the shared geometry but
 * NOT on the Card primitive, and the reason is §3.2's own rule: the quack strip
 * names the openDAQ call a card makes, and toggling which field shows on a face
 * makes none. A card whose strip had nothing to name would be a card that
 * teaches nothing.
 */
function FieldsOnTheCardFaceChooser<T>({
  fields,
  fieldIdsOnTheCardFace,
  exampleValueOfField,
  onToggle,
}: {
  fields: readonly CardGridField<T>[];
  fieldIdsOnTheCardFace: readonly string[];
  exampleValueOfField: (fieldId: string) => string | null;
  onToggle: (fieldId: string) => void;
}) {
  return (
    <div className="card-grid-fields-chooser">
      <p className="card-grid-fields-chooser-note">
        Which of these {fields.length} fields appear on the card face.
      </p>
      <div className="card-grid card-grid--narrow">
        {fields.map((field) => {
          const on = fieldIdsOnTheCardFace.includes(field.id);
          const example = exampleValueOfField(field.id);
          return (
            <button
              key={field.id}
              type="button"
              className={
                "card-grid-field-chip" + (on ? " card-grid-field-chip--on" : "")
              }
              data-quack-chrome=""
              aria-pressed={on}
              onClick={() => onToggle(field.id)}
            >
              <span className="card-grid-field-chip-name">{field.label}</span>
              <span className="card-grid-field-chip-example mono">
                {example === null
                  ? "no entity in this grid to take an example from"
                  : example === ""
                    ? "(empty on the first entity in this grid)"
                    : example}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
