export * from "./types";
export { WireError, isWireErrorCode } from "./errors";
export { decodeDataFrame } from "./decode";
export { TransportClient } from "./client";
export type {
  LinkState,
  LinkStatus,
  CallLogEntry,
  NonEnvelopeServerMessage,
} from "./client";

/**
 * In production the host serves the built SPA from "/" on the same origin, so
 * the socket is same-origin. Under the Vite dev server the page is on 1420 and
 * the host is on 7788, so fall back to the fixed contract address.
 * VITE_QUACK_WS overrides both.
 */
export function hostSocketUrl(): string {
  const override = import.meta.env.VITE_QUACK_WS;
  if (typeof override === "string" && override.length > 0) return override;
  if (import.meta.env.DEV) return "ws://127.0.0.1:7788/ws";
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}
