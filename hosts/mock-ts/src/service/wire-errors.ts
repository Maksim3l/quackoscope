// quackoscope-host-mock -- service layer.
//
// The closed error set. A host that puts anything else on the wire is
// defective, so every refusal in this host is constructed through here.

export const WIRE_ERROR_CODES = [
  "not_found",
  "not_connected",
  "invalid_value",
  "read_only",
  "unsupported",
  "timeout",
  "internal",
] as const;

export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];

export class ServiceRefusal extends Error {
  code: WireErrorCode;
  detail: string;

  constructor(code: WireErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ServiceRefusal";
    this.code = code;
    this.detail = detail;
  }
}
