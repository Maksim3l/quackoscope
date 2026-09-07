import type { Node, NodeKind } from "../transport";

/**
 * The node kinds contract/contract.yaml carries, listed so the input port
 * search can print why it found nothing.
 *
 * Written as a `Record<NodeKind, true>` and not as an array, because a Record
 * over a union is exhaustive: the day the contract grows `input_port` as a node
 * kind, this object stops compiling and whoever added it is sent straight to the
 * grid that has been waiting for it.
 */
const EVERY_NODE_KIND_THE_CONTRACT_CARRIES: Record<NodeKind, true> = {
  device: true,
  channel: true,
  function_block: true,
  signal: true,
  folder: true,
};

export const NODE_KINDS_THE_CONTRACT_CARRIES = Object.keys(
  EVERY_NODE_KIND_THE_CONTRACT_CARRIES,
) as NodeKind[];

/**
 * What the right-hand stack can be built from today: the flat `Node[]` that
 * `get_component_tree` already answered with.
 *
 * §2.7 says it outright for the port cards' candidate list — "The candidate
 * signal list needs no contract row — the frontend already holds every `Node`
 * and filters `kind === "signal"`" — and the same is true of the signal cards
 * themselves. A signal is a component; its identity, its name, its place in the
 * tree and its property ids are all in hand. What is NOT in hand is everything
 * about the signal that is not a component fact: its descriptor, its last value,
 * its domain signal, its related signals. Those need the rows in
 * contract-rows-these-grids-wait-on.ts.
 *
 * Nothing in this file invents a node, and nothing filters by a name.
 */

/**
 * The component's own signals, the way openDAQ's tree stores them: in the
 * component's `Sig` folder rather than as direct children.
 *
 * Recursion descends into `folder` children only. That is deliberate and it is
 * what makes this the component's OWN signals rather than every signal beneath
 * it: descending into a child device or a child channel would pull that
 * component's signals into this component's card grid, which is not what the
 * reference's `node.get_signals()` returns and not what §2.15's grid is about.
 */
export function signalsOfComponent(
  nodes: readonly Node[],
  component: Node,
): Node[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const found: Node[] = [];
  const walk = (parent: Node) => {
    for (const childId of parent.child_ids) {
      const child = byId.get(childId);
      if (child === undefined) continue;
      if (child.kind === "signal") found.push(child);
      else if (child.kind === "folder") walk(child);
    }
  };
  walk(component);
  return found;
}

/**
 * §2.15's sections, which come from the reference's own `refresh()`: a signal
 * node shows itself under `Signal info`; a device or function block shows its
 * `Output signals`.
 *
 * `Domain signal` and `Related signals` are the two sections that do not appear
 * here, and the reason is a fact about the wire rather than a decision: the
 * contract's `Node` record is `{id, name, kind, parent_id, child_ids,
 * property_ids}`. There is no `domain_signal` field and no `related_signals`
 * field on it, and the only place a domain signal is named anywhere in
 * contract/contract.yaml is `SignalDescriptor.domain_id` — a field of a record
 * no operation returns. So the two sections are gapped on the same row the
 * descriptor cards are gapped on, O15, and the descriptor grid says so once
 * instead of this file inventing two empty sections.
 */
export function signalSectionBannerFor(component: Node): string {
  return component.kind === "signal" ? "Signal info" : "Output signals";
}

/** The signals §2.15's grid holds for this component, in the host's own order. */
export function signalsForTheOutputSignalGrid(
  nodes: readonly Node[],
  component: Node,
): Node[] {
  return component.kind === "signal"
    ? [component]
    : signalsOfComponent(nodes, component);
}

/**
 * Every signal in the whole tree, which is §2.7's candidate list for an input
 * port's connection select: "a `<select>` of every signal on the root device
 * plus `none`". No contract row, no call — the tree is already here.
 */
export function everySignalInTheTree(nodes: readonly Node[]): Node[] {
  return nodes.filter((node) => node.kind === "signal");
}

