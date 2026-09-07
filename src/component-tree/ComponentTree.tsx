import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CallLogEntry, Node } from "../transport";
import { CardQuackStrip } from "../card-grid/CardQuackStrip";
import { OpButton } from "../ui/op";
import {
  componentStateOnARow,
  describeComponentStateFields,
  operationModeSuffix,
} from "./component-state-labels-and-row-colour";
import {
  ComponentIcon,
  type ComponentIconName,
} from "./component-icon-sprite";
import {
  describeWhatTheFilterMatched,
  filterTreeRowsByNameOrId,
  TREE_FILTER_PLACEHOLDER,
} from "./filter-tree-rows-by-name-or-id";
import {
  menuGroupsForTreeRow,
  rowOffersAMenu,
  type TreeRowMenuHandlers,
  type WireCallOutcome,
} from "./menu-groups-per-node-kind";
import {
  isADefaultFolder,
  shapeFlatNodesIntoATree,
  type TreeRow,
} from "./shape-flat-nodes-into-a-tree";
import {
  TreeRowActionMenu,
  type OperationModeListing,
} from "./TreeRowActionMenu";
import { treeViewPreset, type TreeViewPresetId } from "./tree-view-presets";

/**
 * The navigation tree of design specification §1.4 and §2.1.
 *
 * §2.1 is emphatic that this STAYS A TREE while every dialog and table in the
 * app becomes a card grid: a card grid of 300 components erases the parent
 * relationship, which is the only thing a component tree exists to show. So the
 * card vocabulary appears here in exactly one place — the quack strip at the
 * foot of the pane, naming the one call that filled the tree.
 *
 * WHAT A ROW SAYS ABOUT ITS COMPONENT, and where it comes from. The wire `Node`
 * now carries six nullable state fields, so the row draws what openDAQ's own
 * GUI draws:
 *   - `Reference Device | Operation`  from `operation_mode`, the reference's
 *     `get_component_tree_name`;
 *   - ` [warn, inactive, locked]`     from `component_status`, `active`,
 *     `connection_status` and `locked`, in the reference's own label order
 *     (`_build_component_state_labels`);
 *   - the row's colour, with warning and error beating the grey of inactive and
 *     locked, exactly as `_set_node_active_status_recursive` orders them;
 *   - a lock glyph on a locked row and an unlink glyph on a disconnected one.
 * A NULL field draws nothing at all — no label, no glyph, no colour. Null means
 * "this host does not report it", which is the reference's try/except typed.
 */
