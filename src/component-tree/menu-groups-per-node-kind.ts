import type { MethodName, Node } from "../transport";
import type { OperationId } from "../ui/op";
import type { ComponentIconName } from "./component-icon-sprite";
import { isADefaultFolder } from "./shape-flat-nodes-into-a-tree";

/**
 * WHICH items a row's menu offers, chosen BY NODE KIND, from the reference's own
 * `gui_demo.py`:
 *
 *   menu_groups()      picks a different menu per kind — IFunctionBlock, IDevice,
 *                      IServer, else update + property items — "add actions
 *                      first, then state, then removal".
 *   menu_add_items()   decides what a row ACCEPTS: "a function block only takes
 *                      nested function blocks, a device also takes devices, and
 *                      only the instance takes servers".
 *   menu_build()       draws a separator between groups and SKIPS EMPTY GROUPS,
 *                      so no separator is left dangling.
 *
 * Nothing here is navigation. The four items this menu used to open with —
 * "Show the properties of X" (selecting the row already does it), "Copy the
 * global id", "Filter the tree to X" (the search box does it) and "Re-read the
 * whole component tree" (a pane-level refresh, not a row action) — are gone.
 * The re-read moved to the tree pane's own header, where it acts on the pane.
 *
 * An item whose wire method does not exist in contract/contract.yaml is drawn
 * DISABLED, carrying the literal name of the operation row it waits on, rather
 * than being left out: a control that is silently absent teaches nothing.
 */

export interface TreeRowAction {
  id: string;
  label: string;
  icon: ComponentIconName;
  /** The literal wire method this item sends, or null when it sends none. */
  wireMethod: MethodName | null;
  /**
   * Non-null when contract/contract.yaml has no operation row behind this item.
   * The string is the second line, and it names the missing row.
   */
  currentlyNotAvailableBecause: string | null;
  /** What the item does when it sends nothing itself, e.g. opens a board. */
  whatItDoesInsteadOfACall: string | null;
  /** Extra capability ids beyond the wire method's own. */
  extraOps?: OperationId[];
  /** Non-null for a destructive item: the inline confirm strip's text. */
  confirmWith: { callPreview: string; confirmLabel: string } | null;
  /**
   * True for the one item that opens the device's operation mode list in place.
   * The list itself comes from get_device_operation_modes, sent when the menu
   * opens — once per opened menu, never once per row.
   */
  opensTheOperationModeList?: boolean;
  /**
   * What the item does. An item that reaches the host resolves with what the
   * host answered, which the menu prints in place; one that only opens a board
   * resolves with nothing.
   */
  perform: () => void | Promise<void> | Promise<WireCallOutcome | undefined>;
}

export interface TreeRowActionGroup {
  /** Named for what the group holds, so the renderer can key on it. */
  id: "add" | "discovery" | "lock" | "mode" | "update" | "property" | "removal";
  items: TreeRowAction[];
}

/** What a call to the host answered, in the host's own words. */
export interface WireCallOutcome {
  /** The literal request, e.g. `lock_device { node_id: "/dev0" }`. */
  call: string;
  refused: boolean;
  /** The closed-set error code, or null when the call returned. */
  errorCode: string | null;
  /** The host's own detail on a refusal; the literal result line otherwise. */
  detail: string;
}

export interface TreeRowMenuHandlers {
  /** Opens the Add device card grid on this node. Null when the app has none. */
  onOpenAddDeviceBoard: ((nodeId: string) => void) | null;
  onOpenAddFunctionBlockBoard: ((nodeId: string) => void) | null;
  onRemoveFunctionBlock: ((nodeId: string) => void) | null;
  onDisconnectDevice: ((nodeId: string) => void) | null;
  onLockDevice: ((nodeId: string) => Promise<WireCallOutcome>) | null;
  onUnlockDevice:
    | ((nodeId: string, force: boolean) => Promise<WireCallOutcome>)
    | null;
  onSetDeviceOperationMode:
    | ((nodeId: string, mode: string) => Promise<WireCallOutcome>)
    | null;
}

const NO_SUCH_CONTRACT_ROW = (operationName: string, alsoMissing = ""): string =>
  `currently not available: no ${operationName} row in contract/contract.yaml${alsoMissing}`;

/**
 * A server row. The wire's NodeKind is a closed set of five — device, channel,
 * function_block, signal, folder — with no server member, so a host that lists
 * its servers can only put them inside the default `Srv` folder the reference
 * already names. That is what this recognises. No host on this contract emits
 * one yet, so this branch is how a server row WOULD be answered, not a shape
 * anything currently draws.
 */
function sitsInsideTheServersFolder(
  node: Node,
  parentOf: (id: string) => Node | null,
): boolean {
  if (node.parent_id === null) return false;
  const parent = parentOf(node.parent_id);
  return parent !== null && parent.kind === "folder" && parent.name === "Srv";
}

