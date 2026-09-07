import {
  flattenRows,
  restampDepth,
  type TreeRow,
} from "./shape-flat-nodes-into-a-tree";

/**
 * The tree's search box, §1.4, with the reference's filter semantics kept
 * verbatim because they are better than the usual web idiom:
 *
 *   - a row matches on its DISPLAY TEXT, its NAME or its LOCAL ID;
 *   - a match keeps its WHOLE SUBTREE and the walk does not look deeper;
 *   - matches are HOISTED to the top level and opened;
 *   - top-level rows holding no match are DROPPED.
 *
 * The result is a flat list of matched subtrees, all open. Dimming non-matches
 * would leave a 300-node tree 300 nodes long; this collapses it to what was
 * asked for.
 *
 * ONE FIELD OF THE REFERENCE'S FOUR IS NOT SEARCHED: tags. The reference reads
 * `component.tags.list` off the live SDK object. The wire `Node` carries
 * `id`, `name`, `kind`, `parent_id`, `child_ids` and `property_ids` — there is
 * no tag field on it, so tags are not searched and the placeholder does not
 * claim they are. The GLOBAL ID is searched instead, which the reference does
 * not do and which is useful here because the global id is what the detail
 * pane, the pond and every error message print.
 */

export interface TreeFilterResult {
  /** What to render: the hoisted matched subtrees, or the whole tree if idle. */
  roots: TreeRow[];
  /** The trimmed, lower-cased query actually applied. Empty means no filter. */
  query: string;
  /** Rows in the tree BEFORE the filter ran, for the count line. */
  rowsBeforeTheFilter: number;
  /** Ids of the rows that matched the query themselves. */
  matchedIds: ReadonlySet<string>;
  /**
   * Ids of the rows shown only because they sit INSIDE a matched subtree. The
   * count line names these separately, because "20 rows" after typing three
   * letters is otherwise a lie about how many things matched.
   */
  shownInsideAMatchIds: ReadonlySet<string>;
  /** Which of the four fields each matched row matched on, for the row title. */
  whyEachRowMatched: ReadonlyMap<string, string>;
}

/**
 * The four fields a row is searched on are display text, name, local id and
 * global id — the same four `fieldsRowMatchedOn` below tests and the same four
 * every count line and row title names, so the box never claims a field the
 * matcher does not read.
 */
export const TREE_FILTER_PLACEHOLDER =
  "Filter tree by name, local id or global id";

function fieldsRowMatchedOn(row: TreeRow, query: string): string[] {
  const hit: string[] = [];
  if (row.displayText.toLowerCase().includes(query)) hit.push("display text");
  if (row.node.name.toLowerCase().includes(query)) hit.push("name");
  if (row.localId.toLowerCase().includes(query)) hit.push("local id");
  if (row.node.id.toLowerCase().includes(query)) hit.push("global id");
  return hit;
}

export function filterTreeRowsByNameOrId(
  roots: readonly TreeRow[],
  rawQuery: string,
): TreeFilterResult {
  const query = rawQuery.trim().toLowerCase();
  const rowsBeforeTheFilter = flattenRows(roots).length;

  if (query === "") {
    return {
      roots: roots as TreeRow[],
      query: "",
      rowsBeforeTheFilter,
      matchedIds: new Set<string>(),
      shownInsideAMatchIds: new Set<string>(),
      whyEachRowMatched: new Map<string, string>(),
    };
  }

  const matchedIds = new Set<string>();
  const whyEachRowMatched = new Map<string, string>();
  const hoisted: TreeRow[] = [];

  // The reference's `collect`: descend until a row matches; that row's whole
  // subtree comes with it and the walk stops there.
  const collect = (row: TreeRow) => {
    const fields = fieldsRowMatchedOn(row, query);
    if (fields.length > 0) {
      matchedIds.add(row.node.id);
      whyEachRowMatched.set(
        row.node.id,
        `matched "${rawQuery.trim()}" on ${fields.join(" and ")}`,
      );
      hoisted.push(row);
      return;
    }
    row.children.forEach(collect);
  };
  roots.forEach(collect);

  const shownInsideAMatchIds = new Set<string>();
  for (const root of hoisted) {
    for (const row of flattenRows(root.children)) {
      shownInsideAMatchIds.add(row.node.id);
    }
  }

  return {
    roots: restampDepth(hoisted),
    query,
    rowsBeforeTheFilter,
    matchedIds,
    shownInsideAMatchIds,
    whyEachRowMatched,
  };
}

/**
 * The count line under the search box, per this project's output rule: literal
 * counts and the literal query, never "some rows matched".
 */
export function describeWhatTheFilterMatched(
  result: TreeFilterResult,
  presetLabel: string,
  rawQuery: string,
): string {
  if (result.query === "") {
    return `${result.rowsBeforeTheFilter} rows in ${presetLabel}, no filter typed`;
  }
  const matched = result.matchedIds.size;
  const inside = result.shownInsideAMatchIds.size;
  if (matched === 0) {
    return (
      `"${rawQuery.trim()}" matched 0 of the ${result.rowsBeforeTheFilter} rows in ${presetLabel} ` +
      `on display text, name, local id or global id`
    );
  }
  return (
    `"${rawQuery.trim()}" matched ${matched} of ${result.rowsBeforeTheFilter} rows in ${presetLabel}; ` +
    `${matched} matched subtree${matched === 1 ? "" : "s"} hoisted to the top, ` +
    `${inside} further row${inside === 1 ? "" : "s"} shown because they sit inside a match`
  );
}
