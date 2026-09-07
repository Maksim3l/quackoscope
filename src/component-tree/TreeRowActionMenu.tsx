import { Fragment, useEffect, useRef, useState } from "react";
import { capabilityIdsForWireMethod } from "../inspect/capability-ids-for-wire-method";
import { useCapabilityGapsBlocking } from "../session/host-capability-context";
import { OpButton, type OperationId } from "../ui/op";
import { ComponentIcon } from "./component-icon-sprite";
import {
  groupsThatHaveItems,
  type TreeRowAction,
  type TreeRowActionGroup,
  type WireCallOutcome,
} from "./menu-groups-per-node-kind";

/**
 * Decision D7: EVERY tree row carries an action affordance, not just the root.
 *
 * The reference gives inline `plus` and `dots` buttons to the root device only,
 * and says why in its own comment: "only the root device carries buttons …
 * every other row is served by its context menu." That rule is a workaround for
 * a `tk.Label` `place()`d over a Treeview. On the web the cost is a `<button>`
 * inside the row, and the reference's rule has a real cost of its own: an
 * action reachable only by right-click is invisible to the keyboard and to
 * touch.
 *
 * WHAT THIS COMPONENT DOES, and what `menu-groups-per-node-kind.ts` does: that
 * file decides WHICH items a row offers; this one draws them, and owns the
 * three rules `menu_build` owns in the reference — a separator between groups,
 * NO separator for an empty group, and no menu at all for a row whose groups
 * are all empty.
 *
 * Every item names the wire method it will send and carries that method's
 * capability id as its `data-op`, so the quack gesture finds it and a gapped
 * host disables it in one place (src/ui/op.tsx). An item whose operation row
 * does not exist in the contract at all is drawn disabled, naming the row it
 * waits on, because a control that is silently absent teaches nothing.
 */

/** What get_device_operation_modes answered for one device row. */
export interface OperationModeListing {
  /** The literal call, so the panel can name what it sent. */
  call: string;
  /** The modes the host listed, or null when it refused. */
  modes: string[] | null;
  /** The host's own refusal text, or null when the call returned. */
  refusal: string | null;
}

/** Menu width in px. Fixed so the open position can be computed before paint. */
const TREE_ROW_MENU_WIDTH = 360;

