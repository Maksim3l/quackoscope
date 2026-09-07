// quackoscope-host-mock -- transport layer.
//
// One port: the SPA over HTTP from ./dist, and the control plane at /ws.
// Nothing here knows what a device is; it hands text requests to the service
// layer and writes back whatever outcome comes out.
//
// Swapping this file for a platform's own WebSocket upgrade (Vercel, Deno,
// Cloudflare) requires nothing from the layers above it: the service layer only
// ever sees a SessionSocket with sendText / sendBinary.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
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
} from "./websocket-frame-codec.ts";
import { decodeRequest, encodeError, encodeResult } from "./wire-envelope.ts";
import type { SessionHub, SessionSocket } from "../service/session-hub.ts";

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/vnd.microsoft.icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Why a decoded request target cannot name a location under the dist root, or
 * "" when it can. Every one of these is refused BEFORE the join, because on
 * Windows join() throws the left operand away the moment the right one names a
 * root of its own, which would serve any file on the machine over HTTP. Path
 * escape is a fixed defect in this project and is not being reintroduced.
 */
function whyTargetCannotBeUnderDistRoot(decodedTarget: string): string {
  if (decodedTarget.length === 0 || decodedTarget[0] !== "/")
    return 'request target is not a server-relative path beginning with "/"';
  if (decodedTarget.includes("\0")) return "request target contains a NUL byte";
  if (decodedTarget.startsWith("//") || decodedTarget.startsWith("/\\"))
    return "request target is a UNC share reference (it starts with two separators)";
  if (decodedTarget.includes("\\"))
    return "request target contains a backslash, which Windows reads as a path separator";
  if (decodedTarget.includes(":"))
    return 'request target contains ":", which Windows reads as a drive letter or an NTFS stream';
  if (decodedTarget.includes("..")) return 'request target contains a parent-directory hop ".."';
  return "";
}

/**
 * Loopback hostnames, as they appear in a URL's hostname: the whole 127.0.0.0/8
 * block, IPv6 ::1 (URL.hostname keeps the brackets), and the localhost names
 * RFC 6761 reserves for the loopback interface.
 */
function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (ipv4 === null) return false;
  return ipv4.slice(1).every((octet) => Number(octet) <= 255) && Number(ipv4[1]) === 127;
}

/**
 * Why this WebSocket upgrade may not open the control plane, or "" when it may,
 * plus the rule that let it through so the accept can be logged as concretely
 * as the refusal.
 *
 * WebSockets are exempt from the same-origin policy, so without a check here
 * any page the user happened to visit could open this control plane and drive
 * what is behind it. That is a fixed defect in this project and is not being
 * reintroduced. What this host does with the check is narrower than what
 * quackoscope-host-cpp and quackoscope-host-python do with theirs, and for a
 * reason that is specific to this process rather than a general loosening:
 *
 *   * There is no openDAQ SDK here, no module path, no hardware and no
 *     manifest. The whole device is synthesised in
 *     hosts/mock-ts/src/synthetic-device/synthetic-reference-device.ts and
 *     lives in this process's memory. A page that opened this control plane
 *     could write a synthetic waveform amplitude and read a synthetic sine.
 *     There is nothing of the user's behind it to reach.
 *   * This is the host meant to be switched to from a page another host
 *     served -- the backend selector's whole purpose -- and the host meant for
 *     a public sandbox. A rule of "only the two loopback origins on my own
 *     port" refuses both: the selector, because the page came from
 *     :7788; and every real visitor of a deployment, because the browser sends
 *     the deployment's origin. That second failure is already written up in
 *     DEPLOYING-THE-MOCK-HOST-SANDBOX-TO-VERCEL.md section 3.1.
 *
 * So the rule is: same origin by comparison against the Host header the request
 * was actually addressed to (deployment-URL agnostic, and what
 * api/quackoscope-mock-host-websocket-endpoint.ts already does), OR a loopback
 * origin, which is what a page served by another host on this machine has. A
 * page from a non-loopback origin -- the one the fixed defect was about -- is
 * still refused, and a host with a real device behind it should keep the
 * stricter same-origin-only rule.
 */
