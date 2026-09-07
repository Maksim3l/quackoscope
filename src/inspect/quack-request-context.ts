import { createContext, useContext } from "react";
import type { OperationId } from "../ui/op";
import type { QuackedControl } from "./quack-gesture";

/**
 * The seam a control uses to open the flock without performing the gesture.
 *
 * The quack gesture (middle click, the chord, a tap in inspector mode) finds its
 * subject by hit-testing `data-op` in the DOM. That works for anything a pointer
 * can land on — but a card's quack strip carries `data-quack-chrome`, per §3.2 of
 * the design specification, so that the card stays operable while inspector mode
 * is on. Chrome is never a quack target, so the strip cannot quack itself.
 *
 * Before this context existed, `CardQuackStrip` worked around that by rendering
 * one zero-size `<span data-op="…">` per call outside its own chrome subtree and
 * dispatching a synthetic middle-button `auxclick` on it. That is gone: the strip
 * now names the operation it wants and calls `showQuack` directly.
 *
 * `QuackInspectorProvider` supplies this. A tree without one gets `null`, and a
 * caller must then say so on screen rather than rendering a control that does
 * nothing.
 */
export const QuackRequestContext = createContext<
  ((quacked: QuackedControl) => void) | null
>(null);

export function useQuackRequest(): ((quacked: QuackedControl) => void) | null {
  return useContext(QuackRequestContext);
}

/**
 * The quack a card's strip raises: one named operation, described the way the
 * flock panel will print it back.
 */
export function quackForOneNamedCall(
  operationId: OperationId,
  cardTitle: string,
  wireMethod: string,
): QuackedControl {
  return {
    operationIds: [operationId],
    controlDescription: `the ${cardTitle} card's ${wireMethod} call`,
    gesture: "card quack strip",
  };
}