export function TreeRowActionMenu({
  rowLabel,
  nodeId,
  currentOperationMode,
  groups,
  anchor,
  onListDeviceOperationModes,
  onSetDeviceOperationMode,
  onUnlockDevice,
  onClose,
}: {
  rowLabel: string;
  nodeId: string;
  /** Node.operation_mode as the row carries it, or null. */
  currentOperationMode: string | null;
  groups: readonly TreeRowActionGroup[];
  /** The ⋯ button the menu hangs off. */
  anchor: HTMLElement | null;
  onListDeviceOperationModes:
    | ((nodeId: string) => Promise<OperationModeListing>)
    | null;
  onSetDeviceOperationMode:
    | ((nodeId: string, mode: string) => Promise<WireCallOutcome>)
    | null;
  onUnlockDevice:
    | ((nodeId: string, force: boolean) => Promise<WireCallOutcome>)
    | null;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState<TreeRowAction | null>(null);
  const [showingOperationModes, setShowingOperationModes] = useState(false);
  const [modeListing, setModeListing] = useState<OperationModeListing | null>(
    null,
  );
  const [outcome, setOutcome] = useState<WireCallOutcome | null>(null);

  const drawn = groupsThatHaveItems(groups);
  const offersTheModeItem = drawn.some((group) => group.id === "mode");
  const deviceModeIsGapped =
    useCapabilityGapsBlocking(["device.mode"]).length > 0;

  /**
   * The AVAILABLE modes are fetched HERE — once, when the menu opens — and not
   * per row. The current mode is a per-row fact and rides on Node.operation_mode
   * instead, which is why contract/contract.yaml keeps the two apart.
   */
  useEffect(() => {
    if (!offersTheModeItem) return;
    if (deviceModeIsGapped) return;
    if (onListDeviceOperationModes === null) return;
    let stillOpen = true;
    void onListDeviceOperationModes(nodeId).then((listing) => {
      if (stillOpen) setModeListing(listing);
    });
    return () => {
      stillOpen = false;
    };
  }, [offersTheModeItem, deviceModeIsGapped, onListDeviceOperationModes, nodeId]);

  /**
   * The menu is positioned in VIEWPORT coordinates rather than inside the row.
   * The tree pane is 320 px wide and scrolls, so a 360 px menu positioned inside
   * a row is clipped by the pane's own `overflow: auto` and pushes a horizontal
   * scrollbar under the tree. `position: fixed` takes it out of that scroll box;
   * the anchor's rect decides where it lands, flipped above the button when
   * there is no room below and pulled left when it would leave the window.
   */
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(
    null,
  );
  useEffect(() => {
    if (anchor === null) return;
    const rect = anchor.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? 200;
    const left = Math.max(
      8,
      Math.min(
        rect.right - TREE_ROW_MENU_WIDTH,
        window.innerWidth - TREE_ROW_MENU_WIDTH - 8,
      ),
    );
    const roomBelow = window.innerHeight - rect.bottom;
    const top =
      roomBelow >= menuHeight + 8 ? rect.bottom + 2 : Math.max(8, rect.top - menuHeight - 2);
    setPlacement({ left, top });
  }, [anchor, confirming, showingOperationModes, outcome, modeListing]);

  // Focus lands on the first item so the menu is usable the instant a keyboard
  // opened it, and Escape hands focus back to the button that opened it.
  useEffect(() => {
    const first = menuRef.current?.querySelector<HTMLElement>(
      "[data-tree-menu-item]:not([disabled])",
    );
    first?.focus();
  }, []);

  useEffect(() => {
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (
        menuRef.current !== null &&
        event.target instanceof globalThis.Node &&
        !menuRef.current.contains(event.target)
      ) {
        onClose();
      }
    };
    // Escape is listened for on the DOCUMENT, not only inside the menu. Focus
    // can legitimately be outside the menu while it is open — clicking an item
    // that swaps the whole menu body leaves focus on a detached node, and then a
    // keydown handler bound to the menu never sees the key.
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    document.addEventListener("keydown", onDocumentKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
    };
  }, [onClose]);

  const moveFocusBy = (step: number) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        "[data-tree-menu-item]:not([disabled])",
      ) ?? [],
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at === -1 ? 0 : (at + step + items.length) % items.length;
    items[next].focus();
  };

  const body = (() => {
    if (confirming !== null && confirming.confirmWith !== null) {
      return (
        <ConfirmStrip
          action={confirming}
          onKeepIt={() => setConfirming(null)}
          onSend={() => {
            void confirming.perform();
            onClose();
          }}
        />
      );
    }
    if (outcome !== null) {
      return (
        <WhatTheHostAnswered
          outcome={outcome}
          canForceTheUnlock={
            outcome.refused &&
            outcome.errorCode === "read_only" &&
            onUnlockDevice !== null
          }
          onForceTheUnlock={() => {
            void onUnlockDevice?.(nodeId, true).then(setOutcome);
          }}
          onBack={() => setOutcome(null)}
        />
      );
    }
    if (showingOperationModes) {
      return (
        <OperationModeList
          listing={modeListing}
          currentOperationMode={currentOperationMode}
          onChoose={(mode) => {
            void onSetDeviceOperationMode?.(nodeId, mode).then(setOutcome);
          }}
          onBack={() => setShowingOperationModes(false)}
        />
      );
    }
    return drawn.map((group, index) => (
      <Fragment key={group.id}>
        {/* menu_build's rule: a separator BETWEEN groups, and never one before
            a group that has no items — those groups are already gone. */}
        {index > 0 && <div className="tree-row-menu-separator" role="separator" />}
        {group.items.map((action) => (
          <MenuItem
            key={action.id}
            action={action}
            modeListing={modeListing}
            onActivate={() => {
              if (action.confirmWith !== null) {
                setConfirming(action);
                return;
              }
              if (action.opensTheOperationModeList === true) {
                setShowingOperationModes(true);
                return;
              }
              const answered = action.perform();
              if (
                answered !== undefined &&
                typeof (answered as Promise<unknown>).then === "function"
              ) {
                void (answered as Promise<unknown>).then((value) => {
                  if (isWireCallOutcome(value)) setOutcome(value);
                  else onClose();
                });
                return;
              }
              onClose();
            }}
          />
        ))}
      </Fragment>
    ));
  })();

  return (
    <div
      ref={menuRef}
      className="tree-row-menu"
      role="menu"
      aria-label={`actions for ${rowLabel}`}
      data-quack-chrome=""
      style={{
        width: `${TREE_ROW_MENU_WIDTH}px`,
        left: placement === null ? -9999 : placement.left,
        top: placement === null ? -9999 : placement.top,
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          moveFocusBy(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          moveFocusBy(-1);
        }
      }}
    >
      {body}
    </div>
  );
}

