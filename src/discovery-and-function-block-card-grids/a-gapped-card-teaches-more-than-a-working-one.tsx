import type { MethodName } from "../transport";
import type { OperationId } from "../ui/op";
import { Card } from "../card-grid/Card";
import { cardStateMark, type CardStateMark } from "../card-grid/card-states";
import { FlockForOperation } from "../inspect/FlockColumns";
import {
  CapabilityGapNotice,
  describeGapInOneLine,
  gapPresentationOf,
  shortTagForGap,
} from "../session/CapabilityGapNotice";
import {
  useCapabilityStanding,
  useHostProcessName,
} from "../session/host-capability-context";
import type { CapabilityStanding } from "../session/host-handshake";

/**
 * §3.7 of the design specification: "A gapped card teaches more than a working
 * one."
 *
 *     the card renders, the widget is dead, the meta line carries the gap kind
 *     and the host's own reason, and quacking it shows the call that *would*
 *     have been made and the four languages that would have made it.
 *
 * This matters more on the two surfaces this lane builds than anywhere else in
 * the app, because `scan_available_devices` and the three
 * `list/add/remove_function_block` rows are exactly the ones a host is likely
 * not to serve. `quackoscope-host-mock` serves none of them: its handshake
 * declares `device.scan`, `device.connect` and `function_block.add` as host
 * gaps, each with a reason naming the file and the missing `dispatch()` case.
 *
 * Nothing here decides whether a capability is gapped. That is
 * `computeCapabilityStandings` in src/session/host-handshake.ts, over the
 * baseline in generated/wire/capability-baseline.json minus the ids the host
 * declared — and it is the same computation that disables the control inside
 * the card, in src/ui/op.tsx, for every control in the app at once.
 */

/** The §1.8 state mark for a capability the connected host does not serve. */
export function gappedCardStateMark(
  standing: CapabilityStanding,
  hostProcessName: string,
): CardStateMark {
  return cardStateMark(
    "gapped",
    describeGapInOneLine(standing, hostProcessName),
    gapPresentationOf(standing),
  );
}

/**
 * §1.8's gapped row, in the band it names: "the existing `CapabilityGapNotice`
 * one-liner in place of the meta line, naming the capability, the gap kind and
 * the host's own reason."
 *
 * A card that carries a gapped mark and nothing else says the gap in colour
 * alone, which §1.8 forbids in the same paragraph — "State is carried by the
 * 3 px left border, plus one explicit word. Never by colour alone." So every
 * card in this lane that can be gapped passes this as its
 * `metaLineReplacement`, and the sentence is the same one the disabled
 * control's own `title` carries, from src/session/CapabilityGapNotice.tsx.
 */
export function GapOneLinerInPlaceOfTheMetaLine({
  standing,
  hostProcessName,
}: {
  standing: CapabilityStanding;
  hostProcessName: string;
}) {
  const presentation = gapPresentationOf(standing);
  return (
    <span className={`card-gap-one-liner card-gap-one-liner--${presentation}`}>
      <span className={`gap-tag gap-tag--${presentation}`}>
        {shortTagForGap(standing)}
      </span>
      {describeGapInOneLine(standing, hostProcessName)}
    </span>
  );
}

/**
 * The standing of one capability plus everything a card needs to show it, or
 * null when the host serves it and there is nothing to show.
 */
export function useGapOnThisCapability(capability: OperationId): {
  standing: CapabilityStanding;
  hostProcessName: string;
} | null {
  const standing = useCapabilityStanding(capability);
  const hostProcessName = useHostProcessName();
  if (standing === null || standing.served) return null;
  return { standing, hostProcessName };
}

/**
 * The whole surface, when the call that would populate it cannot be made.
 *
 * It is a card and not a paragraph on purpose: §1.8 says a gapped card keeps
 * its `data-op`, so this one is quackable exactly like a live card, and its
 * back holds the flock for the capability — the call that would have been made,
 * in every language generated/snippets.json carries, visible at rest rather
 * than behind the gesture. §3.6's "empty states are flock cards" and §3.7's
 * "a gapped card teaches more than a working one" are the same card here.
 */
export function TheCallThatWouldHavePopulatedThisGridCard({
  standing,
  hostProcessName,
  capability,
  wireMethod,
  whatIsBlocked,
  whatTheGridWouldHaveHeld,
}: {
  standing: CapabilityStanding;
  hostProcessName: string;
  capability: OperationId;
  /** The row that would have been sent. Printed as the card's title, in mono. */
  wireMethod: MethodName;
  /** The concrete thing the reader cannot do, in the app's own words. */
  whatIsBlocked: string;
  /** "one card per discovered device" — what is missing, named. */
  whatTheGridWouldHaveHeld: string;
}) {
  const operationId = capability;
  return (
    <Card
      cardId={`the-call-that-would-have-populated-this-grid:${wireMethod}`}
      glyph="🚫"
      title={wireMethod}
      titleTooltip={`contract/contract.yaml declares ${wireMethod}; ${hostProcessName} does not serve it`}
      headerChips={[
        { label: shortTagForGap(standing), tone: "plain", title: whatIsBlocked },
      ]}
      metaLineReplacement={
        <CapabilityGapNotice
          standing={standing}
          hostProcessName={hostProcessName}
          whatIsBlocked={whatIsBlocked}
        />
      }
      states={[gappedCardStateMark(standing, hostProcessName)]}
      operationIds={[operationId]}
      calls={[{ wireMethod: wireMethod }]}
      back={{
        reveals: `the ${capability} flock: the openDAQ calls ${wireMethod} would have made`,
        operationIds: [operationId],
        content: <FlockForOperation operationId={capability} />,
      }}
      defaultExpanded
    >
      <p className="gapped-grid-body">
        This grid would have held {whatTheGridWouldHaveHeld}. Nothing is shown
        because nothing was asked: {hostProcessName} does not serve{" "}
        <code className="mono">{capability}</code>, so{" "}
        <code className="mono">{wireMethod}</code> was never sent. The card stays
        here, and stays quackable, because &quot;what would this have called&quot;
        is precisely the question a missing grid raises.
      </p>
    </Card>
  );
}
