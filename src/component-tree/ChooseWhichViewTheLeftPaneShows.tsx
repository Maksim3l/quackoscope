import { useId } from "react";
import {
  headlineForGap,
  shortTagForGap,
} from "../session/CapabilityGapNotice";
import {
  useCapabilityStanding,
  useHostProcessName,
} from "../session/host-capability-context";
import type { CapabilityStanding } from "../session/host-handshake";
import type { MethodName } from "../transport";
import { OpButton, type OperationId } from "../ui/op";
import { ComponentIcon } from "./component-icon-sprite";
import {
  TREE_VIEW_PRESETS,
  treeViewPreset,
  type TreeViewPresetId,
} from "./tree-view-presets";

/**
 * The six views of decision D11 as ONE DROPDOWN over the left pane, and the
 * pane-level re-read beside it.
 *
 * They were six buttons in a row. A dropdown names the view that is showing
 * without asking the reader to find the pressed one among six, and it gives the
 * five it is not showing a place to state their own condition at full length —
 * a button caption has room for a word, an option has room for the sentence a
 * gapped view needs.
 *
 * It is a native `<select>`, so every key that reaches a select reaches this:
 * Tab onto it, Up/Down or Home/End to move, type-ahead by label, Enter or Escape
 * to close. That was the reason the buttons carried `aria-disabled` rather than
 * `disabled` — a `disabled` button cannot be focused, so the reason it carries
 * is reachable by mouse alone. An `<option>` carries its reason in its own TEXT,
 * which is on screen for anyone who opens the list and is read out by a screen
 * reader whether or not the option can be chosen, so this one can be genuinely
 * `disabled` without hiding anything.
 *
 * TWO CONDITIONS, and they are not the same condition:
 *
 *   * A view that CANNOT BE BUILT is `disabled`. Its option text says so.
 *   * A view whose CAPABILITY THE HOST GAPS stays choosable, and the option and
 *     the line under the select carry the host's own words. Choosing it puts the
 *     gapped card in the left pane, which holds the declared kind, the contract's
 *     meaning of that kind, the host's verbatim reason and the flock of openDAQ
 *     calls the missing wire method would have made. §3.7 wants the richest
 *     gapped surface reachable, and an option nobody can select reaches none of
 *     it. The five tree views are the exception: `tree.read` gapped means
 *     `get_component_tree` was never sent, so there is no row for any of the five
 *     reshapes to arrange, and those five ARE disabled.
 */

/** The pane-level re-read: which call it sends, and under which capability. */
export interface PaneLevelReread {
  wireMethod: MethodName;
  capability: OperationId;
  /** What sending it again does to what is on screen, as the button's title. */
  describesWhatItDoes: string;
  onReread: () => void;
}

export function ChooseWhichViewTheLeftPaneShows({
  viewId,
  onChoose,
  paneLevelReread,
}: {
  viewId: TreeViewPresetId;
  onChoose: (id: TreeViewPresetId) => void;
  /** null when the capability behind the re-read is not this session's to send. */
  paneLevelReread: PaneLevelReread | null;
}) {
  const selectId = useId();
  const hostProcessName = useHostProcessName();
  const treeReadStanding = useCapabilityStanding("tree.read");
  const moduleReadStanding = useCapabilityStanding("module.read");

  const standingFor = (capability: OperationId): CapabilityStanding | null =>
    capability === "tree.read"
      ? treeReadStanding
      : capability === "module.read"
        ? moduleReadStanding
        : null;

  const conditionOf = (id: TreeViewPresetId) => {
    const preset = treeViewPreset(id);
    const standing = standingFor(preset.capabilityTheLeftPaneNeeds);
    const gapped = standing !== null && !standing.served;
    // Only the tree views die on their gap: with tree.read gapped there is no
    // row on the wire for a reshape to arrange. The module grid still has a
    // surface to draw when module.read is gapped — the gapped card.
    const disabled =
      preset.cannotBeBuiltBecause !== null ||
      (gapped && !(preset.replacesTheTreeWithTheModuleCardGrid === true));
    const gapSentence =
      gapped && standing !== null
        ? `${standing.capabilityId} is a ${shortTagForGap(standing)} on ${hostProcessName}: ` +
          `${headlineForGap(standing)}` +
          (standing.gap?.reason
            ? `. ${hostProcessName} says: ${standing.gap.reason}`
            : "")
        : null;
    return {
      preset,
      standing,
      gapped,
      disabled,
      gapSentence,
      reason: preset.cannotBeBuiltBecause ?? gapSentence,
    };
  };

  const here = conditionOf(viewId);

  return (
    <>
      <div className="left-pane-view-bar">
        <label className="left-pane-view-label" htmlFor={selectId}>
          View
        </label>
        <select
          id={selectId}
          className="left-pane-view-select"
          data-quack-chrome=""
          data-capability-gapped={here.gapped ? "" : undefined}
          value={viewId}
          title={here.preset.describesWhatItShows}
          onChange={(event) => onChoose(event.target.value as TreeViewPresetId)}
        >
          {TREE_VIEW_PRESETS.map((preset) => {
            const condition = conditionOf(preset.id);
            return (
              <option
                key={preset.id}
                value={preset.id}
                disabled={condition.disabled}
                title={
                  condition.reason === null
                    ? preset.describesWhatItShows
                    : `${preset.describesWhatItShows} — ${condition.reason}`
                }
              >
                {preset.label}
                {condition.disabled
                  ? ` — unavailable: ${shortSuffixFor(condition)}`
                  : condition.gapped
                    ? ` — ${shortSuffixFor(condition)}`
                    : ""}
              </option>
            );
          })}
        </select>

        {paneLevelReread !== null && (
          <OpButton
            op={[paneLevelReread.capability]}
            className="left-pane-view-reread"
            title={paneLevelReread.describesWhatItDoes}
            onClick={paneLevelReread.onReread}
          >
            <ComponentIcon name="refresh" />
            <span className="mono">{paneLevelReread.wireMethod}</span>
          </OpButton>
        )}
      </div>

      {/* The condition of the view that is actually on screen, at full length
          and where a reader can read it — the tooltip on the option is gone the
          moment the list closes. */}
      {here.reason !== null && (
        <p
          className="left-pane-view-condition"
          role="status"
          data-capability-gapped={here.gapped ? "" : undefined}
        >
          {here.reason}
        </p>
      )}
    </>
  );
}

/**
 * What an option adds after its label. Short enough that the six options stay a
 * list of view names — the full sentence is on the option's title and, for the
 * view that is showing, on the line under the select.
 */
function shortSuffixFor(condition: {
  preset: { cannotBeBuiltBecause: string | null; capabilityTheLeftPaneNeeds: OperationId };
  standing: CapabilityStanding | null;
}): string {
  if (condition.standing !== null && !condition.standing.served) {
    return `${condition.standing.capabilityId} is a ${shortTagForGap(condition.standing)}`;
  }
  return condition.preset.cannotBeBuiltBecause ?? "";
}
