// Vercel Function entry point for quackoscope-host-mock.
//
// INERT UNTIL SOMEONE DEPLOYS. Nothing in this file runs on a developer
// machine; `node api/quackoscope-mock-host-websocket-endpoint.ts` would create
// a server and never listen on it. Vercel's Node.js runtime imports this
// module and drives the exported node:http server itself. Locally the mock
// host is still started by hosts/mock-ts/src/start-mock-host.ts.
//
// This is the transport layer and nothing else. It reuses, unchanged:
//   hosts/mock-ts/src/transport/websocket-frame-codec.ts  (RFC 6455 framing)
//   hosts/mock-ts/src/transport/wire-envelope.ts          (JSON envelope)
//   hosts/mock-ts/src/service/session-hub.ts              (the seven operations)
//   hosts/mock-ts/src/synthetic-device/...                (the synthetic device)
// It does NOT reuse hosts/mock-ts/src/transport/websocket-and-static-file-server.ts,
// for two reasons that are specific to this platform:
//   1. That function calls server.listen(). A Vercel Function must export the
//      server without listening.
//   2. Its Origin allow-list is literally http://127.0.0.1:<port> and
//      http://localhost:<port>. On a Vercel deployment the browser sends
//      Origin: https://<deployment-host>, which that list refuses, so every
//      upgrade from a real visitor would be rejected with 403. The policy here
//      is same-origin-by-comparison instead: the Origin's host must equal the
//      Host header of the upgrade request. That is deployment-URL agnostic and
//      still refuses a third-party page opening this control plane.
//
// Static files are NOT served here. On Vercel the built SPA in dist/ is served
// by the CDN as static output; this function only ever answers /ws.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
  decodeOneClientFrame,
  encodeServerFrame,
  OPCODE_BINARY,
  OPCODE_CLOSE,
  OPCODE_PING,
  OPCODE_PONG,
  OPCODE_TEXT,
  websocketAcceptValueFor,
} from "../hosts/mock-ts/src/transport/websocket-frame-codec.ts";
import {
  decodeRequest,
  encodeError,
  encodeResult,
} from "../hosts/mock-ts/src/transport/wire-envelope.ts";
import {
  HOST_IMPLEMENTATION_NAME,
  HOST_IMPLEMENTATION_VERSION,
  MAX_FRAME_BYTES,
  MAX_SUBSCRIPTIONS,
  PROTOCOL_VERSION,
  SessionHub,
  type SessionSocket,
} from "../hosts/mock-ts/src/service/session-hub.ts";
import { SyntheticReferenceDevice } from "../hosts/mock-ts/src/synthetic-device/synthetic-reference-device.ts";

/**
 * A Vercel Function instance is shared: Fluid compute pins many WebSocket
 * connections to one instance. These two numbers are what stops one visitor
 * from spending the whole instance's memory and CPU. They are the M6 idle
 * timeout and connection cap, enforced here in the transport layer because
 * this is the only layer that knows what a connection is.
 */
const IDLE_TIMEOUT_MS = readPositiveIntegerFromEnvironment("QUACKOSCOPE_MOCK_HOST_IDLE_TIMEOUT_MS", 120_000);
const MAX_CONCURRENT_SESSIONS_PER_INSTANCE = readPositiveIntegerFromEnvironment(
  "QUACKOSCOPE_MOCK_HOST_MAX_CONCURRENT_SESSIONS_PER_INSTANCE",
  32,
);

function readPositiveIntegerFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(
      `[transport] ${name}="${raw}" is not a positive integer; using the built-in ${fallback} instead`,
    );
    return fallback;
  }
  return parsed;
}

class WebSocketSessionSocket implements SessionSocket {
  readonly describedPeer: string;
  private socket: Duplex;

  constructor(socket: Duplex, describedPeer: string) {
    this.socket = socket;
    this.describedPeer = describedPeer;
  }

