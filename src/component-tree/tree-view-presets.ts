import type { Node } from "../transport";
import type { OperationId } from "../ui/op";
import {
  flattenRows,
  restampDepth,
  type TreeRow,
} from "./shape-flat-nodes-into-a-tree";

/**
 * Decision D11 of the design specification: the reference's SIX `ttk.Notebook`
 * tabs — System Overview, Signals, Channels, Function blocks, Full Topology,
 * Modules — become SIX VIEWS OF ONE LEFT PANE, because six trees that differ
 * only by a filter predicate is a tkinter idiom, not a shape the web needs.
 *
 * Five of the six reshape the component tree. The sixth, Modules, REPLACES the
 * tree with §2.16's grid of module cards — a module is not a component and never
 * arrives on `get_component_tree`, so there is no reshape of these rows that
 * could show one. Clicking a module card details that module on the right, the
 * same left-select / right-detail relationship a component row already has.
 *
 * The five reshapes run over nodes ALREADY on the wire. Switching between them
 * sends nothing: the tree they re-shape came from one `get_component_tree`,
 * which is what the tree's quack strip names. Modules is the one view that does
 * send something, `list_loaded_modules`, and its own grid names that.
 */

export type TreeViewPresetId =
  | "system-overview"
  | "signals"
  | "channels"
  | "function-blocks"
  | "full-topology"
  | "modules";

export interface TreeViewPreset {
  id: TreeViewPresetId;
  /** The reference's own tab label, kept verbatim. */
  label: string;
  /** What this view shows, in one sentence, as the option's title. */
  describesWhatItShows: string;
  /**
   * The capability the connected host has to serve for this view to hold
   * anything at all. The five reshapes need `tree.read`, because every row they
   * arrange came from `get_component_tree`; Modules needs `module.read`, because
   * every card it draws came from `list_loaded_modules`.
   */
  capabilityTheLeftPaneNeeds: OperationId;
  /**
   * Null when the view can be built from what `get_component_tree` returns.
   * A string when it cannot — and then the string is the literal reason, shown
   * on a disabled option, never a view that quietly shows an empty tree.
   */
  cannotBeBuiltBecause: string | null;
  /**
   * True for Modules alone: this view puts the module card grid in the left pane
   * in place of the component tree, so `reshape` below returns nothing and is
   * never called.
   */
  replacesTheTreeWithTheModuleCardGrid?: boolean;
  reshape: (roots: readonly TreeRow[]) => TreeRow[];
}

// --- the five reshapes -----------------------------------------------------

/** Drops a row and everything under it when `drop` says so. */
function pruneSubtrees(
  rows: readonly TreeRow[],
  drop: (node: Node) => boolean,
): TreeRow[] {
  return rows
    .filter((row) => !drop(row.node))
    .map((row) => ({ ...row, children: pruneSubtrees(row.children, drop) }));
}

/** Every row of `rows` whose node satisfies `keep`, flat, order preserved. */
function collectFlat(
  rows: readonly TreeRow[],
  keep: (node: Node) => boolean,
): TreeRow[] {
  return flattenRows(rows)
    .filter((row) => keep(row.node))
    .map((row) => ({ ...row, children: [] }));
}

/**
 * Every row satisfying `keep`, hoisted to the top, but with rows satisfying
 * `keep` that are DESCENDANTS of another kept row nested under it instead. This
 * is what the reference does for Channels and Function blocks: the first kept
 * ancestor becomes the tree parent, everything above it disappears.
 */
function hoistKeptRowsAndNestKeptDescendants(
  rows: readonly TreeRow[],
  keep: (node: Node) => boolean,
  keepAsChild: (node: Node) => boolean,
): TreeRow[] {
  const nestUnderAKeptRow = (row: TreeRow): TreeRow => ({
    ...row,
    children: row.children.flatMap((child) =>
      keepAsChild(child.node)
        ? [nestUnderAKeptRow(child)]
        : nestUnderAKeptRow(child).children,
    ),
  });

  const out: TreeRow[] = [];
  const walk = (row: TreeRow) => {
    if (keep(row.node)) {
      out.push(nestUnderAKeptRow(row));
      return; // its own descendants are handled by nestUnderAKeptRow
    }
    row.children.forEach(walk);
  };
  rows.forEach(walk);
  return out;
}

/**
 * The reference's SYSTEM_OVERVIEW: everything EXCEPT signals, input ports and
 * servers, and except the three default folders that hold them (`Sig`, `IP`,
 * `Srv`).
 *
 * The wire's `NodeKind` is a closed set of five — device, channel,
 * function_block, signal, folder — with no `input_port` and no `server` member,
 * so of the reference's three exclusions only the signal one has anything on
 * this wire to exclude. The folder exclusion still does its whole job, because
 * an input port or a server that a future contract adds will arrive inside `IP`
 * or `Srv` and be dropped with the folder.
 */
