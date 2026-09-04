// quackoscope-host-mock -- transport layer.
//
// RFC 6455 server-side framing, written out by hand so this host has zero
// dependencies and can be lifted onto a platform that performs the WebSocket
// upgrade itself (Vercel, Cloudflare, Deno Deploy). Nothing here knows what a
// device, a property or a signal is.

import { createHash } from "node:crypto";

// RFC 6455 section 1.3. Verified against a known pair: the key
// "dGhlIHNhbXBsZSBub25jZQ==" must hash to "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".
const WEBSOCKET_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function websocketAcceptValueFor(clientKey: string): string {
  return createHash("sha1")
    .update(clientKey + WEBSOCKET_ACCEPT_GUID)
    .digest("base64");
}

export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

export interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  /** Total bytes this frame occupied in the input buffer. */
  bytesConsumed: number;
}

/**
 * Reads one frame off the front of `buffer`, or returns null when the buffer
 * does not yet hold a whole frame. A client frame that is not masked is a
 * protocol violation and is reported as such rather than silently accepted.
 */
export function decodeOneClientFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  if (!masked) {
    throw new Error(
      `client sent an unmasked WebSocket frame (opcode 0x${opcode.toString(16)}); RFC 6455 requires client frames to be masked`,
    );
  }

  let payloadLength = second & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`client announced a ${big} byte WebSocket frame, which this host will not buffer`);
    }
    payloadLength = Number(big);
    offset += 8;
  }

  if (buffer.length < offset + 4) return null;
  const maskingKey = buffer.subarray(offset, offset + 4);
  offset += 4;
  if (buffer.length < offset + payloadLength) return null;

  const payload = Buffer.allocUnsafe(payloadLength);
  for (let i = 0; i < payloadLength; i++) {
    payload[i] = buffer[offset + i] ^ maskingKey[i & 3];
  }
  return { fin, opcode, payload, bytesConsumed: offset + payloadLength };
}

/** Server frames are never masked. */
export function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}