  sendText(text: string): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeServerFrame(OPCODE_TEXT, Buffer.from(text, "utf8")));
  }

  sendBinary(bytes: Buffer): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeServerFrame(OPCODE_BINARY, bytes));
  }

  sendPong(payload: Buffer): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeServerFrame(OPCODE_PONG, payload));
  }
}

/**
 * "" when this upgrade may proceed, otherwise the literal reason it may not.
 * An absent Origin is a non-browser client and is allowed; a present Origin
 * must name the same host the request was addressed to.
 */
function whyUpgradeIsRefused(request: IncomingMessage): string {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return "";
  const addressedHost = request.headers.host;
  if (typeof addressedHost !== "string" || addressedHost.length === 0) {
    return `the upgrade carries Origin "${origin}" but no Host header, so same-origin cannot be established`;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return `Origin "${origin}" is not a URL`;
  }
  if (originHost !== addressedHost) {
    return `Origin "${origin}" (host "${originHost}") is not the host this request was addressed to ("${addressedHost}"); only same-origin pages may open this control plane`;
  }
  return "";
}

let liveSessionCount = 0;

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  // Every non-upgrade request that reaches this function is a mistake in the
  // routing, so say exactly that rather than 404-ing silently.
  const body =
    `${HOST_IMPLEMENTATION_NAME} ${HOST_IMPLEMENTATION_VERSION} answers WebSocket upgrades only.\n` +
    `This request was ${request.method ?? "?"} ${request.url ?? "?"} with no Upgrade: websocket header.\n` +
    `The SPA is served as static output by the CDN; the control plane is the WebSocket at /ws, ` +
    `which vercel.json rewrites to /api/quackoscope-mock-host-websocket-endpoint.\n`;
  const bytes = Buffer.from(body, "utf8");
  response.writeHead(426, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": bytes.length,
    server: HOST_IMPLEMENTATION_NAME,
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
});