/**
 * The last segment of a global id, which is openDAQ's local id.
 *
 * `/openDAQDevice/Dev/RefDev0/IO/AI/Ch0/Sig/AI0` -> `AI0`. The same derivation
 * the tree pane makes, kept here rather than imported so the grids do not
 * depend on the tree pane's internals.
 */
export function localIdOf(node: Node): string {
  const segments = node.id.split("/").filter((segment) => segment.length > 0);
  return segments.length === 0 ? node.id : segments[segments.length - 1];
}

/**
 * `AI0 | …/Ch0/Sig/AI0` — the reference's own display text for a signal in an
 * input port's dropdown (`_display_text_for_signal`: the name, then a short id),
 * with the short id built from the tail of the global id rather than from the
 * reference's `context.short_id`, which strips a root prefix this app does not
 * know.
 */
export function signalChoiceText(signal: Node): string {
  const segments = signal.id.split("/").filter((s) => s.length > 0);
  const tail = segments.slice(-3).join("/");
  return `${signal.name} | …/${tail}`;
}

/**
 * What the input port grid found when it looked, and why that number is what it
 * is.
 *
 * It really does look: `kind` is compared against the string `"input_port"`
 * rather than the grid hard-coding an empty list, so the day the contract grows
 * the node kind the grid fills itself. The reason the count is zero is then
 * printed from `NODE_KINDS_THE_CONTRACT_CARRIES` above — computed from the
 * contract, not asserted by this file.
 */
export interface WhatTheInputPortSearchFound {
  ports: Node[];
  /** How many nodes were searched, for the sentence the grid prints. */
  nodesSearched: number;
  /**
   * Every folder the search walked, with how many children it had. This is what
   * makes the empty result checkable rather than asserted: on the C++ host's
   * reference channel the list reads `Sig(1) · FB(0) · IP(0)`, and `IP` is
   * openDAQ's own input-ports folder — present in the tree, empty on this wire.
   * Nothing branches on the name; the folders are listed as they were walked.
   */
  foldersWalked: { localId: string; childCount: number }[];
  /**
   * Null when ports were found. Otherwise the literal reason, naming the kinds
   * that do exist.
   */
  whyThereAreNone: string | null;
}

export function inputPortsOfComponent(
  nodes: readonly Node[],
  component: Node,
): WhatTheInputPortSearchFound {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const searched: Node[] = [];
  const ports: Node[] = [];
  const foldersWalked: { localId: string; childCount: number }[] = [];
  const walk = (parent: Node) => {
    for (const childId of parent.child_ids) {
      const child = byId.get(childId);
      if (child === undefined) continue;
      searched.push(child);
      // Deliberately a string comparison and not a `NodeKind` comparison: the
      // union has no `input_port` member, so `child.kind === "input_port"` does
      // not type-check at all. That refusal is the proof, and it is why the
      // widening below is written out rather than hidden behind a cast helper.
      if ((child.kind as string) === "input_port") ports.push(child);
      else if (child.kind === "folder") {
        foldersWalked.push({
          localId: localIdOf(child),
          childCount: child.child_ids.length,
        });
        walk(child);
      }
    }
  };
  walk(component);

  const folderList = foldersWalked
    .map((folder) => `${folder.localId}(${folder.childCount})`)
    .join(" · ");

  return {
    ports,
    nodesSearched: searched.length,
    foldersWalked,
    whyThereAreNone:
      ports.length > 0
        ? null
        : `${searched.length} node${searched.length === 1 ? " was" : "s were"} searched under ${component.name} for kind "input_port" and none has it` +
          (foldersWalked.length === 0
            ? ""
            : `; the folders walked were ${folderList}, and IP is openDAQ's own input-ports folder`) +
          `. contract/contract.yaml's NodeKind is a closed enum of ${NODE_KINDS_THE_CONTRACT_CARRIES.length}: ` +
          `${NODE_KINDS_THE_CONTRACT_CARRIES.join(", ")}. An input port cannot arrive on this wire as a component.`,
  };
}
