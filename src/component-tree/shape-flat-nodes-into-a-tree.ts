import type { Node } from "../transport";

/**
 * One row of the navigation tree: the wire Node plus the three things the row
 * has to display or be searched on that the Node does not carry directly.
 */
export interface TreeRow {
  node: Node;
  /**
   * §1.4's display text: the folder abbreviation expanded. The reference's
   * `_format_tree_item_text` also appends a device's operation mode
   * (`Reference Device | Operation`); the wire Node has no operation-mode
   * field, so that half is not drawn rather than guessed at.
   */
  displayText: string;
  /**
   * The reference searches `component.local_id`. On the wire a Node carries
   * only the global id, and openDAQ's global id is a `/`-joined path whose last
   * segment IS the local id, so that is what this is: the last segment, never a
   * second read from the host.
   */
  localId: string;
  depth: number;
  children: TreeRow[];
}

/**
 * §1.4's folder-abbreviation expansion, the same six the reference's
 * `get_standard_folder_name` performs, applied only to folders — a device
 * genuinely named `Dev` would otherwise be renamed under the user.
 */
const FOLDER_NAME_EXPANSIONS: Readonly<Record<string, string>> = {
  Sig: "Signals",
  FB: "Function blocks",
  Dev: "Devices",
  IP: "Input ports",
  IO: "Inputs/Outputs",
  Srv: "Servers",
};

export function displayTextForNode(node: Node): string {
  if (node.kind !== "folder") return node.name;
  return FOLDER_NAME_EXPANSIONS[node.name] ?? node.name;
}

/**
 * True when this row is one of the six folders openDAQ creates itself. §1.4:
 * "clicking a default folder row toggles and never selects", because a default
 * folder has nothing of its own to show in the detail pane.
 */
export function isADefaultFolder(node: Node): boolean {
  return (
    node.kind === "folder" &&
    Object.prototype.hasOwnProperty.call(FOLDER_NAME_EXPANSIONS, node.name)
  );
}

export function localIdOf(node: Node): string {
  const segments = node.id.split("/").filter((s) => s.length > 0);
  return segments.length === 0 ? node.id : segments[segments.length - 1];
}

/**
 * Turns the flat `Node[]` that `get_component_tree` returns into rows.
 *
 * `child_ids` gives the host's own ordering and is authoritative; any node that
 * names this node as its `parent_id` but is absent from `child_ids` is appended
 * afterwards, so a host that fills only one of the two links still produces a
 * complete tree. A node whose `parent_id` names nothing in the answer is a root.
 */
export function shapeFlatNodesIntoATree(nodes: readonly Node[]): TreeRow[] {
  const byId = new Map<string, Node>();
  for (const node of nodes) byId.set(node.id, node);

  const seen = new Set<string>();

  const buildRow = (node: Node, depth: number): TreeRow => {
    seen.add(node.id);
    const listed = node.child_ids
      .map((id) => byId.get(id))
      .filter((n): n is Node => n !== undefined && !seen.has(n.id));
    const listedIds = new Set(listed.map((n) => n.id));
    const linkedOnly = nodes.filter(
      (n) => n.parent_id === node.id && !listedIds.has(n.id) && !seen.has(n.id),
    );
    const children = [...listed, ...linkedOnly];
    for (const child of children) seen.add(child.id);
    return {
      node,
      displayText: displayTextForNode(node),
      localId: localIdOf(node),
      depth,
      children: children.map((child) => buildRow(child, depth + 1)),
    };
  };

  const roots = nodes.filter(
    (n) => n.parent_id === null || !byId.has(n.parent_id),
  );
  return roots.filter((n) => !seen.has(n.id)).map((n) => buildRow(n, 0));
}

/** Every row of a forest, parents before children. */
export function flattenRows(rows: readonly TreeRow[]): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (row: TreeRow) => {
    out.push(row);
    row.children.forEach(walk);
  };
  rows.forEach(walk);
  return out;
}

/** Re-stamps `depth` after a preset or the filter re-parented rows. */
export function restampDepth(rows: readonly TreeRow[], depth = 0): TreeRow[] {
  return rows.map((row) => ({
    ...row,
    depth,
    children: restampDepth(row.children, depth + 1),
  }));
}