const SYSTEM_OVERVIEW_HIDDEN_FOLDERS = new Set(["Sig", "IP", "Srv"]);

export const TREE_VIEW_PRESETS: readonly TreeViewPreset[] = [
  {
    id: "system-overview",
    label: "System Overview",
    describesWhatItShows:
      "the hierarchy without signals and without the Signals, Input ports and Servers folders — devices, channels and function blocks only",
    capabilityTheLeftPaneNeeds: "tree.read",
    cannotBeBuiltBecause: null,
    reshape: (roots) =>
      restampDepth(
        pruneSubtrees(
          roots,
          (node) =>
            node.kind === "signal" ||
            (node.kind === "folder" &&
              SYSTEM_OVERVIEW_HIDDEN_FOLDERS.has(node.name)),
        ),
      ),
  },
  {
    id: "signals",
    label: "Signals",
    describesWhatItShows:
      "every signal in the tree, flat, no folders and no owning device",
    capabilityTheLeftPaneNeeds: "tree.read",
    cannotBeBuiltBecause: null,
    reshape: (roots) =>
      restampDepth(collectFlat(roots, (node) => node.kind === "signal")),
  },
  {
    id: "channels",
    label: "Channels",
    describesWhatItShows:
      "every channel, flat, with the function blocks that live inside a channel nested under it",
    capabilityTheLeftPaneNeeds: "tree.read",
    cannotBeBuiltBecause: null,
    reshape: (roots) =>
      restampDepth(
        hoistKeptRowsAndNestKeptDescendants(
          roots,
          (node) => node.kind === "channel",
          (node) => node.kind === "function_block" || node.kind === "channel",
        ),
      ),
  },
  {
    id: "function-blocks",
    label: "Function blocks",
    describesWhatItShows:
      "every function block that is not a channel, flat, with nested function blocks kept nested",
    capabilityTheLeftPaneNeeds: "tree.read",
    cannotBeBuiltBecause: null,
    reshape: (roots) =>
      restampDepth(
        hoistKeptRowsAndNestKeptDescendants(
          roots,
          (node) => node.kind === "function_block",
          (node) => node.kind === "function_block",
        ),
      ),
  },
  {
    id: "full-topology",
    label: "Full Topology",
    describesWhatItShows:
      "every node get_component_tree returned, in the host's own hierarchy and the host's own order",
    capabilityTheLeftPaneNeeds: "tree.read",
    cannotBeBuiltBecause: null,
    reshape: (roots) => restampDepth(roots),
  },
  {
    id: "modules",
    label: "Modules",
    describesWhatItShows:
      "the modules list_loaded_modules names, one card each in the left pane, and the component types the one you click offers on the right",
    capabilityTheLeftPaneNeeds: "module.read",
    // What this used to say — that none of the contract's thirteen wire methods
    // returns a module — was true when it was written and is not true now.
    // contract/contract.yaml carries an eighteenth operation, list_loaded_modules,
    // under the capability module.read, and it answers with ModuleInfo[]: id,
    // name, version and the component types each module offers.
    //
    // So this view is no longer refused. It is also not a reshape of the
    // component tree, because a module is not a component and never arrives on
    // get_component_tree: it takes the left pane over with the card grid of
    // §2.16, which is what `replacesTheTreeWithTheModuleCardGrid` says. The only
    // reason that can still block it is the connected host's own — a host that
    // does not serve module.read — and that one is read at render time from the
    // handshake, in the host's words.
    cannotBeBuiltBecause: null,
    replacesTheTreeWithTheModuleCardGrid: true,
    reshape: () => [],
  },
];

/** True for the one view whose left pane is the module card grid. */
export function viewReplacesTheTreeWithTheModuleCardGrid(
  id: TreeViewPresetId,
): boolean {
  return treeViewPreset(id).replacesTheTreeWithTheModuleCardGrid === true;
}

export const DEFAULT_TREE_VIEW_PRESET_ID: TreeViewPresetId = "full-topology";

export function treeViewPreset(id: TreeViewPresetId): TreeViewPreset {
  const found = TREE_VIEW_PRESETS.find((preset) => preset.id === id);
  if (found === undefined) {
    throw new Error(
      `no left-pane view with id ${id}; the six that exist are ` +
        TREE_VIEW_PRESETS.map((p) => p.id).join(", "),
    );
  }
  return found;
}
