import { useMemo, useRef, useState, type ReactNode } from "react";
import { FlockForOperation } from "../inspect/FlockColumns";
import { capabilityIdsForWireMethod } from "../inspect/capability-ids-for-wire-method";
import type { OperationId } from "../ui/op";
import type { CardCall } from "./CardQuackStrip";
import { CardGridBar } from "./CardGridBar";
import { CardGridRows } from "./CardGridRows";
import {
  itemMatchesFilter,
  sortItemsForDisplay,
  type CardFaceView,
  type CardGridField,
  type CardGridItemFacts,
} from "./card-grid-model";
import {
  CARD_MIN_WIDTH_CSS_VARIABLE,
  CARD_MIN_WIDTH_PX,
  expandedCardColumnSpan,
  useCardGridMeasurement,
  type CardMinWidthName,
} from "./card-grid-geometry";
import { CARD_STATE_LABEL, countCardStates } from "./card-states";
import {
  HOST_ORDER_SORT_ID,
  readCardGridViewPreferences,
  writeCardGridViewPreferences,
  type CardGridRenderer,
  type CardGridViewPreferences,
} from "./card-grid-view-preferences";

/**
 * A card grid: §2.0's geometry, §1.9's bar, and one card per entity.
 *
 * Generic over what an entity is. It is handed items of any type, a function
 * that states the facts it needs about one without rendering it, the fields
 * those items have, and a renderer for the card face. Every grid in §2.17 —
 * properties, discovered devices, function block types, server types, modules,
 * signals, input ports, statuses, field chips — is this component with different
 * arguments.
 */

export interface CardGridProps<T> {
  /** Identity for localStorage. One grid, one remembered set of choices (§2.9). */
  gridId: string;
  /** "property" / "properties". Printed in the count line and the filter placeholder. */
  entityNounSingular: string;
  entityNounPlural: string;

  items: readonly T[];
  factsOf: (item: T) => CardGridItemFacts;
  fields: readonly CardGridField<T>[];

  /** §2.0's three widths, assigned per grid by §2.17's substitution table. */
  cardMinWidth: CardMinWidthName;
  /** §1.9 item 2: what the host's own order is called here. "descriptor order". */
  hostOrderLabel: string;
  /**
   * §1.9 item 4: "Cards are the default". §2.10's update-parameters board is the
   * one grid in the design that defaults to rows, and it says why — it is a diff.
   */
  defaultRenderer?: CardGridRenderer;

  /** §3.1: `data-op` for the entity, used by the card and by the rows renderer alike. */
  operationIdsOf: (item: T) => readonly OperationId[];
  renderCard: (item: T, view: CardFaceView) => ReactNode;
  /** The first column's header in the rows renderer: "Property name". */
  titleColumnLabel: string;

  /**
   * §3.6: the call that would have populated this grid. When the grid is empty
   * the flock for that call is shown instead of "Nothing here" — an empty
   * `scan_available_devices` is a fact about the network, and the call that
   * established it is the most teachable moment in the app.
   */
  populatedBy: CardCall;

  /**
   * §2.5's manual connection card and §2.6's pinned connection-string card: a
   * card that is always first and spans every column. It is rendered before the
   * items and is not filtered, sorted or counted with them.
   */
  pinnedFirst?: ReactNode;

  selectedCardId?: string | null;
  onSelect?: (item: T) => void;
}

