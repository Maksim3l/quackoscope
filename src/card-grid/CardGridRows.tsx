import type { OperationId } from "../ui/op";
import type { CardGridField, CardGridItemFacts } from "./card-grid-model";
import {
  cardStateClassName,
  CARD_STATE_LABEL,
  governingCardState,
} from "./card-states";
import type { CardGridViewPreferences } from "./card-grid-view-preferences";

/**
 * The rows renderer of the design specification's §1.9 item 4.
 *
 * The same data model, a second renderer: one `<table>` with real column
 * alignment and 26 px rows. It exists because §1.7 measured a card at ~1.8x the
 * height of a reference row, and because scanning sixty entities for the one
 * whose value is out of range is a column-scan task that cards genuinely lose.
 * Cards are the default everywhere except §2.10's update-parameters board, which
 * is a `Property | Value | New value` diff and is the strongest
 * column-alignment case in the whole reference.
 *
 * The columns are the entity's title, then the fields currently on the card face
 * — §2.2's `Property name | Value | <chosen fields>` — plus one state column, so
 * the scan the renderer exists for is a scan of a real column and not of nine
 * different left borders.
 *
 * A row keeps the card's `data-op`, so the same entity answers the same quack in
 * either renderer. It has no quack strip: §3.2 puts the strip on a card face,
 * and a 26 px row has no face. Switching to rows is therefore a deliberate trade
 * of the teaching affordance for density, which is why cards are the default.
 */

export interface CardGridRowsProps<T> {
  items: readonly T[];
  factsOf: (item: T) => CardGridItemFacts;
  fields: readonly CardGridField<T>[];
  preferences: CardGridViewPreferences;
  onPreferencesChange: (next: CardGridViewPreferences) => void;
  /** §3.1: the same ids the card element would carry, for the same entity. */
  operationIdsOf: (item: T) => readonly OperationId[];
  /** The header of the first column: "Property name", "Device name". */
  titleColumnLabel: string;
  selectedCardId?: string | null;
  onSelect?: (item: T) => void;
}

export function CardGridRows<T>({
  items,
  factsOf,
  fields,
  preferences,
  onPreferencesChange,
  operationIdsOf,
  titleColumnLabel,
  selectedCardId = null,
  onSelect,
}: CardGridRowsProps<T>) {
  const columns = fields.filter((field) =>
    preferences.fieldIdsOnTheCardFace.includes(field.id),
  );

  const sortBy = (fieldId: string) => {
    onPreferencesChange({
      ...preferences,
      sortId: fieldId,
      sortDirection:
        preferences.sortId === fieldId && preferences.sortDirection === "ascending"
          ? "descending"
          : "ascending",
    });
  };

  return (
    <table className="card-grid-rows">
      <thead>
        <tr>
          <th scope="col" className="card-grid-rows-title-column">
            {titleColumnLabel}
          </th>
          {columns.map((field) => (
            <th key={field.id} scope="col">
              <button
                type="button"
                className="card-grid-rows-sort"
                data-quack-chrome=""
                title={`sort by ${field.label}`}
                onClick={() => sortBy(field.id)}
              >
                {field.label}
                {preferences.sortId === field.id
                  ? preferences.sortDirection === "ascending"
                    ? " ▲"
                    : " ▼"
                  : ""}
              </button>
            </th>
          ))}
          <th scope="col" className="card-grid-rows-state-column">
            state
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const facts = factsOf(item);
          const governing = governingCardState(facts.states);
          return (
            <tr
              key={facts.id}
              className={
                "card-grid-row " +
                cardStateClassName(governing) +
                (facts.id === selectedCardId ? " card-grid-row--selected" : "")
              }
              data-op={operationIdsOf(item).join(" ")}
              data-card-id={facts.id}
              data-card-state={governing.state}
              tabIndex={0}
              onClick={() => onSelect?.(item)}
            >
              <td className="card-grid-rows-title-column">{facts.title}</td>
              {columns.map((field) => (
                <td key={field.id} className="mono">
                  {field.valueOf(item)}
                </td>
              ))}
              <td className="card-grid-rows-state-column" title={governing.words}>
                {governing.state === "normal"
                  ? ""
                  : CARD_STATE_LABEL[governing.state]}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
