import type { Node, NodeOperationMode } from "../transport";

/**
 * The bracketed state suffix and the row colour openDAQ's own GUI puts on every
 * tree row, computed from the six nullable state fields the wire `Node` carries.
 *
 * The reference is `gui_demo.py`:
 *   `_build_component_state_labels`  builds the label list, in this order;
 *   `_update_tree_item_visual_state` joins it as ` [a, b, c]` after the name;
 *   `_set_node_active_status_recursive` / `_set_node_lock_status_recursive` /
 *   `tree_add_component`              decide the foreground colour.
 *
 * NULL IS NOT FALSE. A null field means the host did not report that fact, so
 * nothing is drawn for it: no label, no icon, no colour. The reference reaches
 * the same place by wrapping every read in try/except and appending no label
 * when it raises, which is what nullable on the wire types.
 */

/** The colour class a row takes, or null when no state field asks for one. */
export type TreeRowStateColour = "error" | "warning" | "muted";

export interface ComponentStateOnARow {
  /** `["warn", "inactive", "locked"]`, in the reference's own order. */
  labels: string[];
  /** `" [warn, inactive, locked]"`, or "" when there is nothing to say. */
  suffix: string;
  colour: TreeRowStateColour | null;
  /** true only when `locked` is literally true. */
  showsTheLockIcon: boolean;
  /** true only when `connection_status` arrived and is not "connected". */
  showsTheUnlinkIcon: boolean;
}

/**
 * The reference's own label order:
 *   err | warn        from ComponentStatus
 *   inactive          from IComponent.active
 *   disconnected      from IDevice's connection status
 *   locked            from the effective, inheritance-applied lock
 * The reference's fifth label, `*`, marks a component between begin_update and
 * end_update. `IComponent.updating` reaches no wire field, so no row draws it.
 */
export function componentStateOnARow(node: Node): ComponentStateOnARow {
  const labels: string[] = [];

  if (node.component_status === "error") labels.push("err");
  else if (node.component_status === "warning") labels.push("warn");

  if (node.active === false) labels.push("inactive");

  const disconnected =
    node.connection_status !== null && node.connection_status !== "connected";
  if (disconnected) labels.push("disconnected");

  if (node.locked === true) labels.push("locked");

  // The reference's priority, from _set_node_active_status_recursive: "warning/
  // error color has higher priority", so a warning row stays orange even when
  // it is also inactive. Locked and inactive share one grey.
  const colour: TreeRowStateColour | null =
    node.component_status === "error"
      ? "error"
      : node.component_status === "warning"
        ? "warning"
        : node.active === false || node.locked === true || disconnected
          ? "muted"
          : null;

  return {
    labels,
    suffix: labels.length === 0 ? "" : ` [${labels.join(", ")}]`,
    colour,
    showsTheLockIcon: node.locked === true,
    showsTheUnlinkIcon: disconnected,
  };
}

/**
 * The reference's `operation_mode_to_string`, verbatim including its `/` for
 * Unknown, which is what `get_component_tree_name` appends to a device row as
 * ` | Idle`. A non-device row carries null here and gets no suffix.
 */
export const OPERATION_MODE_AS_THE_REFERENCE_SPELLS_IT: Readonly<
  Record<NodeOperationMode, string>
> = {
  unknown: "/",
  idle: "Idle",
  operation: "Operation",
  safe_operation: "SafeOperation",
};

/** `" | Operation"`, or "" when the host reported no operation mode. */
export function operationModeSuffix(node: Node): string {
  if (node.operation_mode === null) return "";
  return ` | ${OPERATION_MODE_AS_THE_REFERENCE_SPELLS_IT[node.operation_mode]}`;
}

/**
 * The state facts a row carries, as sentences, for the row's `title` and for
 * the detail header. Every sentence names the wire field and its literal value;
 * a field the host left null produces no sentence at all.
 */
export function describeComponentStateFields(node: Node): string[] {
  const said: string[] = [];
  if (node.active !== null) said.push(`active ${node.active}`);
  if (node.locked !== null) said.push(`locked ${node.locked}`);
  if (node.component_status !== null) {
    said.push(
      `component_status ${node.component_status}` +
        (node.component_status_message === null
          ? ""
          : ` — ${node.component_status_message}`),
    );
  }
  if (node.connection_status !== null) {
    said.push(`connection_status ${node.connection_status}`);
  }
  if (node.operation_mode !== null) {
    said.push(`operation_mode ${node.operation_mode}`);
  }
  return said;
}
