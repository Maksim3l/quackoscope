// quackoscope-host-mock -- transport layer.
//
// JSON envelope encode/decode and the 17-byte binary data-frame header, byte
// for byte the same shapes hosts/cpp/src/transport/wire.cpp writes. Nothing
// here knows what a device is.

export interface WireRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface RequestOutcome {
  ok: boolean;
  result?: unknown;
  code?: string;
  detail?: string;
}

export function encodeResult(id: number, result: unknown): string {
  return JSON.stringify({ id, result: result === undefined ? null : result });
}

export function encodeError(id: number, code: string, detail: string): string {
  return JSON.stringify({ id, error: { code, detail } });
}

/**
 * Returns the decoded request, or a complete error envelope ready to send back.
 * A request whose id cannot be read gets id 0, exactly as the C++ host does,
 * because there is nothing else to correlate it with.
 */
export function decodeRequest(text: string): { request?: WireRequest; errorEnvelope?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { errorEnvelope: encodeError(0, "invalid_value", `request is not valid JSON: ${String(e)}`) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { errorEnvelope: encodeError(0, "invalid_value", "request is not a JSON object") };
  }
  const envelope = parsed as Record<string, unknown>;
  const id = typeof envelope.id === "number" ? envelope.id : 0;
  if (typeof envelope.method !== "string") {
    return { errorEnvelope: encodeError(id, "invalid_value", 'request is missing a string "method"') };
  }
  const params =
    typeof envelope.params === "object" && envelope.params !== null && !Array.isArray(envelope.params)
      ? (envelope.params as Record<string, unknown>)
      : {};
  return { request: { id, method: envelope.method, params } };
}

export const DATA_FRAME_HEADER_BYTES = 17;

/**
 * Little-endian, 17 bytes, then the payload doubles:
 *   uint32 subscription_id
 *   uint64 domain_start
 *   uint32 sample_count
 *   uint8  encoding      (0 = raw, 1 = min_max_envelope)
 */
export function encodeDataFrame(
  subscriptionId: number,
  domainStart: bigint,
  sampleCount: number,
  encoding: number,
  payload: Float64Array,
): Buffer {
  const frame = Buffer.allocUnsafe(DATA_FRAME_HEADER_BYTES + payload.length * 8);
  frame.writeUInt32LE(subscriptionId, 0);
  frame.writeBigUInt64LE(domainStart, 4);
  frame.writeUInt32LE(sampleCount, 12);
  frame.writeUInt8(encoding, 16);
  for (let i = 0; i < payload.length; i++) {
    frame.writeDoubleLE(payload[i], DATA_FRAME_HEADER_BYTES + i * 8);
  }
  return frame;
}
