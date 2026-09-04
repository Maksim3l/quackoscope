import { useId, useState, type ReactNode } from "react";
import type { OperationId } from "../ui/op";
import { CardQuackStrip, type CardCall } from "./CardQuackStrip";
import {
  cardStateClassName,
  governingCardState,
  type CardStateMark,
} from "./card-states";

/**
 * The card primitive of the design specification's §1.8.
 *
 * One component, five bands, for every entity the app shows: a property, a
 * discovered device, a function block type, a module, a signal, an input port.
 * Nothing in this file knows which of those it is rendering — the caller brings
 * the title, the body and the calls, and the card brings the anatomy, the state
 * vocabulary, the expansion mechanism and the quack strip.
 *
 *   header       icon, title, the value cell, chips, the expander — one row, the
 *                way the reference's Treeview puts `#0` and `value` side by side
 *   body         only when a card has more than a value: a definition list, a
 *                draft form, container rows
 *   meta         the descriptor facts, 11 px muted — or, when the card is
 *                gapped, the CapabilityGapNotice in place of them (§1.8)
 *   description  clamped to 2 lines
 *   quack strip  permanent, §3.2
 *
 * plus the 3 px left border that carries state, and the back — the expansion
 * that replaces D8, D10, D14 and D15, four dialogs deleted by one mechanism
 * (§2.8).
 */

export interface CardChip {
  label: string;
  title?: string;
  /**
   * `unit` and `value-type` are the two header chips §1.8's diagram draws;
   * `hidden` is the chip the `invisible` state adds. `plain` is anything else.
   */
  tone?: "plain" | "unit" | "value-type" | "hidden";
}

/**
 * §2.8's card back. Four reference dialogs — property metadata, device info,
 * View Value, View Struct — are all "more about the one thing you already
 * clicked", so they are all this: the card expanded in place.
 */
export interface CardBack {
  /**
   * What expanding reveals, named. `all 14 PropertyDescriptor fields`, not
   * "more" — the control says what pressing it will show. It is the expander's
   * accessible name and its tooltip; the expander itself is a chevron, so the
   * sentence costs the card no height.
   */
  reveals: string;
  /**
   * §3.1: quacking the expander answers "where does this come from", which is
   * the read that already populated the card.
   */
  operationIds: readonly OperationId[];
  content: ReactNode;
}

export interface CardProps {
  /** Stable across refreshes: the React key and the DOM identity of this entity. */
  cardId: string;
  /** 20 x 20 kind glyph, left of the title. */
  glyph?: ReactNode;
  title: string;
  /** Shown on hover of the title. The entity's id, usually. */
  titleTooltip?: string;
  headerChips?: readonly CardChip[];

  /**
   * The value cell, on the header row beside the title — the reference's
   * `value` column, which stretches alongside `#0` rather than sitting under it.
   */
  headerValue?: ReactNode;

  /** The body band, for a card that has more to show than its value cell. */
  children?: ReactNode;

  /** The meta line: `min 100 · max 100000 · default 1000`, each fact one entry. */
  metaFacts?: readonly string[];
  /**
   * §1.8, the gapped row: "the existing CapabilityGapNotice one-liner in place
   * of the meta line". Pass the notice here and the meta facts are not rendered.
   */
  metaLineReplacement?: ReactNode;

  /** Clamped to two lines by the stylesheet, never truncated in JavaScript. */
  description?: string | null;

  /** §1.8. Empty means `normal`. */
  states?: readonly CardStateMark[];

  /** §3.1: `data-op` on the card element as well as on its inner controls. */
  operationIds: readonly OperationId[];

  /** §3.2: the openDAQ calls this card can make. */
  calls: readonly CardCall[];

  back?: CardBack | null;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean, cardId: string) => void;

  /** §1.10: the same treatment `.tree-row--selected` uses, so selection reads identically. */
  selected?: boolean;
  onSelect?: () => void;

  /**
   * §2.0's expansion clamp, handed down by the grid: 2 where two columns fit,
   * 1 where they do not. A card outside a grid spans nothing.
   */
  expandedColumnSpan?: number;
}