export function CardGrid<T>({
  gridId,
  entityNounSingular,
  entityNounPlural,
  items,
  factsOf,
  fields,
  cardMinWidth,
  hostOrderLabel,
  defaultRenderer = "cards",
  operationIdsOf,
  renderCard,
  titleColumnLabel,
  populatedBy,
  pinnedFirst,
  selectedCardId = null,
  onSelect,
}: CardGridProps<T>) {
  // Measured on the surface, not on the grid element: the grid element does not
  // exist while the grid is empty or while the rows renderer is showing, and a
  // count line printing "1 column at 0 px" because nothing was mounted would be
  // reporting the measurement's absence as a fact about the layout. The surface
  // and the grid are the same width, so it is the same number.
  const gridSurface = useRef<HTMLElement | null>(null);
  const [filterText, setFilterText] = useState("");

  const defaults = useMemo<CardGridViewPreferences>(
    () => ({
      renderer: defaultRenderer,
      fieldIdsOnTheCardFace: fields
        .filter((field) => field.onCardFaceByDefault)
        .map((field) => field.id),
      sortId: HOST_ORDER_SORT_ID,
      sortDirection: "ascending",
      showHiddenByDescriptor: false,
    }),
    [defaultRenderer, fields],
  );

  const [preferences, setPreferences] = useState<CardGridViewPreferences>(() =>
    readCardGridViewPreferences(gridId, defaults),
  );

  const changePreferences = (next: CardGridViewPreferences) => {
    setPreferences(next);
    writeCardGridViewPreferences(gridId, next);
  };

  const minWidthPx = CARD_MIN_WIDTH_PX[cardMinWidth];
  const measurement = useCardGridMeasurement(gridSurface, minWidthPx);
  const columnSpanForAnExpandedCard = expandedCardColumnSpan(measurement.columns);

  const shownByDescriptor = preferences.showHiddenByDescriptor
    ? items
    : items.filter((item) => !factsOf(item).hiddenByDescriptor);
  const hiddenByDescriptorCount = items.length - shownByDescriptor.length;

  const matching = shownByDescriptor.filter((item) =>
    itemMatchesFilter(item, factsOf(item), fields, filterText),
  );
  const ordered = sortItemsForDisplay(
    matching,
    factsOf,
    fields,
    preferences.sortId,
    preferences.sortDirection,
  );

  const countLine = buildCountLine({
    entityNounSingular,
    entityNounPlural,
    total: items.length,
    shown: ordered.length,
    hiddenByDescriptorCount,
    filterText,
    stateCounts: countCardStates(ordered.map((item) => factsOf(item).states)),
  });

  const view: CardFaceView = {
    fieldIsOnTheCardFace: (fieldId) =>
      preferences.fieldIdsOnTheCardFace.includes(fieldId),
    fieldIdsOnTheCardFace: preferences.fieldIdsOnTheCardFace,
    expandedColumnSpan: columnSpanForAnExpandedCard,
  };

  const firstItem = items.length > 0 ? items[0] : null;
  const exampleValueOfField = (fieldId: string): string | null => {
    if (firstItem === null) return null;
    const field = fields.find((each) => each.id === fieldId);
    return field === undefined ? null : field.valueOf(firstItem);
  };

  return (
    <section
      ref={gridSurface}
      className="card-grid-surface"
      data-card-grid-id={gridId}
    >
      <CardGridBar
        entityNounPlural={entityNounPlural}
        fields={fields}
        hostOrderLabel={hostOrderLabel}
        preferences={preferences}
        onPreferencesChange={changePreferences}
        filterText={filterText}
        onFilterTextChange={setFilterText}
        countLine={countLine}
        exampleValueOfField={exampleValueOfField}
      />

      {pinnedFirst !== undefined && (
        <div className="card-grid-pinned-first">{pinnedFirst}</div>
      )}

      {ordered.length === 0 ? (
        <EmptyCardGrid
          entityNounPlural={entityNounPlural}
          filterText={filterText}
          totalBeforeFiltering={items.length}
          hiddenByDescriptorCount={hiddenByDescriptorCount}
          populatedBy={populatedBy}
        />
      ) : preferences.renderer === "rows" ? (
        <CardGridRows
          items={ordered}
          factsOf={factsOf}
          fields={fields}
          preferences={preferences}
          onPreferencesChange={changePreferences}
          operationIdsOf={operationIdsOf}
          titleColumnLabel={titleColumnLabel}
          selectedCardId={selectedCardId}
          onSelect={onSelect}
        />
      ) : (
        <div
          className={`card-grid card-grid--${cardMinWidth}`}
          style={
            {
              [CARD_MIN_WIDTH_CSS_VARIABLE[cardMinWidth]]: `${minWidthPx}px`,
            } as React.CSSProperties
          }
        >
          {ordered.map((item) => (
            <RenderedCard
              key={factsOf(item).id}
              item={item}
              view={view}
              renderCard={renderCard}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A wrapper that exists for one reason: `renderCard` returns the card element
 * itself, and React needs the key on what the map produces. Keeping it a named
 * component rather than a fragment keeps the card's own element the direct grid
 * child, so `grid-column: span 2` on an expanded card still addresses the grid.
 */
function RenderedCard<T>({
  item,
  view,
  renderCard,
}: {
  item: T;
  view: CardFaceView;
  renderCard: (item: T, view: CardFaceView) => ReactNode;
}) {
  return <>{renderCard(item, view)}</>;
}

function buildCountLine({
  entityNounSingular,
  entityNounPlural,
  total,
  shown,
  hiddenByDescriptorCount,
  filterText,
  stateCounts,
}: {
  entityNounSingular: string;
  entityNounPlural: string;
  total: number;
  shown: number;
  hiddenByDescriptorCount: number;
  filterText: string;
  stateCounts: { state: keyof typeof CARD_STATE_LABEL; count: number }[];
}): string {
  const parts: string[] = [
    `${total} ${total === 1 ? entityNounSingular : entityNounPlural}`,
    `${shown} shown`,
  ];
  if (hiddenByDescriptorCount > 0) {
    parts.push(`${hiddenByDescriptorCount} hidden by descriptor`);
  }
  if (filterText.trim().length > 0) {
    parts.push(`filter "${filterText}"`);
  }
  for (const { state, count } of stateCounts) {
    parts.push(`${count} ${CARD_STATE_LABEL[state]}`);
  }
  return parts.join(" · ");
}

/**
 * §3.6: "Empty states are flock cards."
 *
 * Two different emptinesses, said as two different things. A grid the host
 * returned nothing for shows the call that established that, in every language
 * generated/snippets.json carries — that is the teachable one. A grid the reader
 * emptied with their own filter shows the filter text and the count it started
 * from, because the call is not the reason and pretending otherwise would teach
 * the wrong lesson.
 */
function EmptyCardGrid({
  entityNounPlural,
  filterText,
  totalBeforeFiltering,
  hiddenByDescriptorCount,
  populatedBy,
}: {
  entityNounPlural: string;
  filterText: string;
  totalBeforeFiltering: number;
  hiddenByDescriptorCount: number;
  populatedBy: CardCall;
}) {
  if (filterText.trim().length > 0) {
    return (
      <div className="card-grid-empty" role="status">
        <p>
          No {entityNounPlural} match the filter{" "}
          <strong>&quot;{filterText}&quot;</strong>. There are{" "}
          {totalBeforeFiltering} in this grid; clearing the filter shows them
          again.
        </p>
      </div>
    );
  }

  const capabilityIds = capabilityIdsForWireMethod(populatedBy.wireMethod);
  return (
    <div className="card-grid-empty card-grid-empty--flock" role="status">
      <p className="card-grid-empty-sentence">
        <code className="mono">{populatedBy.wireMethod}</code> returned an empty
        list, so this grid has no {entityNounPlural} to show
        {hiddenByDescriptorCount > 0
          ? `, and ${hiddenByDescriptorCount} more are hidden by the host's descriptor`
          : ""}
        .
      </p>
      {capabilityIds.length === 0 ? (
        <p className="muted">
          src/inspect/capability-ids-for-wire-method.ts maps no capability id to{" "}
          <code className="mono">{populatedBy.wireMethod}</code>, so there is no
          flock to show for it.
        </p>
      ) : (
        <FlockForOperation operationId={capabilityIds[0]} />
      )}
    </div>
  );
}
