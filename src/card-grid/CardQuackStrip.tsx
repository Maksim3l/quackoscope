import { createContext, useContext, type ReactNode } from "react";
import type { CallLogEntry, MethodName } from "../transport";
import { capabilityIdsForWireMethod } from "../inspect/capability-ids-for-wire-method";
import {
  quackForOneNamedCall,
  useQuackRequest,
} from "../inspect/quack-request-context";
import type { OperationId } from "../ui/op";

/**
 * The quack strip of the design specification's §3.2: the bottom band of every
 * card face, permanent, never hover-revealed.
 *
 *     🦆  set_property_value · property.write   ×3
 *
 * Four things, all of them already in the codebase and none of them
 * reimplemented here:
 *   - the duck, the gesture's own mark, which QuackBadgeLayer already uses;
 *   - the wire method name in mono, the literal string that goes on the socket,
 *     typed `MethodName` so a method the transport does not have will not compile;
 *   - the capability id, from src/inspect/capability-ids-for-wire-method.ts —
 *     the one place the wire vocabulary and the capability vocabulary meet, and
 *     the file that makes an unmapped method a compile error;
 *   - a count of pond entries this card produced this session, so a card that
 *     has actually been exercised is visibly different from one that has not.
 *
 * The strip carries `data-quack-chrome`, per §3.2, so it never becomes a quack
 * target itself and the card stays operable while inspector mode is on. Chrome
 * is never a quack target, so clicking a line cannot go through the pointer
 * gesture: it calls `showQuack` from src/inspect/quack-request-context.ts
 * instead, naming the one operation the line prints.
 */

/** One openDAQ call a card can make. §2.7's add-server card declares two. */
export interface CardCall {
  /** The literal wire method. `set_property_value`, not "write". */
  wireMethod: MethodName;
  /**
   * §3.5: the parameters this call will send, with their current values, each
   * already formatted as one line — `connection_string = "daq.opcua://…"`. This
   * is what turns a draft card's commit button into a call preview, so it is
   * printed on draft cards and left off cards that only re-send what is already
   * on screen.
   */
  parameterPreview?: readonly string[];
  /**
   * Which pond entries this card produced. The pond logs `method` and `params`;
   * only the card knows that `node_id: "dev0"` + `property_id: "SampleRate"` is
   * its own call. Without a predicate the count falls back to matching the
   * method alone, and the strip's title says so rather than overclaiming.
   */
  pondEntryIsThisCards?: (entry: CallLogEntry) => boolean;
}

export interface CardQuackStripPond {
  entries: readonly CallLogEntry[];
  /**
   * §3.4, card → pond: the `×3` narrows the pond pane to that card's calls.
   * Optional because a surface can wire the pond's entries without wiring the
   * filter; when it is absent the count is text with a title saying the link is
   * not wired, not a button that does nothing.
   */
  showTheseEntriesInThePond?: (
    entries: readonly CallLogEntry[],
    describedAs: string,
  ) => void;
}

const CardQuackStripPondContext = createContext<CardQuackStripPond | null>(null);

/**
 * Hands the session's pond to every quack strip below it. Without it the strips
 * still render — the wire method and the capability id are static facts — and
 * they say plainly that no pond is wired rather than printing a `×0` they cannot
 * stand behind.
 */
export function CardQuackStripPondProvider({
  pond,
  children,
}: {
  pond: CardQuackStripPond;
  children: ReactNode;
}) {
  return (
    <CardQuackStripPondContext.Provider value={pond}>
      {children}
    </CardQuackStripPondContext.Provider>
  );
}

export function usePondForCardQuackStrips(): CardQuackStripPond | null {
  return useContext(CardQuackStripPondContext);
}

function entriesThisCardProduced(
  pond: readonly CallLogEntry[],
  call: CardCall,
): readonly CallLogEntry[] {
  const belongs =
    call.pondEntryIsThisCards ??
    ((entry: CallLogEntry) => entry.method === call.wireMethod);
  return pond.filter(
    (entry) => entry.method === call.wireMethod && belongs(entry),
  );
}

