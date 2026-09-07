import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  SelectHTMLAttributes,
} from "react";
import { describeGapInOneLine } from "../session/CapabilityGapNotice";
import {
  useCapabilityGapsBlocking,
  useHostProcessName,
} from "../session/host-capability-context";

/**
 * Operation capability ids.
 *
 * Every interactive element in the app declares which operations it exercises
 * via an `op` prop, mirrored onto the DOM as `data-op` so the quack gesture can
 * find it by hit-testing.
 *
 * Since the handshake, that declaration does a second job: a control whose
 * capability the connected host does not serve is DISABLED here, in one place,
 * for every control in the app at once. Nothing needs to be remembered at each
 * call site, and adding a control that declares a gapped capability cannot
 * accidentally stay live.
 *
 * The gate is driven by the COMPUTED gap list — baseline minus declared
 * capabilities — never by a host-supplied gap list, and never by the host's
 * name. `session.reconnect` is not a capability id, so it is never gated:
 * reopening the socket is a client-side action that reaches no SDK.
 */
export type OperationId =
  // The twelve baseline capability ids of contract 4, the same twelve in
  // generated/wire/capability-baseline.json and BASELINE_CAPABILITY_IDS of
  // generated/typescript/contract-types.ts.
  | "device.scan"
  | "device.connect"
  | "tree.read"
  | "property.read"
  | "property.write"
  | "function_block.add"
  | "streaming.decimated"
  | "streaming.raw"
  | "device.mode"
  | "device.lock"
  | "module.read"
  | "module.load"
  // Not a capability id: reopening the WebSocket is a client-side session
  // action that makes no openDAQ call. generated/snippets.json carries that
  // reason so the inspect panel can say so rather than show an empty column.
  | "session.reconnect";

export interface OpProps {
  op: OperationId[];
}

function opAttr(op: OperationId[]): string {
  return op.join(" ");
}

/**
 * The disabled state and the title text a control gets from the gap list.
 * `title` names the capability, the kind of gap and the host's own reason, so
 * hovering a greyed-out control answers "why" without opening a panel.
 */
function useGapGate(
  op: OperationId[],
  disabledByTheCallSite: boolean | undefined,
): { disabled: boolean; title: string | undefined } {
  const blocking = useCapabilityGapsBlocking(op);
  const hostProcessName = useHostProcessName();
  if (blocking.length === 0) {
    return { disabled: disabledByTheCallSite === true, title: undefined };
  }
  return {
    disabled: true,
    title: blocking
      .map((standing) => describeGapInOneLine(standing, hostProcessName))
      .join(" "),
  };
}

export function OpButton({
  op,
  disabled,
  title,
  ...rest
}: OpProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  const gate = useGapGate(op, disabled);
  return (
    <button
      data-op={opAttr(op)}
      data-gapped={gate.title === undefined ? undefined : ""}
      disabled={gate.disabled}
      title={gate.title ?? title}
      {...rest}
    />
  );
}

export function OpInput({
  op,
  disabled,
  title,
  ...rest
}: OpProps & InputHTMLAttributes<HTMLInputElement>) {
  const gate = useGapGate(op, disabled);
  return (
    <input
      data-op={opAttr(op)}
      data-gapped={gate.title === undefined ? undefined : ""}
      disabled={gate.disabled}
      title={gate.title ?? title}
      {...rest}
    />
  );
}

export function OpSelect({
  op,
  disabled,
  title,
  ...rest
}: OpProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const gate = useGapGate(op, disabled);
  return (
    <select
      data-op={opAttr(op)}
      data-gapped={gate.title === undefined ? undefined : ""}
      disabled={gate.disabled}
      title={gate.title ?? title}
      {...rest}
    />
  );
}