function isWireCallOutcome(value: unknown): value is WireCallOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    "call" in value &&
    "refused" in value &&
    "detail" in value
  );
}

function MenuItem({
  action,
  modeListing,
  onActivate,
}: {
  action: TreeRowAction;
  modeListing: OperationModeListing | null;
  onActivate: () => void;
}) {
  const secondLine = describeWhatTheItemSends(action, modeListing);

  // An item with no contract row behind it is drawn with aria-disabled rather
  // than `disabled`: a `disabled` button cannot be focused, so the reason it
  // carries would be reachable only by a mouse hover. This stays in the tab
  // order and activating it does nothing, while the reason sits on screen under
  // the label rather than in a tooltip.
  if (action.currentlyNotAvailableBecause !== null) {
    return (
      <button
        type="button"
        role="menuitem"
        className="tree-row-menu-item"
        data-tree-menu-item=""
        data-quack-chrome=""
        data-unavailable=""
        aria-disabled="true"
        title={`${action.label} — ${action.currentlyNotAvailableBecause}`}
        onClick={(event) => event.preventDefault()}
      >
        <ComponentIcon name={action.icon} className="component-icon--menu" />
        <span className="tree-row-menu-lines">
          <span className="tree-row-menu-label">{action.label}</span>
          <span className="tree-row-menu-call mono">{secondLine}</span>
        </span>
      </button>
    );
  }

  return (
    <OpButton
      op={opsForAction(action)}
      role="menuitem"
      className="tree-row-menu-item"
      data-tree-menu-item=""
      title={
        action.wireMethod === null
          ? `${action.label} — ${action.whatItDoesInsteadOfACall ?? "sends nothing"}`
          : `${action.label} — sends ${action.wireMethod}, capability ${capabilityIdsForWireMethod(action.wireMethod).join(" ")}`
      }
      onClick={onActivate}
    >
      <ComponentIcon name={action.icon} className="component-icon--menu" />
      <span className="tree-row-menu-lines">
        <span className="tree-row-menu-label">{action.label}</span>
        {/* The second line is what the item SENDS — never a bare verb. */}
        <span className="tree-row-menu-call mono">{secondLine}</span>
      </span>
      {action.opensTheOperationModeList === true && (
        <ComponentIcon name="right" className="component-icon--menu" />
      )}
    </OpButton>
  );
}

function describeWhatTheItemSends(
  action: TreeRowAction,
  modeListing: OperationModeListing | null,
): string {
  if (action.currentlyNotAvailableBecause !== null) {
    return action.currentlyNotAvailableBecause;
  }
  if (action.opensTheOperationModeList === true) {
    if (modeListing === null) return "sends get_device_operation_modes";
    if (modeListing.modes === null) {
      return `get_device_operation_modes was refused: ${modeListing.refusal ?? ""}`;
    }
    return `${modeListing.modes.length} mode(s) from get_device_operation_modes: ${modeListing.modes.join(", ")}`;
  }
  if (action.wireMethod === null) {
    return action.whatItDoesInsteadOfACall ?? "sends nothing";
  }
  return `sends ${action.wireMethod}`;
}

/**
 * §D16: no message boxes anywhere. A destructive item turns the menu into this
 * strip, which prints the exact call it will send.
 */
function ConfirmStrip({
  action,
  onSend,
  onKeepIt,
}: {
  action: TreeRowAction;
  onSend: () => void;
  onKeepIt: () => void;
}) {
  if (action.confirmWith === null) return null;
  return (
    <div className="tree-row-menu-confirm">
      <p className="tree-row-menu-confirm-question">{action.label}. This sends:</p>
      <code className="mono tree-row-menu-confirm-call">
        {action.confirmWith.callPreview}
      </code>
      <div className="tree-row-menu-confirm-buttons">
        <OpButton
          op={opsForAction(action)}
          className="tree-row-menu-confirm-send"
          data-tree-menu-item=""
          onClick={onSend}
        >
          {action.confirmWith.confirmLabel}
        </OpButton>
        <button
          type="button"
          data-quack-chrome=""
          data-tree-menu-item=""
          onClick={onKeepIt}
        >
          Keep it
        </button>
      </div>
    </div>
  );
}

