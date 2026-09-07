import { useState, type ReactNode } from "react";
import type { MethodName } from "../transport";
import type { OperationId } from "../ui/op";
import type { CardCall } from "../card-grid/CardQuackStrip";
import { cardStateMark, type CardStateMark } from "../card-grid/card-states";
import { WireError } from "../transport";
import { OpButton } from "../ui/op";

/**
 * §3.5 of the design specification, "the draft card *is* the call preview —
 * the strongest gesture in the design", implemented as one type and one
 * control.
 *
 *     A dialog's OK button says "OK". A draft card's commit button says
 *     connect_device, and its quack strip can list the parameters it will send
 *     with their current values.
 *
 * The mechanism that makes that a guarantee rather than a decoration is here:
 * a `DraftedCall` is ONE object holding the wire method, the capability id and
 * the params, and all three consumers read that same object —
 *
 *   * `previewLinesOfDraftedCall` renders the parameter lines on the card face;
 *   * `quackStripLineForDraftedCall` hands the same lines to §3.2's strip, so
 *     quacking the card before pressing it shows the call with these values;
 *   * `DraftCallCommit`'s button sends that object and nothing else.
 *
 * There is no second copy of the params for the preview to drift from. A card
 * that shows `connection_string = "daq.opcua://192.168.1.44:4840"` and then
 * sends something else is not a bug that can be written against this type: the
 * preview is a projection of the argument the send is given.
 */

export interface DraftedCall {
  /** The literal string that goes on the socket, from the contract's operation table. */
  wireMethod: MethodName;
  /** The capability the row belongs to. Drives `data-op` and the gap gate. */
  capability: OperationId;
  /**
   * Exactly the params object the transport will JSON.stringify. Written in the
   * contract's own parameter order, because the preview prints it in insertion
   * order and a reader comparing the card to contract/contract.yaml should find
   * the same order in both.
   */
  params: Record<string, unknown>;
  /**
   * Why this draft cannot be sent yet, in the app's own words — `type a
   * connection string first`, not "invalid". Empty string means it can be sent.
   */
  refusalBeforeSending: string;
}

/**
 * `connection_string = "daq.opcua://192.168.1.44:4840"`, one line per param,
 * values as JSON so a string is quoted and a number is not — which is exactly
 * how they cross the wire.
 */
export function previewLinesOfDraftedCall(call: DraftedCall): string[] {
  const names = Object.keys(call.params);
  if (names.length === 0) {
    return [`${call.wireMethod} takes no parameters`];
  }
  return names.map((name) => `${name} = ${JSON.stringify(call.params[name])}`);
}

/**
 * The literal text the transport will send, minus the correlation id, which
 * `TransportClient.call` assigns at send time from its own counter.
 */
export function wireEnvelopePreviewOfDraftedCall(call: DraftedCall): string {
  return JSON.stringify({ method: call.wireMethod, params: call.params });
}

/** §3.2's strip line for a draft card: the method, its capability, its values. */
export function quackStripLineForDraftedCall(call: DraftedCall): CardCall {
  return {
    wireMethod: call.wireMethod,
    parameterPreview: previewLinesOfDraftedCall(call),
  };
}

/** What happened to the last send from one draft card. */
export type DraftCallOutcome =
  | { state: "never-sent" }
  | { state: "sending" }
  | { state: "answered"; sentence: string }
  | { state: "refused"; code: string; detail: string };

export const NEVER_SENT: DraftCallOutcome = { state: "never-sent" };

/**
 * §1.8's `rejected` row for a draft card: the wire code, then the host's
 * opaque detail verbatim. Nothing is reworded and nothing is swallowed.
 */
export function cardStateMarksForDraftCallOutcome(
  outcome: DraftCallOutcome,
): CardStateMark[] {
  if (outcome.state === "refused") {
    return [cardStateMark("rejected", `${outcome.code}: ${outcome.detail}`)];
  }
  return [];
}

/** The wire code and detail of any failure, without inventing either. */
export function describeSendFailure(error: unknown): {
  code: string;
  detail: string;
} {
  if (error instanceof WireError) {
    return { code: error.code, detail: error.detail };
  }
  if (error instanceof Error) {
    return { code: error.name, detail: error.message };
  }
  return { code: "internal", detail: String(error) };
}

/**
 * The band that turns a card into a call preview, and the one commit control
 * §2.0 allows a creating grid: "labelled with the wire method it will send —
 * connect_device, add_function_block, add_server — never OK".
 *
 * `OpButton` brings the gap gate with it, so a draft whose capability the
 * connected host does not serve is disabled here for the same reason and with
 * the same sentence as every other control in the app (§3.7). The preview
 * stays visible while it is disabled, which is the whole point of §3.7: the
 * call that WOULD have been made is the teachable thing.
 */
export function DraftCallCommit({
  call,
  outcome,
  onSend,
  discard,
  children,
}: {
  call: DraftedCall;
  outcome: DraftCallOutcome;
  onSend: (call: DraftedCall) => void;
  /** §2.0: "an × that discards the draft". Absent on a card that is not discardable. */
  discard?: { label: string; onDiscard: () => void };
  /** Extra body content shown above the preview — the input a typed draft edits. */
  children?: ReactNode;
}) {
  const [envelopeShown, setEnvelopeShown] = useState(false);
  const lines = previewLinesOfDraftedCall(call);
  const sending = outcome.state === "sending";

  return (
    <div className="draft-call">
      {children}

      <div className="draft-call-preview" data-quack-chrome="">
        <div className="draft-call-preview-head">
          <span className="draft-call-preview-label">
            about to send · nothing has gone to the host yet
          </span>
          <button
            type="button"
            className="draft-call-envelope-toggle mono"
            data-quack-chrome=""
            aria-expanded={envelopeShown}
            title={
              envelopeShown
                ? "hide the wire envelope"
                : "show the literal JSON that goes on the wire, minus the correlation id assigned at send time"
            }
            onClick={() => setEnvelopeShown(!envelopeShown)}
          >
            {envelopeShown ? "▾" : "▸"} wire envelope
          </button>
        </div>

        <ul className="draft-call-parameters mono">
          <li className="draft-call-method">{call.wireMethod}</li>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        {envelopeShown && (
          <pre className="draft-call-envelope mono">
            {wireEnvelopePreviewOfDraftedCall(call)}
          </pre>
        )}
      </div>

      <div className="draft-call-controls">
        <OpButton
          op={[call.capability]}
          className="draft-call-commit mono"
          disabled={sending || call.refusalBeforeSending.length > 0}
          title={
            call.refusalBeforeSending.length > 0
              ? call.refusalBeforeSending
              : `send ${call.wireMethod} with ${lines.join(", ")}`
          }
          onClick={(event) => {
            event.stopPropagation();
            onSend(call);
          }}
        >
          {sending ? `${call.wireMethod} — sent, waiting` : call.wireMethod}
        </OpButton>

        {discard !== undefined && (
          <button
            type="button"
            className="draft-call-discard"
            title={discard.label}
            onClick={(event) => {
              event.stopPropagation();
              discard.onDiscard();
            }}
          >
            ×
          </button>
        )}
      </div>

      {call.refusalBeforeSending.length > 0 && (
        <p className="draft-call-refusal">{call.refusalBeforeSending}</p>
      )}

      {outcome.state === "answered" && (
        <p className="draft-call-answered" role="status">
          {outcome.sentence}
        </p>
      )}
    </div>
  );
}
