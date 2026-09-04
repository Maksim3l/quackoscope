import type { ReactNode } from "react";
import { Card } from "../card-grid/Card";
import type { CardCall } from "../card-grid/CardQuackStrip";
import { cardStateMark } from "../card-grid/card-states";
import { ComponentIcon } from "../component-tree/component-icon-sprite";
import { FlockForOperation } from "../inspect/FlockColumns";
import type { OperationId } from "../ui/op";
import {
  describeTheRowInOneLine,
  type ContractRowThisGridIsWaitingOn,
} from "./contract-rows-these-grids-wait-on";

/**
 * §3.7's gapped card, for the one gap §3.7 does not describe.
 *
 * The design specification's gapped card is a card whose CAPABILITY the
 * connected host does not serve: `CapabilityGapNotice` renders it, the host's
 * own declared reason is printed verbatim, and `useGapGate` in src/ui/op.tsx
 * disables the control. Every part of that machinery starts from a
 * `CapabilityStanding`, and a standing is computed as the contract's baseline
 * minus the host's declared capabilities.
 *
 * These cards have no standing to compute, because the capability is not in the
 * baseline either. `input_port.read`, `input_port.write` and `signal.describe`
 * are not among contract/contract.yaml's eight, so no host anywhere can declare
 * them and no host is at fault for their absence. Saying "host gap" here would
 * be exactly the invented cause the user's ruling forbids. So this card says the
 * only thing that was actually established: which row of the operation table is
 * missing, which section of the design specification asked for it, and what the
 * reader therefore cannot see.
 *
 * It is still §1.8's `gapped` state and it still takes the dashed gap border, in
 * the `undeclared` presentation — nobody declared anything, because there was
 * nobody to declare it.
 *
 * It is still quackable, and that is the point §3.7 makes: the card carries
 * `data-op` for the capability that DID run — usually `tree.read`, the
 * `get_component_tree` call whose answer established the absence — so quacking
 * it shows the call that was actually made, in four languages, beside the row
 * that was not.
 */
export function CardWaitingOnAContractRow({
  cardId,
  title,
  /** The rows this surface needs. The first one names the card's state. */
  rows,
  /** What the reader would be looking at if the rows existed. */
  whatThisSurfaceWouldShow,
  /**
   * The call that DID run and established the absence — `get_component_tree`
   * for the port and signal grids. Printed on the quack strip, which types its
   * wire method as `MethodName`, so a missing method could not be put there
   * even by mistake.
   */
  establishedBy,
  operationIds,
  /**
   * The part of the surface that needs no contract row and therefore works
   * today — §2.7's candidate signal list is the whole example. Rendered inside
   * the card, live, so the reader can see which half is already possible.
   */
  theHalfThatWorksToday,
  defaultExpanded = false,
}: {
  cardId: string;
  title: string;
  rows: readonly ContractRowThisGridIsWaitingOn[];
  whatThisSurfaceWouldShow: string;
  establishedBy: CardCall;
  operationIds: readonly OperationId[];
  theHalfThatWorksToday?: ReactNode;
  defaultExpanded?: boolean;
}) {
  const first = rows[0];
  return (
    <Card
      cardId={cardId}
      glyph={<ComponentIcon name="unlink" />}
      title={title}
      titleTooltip={describeTheRowInOneLine(first)}
      headerChips={[
        {
          label: "waiting on the contract",
          tone: "plain",
          title:
            "not a host gap: the capability is absent from contract/contract.yaml's baseline, " +
            "so no host could have declared it and no host is at fault.",
        },
      ]}
      states={[
        cardStateMark(
          "gapped",
          describeTheRowInOneLine(first),
          // "undeclared" and not "host": nobody declared this gap, because the
          // capability the host would have declared it against does not exist.
          "undeclared",
        ),
      ]}
      metaLineReplacement={
        <span className="card-gap-one-liner card-gap-one-liner--undeclared">
          <span className="gap-tag gap-tag--undeclared">contract gap</span>
          {whatThisSurfaceWouldShow}
        </span>
      }
      operationIds={operationIds}
      calls={[establishedBy]}
      back={{
        reveals:
          operationIds.length === 0
            ? "the rows this surface is waiting on"
            : `the ${operationIds[0]} flock: the call that established this absence`,
        operationIds,
        content:
          operationIds.length === 0 ? (
            <p className="muted">
              This card names no capability that exists, so there is no flock to
              show beside it.
            </p>
          ) : (
            <FlockForOperation operationId={operationIds[0]} />
          ),
      }}
      defaultExpanded={defaultExpanded}
    >
      <div className="contract-row-gap-body">
        <ol className="contract-rows-waited-on">
          {rows.map((row) => (
            <li key={row.wireMethodThatDoesNotExist}>
              <code className="mono contract-row-method">
                {row.wireMethodThatDoesNotExist}
              </code>
              <span className="contract-row-capability mono">
                {row.capabilityIdThatDoesNotExist}
              </span>
              <span className="contract-row-where">
                {row.designSpecificationRow === null
                  ? "no row proposed"
                  : `proposed: ${row.designSpecificationRow}`}
              </span>
              <span className="contract-row-returns">
                would return {row.whatItWouldReturn}
              </span>
              <span className="contract-row-missing">
                {row.whatIsMissingWithoutIt}
              </span>
            </li>
          ))}
        </ol>

        {theHalfThatWorksToday !== undefined && (
          <div className="the-half-that-works-today">
            {theHalfThatWorksToday}
          </div>
        )}
      </div>
    </Card>
  );
}