/**
 * The device's available modes, listed in place rather than as a second popup.
 * The list is what `get_device_operation_modes` answered for THIS node; the
 * mode already in force is the one the row carries on `Node.operation_mode`.
 */
function OperationModeList({
  listing,
  currentOperationMode,
  onChoose,
  onBack,
}: {
  listing: OperationModeListing | null;
  currentOperationMode: string | null;
  onChoose: (mode: string) => void;
  onBack: () => void;
}) {
  return (
    <div className="tree-row-menu-modes">
      <p className="tree-row-menu-panel-heading">
        {listing === null
          ? "get_device_operation_modes is in flight"
          : listing.modes === null
            ? `${listing.call} was refused`
            : `${listing.call} answered with ${listing.modes.length} mode(s)`}
      </p>
      {listing !== null && listing.modes === null && (
        <p className="tree-row-menu-host-text">{listing.refusal}</p>
      )}
      {listing?.modes?.map((mode) => (
        <OpButton
          key={mode}
          op={["device.mode"]}
          role="menuitem"
          className="tree-row-menu-item"
          data-tree-menu-item=""
          data-mode-in-force={mode === currentOperationMode ? "" : undefined}
          title={`sends set_device_operation_mode { mode: "${mode}" }`}
          onClick={() => onChoose(mode)}
        >
          <ComponentIcon
            name={mode === currentOperationMode ? "settings" : "circle"}
            className="component-icon--menu"
          />
          <span className="tree-row-menu-lines">
            <span className="tree-row-menu-label">
              {mode}
              {mode === currentOperationMode ? " — in force now" : ""}
            </span>
            <span className="tree-row-menu-call mono">
              sends set_device_operation_mode {`{ mode: "${mode}" }`}
            </span>
          </span>
        </OpButton>
      ))}
      <button
        type="button"
        className="tree-row-menu-back"
        data-quack-chrome=""
        data-tree-menu-item=""
        onClick={onBack}
      >
        Back to the actions
      </button>
    </div>
  );
}

/**
 * What the host said, in the host's own words, printed where the click was.
 *
 * A refused unlock is the one place this panel offers something more: openDAQ
 * permits an unlock only by the session holding the lock, and answers anyone
 * else `read_only`. That code is the exact signal the reference reacts to by
 * offering `IDevicePrivate.force_unlock()`, which on this wire is
 * `unlock_device` with `force: true`.
 */
function WhatTheHostAnswered({
  outcome,
  canForceTheUnlock,
  onForceTheUnlock,
  onBack,
}: {
  outcome: WireCallOutcome;
  canForceTheUnlock: boolean;
  onForceTheUnlock: () => void;
  onBack: () => void;
}) {
  return (
    <div
      className="tree-row-menu-outcome"
      data-refused={outcome.refused ? "" : undefined}
    >
      <p className="tree-row-menu-panel-heading">
        {outcome.refused
          ? `${outcome.call} was refused with ${outcome.errorCode}`
          : `${outcome.call} returned without error`}
      </p>
      <p className="tree-row-menu-host-text">{outcome.detail}</p>
      <div className="tree-row-menu-confirm-buttons">
        {canForceTheUnlock && (
          <OpButton
            op={["device.lock"]}
            className="tree-row-menu-confirm-send"
            data-tree-menu-item=""
            title={`sends unlock_device with force true, which is openDAQ's IDevicePrivate.force_unlock()`}
            onClick={onForceTheUnlock}
          >
            Send unlock_device with force true
          </OpButton>
        )}
        <button
          type="button"
          data-quack-chrome=""
          data-tree-menu-item=""
          onClick={onBack}
        >
          Back to the actions
        </button>
      </div>
    </div>
  );
}

function opsForAction(action: TreeRowAction): OperationId[] {
  const fromMethod =
    action.wireMethod === null
      ? []
      : capabilityIdsForWireMethod(action.wireMethod);
  const extra = action.extraOps ?? [];
  const all = [...fromMethod, ...extra];
  // An item that sends nothing still has to declare something the quack gesture
  // can name. `tree.read` is what put the row on screen in the first place.
  return all.length === 0 ? ["tree.read"] : Array.from(new Set(all));
}
