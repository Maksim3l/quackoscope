import { useMemo } from "react";
import type { Node } from "../transport";
import { OpButton } from "../ui/op";

const KIND_GLYPH: Record<Node["kind"], string> = {
  device: "▣",
  channel: "⌁",
  function_block: "⛭",
  signal: "∿",
  folder: "▸",
};

/**
 * Renders the flat Node[] from get_component_tree as a tree, using parent_id
 * for the shape and child_ids for the order within a parent.
 */
export function ComponentTree({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: Node[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { byId, roots } = useMemo(() => {
    const byId = new Map<string, Node>();
    for (const n of nodes) byId.set(n.id, n);
    const roots = nodes.filter(
      (n) => n.parent_id === null || !byId.has(n.parent_id),
    );
    return { byId, roots };
  }, [nodes]);

  const renderNode = (node: Node, depth: number) => {
    // child_ids gives the host's ordering; fall back to parent_id scan for any
    // child the host listed only by parent link.
    const listed = node.child_ids
      .map((id) => byId.get(id))
      .filter((n): n is Node => n !== undefined);
    const listedIds = new Set(listed.map((n) => n.id));
    const extra = nodes.filter(
      (n) => n.parent_id === node.id && !listedIds.has(n.id),
    );
    const children = [...listed, ...extra];

    return (
      <li key={node.id}>
        <OpButton
          // Selecting a signal is also what opens and closes its subscription.
          op={
            node.kind === "signal"
              ? ["tree.read", "property.read", "signal.subscribe", "signal.unsubscribe"]
              : ["tree.read", "property.read"]
          }
          className={
            "tree-row" + (node.id === selectedId ? " tree-row--selected" : "")
          }
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          title={node.id}
          onClick={() => onSelect(node.id)}
        >
          <span className="tree-glyph">{KIND_GLYPH[node.kind] ?? "•"}</span>
          <span className="tree-name">{node.name}</span>
          <span className="tree-kind">{node.kind}</span>
        </OpButton>
        {children.length > 0 && (
          <ul>{children.map((c) => renderNode(c, depth + 1))}</ul>
        )}
      </li>
    );
  };

  if (nodes.length === 0) {
    return <p className="muted pad">No components.</p>;
  }

  return <ul className="tree">{roots.map((r) => renderNode(r, 0))}</ul>;
}
