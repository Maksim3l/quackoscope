import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  describeControl,
  operationIdsOf,
  quackableControlsOnPage,
  type QuackedControl,
} from "./quack-gesture";

/**
 * Inspector mode's badges: one duck pinned to every quackable control on the page.
 *
 * The badge is a real button, so a touch screen needs neither a middle button
 * nor a modifier chord — tapping the badge is the whole gesture. It also reaches
 * disabled controls, which never receive mouse events of their own.
 *
 * The layer is portalled to document.body, outside #root, so the DOM the badges
 * add can never feed back into the MutationObserver that watches #root for the
 * layout changes the badges must follow.
 */

interface BadgeAnchor {
  element: HTMLElement;
  left: number;
  top: number;
  operationIds: string[];
  controlDescription: string;
}

const BADGE_OFFSET_PX = 7;

function measureQuackableControls(): BadgeAnchor[] {
  const anchors: BadgeAnchor[] = [];
  for (const element of quackableControlsOnPage()) {
    const rect = element.getBoundingClientRect();
    const offScreen =
      rect.width === 0 ||
      rect.height === 0 ||
      rect.bottom < 0 ||
      rect.right < 0 ||
      rect.top > window.innerHeight ||
      rect.left > window.innerWidth;
    if (offScreen) continue;
    anchors.push({
      element,
      left: Math.min(Math.max(rect.left - BADGE_OFFSET_PX, 2), window.innerWidth - 22),
      top: Math.min(Math.max(rect.top - BADGE_OFFSET_PX, 2), window.innerHeight - 22),
      operationIds: operationIdsOf(element),
      controlDescription: describeControl(element),
    });
  }
  return anchors;
}

export function QuackBadgeLayer({
  onQuack,
}: {
  onQuack: (quacked: QuackedControl) => void;
}) {
  const [anchors, setAnchors] = useState<BadgeAnchor[]>(() =>
    measureQuackableControls(),
  );
  const lastPlacement = useRef<string>("");

  /**
   * A live plot rewrites its own frame counter on every animation frame, and
   * that is a DOM mutation the observer below sees. Re-rendering ~30 badges 60
   * times a second because a number changed elsewhere is pure waste, so a
   * measurement that places every badge exactly where it already is drops here.
   */
  const remeasure = useCallback(() => {
    const measured = measureQuackableControls();
    const placement = measured
      .map((a) => `${a.left},${a.top},${a.operationIds.join(" ")}`)
      .join("|");
    if (placement === lastPlacement.current) return;
    lastPlacement.current = placement;
    setAnchors(measured);
  }, []);

  useEffect(() => {
    let scheduled = 0;
    const remeasureOnNextFrame = () => {
      if (scheduled !== 0) return;
      scheduled = window.requestAnimationFrame(() => {
        scheduled = 0;
        remeasure();
      });
    };

    remeasureOnNextFrame();
    // Capture phase: the component tree and the property grid scroll inside
    // their own panes, not on the window.
    window.addEventListener("scroll", remeasureOnNextFrame, true);
    window.addEventListener("resize", remeasureOnNextFrame);

    const appRoot = document.getElementById("root");
    const observer = new MutationObserver(remeasureOnNextFrame);
    if (appRoot !== null) {
      observer.observe(appRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-op", "class", "style", "disabled"],
      });
    }

    return () => {
      if (scheduled !== 0) window.cancelAnimationFrame(scheduled);
      window.removeEventListener("scroll", remeasureOnNextFrame, true);
      window.removeEventListener("resize", remeasureOnNextFrame);
      observer.disconnect();
    };
  }, [remeasure]);

  return createPortal(
    <div className="quack-badge-layer" data-quack-chrome="">
      {anchors.map((anchor, index) => (
        <button
          key={`${index}:${anchor.operationIds.join(" ")}`}
          className="quack-badge"
          data-quack-chrome=""
          style={{ left: `${anchor.left}px`, top: `${anchor.top}px` }}
          title={`quack ${anchor.controlDescription}: ${anchor.operationIds.join(", ")}`}
          onClick={() =>
            onQuack({
              operationIds: anchor.operationIds as QuackedControl["operationIds"],
              controlDescription: anchor.controlDescription,
              gesture: "inspector mode badge",
            })
          }
        >
          🦆
        </button>
      ))}
    </div>,
    document.body,
  );
}