export function ComponentTree({
  nodes,
  presetId,
  selectedId,
  onSelect,
  onOpenAddDeviceBoard,
  onOpenAddFunctionBlockBoard,
  onRemoveFunctionBlock,
  onDisconnectDevice,
  onLockDevice,
  onUnlockDevice,
  onListDeviceOperationModes,
  onSetDeviceOperationMode,
}: {
  nodes: Node[];
  /**
   * Which of the five reshapes is on screen. It is chosen ABOVE this tree, by
   * the left pane's own dropdown, because the sixth view does not reshape these
   * rows — it replaces them with the module card grid, and a control that can
   * take the tree off the screen cannot live inside the tree.
   */
  presetId: TreeViewPresetId;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenAddDeviceBoard: ((nodeId: string) => void) | null;
  onOpenAddFunctionBlockBoard: ((nodeId: string) => void) | null;
  onRemoveFunctionBlock: ((nodeId: string) => void) | null;
  onDisconnectDevice: ((nodeId: string) => void) | null;
  onLockDevice: ((nodeId: string) => Promise<WireCallOutcome>) | null;
  onUnlockDevice:
    | ((nodeId: string, force: boolean) => Promise<WireCallOutcome>)
    | null;
  onListDeviceOperationModes:
    | ((nodeId: string) => Promise<OperationModeListing>)
    | null;
  onSetDeviceOperationMode:
    | ((nodeId: string, mode: string) => Promise<WireCallOutcome>)
    | null;
}) {
  const [query, setQuery] = useState("");
  const [toggledOpen, setToggledOpen] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [menuForNodeId, setMenuForNodeId] = useState<string | null>(null);

  const treeListRef = useRef<HTMLUListElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const preset = treeViewPreset(presetId);

  const shaped = useMemo(() => shapeFlatNodesIntoATree(nodes), [nodes]);
  const presetRoots = useMemo(
    () => preset.reshape(shaped),
    [preset, shaped],
  );
  const filtered = useMemo(
    () => filterTreeRowsByNameOrId(presetRoots, query),
    [presetRoots, query],
  );

  const filtering = filtered.query !== "";

  const nodeById = useMemo(() => {
    const map = new Map<string, Node>();
    for (const node of nodes) map.set(node.id, node);
    return map;
  }, [nodes]);
  const parentOf = useCallback(
    (id: string) => nodeById.get(id) ?? null,
    [nodeById],
  );

  const menuHandlers = useMemo<TreeRowMenuHandlers>(
    () => ({
      onOpenAddDeviceBoard,
      onOpenAddFunctionBlockBoard,
      onRemoveFunctionBlock,
      onDisconnectDevice,
      onLockDevice,
      onUnlockDevice,
      onSetDeviceOperationMode,
    }),
    [
      onOpenAddDeviceBoard,
      onOpenAddFunctionBlockBoard,
      onRemoveFunctionBlock,
      onDisconnectDevice,
      onLockDevice,
      onUnlockDevice,
      onSetDeviceOperationMode,
    ],
  );

  // §1.4: under a filter every surviving subtree is open. Outside a filter,
  // everything is open except function blocks, until the user says otherwise.
  const isExpanded = useCallback(
    (row: TreeRow): boolean => {
      if (row.children.length === 0) return false;
      if (filtering) return true;
      const toggled = toggledOpen.get(row.node.id);
      if (toggled !== undefined) return toggled;
      return row.node.kind !== "function_block";
    },
    [filtering, toggledOpen],
  );

  /** The rows actually on screen, in visual order — what the arrow keys walk. */
  const visibleRows = useMemo(() => {
    const out: { row: TreeRow; parentId: string | null }[] = [];
    const walk = (row: TreeRow, parentId: string | null) => {
      out.push({ row, parentId });
      if (isExpanded(row)) {
        row.children.forEach((child) => walk(child, row.node.id));
      }
    };
    filtered.roots.forEach((row) => walk(row, null));
    return out;
  }, [filtered.roots, isExpanded]);

  const rootIds = useMemo(
    () => new Set(shaped.map((row) => row.node.id)),
    [shaped],
  );

  // The roving tabindex has to land on a row that is still on screen: a preset
  // switch or a filter keystroke can take the focused row away.
  useEffect(() => {
    if (visibleRows.length === 0) {
      if (focusedId !== null) setFocusedId(null);
      return;
    }
    const stillThere = visibleRows.some(({ row }) => row.node.id === focusedId);
    if (!stillThere) {
      const landOn =
        visibleRows.find(({ row }) => row.node.id === selectedId)?.row.node.id ??
        visibleRows[0].row.node.id;
      setFocusedId(landOn);
    }
  }, [visibleRows, focusedId, selectedId]);

  const focusRow = useCallback((nodeId: string) => {
    setFocusedId(nodeId);
    const element = treeListRef.current?.querySelector<HTMLElement>(
      `[data-tree-row-select][data-node-id="${cssAttributeEscape(nodeId)}"]`,
    );
    element?.focus();
  }, []);

  /**
   * A row to focus AFTER the next render, for the case where the row does not
   * exist yet at the moment focus is asked for. Clearing the filter is exactly
   * that case: the row the focus should land on is one the filter had hidden,
   * so a synchronous `querySelector` finds nothing and the focus falls to
   * `<body>` — which is the bug this ref exists to prevent, because §1.4 is
   * explicit that clearing hands focus to the TREE, not to the toplevel.
   */
  const focusAfterTheNextRender = useRef<string | null>(null);
  useEffect(() => {
    const wanted = focusAfterTheNextRender.current;
    if (wanted === null) return;
    focusAfterTheNextRender.current = null;
    const list = treeListRef.current;
    if (list === null) return;
    const exact = list.querySelector<HTMLElement>(
      `[data-tree-row-select][data-node-id="${cssAttributeEscape(wanted)}"]`,
    );
    const landed = exact ?? list.querySelector<HTMLElement>("[data-tree-row-select]");
    landed?.focus();
  });

  const setOpen = useCallback((nodeId: string, open: boolean) => {
    setToggledOpen((previous) => {
      const next = new Map(previous);
      next.set(nodeId, open);
      return next;
    });
  }, []);

  const clearTheFilterAndReturnFocusToTheTree = useCallback(() => {
    setQuery("");
    // The reference hands focus to the tree, "not the toplevel, so it cannot
    // land back here". Same rule, same reason — but deferred by one render,
    // because the row to land on is only in the DOM once the filter is gone.
    focusAfterTheNextRender.current =
      focusedId ?? visibleRows[0]?.row.node.id ?? null;
  }, [focusedId, visibleRows]);

  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (menuForNodeId !== null) return;
    const at = visibleRows.findIndex(({ row }) => row.node.id === focusedId);
    if (at === -1) return;
    const here = visibleRows[at];

    const move = (to: number) => {
      const clamped = Math.max(0, Math.min(visibleRows.length - 1, to));
      focusRow(visibleRows[clamped].row.node.id);
    };

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(at + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(at - 1);
        break;
      case "Home":
        event.preventDefault();
        move(0);
        break;
      case "End":
        event.preventDefault();
        move(visibleRows.length - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (here.row.children.length === 0) break;
        if (!isExpanded(here.row)) setOpen(here.row.node.id, true);
        else move(at + 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (here.row.children.length > 0 && isExpanded(here.row)) {
          setOpen(here.row.node.id, false);
        } else if (here.parentId !== null) {
          focusRow(here.parentId);
        }
        break;
      default:
        break;
    }
  };

  if (nodes.length === 0) {
    return (
      <div className="component-tree-surface">
        <p className="muted pad">
          get_component_tree returned 0 nodes, so there is nothing to list.
        </p>
      </div>
    );
  }

  return (
    <div className="component-tree-surface">
      <div className="tree-search">
        <ComponentIcon name="discovery" className="tree-search-icon" />
        <input
          ref={searchInputRef}
          className="tree-search-input"
          type="search"
          value={query}
          placeholder={TREE_FILTER_PLACEHOLDER}
          aria-label={TREE_FILTER_PLACEHOLDER}
          data-quack-chrome=""
          // Deliberately NOT autofocused. The reference made the same call with
          // `takefocus=False`; it also took the box out of tab traversal, which
          // this does not do, because a control no keyboard can reach is a
          // defect rather than a style (§1.10 says the same about focus rings).
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              clearTheFilterAndReturnFocusToTheTree();
            }
          }}
        />
        {query !== "" && (
          <button
            type="button"
            className="tree-search-clear"
            data-quack-chrome=""
            aria-label={`clear the filter "${query}"`}
            title={`clear the filter "${query}" and put the focus back on the tree`}
            onClick={clearTheFilterAndReturnFocusToTheTree}
          >
            ×
          </button>
        )}
      </div>

      <p
        className="tree-filter-count"
        role="status"
        data-filtering={filtering ? "" : undefined}
      >
        {describeWhatTheFilterMatched(filtered, preset.label, query)}
      </p>

      {visibleRows.length === 0 ? (
        <p className="muted pad">
          {filtering
            ? `No row in ${preset.label} matched "${query.trim()}" on display text, name, local id or global id.`
            : `${preset.label} keeps no row of the ${nodes.length} nodes get_component_tree returned.`}
        </p>
      ) : (
        <ul
          ref={treeListRef}
          className="tree"
          role="tree"
          aria-label={`components, ${preset.label}`}
          onKeyDown={onTreeKeyDown}
        >
          {filtered.roots.map((row) => (
            <TreeRowItem
              key={row.node.id}
              row={row}
              level={1}
              selectedId={selectedId}
              focusedId={focusedId}
              menuForNodeId={menuForNodeId}
              isExpanded={isExpanded}
              rootIds={rootIds}
              parentOf={parentOf}
              menuHandlers={menuHandlers}
              matchedIds={filtered.matchedIds}
              shownInsideAMatchIds={filtered.shownInsideAMatchIds}
              whyEachRowMatched={filtered.whyEachRowMatched}
              filtering={filtering}
              onSelect={onSelect}
              onSetOpen={setOpen}
              onFocusRow={setFocusedId}
              onOpenMenu={setMenuForNodeId}
              onListDeviceOperationModes={onListDeviceOperationModes}
              onSetDeviceOperationMode={onSetDeviceOperationMode}
              onUnlockDevice={onUnlockDevice}
            />
          ))}
        </ul>
      )}

      {/* §3.2: the pane's own quack strip. Every row on screen is here because
          of ONE call, and this names it. Switching a preset or typing in the
          filter sends nothing — both re-shape what this call already returned,
          which is the fact the strip's title states. */}
      <div className="tree-quack-strip-holder">
        <CardQuackStrip
          cardTitle={`the component tree, ${preset.label} preset`}
          calls={[
            {
              wireMethod: "get_component_tree",
              pondEntryIsThisCards: (entry: CallLogEntry) =>
                entry.method === "get_component_tree",
            },
          ]}
        />
      </div>
    </div>
  );
}


