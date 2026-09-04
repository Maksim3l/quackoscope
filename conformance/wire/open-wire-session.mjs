// One WebSocket session against a Quackoscope host, addressed by URL and nothing
// else.
//
// This module never reads implementation.name and never branches on which host
// it is talking to. contract.yaml implementation_names says the name is display
// only; the whole point of the conformance harness is that it works out what a
// host can do from the handshake's capability list, not from its identity.
//
// What it records, per session:
//   - every text message in arrival order, so "the handshake is message ordinal
//     1" is an assertion and not an assumption
//   - responses keyed by correlation id
//   - events, which carry no id
//   - binary sample frames, decoded against contract.yaml binary_frame

import { setTimeout as sleep } from "node:timers/promises";

export class WireProtocolViolation extends Error {}

/** Decodes one binary sample frame against the contract's binary_frame block. */
export function decodeSampleFrame(bytes, binaryFrameSpec) {
  const headerBytes = binaryFrameSpec.header_bytes;
  if (bytes.length < headerBytes) {
    return {
      wellFormed: false,
      byteLength: bytes.length,
      reason: `frame is ${bytes.length} bytes, shorter than the ${headerBytes}-byte header contract.yaml binary_frame.header_bytes declares`,
    };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = binaryFrameSpec.byte_order === "little_endian";
  const offsetOf = (name) => binaryFrameSpec.header.find((field) => field.name === name).offset;

  const subscriptionId = view.getUint32(offsetOf("subscription_id"), littleEndian);
  const domainStart = view.getBigUint64(offsetOf("domain_start"), littleEndian);
  const sampleCount = view.getUint32(offsetOf("sample_count"), littleEndian);
  const encoding = view.getUint8(offsetOf("encoding"));

  const encodingSpec = binaryFrameSpec.encodings.find((row) => row.value === encoding);
  if (!encodingSpec) {
    return {
      wellFormed: false,
      byteLength: bytes.length,
      subscriptionId,
      domainStart,
      sampleCount,
      encoding,
      reason: `encoding byte ${encoding} is not one of ${binaryFrameSpec.encodings.map((row) => `${row.value} (${row.name})`).join(", ")}`,
    };
  }

  const valuesPerSample = encodingSpec.payload_value_count === "sample_count" ? 1 : 2;
  const expectedByteLength = headerBytes + sampleCount * valuesPerSample * 8;
  if (bytes.length !== expectedByteLength) {
    return {
      wellFormed: false,
      byteLength: bytes.length,
      subscriptionId,
      domainStart,
      sampleCount,
      encoding,
      encodingName: encodingSpec.name,
      reason:
        `frame is ${bytes.length} bytes; encoding ${encoding} (${encodingSpec.name}) with sample_count ${sampleCount} ` +
        `requires ${headerBytes} header + ${sampleCount} * ${valuesPerSample} * 8 payload = ${expectedByteLength} bytes`,
    };
  }

  // contract.yaml binary_frame.reader_must_copy_payload: the 17-byte header
  // leaves the payload unaligned, so the payload is copied out, never viewed in
  // place.
  const payloadCopy = new Uint8Array(bytes.slice(headerBytes)).buffer;
  const values = new Float64Array(payloadCopy);

  return {
    wellFormed: true,
    byteLength: bytes.length,
    subscriptionId,
    domainStart,
    sampleCount,
    encoding,
    encodingName: encodingSpec.name,
    valuesPerSample,
    values: Array.from(values),
  };
}

export class WireSession {
  constructor(url, contract, options = {}) {
    this.url = url;
    this.contract = contract;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
    this.socket = null;
    this.textMessagesInArrivalOrder = [];
    this.binaryFramesInArrivalOrder = [];
    this.eventsInArrivalOrder = [];
    this.responsesByCorrelationId = new Map();
    this.pendingResolvers = new Map();
    this.malformedTextMessages = [];
    this.nextCorrelationId = 1;
    this.closed = false;
    this.closeInfo = null;
  }

  /**
   * Connects and waits for message ordinal 1, which contract.yaml handshake
   * (contract 1.6) says is the handshake. Returns the raw parsed ordinal-1
   * message without judging it; the handshake sweep does the judging.
   */
  async connectAndReadFirstMessage() {
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    const firstMessage = await new Promise((resolve, reject) => {
      const failIfSlow = setTimeout(() => {
        reject(
          new WireProtocolViolation(
            `no message arrived within ${this.requestTimeoutMs} ms of the WebSocket at ${this.url} opening; contract.yaml handshake.ordinal 1 requires the server to speak first`,
          ),
        );
      }, this.requestTimeoutMs);

      socket.addEventListener("error", () => {
        clearTimeout(failIfSlow);
        reject(new Error(`the WebSocket connection to ${this.url} failed; nothing is listening there, or it refused the upgrade`));
      });
      socket.addEventListener("close", (closeEvent) => {
        this.closed = true;
        this.closeInfo = { code: closeEvent.code, reason: closeEvent.reason };
        clearTimeout(failIfSlow);
        reject(
          new Error(
            `the WebSocket at ${this.url} closed with code ${closeEvent.code} ("${closeEvent.reason}") before sending anything`,
          ),
        );
      });
      socket.addEventListener("message", (messageEvent) => {
        const handled = this.absorbMessage(messageEvent);
        if (this.textMessagesInArrivalOrder.length === 1 && handled.kind === "text") {
          clearTimeout(failIfSlow);
          resolve(handled);
        }
      });
    });

    // From here on, failures are recorded rather than thrown at connect time.
    this.socket.addEventListener("close", (closeEvent) => {
      this.closed = true;
      this.closeInfo = { code: closeEvent.code, reason: closeEvent.reason };
      for (const [correlationId, resolver] of this.pendingResolvers) {
        resolver.reject(
          new WireProtocolViolation(
            `the socket closed (code ${closeEvent.code}) while request id ${correlationId} was still unanswered`,
          ),
        );
      }
      this.pendingResolvers.clear();
    });

    return firstMessage;
  }

  absorbMessage(messageEvent) {
    if (typeof messageEvent.data !== "string") {
      const bytes = new Uint8Array(messageEvent.data);
      const frame = decodeSampleFrame(bytes, this.contract.binaryFrame);
      frame.arrivedAtMs = Date.now();
      this.binaryFramesInArrivalOrder.push(frame);
      return { kind: "binary", frame };
    }

    const text = messageEvent.data;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseFailure) {
      this.malformedTextMessages.push({ text, reason: parseFailure.message });
      this.textMessagesInArrivalOrder.push({ text, parsed: null, parseFailure: parseFailure.message });
      return { kind: "text", text, parsed: null, parseFailure: parseFailure.message };
    }

    const record = { text, parsed, arrivedAtMs: Date.now() };
    this.textMessagesInArrivalOrder.push(record);

    // contract.yaml envelopes: the discriminators are has_key_result,
    // has_key_error and has_key_event, in that vocabulary.
    if (parsed !== null && typeof parsed === "object") {
      if ("event" in parsed) {
        this.eventsInArrivalOrder.push(parsed);
      } else if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
        this.responsesByCorrelationId.set(parsed.id, parsed);
        const resolver = this.pendingResolvers.get(parsed.id);
        if (resolver) {
          this.pendingResolvers.delete(parsed.id);
          resolver.resolve(parsed);
        }
      }
    }
    return { kind: "text", text, parsed };
  }

  /**
   * Sends one request envelope and waits for the response carrying the same
   * correlation id. Returns {id, result} or {id, error} verbatim.
   */
  async request(method, params) {
    if (this.closed) {
      throw new WireProtocolViolation(`cannot send ${method}: the session to ${this.url} is already closed`);
    }
    const correlationId = this.nextCorrelationId++;
    const envelope = { id: correlationId, method, params };
    const answered = new Promise((resolve, reject) => {
      this.pendingResolvers.set(correlationId, { resolve, reject });
      setTimeout(() => {
        if (this.pendingResolvers.has(correlationId)) {
          this.pendingResolvers.delete(correlationId);
          reject(
            new WireProtocolViolation(
              `no response to id ${correlationId} (${method}) within ${this.requestTimeoutMs} ms; every request envelope must be answered with a result or an error carrying the same id`,
            ),
          );
        }
      }, this.requestTimeoutMs);
    });
    this.socket.send(JSON.stringify(envelope));
    return await answered;
  }

  /** Sends a raw text frame with no envelope shaping, for malformed-input sweeps. */
  sendRawText(text) {
    this.socket.send(text);
  }

  eventsSince(index) {
    return this.eventsInArrivalOrder.slice(index);
  }

  framesSince(index) {
    return this.binaryFramesInArrivalOrder.slice(index);
  }

  async waitForFrames(minimumCount, withinMs) {
    const startedAt = Date.now();
    const startedWith = this.binaryFramesInArrivalOrder.length;
    while (this.binaryFramesInArrivalOrder.length - startedWith < minimumCount) {
      if (Date.now() - startedAt > withinMs) break;
      await sleep(25);
    }
    return this.binaryFramesInArrivalOrder.length - startedWith;
  }

  async quietFor(milliseconds) {
    await sleep(milliseconds);
  }

  close() {
    if (this.socket && this.socket.readyState <= 1) this.socket.close(1000, "conformance sweep finished");
  }
}

/** Opens a session, reads message ordinal 1, and hands both back. */
export async function openWireSession(url, contract, options) {
  const session = new WireSession(url, contract, options);
  const firstMessage = await session.connectAndReadFirstMessage();
  return { session, firstMessage };
}
