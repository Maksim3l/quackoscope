import { WIRE_ERROR_CODES, type WireErrorCode } from "./types";

/**
 * A host-reported error. `code` is from the closed set; `detail` is opaque
 * native text that the UI shows verbatim and never parses.
 */
export class WireError extends Error {
  readonly code: WireErrorCode;
  readonly detail: string;

  constructor(code: WireErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "WireError";
    this.code = code;
    this.detail = detail;
  }
}

export function isWireErrorCode(v: unknown): v is WireErrorCode {
  return typeof v === "string" && (WIRE_ERROR_CODES as readonly string[]).includes(v);
}

/**
 * Anything off the closed set is a host defect. Surface it as `internal` rather
 * than inventing a new code, and keep the offending text in the detail.
 */
export function toWireError(code: unknown, detail: unknown): WireError {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? null);
  if (isWireErrorCode(code)) return new WireError(code, text);
  return new WireError("internal", `host sent unknown error code ${JSON.stringify(code)}: ${text}`);
}
