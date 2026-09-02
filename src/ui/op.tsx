import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  SelectHTMLAttributes,
} from "react";

/**
 * Operation capability ids.
 *
 * Every interactive element in the app declares which operations it exercises
 * via an `op` prop. Nothing reads this in M1 — it is groundwork for the M2
 * quack gesture (the inspect gesture), and no inspect behaviour is built here.
 *
 * The declared ids are mirrored onto the DOM as `data-op` so a later gesture can
 * find them by hit-testing without a React-side registry.
 */
export type OperationId =
  | "device.connect"
  | "tree.read"
  | "property.read"
  | "property.write"
  | "signal.subscribe"
  | "signal.unsubscribe"
  | "session.reconnect";

export interface OpProps {
  op: OperationId[];
}

function opAttr(op: OperationId[]): string {
  return op.join(" ");
}

export function OpButton({
  op,
  ...rest
}: OpProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button data-op={opAttr(op)} {...rest} />;
}

export function OpInput({
  op,
  ...rest
}: OpProps & InputHTMLAttributes<HTMLInputElement>) {
  return <input data-op={opAttr(op)} {...rest} />;
}

export function OpSelect({
  op,
  ...rest
}: OpProps & SelectHTMLAttributes<HTMLSelectElement>) {
  return <select data-op={opAttr(op)} {...rest} />;
}