function whyOriginMayNotOpenTheControlPlane(
  origin: string | undefined,
  addressedHost: string | undefined,
): { refusal: string; acceptedBecause: string } {
  if (typeof origin !== "string" || origin.length === 0) {
    return { refusal: "", acceptedBecause: "it carries no Origin header at all, so it is not a browser page" };
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return {
      refusal: `Origin "${origin}" is not a URL, so no origin can be established from it`,
      acceptedBecause: "",
    };
  }

  if (typeof addressedHost === "string" && addressedHost.length > 0 && originUrl.host === addressedHost) {
    return {
      refusal: "",
      acceptedBecause: `its Origin host "${originUrl.host}" is the Host this request was addressed to, so the page is same-origin`,
    };
  }

  if (isLoopbackHostname(originUrl.hostname)) {
    return {
      refusal: "",
      acceptedBecause:
        `its Origin "${origin}" is on the loopback interface (hostname "${originUrl.hostname}"), so it is a page ` +
        "served by another process on this machine -- the backend selector switching to this host",
    };
  }

  return {
    refusal:
      `Origin "${origin}" is neither the Host this request was addressed to ("${addressedHost ?? "absent"}") nor a ` +
      "loopback origin. quackoscope-host-mock accepts a page it served itself and a page served from loopback; a " +
      "page from anywhere else may not open this control plane",
    acceptedBecause: "",
  };
}