/** The reference's menu_add_items: what this row ACCEPTS. */
function addGroup(
  node: Node,
  isRoot: boolean,
  handlers: TreeRowMenuHandlers,
): TreeRowActionGroup {
  const items: TreeRowAction[] = [];
  const takesDevices = node.kind === "device";
  const takesFunctionBlocks =
    node.kind === "device" ||
    node.kind === "function_block" ||
    node.kind === "channel";

  if (takesDevices && handlers.onOpenAddDeviceBoard !== null) {
    items.push({
      id: "add-device",
      label: `Add a device under ${node.name}`,
      icon: "device",
      wireMethod: "scan_available_devices",
      currentlyNotAvailableBecause: null,
      whatItDoesInsteadOfACall: null,
      extraOps: ["device.connect"],
      confirmWith: null,
      perform: () => handlers.onOpenAddDeviceBoard?.(node.id),
    });
  }

  if (takesFunctionBlocks && handlers.onOpenAddFunctionBlockBoard !== null) {
    items.push({
      id: "add-function-block",
      label: `Add a function block under ${node.name}`,
      icon: "add_function_block",
      wireMethod: "list_function_block_types",
      currentlyNotAvailableBecause: null,
      whatItDoesInsteadOfACall: null,
      confirmWith: null,
      perform: () => handlers.onOpenAddFunctionBlockBoard?.(node.id),
    });
  }

  // The reference: "only the instance takes servers", checked as
  // node.global_id == instance.global_id.
  if (takesDevices && isRoot) {
    items.push({
      id: "add-server",
      label: `Add a server on ${node.name}`,
      icon: "server",
      wireMethod: null,
      currentlyNotAvailableBecause: NO_SUCH_CONTRACT_ROW(
        "add_server",
        ", whose NodeKind has no server member either",
      ),
      whatItDoesInsteadOfACall: null,
      confirmWith: null,
      perform: () => {},
    });
  }

  return { id: "add", items };
}

/** The reference's menu_update_items, both waiting on a contract row. */
function updateGroup(node: Node): TreeRowActionGroup {
  return {
    id: "update",
    items: [
      {
        id: "begin-update",
        label: `Begin update on ${node.name}`,
        icon: "in_update",
        wireMethod: null,
        currentlyNotAvailableBecause: NO_SUCH_CONTRACT_ROW("begin_update"),
        whatItDoesInsteadOfACall: null,
        confirmWith: null,
        perform: () => {},
      },
      {
        id: "end-update",
        label: `End update on ${node.name}`,
        icon: "in_update",
        wireMethod: null,
        currentlyNotAvailableBecause: NO_SUCH_CONTRACT_ROW("end_update"),
        whatItDoesInsteadOfACall: null,
        confirmWith: null,
        perform: () => {},
      },
    ],
  };
}

/** The reference's menu_property_items. */
function propertyGroup(node: Node): TreeRowActionGroup {
  return {
    id: "property",
    items: [
      {
        id: "clear-property-values",
        label: `Clear the property values of ${node.name}`,
        icon: "clear_values",
        wireMethod: null,
        currentlyNotAvailableBecause: NO_SUCH_CONTRACT_ROW(
          "clear_property_values",
        ),
        whatItDoesInsteadOfACall: null,
        confirmWith: null,
        perform: () => {},
      },
    ],
  };
}

function lockGroup(
  node: Node,
  handlers: TreeRowMenuHandlers,
): TreeRowActionGroup {
  const items: TreeRowAction[] = [];
  if (handlers.onLockDevice !== null) {
    items.push({
      id: "lock-device",
      label: `Lock ${node.name}`,
      icon: "lock",
      wireMethod: "lock_device",
      currentlyNotAvailableBecause: null,
      whatItDoesInsteadOfACall: null,
      confirmWith: null,
      perform: () => handlers.onLockDevice?.(node.id),
    });
  }
  if (handlers.onUnlockDevice !== null) {
    items.push({
      id: "unlock-device",
      label: `Unlock ${node.name}`,
      icon: "unlock",
      wireMethod: "unlock_device",
      currentlyNotAvailableBecause: null,
      whatItDoesInsteadOfACall: null,
      confirmWith: null,
      perform: () => handlers.onUnlockDevice?.(node.id, false),
    });
  }
  return { id: "lock", items };
}

function operationModeGroup(
  node: Node,
  handlers: TreeRowMenuHandlers,
): TreeRowActionGroup {
  if (handlers.onSetDeviceOperationMode === null) {
    return { id: "mode", items: [] };
  }
  return {
    id: "mode",
    items: [
      {
        id: "operation-mode",
        label:
          node.operation_mode === null
            ? "Operation mode"
            : `Operation mode: ${node.operation_mode}`,
        icon: "settings",
        wireMethod: "get_device_operation_modes",
        currentlyNotAvailableBecause: null,
        whatItDoesInsteadOfACall: null,
        confirmWith: null,
        opensTheOperationModeList: true,
        perform: () => {},
      },
    ],
  };
}

