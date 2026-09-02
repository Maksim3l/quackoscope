import { decodeDataFrame } from "./decode";
import { toWireError, WireError } from "./errors";
import type {
  DataFrame,
  EventName,
  EventPayloads,
  MethodContract,
  MethodName,
} from "./types";

/**
 * The one and only place in the app that touches a WebSocket.
 *
 * Owns: request/response correlation by id, event dispatch, binary frame
 * decoding, and connection lifecycle. Knows nothing about React, and nothing
 * about which host implementation answers.
 */

export type LinkState =
  | "idle"
  | "connecting"
  | "open"
  /** The socket dropped or never came up. The session is invalid; state must be cleared. */
  | "closed";

export interface LinkStatus {
  state: LinkState;
  /** Human-readable reason present when state is "closed". */
  reason: string | null;
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

export interface CallLogEntry {
  seq: number;
  id: number;
  method: string;
  params: unknown;
  at: number;
  durationMs: number | null;
  ok: boolean | null;
  error: { code: string; detail: string } | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class TransportClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private eventHandlers = new Map<string, Set<(payload: never) => void>>();
  private dataHandlers = new Set<(frame: DataFrame) => void>();
  private statusHandlers = new Set<(s: LinkStatus) => void>();
  /** The "pond": the running call log. Nothing renders it in M1 beyond a count. */
  private pond: CallLogEntry[] = [];
  private pondSeq = 0;
  private pondHandlers = new Set<(pond: readonly CallLogEntry[]) => void>();
  private status: LinkStatus = { state: "idle", reason: null };

  constructor(private readonly url: string, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  getStatus(): LinkStatus {
    return this.status;
  }

  getPond(): readonly CallLogEntry[] {
    return this.pond;
  }

  onStatus(handler: (s: LinkStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onPond(handler: (pond: readonly CallLogEntry[]) => void): () => void {
    this.pondHandlers.add(handler);
    return () => this.pondHandlers.delete(handler);
  }

  on<E extends EventName>(
    event: E,
    handler: (payload: EventPayloads[E]) => void,
  ): () => void {
    const existing = this.eventHandlers.get(event);
    const set = existing ?? new Set<(payload: never) => void>();
    if (!existing) this.eventHandlers.set(event, set);
    set.add(handler as (payload: never) => void);
    return () => {
      set.delete(handler as (payload: never) => void);
    };
  }

  onData(handler: (frame: DataFrame) => void): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  /** Opens the socket. Never throws; failure arrives as a "closed" status. */
  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus({ state: "connecting", reason: null });
    let sock: WebSocket;
    try {
      sock = new WebSocket(this.url);
    } catch {
      this.setStatus({ state: "closed", reason: `cannot reach host at ${this.url}` });
      return;
    }
    sock.binaryType = "arraybuffer";
    this.socket = sock;

    sock.onopen = () => {
      if (this.socket !== sock) return;
      this.setStatus({ state: "open", reason: null });
    };
    sock.onerror = () => {
      // onclose always follows; the reason is filled in there.
    };
    sock.onclose = (ev) => {
      if (this.socket !== sock) return;
      this.socket = null;
      const reason =
        ev.reason && ev.reason.length > 0
          ? ev.reason
          : `cannot reach host at ${this.url}`;
      this.failAllPending(new WireError("not_connected", reason));
      this.setStatus({ state: "closed", reason });
    };
    sock.onmessage = (ev) => {
      if (this.socket !== sock) return;
      if (typeof ev.data === "string") this.handleText(ev.data);
      else if (ev.data instanceof ArrayBuffer) this.handleBinary(ev.data);
    };
  }

  /** Closes deliberately. Pending calls reject with not_connected. */
  close(reason = "closed by client"): void {
    const sock = this.socket;
    this.socket = null;
    if (sock) {
      sock.onopen = sock.onclose = sock.onerror = sock.onmessage = null;
      try {
        sock.close();
      } catch {
        /* already gone */
      }
    }
    this.failAllPending(new WireError("not_connected", reason));
    this.setStatus({ state: "closed", reason });
  }

  /** Wipes the call log. Used when a dropped session is reset. */
  clearPond(): void {
    this.pond = [];
    this.emitPond();
  }

  call<M extends MethodName>(
    method: M,
    params: MethodContract[M]["params"],
  ): Promise<MethodContract[M]["result"]> {
    const sock = this.socket;
    if (!sock || sock.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new WireError("not_connected", `no open socket to ${this.url}`),
      );
    }
    const id = this.nextId++;
    const entry: CallLogEntry = {
      seq: ++this.pondSeq,
      id,
      method,
      params,
      at: Date.now(),
      durationMs: null,
      ok: null,
      error: null,
    };
    this.pond.push(entry);
    if (this.pond.length > 500) this.pond.shift();
    this.emitPond();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.settlePond(entry, new WireError("timeout", `${method} did not answer in ${this.timeoutMs} ms`));
        reject(new WireError("timeout", `${method} did not answer in ${this.timeoutMs} ms`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          this.settlePond(entry, null);
          resolve(v as MethodContract[M]["result"]);
        },
        reject: (e) => {
          this.settlePond(entry, e);
          reject(e);
        },
        timer,
        method,
      });

      try {
        sock.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        const err = new WireError("not_connected", String(e));
        this.settlePond(entry, err);
        reject(err);
      }
    });
  }

  // --- internals -----------------------------------------------------------

  private settlePond(entry: CallLogEntry, error: unknown): void {
    entry.durationMs = Date.now() - entry.at;
    entry.ok = error === null;
    entry.error =
      error instanceof WireError ? { code: error.code, detail: error.detail } : null;
    this.emitPond();
  }

  private emitPond(): void {
    if (this.pondHandlers.size === 0) return;
    const snapshot = this.pond.slice();
    for (const h of this.pondHandlers) h(snapshot);
  }

  private setStatus(s: LinkStatus): void {
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }

  private failAllPending(err: WireError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private handleText(text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // a host that sends non-JSON text is defective; drop the frame
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;

    if (typeof m.event === "string") {
      const handlers = this.eventHandlers.get(m.event);
      if (!handlers) return;
      const payload = (m.payload ?? {}) as never;
      for (const h of handlers) h(payload);
      return;
    }

    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);

    if (m.error !== undefined && m.error !== null) {
      const e = m.error as Record<string, unknown>;
      p.reject(toWireError(e.code, e.detail));
    } else {
      p.resolve(m.result);
    }
  }

  private handleBinary(buffer: ArrayBuffer): void {
    let frame: DataFrame;
    try {
      frame = decodeDataFrame(buffer);
    } catch {
      return; // malformed frame: drop rather than kill the session
    }
    for (const h of this.dataHandlers) h(frame);
  }
}

export { WireError } from "./errors";
export type { DataFrame } from "./types";
