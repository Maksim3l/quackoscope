// A minimal RFC 6455 server side: the upgrade handshake and the frame codec.
//
// Node ships a WebSocket CLIENT as a global but no server, and conformance/ has
// no dependencies, so the seeded-fault proxy carries its own. This is not a
// general WebSocket implementation: it speaks exactly what the proxy needs -
// text, binary, close, ping and pong, with continuation frames reassembled -
// and it refuses anything else by name rather than guessing.

import { createHash } from "node:crypto";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export function computeAcceptHeaderValue(secWebSocketKey) {
  return createHash("sha1").update(secWebSocketKey + WEBSOCKET_GUID).digest("base64");
}

export function writeUpgradeResponse(socket, secWebSocketKey) {
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${computeAcceptHeaderValue(secWebSocketKey)}`,
      "",
      "",
    ].join("\r\n"),
  );
}

/** Encodes one unmasked server-to-client frame. */
export function encodeServerFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

export const encodeTextFrame = (text) => encodeServerFrame(OPCODE_TEXT, Buffer.from(text, "utf8"));
export const encodeBinaryFrame = (bytes) => encodeServerFrame(OPCODE_BINARY, bytes);
export const encodeCloseFrame = (code, reason) => {
  const reasonBytes = Buffer.from(reason ?? "", "utf8");
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeServerFrame(OPCODE_CLOSE, payload);
};
export const encodePongFrame = (payload) => encodeServerFrame(OPCODE_PONG, payload);

/**
 * Accumulates bytes from one client socket and calls back with whole messages.
 * onMessage({kind: "text"|"binary", text?, bytes?}), onControl({kind, payload}).
 */
export class ClientFrameReader {
  constructor({ onMessage, onControl, onProtocolFailure }) {
    this.buffered = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.onMessage = onMessage;
    this.onControl = onControl;
    this.onProtocolFailure = onProtocolFailure;
  }

  absorb(chunk) {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    for (;;) {
      const frame = this.takeOneFrame();
      if (frame === null) return;
      this.dispatch(frame);
    }
  }

  takeOneFrame() {
    const buffer = this.buffered;
    if (buffer.length < 2) return null;
    const isFinal = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const isMasked = (buffer[1] & 0x80) !== 0;
    let payloadLength = buffer[1] & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (buffer.length < offset + 2) return null;
      payloadLength = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buffer.length < offset + 8) return null;
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.onProtocolFailure(`a client frame declared a payload of ${big} bytes, which this proxy will not buffer`);
        return null;
      }
      payloadLength = Number(big);
      offset += 8;
    }

    let maskKey = null;
    if (isMasked) {
      if (buffer.length < offset + 4) return null;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    } else {
      // RFC 6455 section 5.1: every client-to-server frame is masked.
      this.onProtocolFailure(`a client frame with opcode 0x${opcode.toString(16)} arrived unmasked; RFC 6455 5.1 requires client frames to be masked`);
      return null;
    }

    if (buffer.length < offset + payloadLength) return null;
    const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    this.buffered = buffer.subarray(offset + payloadLength);
    return { isFinal, opcode, payload };
  }

  dispatch(frame) {
    if (frame.opcode === OPCODE_CLOSE || frame.opcode === OPCODE_PING || frame.opcode === OPCODE_PONG) {
      this.onControl({ kind: frame.opcode === OPCODE_CLOSE ? "close" : frame.opcode === OPCODE_PING ? "ping" : "pong", payload: frame.payload });
      return;
    }
    if (frame.opcode === OPCODE_CONTINUATION) {
      if (this.fragmentOpcode === null) {
        this.onProtocolFailure("a continuation frame arrived with no fragmented message in progress");
        return;
      }
      this.fragments.push(frame.payload);
    } else if (frame.opcode === OPCODE_TEXT || frame.opcode === OPCODE_BINARY) {
      this.fragmentOpcode = frame.opcode;
      this.fragments = [frame.payload];
    } else {
      this.onProtocolFailure(`opcode 0x${frame.opcode.toString(16)} is not one this proxy speaks (text 0x1, binary 0x2, close 0x8, ping 0x9, pong 0xa)`);
      return;
    }
    if (!frame.isFinal) return;
    const whole = Buffer.concat(this.fragments);
    const opcode = this.fragmentOpcode;
    this.fragmentOpcode = null;
    this.fragments = [];
    this.onMessage(opcode === OPCODE_TEXT ? { kind: "text", text: whole.toString("utf8") } : { kind: "binary", bytes: whole });
  }
}
