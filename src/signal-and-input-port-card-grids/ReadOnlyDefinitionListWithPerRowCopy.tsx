import { useState } from "react";
import { copyTextToClipboard } from "../inspect/copy-text-to-clipboard";

/**
 * §2.4's body, and §2.8's card back: "a `<dl>` of `name : value`, 11 px,
 * `grid-template-columns: max-content 1fr`, nested descriptor objects indented
 * by 12 px rather than becoming nested cards. Read-only throughout — the
 * reference has no editing here either. Right-click copy on any row; a **copy
 * all** control on the card header, which the reference gives you only
 * per-row."
 *
 * Read-only is not a styling choice here, it is the whole contract of the
 * component: there is no input, no commit, no onChange. Nothing rendered by
 * this file can send anything to a host.
 *
 * The reference's own copy affordance is a `<Button-3>` context menu with a
 * single *Copy* item. That is kept — right-click a row and it copies — and a
 * keyboard path is added beside it, because a context menu is a pointer-only
 * gesture and a copy control nobody can reach from the keyboard is a defect.
 */

export interface DefinitionListEntry {
  name: string;
  /** Rendered verbatim, never parsed. `null` prints the absent-value word. */
  value: string | null;
  /** 12 px per level, per §2.4. Nested objects indent; they do not nest cards. */
  indentLevel?: number;
  /** Shown under the row, 11 px muted. Where a field's provenance goes. */
  note?: string;
}

/**
 * The word an absent value prints. The user's ruling: "the neutral default is
 * `currently not available`". It is neutral on purpose — it blames neither the
 * host nor a binding, and every absent value in this lane is absent for the same
 * establishable reason, which the card's gap line states beside the list.
 */
export const THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE = "currently not available";

export function ReadOnlyDefinitionListWithPerRowCopy({
  entries,
  /** Named in the copy-all control, so the control says what it will copy. */
  describedAs,
}: {
  entries: readonly DefinitionListEntry[];
  describedAs: string;
}) {
  const [copyReport, setCopyReport] = useState<string | null>(null);

  const asText = (entry: DefinitionListEntry) =>
    `${entry.name}: ${entry.value ?? THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE}`;
  const allAsText = entries.map(asText).join("\n");

  const copy = (text: string, describedAsCopied: string) => {
    void copyTextToClipboard(text).then((outcome) => {
      setCopyReport(
        outcome.copied
          ? `copied ${describedAsCopied} — ${text.length} characters on the clipboard`
          : `could not copy ${describedAsCopied}: ${outcome.error}`,
      );
    });
  };

  return (
    <div className="definition-list-block">
      <div className="definition-list-head">
        <span className="muted">
          {entries.length} field{entries.length === 1 ? "" : "s"}, read-only
        </span>
        <button
          type="button"
          className="chrome-button"
          data-quack-chrome=""
          title={`copy all ${entries.length} rows of ${describedAs} as name: value lines`}
          onClick={() => copy(allAsText, `all ${entries.length} rows of ${describedAs}`)}
        >
          copy all
        </button>
      </div>

      <dl className="definition-list mono">
        {entries.map((entry) => (
          <div
            key={`${entry.indentLevel ?? 0}:${entry.name}`}
            className="definition-list-row"
            style={
              entry.indentLevel === undefined || entry.indentLevel === 0
                ? undefined
                : { paddingLeft: `${entry.indentLevel * 12}px` }
            }
            onContextMenu={(event) => {
              event.preventDefault();
              copy(asText(entry), entry.name);
            }}
            title={`right-click to copy "${asText(entry)}"`}
          >
            <dt>{entry.name}</dt>
            <dd
              className={
                entry.value === null ? "definition-list-absent" : undefined
              }
            >
              {entry.value ?? THE_WORD_FOR_A_VALUE_THAT_IS_NOT_THERE}
              <button
                type="button"
                className="definition-list-copy"
                data-quack-chrome=""
                title={`copy "${asText(entry)}"`}
                onClick={() => copy(asText(entry), entry.name)}
              >
                copy
              </button>
            </dd>
            {entry.note !== undefined && (
              <p className="definition-list-note">{entry.note}</p>
            )}
          </div>
        ))}
      </dl>

      {copyReport !== null && (
        <p className="definition-list-copy-report muted" role="status">
          {copyReport}
        </p>
      )}
    </div>
  );
}