/** The reference's menu_server_groups. */
function serverGroups(
  node: Node,
  handlers: TreeRowMenuHandlers,
): TreeRowActionGroup[] {
  void handlers;
  return [
    {
      id: "discovery",
      items: [
        {
          id: "enable-discovery",
          label: `Enable discovery on ${node.name}`,
          icon: "discovery",
          wireMethod: null,
          currentlyNotAvailableBecause: NO_SUCH_CONTRACT_ROW("enable_discovery"),
          whatItDoesInsteadOfACall: null,
          confirmWith: null,
          perform: () => {},
        },
        {
          id: "disable-discovery",
          label: `Disable discovery on ${node.name}`,
          icon: "discovery_off",
          wireMethod: null,
          currentlyNotAvailableBecause:
            NO_SUCH_CONTRACT_ROW("disable_discovery"),
          whatItDoesInsteadOfACall: null,
          confirmWith: null,
          perform: () => {},
        },
      ],
    },
    updateGroup(node),
    propertyGroup(node),
  ];
}

/**
 * The groups one row offers, in the reference's order: add, then state, then
 * removal. An empty group is returned as an empty group — the renderer is what
 * drops it, so the separator rule lives in one place.
 *
 * Returns an EMPTY ARRAY for a row that offers nothing, and then no menu opens
 * at all. That is a default openDAQ folder (`Sig`, `FB`, `Dev`, `IP`, `IO`,
 * `Srv`): the reference clears the selection on one of those
 * (`_is_default_folder` → `selection_set('')`) and builds its context menu from
 * the selection, so a default folder never has a menu there either.
 */
export function menuGroupsForTreeRow({
  node,
  isRoot,
  parentOf,
  handlers,
}: {
  node: Node;
  isRoot: boolean;
  parentOf: (id: string) => Node | null;
  handlers: TreeRowMenuHandlers;
}): TreeRowActionGroup[] {
  if (isADefaultFolder(node)) return [];

  if (sitsInsideTheServersFolder(node, parentOf)) {
    return serverGroups(node, handlers);
  }

  const add = addGroup(node, isRoot, handlers);

  if (node.kind === "function_block" || node.kind === "channel") {
    // The reference: "a channel belongs to its device, it cannot be removed on
    // its own", so the removal group is EMPTY for a channel — which is the
    // shortest proof that an empty group draws no separator.
    const removal: TreeRowActionGroup = {
      id: "removal",
      items:
        node.kind === "channel" || handlers.onRemoveFunctionBlock === null
          ? []
          : [
              {
                id: "remove-function-block",
                label: `Remove the function block ${node.name}`,
                icon: "trash",
                wireMethod: "remove_function_block",
                currentlyNotAvailableBecause: null,
                whatItDoesInsteadOfACall: null,
                confirmWith: {
                  callPreview: `remove_function_block { node_id: "${node.id}" }`,
                  confirmLabel: "Send remove_function_block",
                },
                perform: () => handlers.onRemoveFunctionBlock?.(node.id),
              },
            ],
    };
    return [add, updateGroup(node), propertyGroup(node), removal];
  }

  if (node.kind === "device") {
    // Offered on EVERY device row, including the root of what the answer
    // carried: quackoscope-host-cpp answers get_component_tree with the
    // connected device's own subtree, so a rule reading "not the root" hid the
    // item on the only device on screen. Whether a device can be disconnected
    // is the host's ruling, and the host's answer is what gets printed.
    const removal: TreeRowActionGroup = {
      id: "removal",
      items:
        handlers.onDisconnectDevice === null
          ? []
          : [
              {
                id: "disconnect-device",
                label: `Disconnect the device ${node.name}`,
                icon: "unlink",
                wireMethod: "disconnect_device",
                currentlyNotAvailableBecause: null,
                whatItDoesInsteadOfACall: null,
                confirmWith: {
                  callPreview:
                    `disconnect_device { node_id: "${node.id}" }` +
                    (isRoot
                      ? "\n// this device is the root of what get_component_tree returned"
                      : ""),
                  confirmLabel: "Send disconnect_device",
                },
                perform: () => handlers.onDisconnectDevice?.(node.id),
              },
            ],
    };
    return [
      add,
      lockGroup(node, handlers),
      operationModeGroup(node, handlers),
      updateGroup(node),
      propertyGroup(node),
      removal,
    ];
  }

  // The reference's fallback for everything else — a signal, a folder that is
  // not one openDAQ made itself: update items, then property items.
  return [updateGroup(node), propertyGroup(node)];
}

/** The groups that will actually be drawn: the empty ones never appear. */
export function groupsThatHaveItems(
  groups: readonly TreeRowActionGroup[],
): TreeRowActionGroup[] {
  return groups.filter((group) => group.items.length > 0);
}

/** True when this row opens a menu at all. */
export function rowOffersAMenu(groups: readonly TreeRowActionGroup[]): boolean {
  return groupsThatHaveItems(groups).length > 0;
}