/** True when candidate is the root itself or lies below it, compared path component by path component. */
function pathLiesInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function decodeTarget(rawTarget: string): string {
  const withoutQuery = rawTarget.split(/[?#]/)[0];
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return withoutQuery;
  }
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

export interface HostServerOptions {
  address: string;
  port: number;
  distDirectory: string;
  hub: SessionHub;
}

export async function startWebSocketAndStaticFileServer(options: HostServerOptions): Promise<void> {
  const canonicalDistRoot = resolve(options.distDirectory);

  console.log(
    "[transport] WebSocket Origin policy at /ws: a request with no Origin header is accepted (not a browser page); " +
      "a request whose Origin host equals the Host header it was addressed to is accepted (same origin, so " +
      `http://127.0.0.1:${options.port} and http://localhost:${options.port} for this run, and a deployment host ` +
      "when there is one); a request whose Origin is on the loopback interface (127.0.0.0/8, ::1, localhost) is " +
      "accepted, which is how the backend selector switches to this host from a page another host served; every " +
      "other Origin is refused with 403. This is looser than quackoscope-host-cpp on purpose and only because " +
      "there is no SDK and no hardware in this process -- the device is synthetic.",
  );

  const server = createServer((request, response) => {
    void serveStaticFileFromDist(request, response, canonicalDistRoot);
  });

  server.on("upgrade", (request, socket) => {
    const target = decodeTarget(request.url ?? "");
    if (target !== "/ws") {
      socket.end(`HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nno WebSocket endpoint at ${target}\n`);
      console.error(`[transport] refused a WebSocket upgrade to ${target}: the only endpoint is /ws`);
      return;
    }

    const origin = request.headers.origin;
    const originVerdict = whyOriginMayNotOpenTheControlPlane(origin, request.headers.host);
    if (originVerdict.refusal.length > 0) {
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nquackoscope-host-mock refuses a WebSocket upgrade: ${originVerdict.refusal}\n`,
      );
      console.error(`[transport] refused a WebSocket upgrade at /ws: ${originVerdict.refusal}`);
      return;
    }
    console.log(
      `[transport] Origin check passed for an upgrade to /ws (Origin ${origin ?? "absent"}, Host ${request.headers.host ?? "absent"}): ${originVerdict.acceptedBecause}`,
    );

    const clientKey = request.headers["sec-websocket-key"];
    if (typeof clientKey !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\nmissing Sec-WebSocket-Key\n");
      console.error("[transport] refused a WebSocket upgrade with no Sec-WebSocket-Key header");
      return;
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${websocketAcceptValueFor(clientKey)}\r\n` +
        "Server: quackoscope-host-mock\r\n\r\n",
    );
    socket.setNoDelay(true);

    const describedPeer = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
    const sessionSocket = new WebSocketSessionSocket(socket, describedPeer);
    console.log(`[transport] WebSocket upgrade accepted at /ws from ${describedPeer}`);
    options.hub.openSession(sessionSocket);

    let pendingBytes = Buffer.alloc(0);
    let closed = false;
    const finish = (why: string): void => {
      if (closed) return;
      closed = true;
      options.hub.closeSession(sessionSocket);
      console.log(`[transport] WebSocket from ${describedPeer} finished: ${why}`);
    };

    socket.on("data", (chunk: Buffer) => {
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
        const request2 = decoded.request!;
        const outcome = options.hub.answerRequest(sessionSocket, request2.method, request2.params);
        sessionSocket.sendText(
          outcome.ok
            ? encodeResult(request2.id, outcome.result)
            : encodeError(request2.id, outcome.code!, outcome.detail!),
        );
      }
    });

    socket.on("error", (e) => {
      console.error(`[transport] WebSocket from ${describedPeer} errored: ${String(e)}`);
      finish("socket error");
    });
    socket.on("close", () => finish("the socket closed"));
  });

  await new Promise<void>((settle, fail) => {
    server.once("error", fail);
    server.listen(options.port, options.address, () => {
      server.removeListener("error", fail);
      settle();
    });
  });
}

async function serveStaticFileFromDist(
  request: IncomingMessage,
  response: ServerResponse,
  canonicalDistRoot: string,
): Promise<void> {
  const target = decodeTarget(request.url ?? "/");

  if (request.method !== "GET" && request.method !== "HEAD") {
    respondWithText(request, response, 405, `only GET and HEAD are served; ${request.method} is not\n`);
    return;
  }

  let relative = target;
  if (relative.length === 0 || relative === "/") relative = "/index.html";

  const refusal = whyTargetCannotBeUnderDistRoot(relative);
  if (refusal.length > 0) {
    console.error(`[transport] refused GET ${target}: ${refusal}; the dist root is ${canonicalDistRoot}`);
    respondWithText(
      request,
      response,
      403,
      `quackoscope-host-mock refuses "${target}": ${refusal}.\nOnly files under ${canonicalDistRoot} are served.\n`,
    );
    return;
  }

  const candidate = resolve(join(canonicalDistRoot, relative.slice(1)));
  if (!pathLiesInside(canonicalDistRoot, candidate)) {
    console.error(`[transport] refused GET ${target}: it resolves to ${candidate}, outside ${canonicalDistRoot}`);
    respondWithText(
      request,
      response,
      403,
      `quackoscope-host-mock refuses "${target}": it resolves to ${candidate}, outside ${canonicalDistRoot}\n`,
    );
    return;
  }

  const served = await readFileUnderDistRoot(candidate);
  if (served !== null) {
    respondWithFile(request, response, candidate, served);
    return;
  }

  // SPA fallback: a route with no file extension falls back to the shell.
  const lastSlash = relative.lastIndexOf("/");
  const looksLikeAnAsset = relative.indexOf(".", lastSlash === -1 ? 0 : lastSlash) !== -1;
  if (looksLikeAnAsset) {
    respondWithText(request, response, 404, `not found under ${canonicalDistRoot}: ${target}\n`);
    return;
  }
  const shell = join(canonicalDistRoot, "index.html");
  const shellBytes = await readFileUnderDistRoot(shell);
  if (shellBytes === null) {
    respondWithText(
      request,
      response,
      404,
      `quackoscope-host-mock: no SPA build at "${canonicalDistRoot}".\nThe wire contract is still live on /ws -- build the SPA into that directory.\n`,
    );
    return;
  }
  respondWithFile(request, response, shell, shellBytes);
}

async function readFileUnderDistRoot(candidate: string): Promise<Buffer | null> {
  try {
    const entry = await stat(candidate);
    if (!entry.isFile()) return null;
    return await readFile(candidate);
  } catch {
    return null;
  }
}

function respondWithFile(request: IncomingMessage, response: ServerResponse, path: string, bytes: Buffer): void {
  response.writeHead(200, {
    "content-type": MIME_TYPE_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream",
    "content-length": bytes.length,
    server: "quackoscope-host-mock",
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

function respondWithText(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: string,
): void {
  const bytes = Buffer.from(body, "utf8");
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": bytes.length,
    server: "quackoscope-host-mock",
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}