export function CardQuackStrip({
  calls,
  cardTitle,
}: {
  calls: readonly CardCall[];
  /** Named in the quack the strip raises, which is what the flock prints back. */
  cardTitle: string;
}) {
  const pond = usePondForCardQuackStrips();
  const showQuack = useQuackRequest();

  const lines = calls.map((call) => ({
    call,
    capabilityIds: capabilityIdsForWireMethod(call.wireMethod),
  }));

  return (
    <footer className="card-quack-strip" data-quack-chrome="">
      {lines.map(({ call, capabilityIds }) => (
        <QuackStripLine
          key={call.wireMethod}
          call={call}
          capabilityIds={capabilityIds}
          pond={pond}
          onOpenFlock={
            showQuack === null
              ? null
              : (capabilityId) =>
                  showQuack(
                    quackForOneNamedCall(
                      capabilityId,
                      cardTitle,
                      call.wireMethod,
                    ),
                  )
          }
        />
      ))}
    </footer>
  );
}

function QuackStripLine({
  call,
  capabilityIds,
  pond,
  onOpenFlock,
}: {
  call: CardCall;
  capabilityIds: readonly OperationId[];
  pond: CardQuackStripPond | null;
  /** null when no inspect layer is mounted above this grid; said, not hidden. */
  onOpenFlock: ((capabilityId: OperationId) => void) | null;
}) {
  const mine = pond === null ? null : entriesThisCardProduced(pond.entries, call);
  const countIsExact = call.pondEntryIsThisCards !== undefined;

  return (
    <div className="card-quack-line">
      <span className="card-quack-duck" aria-hidden="true">
        🦆
      </span>

      {capabilityIds.length === 0 ? (
        <span className="card-quack-unmapped mono" title={`src/inspect/capability-ids-for-wire-method.ts maps no capability id to ${call.wireMethod}`}>
          {call.wireMethod} · no capability id mapped
        </span>
      ) : (
        capabilityIds.map((capabilityId) => (
          <button
            key={capabilityId}
            type="button"
            className="card-quack-call mono"
            data-quack-chrome=""
            disabled={onOpenFlock === null}
            title={
              onOpenFlock === null
                ? `no inspect layer is mounted above this grid, so the flock for ${capabilityId} cannot be opened from here`
                : `open the flock for ${capabilityId}: the openDAQ calls behind ${call.wireMethod}, in every language generated/snippets.json carries`
            }
            onClick={() => onOpenFlock?.(capabilityId)}
          >
            <span className="card-quack-method">{call.wireMethod}</span>
            <span className="card-quack-separator" aria-hidden="true">
              ·
            </span>
            <span className="card-quack-capability">{capabilityId}</span>
          </button>
        ))
      )}

      <span className="card-quack-spacer" />

      {mine === null ? (
        <span
          className="card-quack-count card-quack-count--no-pond"
          title="this grid is not wired to the call log, so this card cannot count the calls it made"
        >
          ×?
        </span>
      ) : pond?.showTheseEntriesInThePond === undefined ? (
        <span
          className="card-quack-count mono"
          title={
            `${mine.length} call${mine.length === 1 ? "" : "s"} to ${call.wireMethod} from this card this session` +
            (countIsExact
              ? ", matched to this card by its own parameters"
              : ", matched by wire method only — this card declared no parameter predicate, so another card's call to the same method is counted here too")
          }
        >
          ×{mine.length}
        </span>
      ) : (
        <button
          type="button"
          className="card-quack-count mono"
          data-quack-chrome=""
          title={`show these ${mine.length} calls to ${call.wireMethod} in the call log`}
          onClick={() =>
            pond.showTheseEntriesInThePond?.(
              mine,
              `${call.wireMethod} calls from this card`,
            )
          }
        >
          ×{mine.length}
        </button>
      )}

      {call.parameterPreview !== undefined &&
        call.parameterPreview.length > 0 && (
          <ul className="card-quack-parameters mono">
            {call.parameterPreview.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
    </div>
  );
}