const ICON_FOR_NODE_KIND: Record<Node["kind"], ComponentIconName> = {
  channel: "channel",
  signal: "signal",
  function_block: "function_block",
  device: "device",
  folder: "folder",
};

function TreeRowItem({
  row,
  level,
  selectedId,
  focusedId,
  menuForNodeId,
  isExpanded,
  rootIds,
  parentOf,
  menuHandlers,
  matchedIds,
  shownInsideAMatchIds,
  whyEachRowMatched,
  filtering,
  onSelect,
  onSetOpen,
  onFocusRow,
  onOpenMenu,
  onListDeviceOperationModes,
  onSetDeviceOperationMode,
  onUnlockDevice,
}: {
  row: TreeRow;
  level: number;
  selectedId: string | null;
  focusedId: string | null;
  menuForNodeId: string | null;
  isExpanded: (row: TreeRow) => boolean;
  rootIds: ReadonlySet<string>;
  parentOf: (id: string) => Node | null;
  menuHandlers: TreeRowMenuHandlers;
  matchedIds: ReadonlySet<string>;
  shownInsideAMatchIds: ReadonlySet<string>;
  whyEachRowMatched: ReadonlyMap<string, string>;
  filtering: boolean;
  onSelect: (id: string) => void;
  onSetOpen: (id: string, open: boolean) => void;
  onFocusRow: (id: string) => void;
  onOpenMenu: (id: string | null) => void;
  onListDeviceOperationModes:
    | ((nodeId: string) => Promise<OperationModeListing>)
    | null;
  onSetDeviceOperationMode:
    | ((nodeId: string, mode: string) => Promise<WireCallOutcome>)
    | null;
  onUnlockDevice:
    | ((nodeId: string, force: boolean) => Promise<WireCallOutcome>)
    | null;
}) {
  const node = row.node;
  const expanded = isExpanded(row);
  const hasChildren = row.children.length > 0;
  const selected = node.id === selectedId;
  const roving = node.id === focusedId;
  const matched = matchedIds.has(node.id);
  const insideAMatch = shownInsideAMatchIds.has(node.id);
  const defaultFolder = isADefaultFolder(node);
  const menuOpen = menuForNodeId === node.id;
  const actionButtonRef = useRef<HTMLButtonElement>(null);

  const state = componentStateOnARow(node);
  const modeSuffix = operationModeSuffix(node);
  const stateFacts = describeComponentStateFields(node);

  const groups = menuGroupsForTreeRow({
    node,
    isRoot: rootIds.has(node.id),
    parentOf,
    handlers: menuHandlers,
  });
  const hasAMenu = rowOffersAMenu(groups);

  return (
    <li className="tree-item" role="none">
      <div
        className={
          "tree-row" +
          (selected ? " tree-row--selected" : "") +
          (menuOpen ? " tree-row--menu-open" : "")
        }
        data-node-id={node.id}
        // §1.6's row colour, driven by the reference's own priority: error and
        // warning beat the grey that inactive, locked and disconnected share.
        // Absent when every state field the host sent is null.
        data-component-state={state.colour ?? undefined}
        data-tree-match={
          !filtering ? undefined : matched ? "matched" : insideAMatch ? "inside-a-match" : undefined
        }
        style={{ paddingLeft: `${6 + (row.depth) * 14}px` }}
        onContextMenu={(event) => {
          event.preventDefault();
          onFocusRow(node.id);
          if (hasAMenu) onOpenMenu(node.id);
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="tree-twisty"
            tabIndex={-1}
            aria-hidden="true"
            data-quack-chrome=""
            title={
              expanded
                ? `collapse ${row.displayText}, hiding ${row.children.length} child row${row.children.length === 1 ? "" : "s"}`
                : `expand ${row.displayText}, showing ${row.children.length} child row${row.children.length === 1 ? "" : "s"}`
            }
            onClick={(event) => {
              event.stopPropagation();
              onSetOpen(node.id, !expanded);
            }}
          >
            <ComponentIcon name={expanded ? "down" : "right"} />
          </button>
        ) : (
          <span className="tree-twisty tree-twisty--leaf" aria-hidden="true" />
        )}

        <OpButton
          // Selecting a signal is also what opens and closes its subscription.
          op={
            node.kind === "signal"
              ? ["tree.read", "property.read", "streaming.decimated"]
              : ["tree.read", "property.read"]
          }
          className="tree-row-select"
          role="treeitem"
          aria-level={level}
          aria-selected={selected}
          aria-expanded={hasChildren ? expanded : undefined}
          tabIndex={roving ? 0 : -1}
          data-tree-row-select=""
          data-node-id={node.id}
          title={
            `${row.displayText}${modeSuffix}${state.suffix} — kind ${node.kind}, global id ${node.id}, local id ${row.localId}, ` +
            `${node.property_ids.length} propert${node.property_ids.length === 1 ? "y" : "ies"}` +
            (defaultFolder
              ? ". A default openDAQ folder."
              : ". Selecting it sends get_property_descriptors for this node.") +
            (stateFacts.length === 0
              ? ""
              : ` get_component_tree reported ${stateFacts.join("; ")}.`) +
            (whyEachRowMatched.has(node.id)
              ? ` This row ${whyEachRowMatched.get(node.id)}.`
              : insideAMatch
                ? " Shown because it sits inside a matched subtree, not because it matched."
                : "")
          }
          onFocus={() => onFocusRow(node.id)}
          onClick={() => {
            onFocusRow(node.id);
            // §1.4: clicking a default folder toggles and never selects;
            // clicking the already-selected row toggles it open.
            if (defaultFolder || (selected && hasChildren)) {
              if (hasChildren) onSetOpen(node.id, !expanded);
              if (defaultFolder) return;
              return;
            }
            onSelect(node.id);
          }}
        >
          <ComponentIcon
            name={ICON_FOR_NODE_KIND[node.kind] ?? "circle"}
            className="component-icon--tree"
          />
          <span className="tree-name">{row.displayText}</span>
          {/* The reference's `get_component_tree_name`: a device's current
              operation mode is part of the row's NAME, as ` | Idle`. */}
          {modeSuffix !== "" && (
            <span
              className="tree-operation-mode"
              title={`Node.operation_mode is "${node.operation_mode}" on this device row`}
            >
              {modeSuffix}
            </span>
          )}
          {/* `_build_component_state_labels` joined as ` [a, b, c]`. */}
          {state.suffix !== "" && (
            <span
              className="tree-state-suffix"
              title={stateFacts.join("; ")}
            >
              {state.suffix}
            </span>
          )}
          {state.showsTheLockIcon && (
            <span className="tree-state-glyph" title="Node.locked is true on this row">
              <ComponentIcon name="lock" className="component-icon--row-state" />
            </span>
          )}
          {state.showsTheUnlinkIcon && (
            <span
              className="tree-state-glyph"
              title={`Node.connection_status is "${node.connection_status}" on this device row`}
            >
              <ComponentIcon name="unlink" className="component-icon--row-state" />
            </span>
          )}
          {matched && (
            <span className="tree-match-badge" title={whyEachRowMatched.get(node.id)}>
              match
            </span>
          )}
          <span className="tree-kind">{node.kind}</span>
        </OpButton>

        {/* §D7's affordance, but only where there is something to offer: a row
            whose groups are all empty opens no menu, and shows no ⋯ button. */}
        {hasAMenu && (
          <button
            ref={actionButtonRef}
            type="button"
            className="tree-row-actions"
            data-quack-chrome=""
            tabIndex={roving ? 0 : -1}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`actions for ${row.displayText}`}
            title={
              `actions for ${row.displayText}: ` +
              groups
                .filter((group) => group.items.length > 0)
                .map(
                  (group) =>
                    `${group.id} — ` +
                    group.items
                      .map((a) => (a.wireMethod === null ? a.id : a.wireMethod))
                      .join(", "),
                )
                .join(" | ")
            }
            onClick={(event) => {
              event.stopPropagation();
              onFocusRow(node.id);
              onOpenMenu(menuOpen ? null : node.id);
            }}
          >
            <ComponentIcon name="dots" />
          </button>
        )}

        {menuOpen && hasAMenu && (
          <TreeRowActionMenu
            rowLabel={row.displayText}
            nodeId={node.id}
            currentOperationMode={node.operation_mode}
            groups={groups}
            anchor={actionButtonRef.current}
            onListDeviceOperationModes={onListDeviceOperationModes}
            onSetDeviceOperationMode={onSetDeviceOperationMode}
            onUnlockDevice={onUnlockDevice}
            onClose={() => {
              onOpenMenu(null);
              actionButtonRef.current?.focus();
            }}
          />
        )}
      </div>

      {hasChildren && expanded && (
        <ul role="group" className="tree-group">
          {row.children.map((child) => (
            <TreeRowItem
              key={child.node.id}
              row={child}
              level={level + 1}
              selectedId={selectedId}
              focusedId={focusedId}
              menuForNodeId={menuForNodeId}
              isExpanded={isExpanded}
              rootIds={rootIds}
              parentOf={parentOf}
              menuHandlers={menuHandlers}
              matchedIds={matchedIds}
              shownInsideAMatchIds={shownInsideAMatchIds}
              whyEachRowMatched={whyEachRowMatched}
              filtering={filtering}
              onSelect={onSelect}
              onSetOpen={onSetOpen}
              onFocusRow={onFocusRow}
              onOpenMenu={onOpenMenu}
              onListDeviceOperationModes={onListDeviceOperationModes}
              onSetDeviceOperationMode={onSetDeviceOperationMode}
              onUnlockDevice={onUnlockDevice}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * openDAQ global ids are `/`-joined paths and can carry characters that end an
 * attribute selector. CSS.escape exists in every browser this app runs in; the
 * manual branch is for a test environment that has no CSS object at all.
 */
function cssAttributeEscape(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (css?.escape !== undefined) return css.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
