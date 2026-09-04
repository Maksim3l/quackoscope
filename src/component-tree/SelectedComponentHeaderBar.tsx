import { useState } from "react";
import type { Node } from "../transport";
import { copyTextToClipboard } from "../inspect/copy-text-to-clipboard";
import {
  componentStateOnARow,
  operationModeSuffix,
} from "./component-state-labels-and-row-colour";
import { ComponentIcon, type ComponentIconName } from "./component-icon-sprite";
import {
  displayTextForNode,
  localIdOf,
} from "./shape-flat-nodes-into-a-tree";

/**
 * The detail pane's header bar, §1.4's last piece and §1.10's selection rule
 * carried across the divider: the pane says WHICH component it is answering
 * about, with the same icon the tree row uses, so selection reads identically
 * on both sides of the split.
 *
 * The reference has nothing here — its right-hand panel starts straight at the
 * properties treeview, and the only place the selected component's identity
 * appears is the tree row itself. That is fine in a 1 200 px window with the
 * tree always visible; it is not fine once the detail pane carries three
 * different boards (§2.5, §2.7) that all look alike.
 *
 * Everything on the bar is a literal read off the wire `Node`: the display
 * text after §1.4's folder expansion, the device's current operation mode, the
 * bracketed state labels, the ComponentStatus chip with the host's own message,
 * the kind, the global id, the local id and the number of property ids the host
 * listed.
 *
 * The chip is `block_view.py`'s: a coloured square beside the status name and
 * its message, `change_status()` choosing the colour from ComponentStatus and
 * the text as `status.name + ' - ' + message`. A component whose
 * `component_status` is null draws NO chip — the reference's own behaviour, its
 * `change_status` returning early when the status container gave it nothing.
 */
const ICON_FOR_NODE_KIND: Record<Node["kind"], ComponentIconName> = {
  channel: "channel",
  signal: "signal",
  function_block: "function_block",
  device: "device",
  folder: "folder",
};

export function SelectedComponentHeaderBar({ node }: { node: Node }) {
  const [copyOutcome, setCopyOutcome] = useState<string | null>(null);
  const displayText = displayTextForNode(node);
  const localId = localIdOf(node);
  const state = componentStateOnARow(node);

  return (
    <header className="detail-header">
      <ComponentIcon
        name={ICON_FOR_NODE_KIND[node.kind] ?? "circle"}
        className="component-icon--detail-header"
      />
      <h2 className="detail-header-name">
        {displayText}
        {/* The reference's get_component_tree_name puts a device's current
            operation mode into the name as " | Idle". */}
        {operationModeSuffix(node) !== "" && (
          <span
            className="detail-header-operation-mode"
            title={`Node.operation_mode is "${node.operation_mode}"`}
          >
            {operationModeSuffix(node)}
          </span>
        )}
      </h2>
      <span className="detail-header-kind">{node.kind}</span>

      {state.suffix !== "" && (
        <span className="detail-header-state-suffix">{state.suffix.trim()}</span>
      )}

      {node.component_status !== null && (
        <span
          className="detail-header-status"
          data-component-status={node.component_status}
          title={`status_container.get_status("ComponentStatus") is ${node.component_status}`}
        >
          <span className="detail-header-status-square" aria-hidden="true" />
          <span className="detail-header-status-text">
            {node.component_status}
            {node.component_status_message === null
              ? ""
              : ` — ${node.component_status_message}`}
          </span>
        </span>
      )}

      <span className="detail-header-facts mono">
        <span title={`the global id get_component_tree gave this node`}>
          {node.id}
        </span>
        <span className="detail-header-dot" aria-hidden="true">
          ·
        </span>
        <span title="the last segment of the global id, which is openDAQ's local id">
          local id {localId}
        </span>
        <span className="detail-header-dot" aria-hidden="true">
          ·
        </span>
        <span
          title={`get_component_tree listed ${node.property_ids.length} property id${node.property_ids.length === 1 ? "" : "s"} on this node`}
        >
          {node.property_ids.length} propert
          {node.property_ids.length === 1 ? "y" : "ies"}
        </span>
      </span>

      <button
        type="button"
        className="detail-header-copy"
        data-quack-chrome=""
        title={`put the global id ${node.id} on the clipboard; this sends nothing`}
        onClick={() => {
          void copyTextToClipboard(node.id).then((outcome) =>
            setCopyOutcome(
              outcome.copied
                ? `copied ${node.id}`
                : `could not copy ${node.id}: ${outcome.error}`,
            ),
          );
        }}
      >
        <ComponentIcon name="copy" />
        <span>Copy id</span>
      </button>

      {copyOutcome !== null && (
        <span className="detail-header-copy-outcome muted" role="status">
          {copyOutcome}
        </span>
      )}
    </header>
  );
}