export function Card({
  cardId,
  glyph,
  title,
  titleTooltip,
  headerChips = [],
  headerValue,
  children,
  metaFacts = [],
  metaLineReplacement,
  description,
  states = [],
  operationIds,
  calls,
  back = null,
  defaultExpanded = false,
  onExpandedChange,
  selected = false,
  onSelect,
  expandedColumnSpan = 1,
}: CardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const backId = useId();

  const governing = governingCardState(states);

  // §1.8 routes three of the nine states somewhere other than the notice band:
  // read-only goes into the meta line, invisible becomes a header chip, and
  // gapped replaces the meta line with the capability notice the caller passes.
  const readOnlyMark = states.find((mark) => mark.state === "read-only");
  const invisibleMark = states.find((mark) => mark.state === "invisible");
  const noticeMarks = states.filter(
    (mark) =>
      mark.state !== "normal" &&
      mark.state !== "read-only" &&
      mark.state !== "invisible" &&
      mark.state !== "gapped",
  );

  const metaLine = [
    ...metaFacts,
    ...(readOnlyMark === undefined ? [] : [readOnlyMark.words]),
  ];

  const chips: CardChip[] = [
    ...headerChips,
    ...(invisibleMark === undefined
      ? []
      : [
          {
            label: "hidden",
            title: invisibleMark.words,
            tone: "hidden" as const,
          },
        ]),
  ];

  return (
    <article
      className={
        "card-face " +
        cardStateClassName(governing) +
        (selected ? " card-face--selected" : "") +
        (expanded ? " card-face--expanded" : "")
      }
      data-op={operationIds.join(" ")}
      data-card-id={cardId}
      data-card-state={governing.state}
      style={
        expanded && expandedColumnSpan > 1
          ? { gridColumn: `span ${expandedColumnSpan}` }
          : undefined
      }
      tabIndex={0}
      aria-label={`${title} card`}
      onClick={onSelect}
    >
      <header
        className={
          "card-header" +
          (headerValue === undefined ? "" : " card-header--with-value")
        }
      >
        {glyph !== undefined && (
          <span className="card-glyph" aria-hidden="true">
            {glyph}
          </span>
        )}
        <span className="card-title" title={titleTooltip}>
          {title}
        </span>
        {chips.map((chip) => (
          <span
            key={`${chip.tone ?? "plain"}:${chip.label}`}
            className={`card-chip card-chip--${chip.tone ?? "plain"}`}
            title={chip.title}
          >
            {chip.label}
          </span>
        ))}
        {headerValue === undefined ? (
          <span className="card-header-spacer" />
        ) : (
          <span className="card-header-value">{headerValue}</span>
        )}

        {/* §2.8's one expander — the control that deleted D8, D10, D14 and D15.
            It rides the header row as a chevron, carrying its own data-op so
            §3.1's specificity gradient holds: quacking the expander answers
            "where does this come from", not "what does this card write". */}
        {back !== null && (
          <button
            type="button"
            className="card-expander"
            data-op={back.operationIds.join(" ")}
            aria-expanded={expanded}
            aria-controls={backId}
            aria-label={expanded ? `hide ${back.reveals}` : `show ${back.reveals}`}
            title={expanded ? `hide ${back.reveals}` : `show ${back.reveals}`}
            onClick={(event) => {
              event.stopPropagation();
              const next = !expanded;
              setExpanded(next);
              onExpandedChange?.(next, cardId);
            }}
          >
            {expanded ? "▾" : "▸"}
          </button>
        )}
      </header>

      {children !== undefined && children !== null && (
        <div className="card-body">{children}</div>
      )}

      {metaLineReplacement !== undefined ? (
        <div className="card-meta-replacement">{metaLineReplacement}</div>
      ) : (
        metaLine.length > 0 && (
          <div className="card-meta mono">
            {metaLine.map((fact, index) => (
              <span key={fact} className="card-meta-fact">
                {index > 0 && (
                  <span className="card-meta-separator" aria-hidden="true">
                    ·
                  </span>
                )}
                {fact}
              </span>
            ))}
          </div>
        )
      )}

      {description !== null && description !== undefined && description !== "" && (
        <p className="card-description" title={description}>
          {description}
        </p>
      )}

      {noticeMarks.map((mark) => (
        <p
          key={mark.state}
          className={`card-notice card-notice--${mark.state}`}
          role={
            mark.state === "rejected" || mark.state === "out-of-range"
              ? "alert"
              : "status"
          }
        >
          <span className="card-notice-state">{mark.state}</span>
          <span className="card-notice-words">{mark.words}</span>
        </p>
      ))}

      {back !== null && expanded && (
        <section className="card-back" id={backId}>
          {back.content}
        </section>
      )}

      <CardQuackStrip calls={calls} cardTitle={title} />
    </article>
  );
}