server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
  const addressedPath = (request.url ?? "").split(/[?#]/)[0];
  const describedPeer = `${request.socket.remoteAddress}:${request.socket.remotePort}`;

  const refusal = whyUpgradeIsRefused(request);
  if (refusal.length > 0) {
    socket.end(
      `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${HOST_IMPLEMENTATION_NAME} refuses this upgrade: ${refusal}\n`,
    );
    console.error(`[transport] refused a WebSocket upgrade from ${describedPeer}: ${refusal}`);
    return;
  }

  const clientKey = request.headers["sec-websocket-key"];
  if (typeof clientKey !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\nmissing Sec-WebSocket-Key\n");
    console.error(`[transport] refused a WebSocket upgrade from ${describedPeer} with no Sec-WebSocket-Key header`);
    return;
  }

  if (liveSessionCount >= MAX_CONCURRENT_SESSIONS_PER_INSTANCE) {
    socket.end(
      `HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\n${HOST_IMPLEMENTATION_NAME}: this function instance already holds ${liveSessionCount} of ${MAX_CONCURRENT_SESSIONS_PER_INSTANCE} allowed WebSocket sessions\n`,
    );
    console.error(
      `[transport] refused a WebSocket upgrade from ${describedPeer}: ${liveSessionCount} of ${MAX_CONCURRENT_SESSIONS_PER_INSTANCE} allowed sessions are already live on this instance`,
    );
    return;
  }

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${websocketAcceptValueFor(clientKey)}\r\n` +
      `Server: ${HOST_IMPLEMENTATION_NAME}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  // One synthetic device per connection, not one per instance. Fluid compute
  // puts many visitors on one instance; a shared device would let one visitor's
  // "Simulate a device disconnect" or coerced write reach every other visitor's
  // screen. The device is cheap to build and its waveform pump only starts on a
  // subscription.
  const device = new SyntheticReferenceDevice();
  const hub = new SessionHub(device);
  const sessionSocket = new WebSocketSessionSocket(socket, describedPeer);
  liveSessionCount++;
  console.log(
    `[transport] WebSocket upgrade accepted at ${addressedPath} from ${describedPeer}; ` +
      `device ${device.getDeviceNode().id} built for this session alone; ` +
      `${liveSessionCount} of ${MAX_CONCURRENT_SESSIONS_PER_INSTANCE} sessions live on this instance`,
  );
  hub.openSession(sessionSocket);

  let pendingBytes = Buffer.alloc(0);
  let closed = false;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (why: string): void => {
    if (closed) return;
    closed = true;
    if (idleTimer !== null) clearTimeout(idleTimer);
    hub.closeSession(sessionSocket);
    liveSessionCount--;
    console.log(
      `[transport] WebSocket from ${describedPeer} finished: ${why}; ${liveSessionCount} session(s) still live on this instance`,
    );
  };
  const restartIdleCountdown = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log(
        `[transport] closing the WebSocket from ${describedPeer}: it sent nothing for ${IDLE_TIMEOUT_MS} ms`,
      );
      socket.end(encodeServerFrame(OPCODE_CLOSE, Buffer.alloc(0)));
      finish(`idle for ${IDLE_TIMEOUT_MS} ms`);
    }, IDLE_TIMEOUT_MS);
  };
  restartIdleCountdown();

  socket.on("data", (chunk: Buffer) => {
    restartIdleCountdown();
    pendingBytes = Buffer.concat([pendingBytes, chunk]);
    for (;;) {
      let frame;
      try {
        frame = decodeOneClientFrame(pendingBytes);
      } catch (e) {
        console.error(`[transport] dropping the WebSocket from ${describedPeer}: ${String(e)}`);
        socket.destroy();
        finish("protocol violation in a client frame");
        return;
      }
      if (frame === null) return;
      pendingBytes = pendingBytes.subarray(frame.bytesConsumed);

      if (frame.opcode === OPCODE_CLOSE) {
        socket.end(encodeServerFrame(OPCODE_CLOSE, Buffer.alloc(0)));
        finish("the client sent a close frame");
        return;
      }
      if (frame.opcode === OPCODE_PING) {
        sessionSocket.sendPong(frame.payload);
        continue;
      }
      if (frame.opcode === OPCODE_PONG) continue;
      if (frame.opcode === OPCODE_BINARY) continue; // the client side of the data plane is not used in M1
      if (frame.opcode !== OPCODE_TEXT) continue;

      const text = frame.payload.toString("utf8");
      const decoded = decodeRequest(text);
      if (decoded.errorEnvelope !== undefined) {
        sessionSocket.sendText(decoded.errorEnvelope);
        continue;
      }
      const wireRequest = decoded.request!;
      const outcome = hub.answerRequest(sessionSocket, wireRequest.method, wireRequest.params);
      sessionSocket.sendText(
        outcome.ok
          ? encodeResult(wireRequest.id, outcome.result)
          : encodeError(wireRequest.id, outcome.code!, outcome.detail!),
      );
    }
  });

  socket.on("error", (e) => {
    console.error(`[transport] WebSocket from ${describedPeer} errored: ${String(e)}`);
    finish("socket error");
  });
  socket.on("close", () => finish("the socket closed"));
});

console.log(
  `[function] ${HOST_IMPLEMENTATION_NAME} ${HOST_IMPLEMENTATION_VERSION} loaded as a Vercel Function; ` +
    `node ${process.version} on ${process.platform}`,
);
console.log(
  `[function] protocol ${PROTOCOL_VERSION}, limits max_subscriptions ${MAX_SUBSCRIPTIONS}, max_frame_bytes ${MAX_FRAME_BYTES}`,
);
console.log(
  `[function] idle timeout ${IDLE_TIMEOUT_MS} ms, at most ${MAX_CONCURRENT_SESSIONS_PER_INSTANCE} concurrent sessions per instance, one synthetic device per session`,
);
console.log(
  `[function] sdk none: the device is synthetic, no openDAQ module is loaded and no real hardware is reachable from here`,
);

export default server;
