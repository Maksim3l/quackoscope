# Deploying the Quackoscope mock-host sandbox to Vercel

**Status: prepared, not deployed.** Nothing in this repository has been pushed to Vercel. No
project exists, no CLI login was performed, no `vercel deploy` was run. This file plus
`vercel.json` plus `api/quackoscope-mock-host-websocket-endpoint.ts` are inert until a human
decides to deploy.

**What would be deployed:** the Quackoscope SPA built into `dist/`, plus `quackoscope-host-mock`
serving a *synthetic* device over the M1 wire contract. Not openDAQ. See
[The honesty requirement](#the-honesty-requirement-and-the-one-thing-i-could-not-do) — it is a
blocker, not a nicety.

---

## 1. Why only the mock host can go

`quackoscope-host-cpp`, `-python` and `-csharp` load native openDAQ modules out of a local Windows
MSVC build tree. `manifest.json` in this repo records the exact path they load from:

```
module_path = C:/Users/opendaq/Projects/openDAQ/build/x64/msvc-26/full/bin/Release
sdk_version = 3.41.0_bec37b44
```

Vercel Functions run on Linux. Those `.dll` files cannot load there, the build tree is not in the
repository (`.gitignore` refuses every `*.dll`, `*.exe`, `*.lib`, `bin/`, `Release/` by policy),
and there is no Linux openDAQ build to substitute. `quackoscope-host-mock` is the only host with no
SDK in the process at all — its own header says so — so it is the only one that can be lifted.

A Vercel sandbox is therefore **the SPA plus a synthetic device**, and it must say so on screen.

## 2. What the frontend already gets right, and what it does not

The connection target is decided in exactly one place — `src/transport/index.ts`:

```ts
export function hostSocketUrl(): string {
  const override = import.meta.env.VITE_QUACK_WS;
  if (typeof override === "string" && override.length > 0) return override;
  if (import.meta.env.DEV) return "ws://127.0.0.1:7788/ws";
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}
```

`ws://127.0.0.1:7788/ws` is the **dev-server-only** branch. `vite build` sets `import.meta.env.DEV`
to `false`, so a production bundle already derives `wss://<deployment-host>/ws` from
`window.location`. **No change to `src/transport/index.ts` is required, and no environment variable
needs setting.** The one live consumer, `src/App.tsx`, does `new TransportClient(hostSocketUrl())`
and nothing else touches a URL. Grep confirms `7788` appears nowhere else in `src/` except a
comment in `src/transport/types.ts`.

So the platform work is entirely: get `/ws` on the deployment origin to reach the mock host's
service layer.

## 3. What actually has to change

### 3.1 The upgrade handler cannot be the mock host's own (fixed — in the new function)

`hosts/mock-ts/src/transport/websocket-and-static-file-server.ts` cannot be the Vercel entry point
for two concrete reasons:

1. It calls `server.listen(port, address)`. A Vercel Function must `export default server` and never
   listen.
2. Its Origin allow-list is literally
   `[`http://127.0.0.1:${port}`, `http://localhost:${port}`]`. A browser on a deployment sends
   `Origin: https://<deployment>.vercel.app`, which that list refuses with 403. **Every real
   visitor's upgrade would be rejected.**

`api/quackoscope-mock-host-websocket-endpoint.ts` is a new transport layer that reuses the frame
codec, the wire envelope, the `SessionHub` and the synthetic device **unmodified**, and replaces the
Origin check with same-origin-by-comparison: a present `Origin` must have the same host as the
request's `Host` header; an absent `Origin` (a non-browser client) is allowed. That is
deployment-URL agnostic and still refuses a third-party page opening the control plane.

### 3.2 Static serving moves to the CDN

The mock host serves `dist/` itself, with a hand-checked path-escape refusal. On Vercel that whole
path is dead code: `outputDirectory: "dist"` makes the CDN serve the SPA, and the function only ever
answers `/ws`. The rewrite `"/(.*)" -> "/index.html"` reproduces the mock host's SPA fallback.
Note the consequence: the Windows-specific refusals (backslash, drive-letter colon) are no longer
exercised in this deployment — Vercel's static layer is doing that job now, on Linux.

### 3.3 One synthetic device per connection, not per instance

Fluid compute pins **many** WebSocket connections to **one** function instance. The local host
builds a single `SyntheticReferenceDevice` in `start-mock-host.ts` and shares it across sessions —
which on one machine with one user is fine, and on a public URL is not: visitor A ticking *Simulate
a device disconnect* or writing *Waveform shape* would change visitor B's screen. The new entry
point constructs a device and a `SessionHub` **per upgrade**, and `hub.closeSession()` already stops
that session's frame delivery. Cost: one `setInterval` waveform pump per *subscribed* connection.

### 3.4 An idle timeout and a connection cap (M6)

Neither exists in the local host, and on a public URL both are load-bearing. The new entry point
enforces:

| Control | Default | Environment variable |
|---|---|---|
| Idle timeout — no client bytes for this long closes the socket | 120000 ms | `QUACKOSCOPE_MOCK_HOST_IDLE_TIMEOUT_MS` |
| Concurrent sessions per function instance | 32 | `QUACKOSCOPE_MOCK_HOST_MAX_CONCURRENT_SESSIONS_PER_INSTANCE` |

Over the cap the upgrade is refused with `503` and a body naming both numbers. This is a
*per-instance* cap; it is not a global cap, because instances scale out independently and nothing
here shares state (see 5.3).

### 3.5 The mock host and `dist/` are not in git

`git ls-files hosts/mock-ts` returns **nothing** — the whole mock host is untracked
(`git status` shows `?? hosts/mock-ts/`, and also `?? contract/`, `?? generated/`,
`?? src/inspect/`, `?? tools/snippet-extractor/`). `dist` is in `.gitignore`. A Git-backed Vercel
deploy builds from the commit, so **as things stand today a deploy would produce a 404 SPA and a
function that fails to import.** Whoever deploys must first commit `hosts/mock-ts/`, `contract/`,
`generated/`, `src/inspect/`, `tools/snippet-extractor/` and `api/`. I did not commit anything —
those paths belong to other lanes.

## 4. The files I created

| Path | What it is |
|---|---|
| `C:\Users\opendaq\Projects\quackoscope\vercel.json` | Build command, output directory, the `/ws` rewrite, the SPA fallback, function duration and memory |
| `C:\Users\opendaq\Projects\quackoscope\api\quackoscope-mock-host-websocket-endpoint.ts` | The Vercel Function: a node:http server exported (never listened on) with an `upgrade` handler that reuses the mock host's codec, envelope, `SessionHub` and synthetic device |
| `C:\Users\opendaq\Projects\quackoscope\DEPLOYING-THE-MOCK-HOST-SANDBOX-TO-VERCEL.md` | This file |

`vercel.json` in full:

- `buildCommand` repeats the repo's own `build` script inline
  (`pnpm extract-opendaq-snippets-from-host-sources && tsc && vite build`) rather than calling
  `pnpm build`, so that `package.json` needs no edit and the deployment does not silently inherit a
  later change to that script.
- `outputDirectory: "dist"`, `framework: "vite"`.
- `regions: ["iad1"]` — Washington D.C., the cheapest tier ($0.128/CPU-hr, $0.0106/GB-hr) and the
  platform default.
- `functions."api/quackoscope-mock-host-websocket-endpoint.ts": { maxDuration: 300, memory: 2048 }`
  — 300 s is the Hobby maximum and the Pro default; 2048 MB is the Hobby maximum.
- `rewrites`: `/ws` → `/api/quackoscope-mock-host-websocket-endpoint` **before** the
  `/(.*)` → `/index.html` catch-all. Vercel's docs state a WebSocket upgrade "goes through the same
  routing and security controls as other requests … including Routing Middleware, rewrites, Firewall
  rules, and rate limits", so rewriting an upgrade request is a supported path.

## 5. What breaks or degrades

Everything in this section is from Vercel's current documentation, cited inline. Nothing here was
observed on a running deployment, because nothing was deployed.

### 5.1 Connection lifetime — the plot dies on a timer

> "WebSocket connections close when a Vercel Function reaches its maximum duration."
> — `/docs/functions/websockets`

| Plan | Default | Maximum | Extended maximum |
|---|---|---|---|
| Hobby | 300 s | 300 s | — |
| Pro | 300 s | 800 s | 1800 s (beta, function-level config, specific runtime versions) |
| Enterprise | 300 s | 800 s | 1800 s (same beta) |

So on Hobby a visitor watching a live plot is **disconnected every five minutes, unconditionally**.
The frontend's behaviour on that close is already known and is not graceful: `TransportClient.onclose`
fires, `App.tsx` clears `device`, `nodes` and `selectedId`, and the user is dropped back to the
connect screen having lost their tree selection and their subscription. **There is no reconnect
logic in `src/transport/client.ts`** — `connect()` is called once from a `useEffect`. Vercel's docs
explicitly ask for client reconnect-and-resubscribe logic here. That is the largest src/** gap and
it is listed in §7.

### 5.2 Cold starts

An instance is started on the first request and paused after the last in-flight request completes.
A visitor arriving at an idle deployment pays a Node cold start before the upgrade completes. I have
no measured number for this bundle — **unverified**. The bundle is small (no dependencies; the mock
host is dependency-free by design) which argues for a short one, but that is an inference, not a
measurement.

### 5.3 Per-visitor isolation

Fixed at the device level (§3.3): each connection gets its own `SyntheticReferenceDevice`. What is
*not* fixed, and cannot be with in-memory state:

> "New WebSocket connections are not guaranteed to reach the same Vercel Function instance … After a
> new deployment, new connections may reach the new deployment while existing connections remain on
> the previous deployment until they close." — `/docs/functions/websockets`

Every reconnect (including the forced one at 300 s) starts a **brand new synthetic device**: the
tree is re-fetched, every property write the visitor made is gone, subscriptions must be re-made.
For a demo sandbox that is acceptable; it must not be described as a session.

Corollary: `liveSessionCount` and the cap in §3.4 are per-instance and per-deployment. There is no
global connection cap without an external store (Vercel points at Redis from its marketplace).

### 5.4 The idle timeout and connection cap

Implemented (§3.4), but note they are *defences*, not guarantees: an attacker who opens connections
faster than the cap refuses them simply causes Vercel to scale out to more instances — auto-scaling
goes to 30,000 concurrency on Hobby and Pro. The real spend control is Vercel's own Spend Management
and the WAF rate limit on the `/ws` upgrade path (the docs confirm "rate limits apply to each upgrade
request"), not this counter. Set a spend cap before deploying.

Also: Vercel Functions have a limit of **1,024 file descriptors shared across concurrent
executions**, including the runtime's own. Each WebSocket is a descriptor. The per-instance cap of 32
is comfortably inside that; raising it toward the thousands is not.

### 5.5 Binary frames

The data plane is 17-byte-header binary frames, and this is the risk I could not eliminate by
reading alone.

- **What is verified:** Vercel documents `ws`'s `WebSocketServer({ server })` attached to an
  exported `node:http` server as a supported pattern, and `ws` implements that by listening on the
  server's `upgrade` event and taking over the raw socket — exactly what this entry point does by
  hand. `experimental_upgradeWebSocket` documents `maxPayload` defaulting to **262144 bytes**, which
  is *precisely* the contract's `max_frame_bytes` of 262144 — a coincidence worth knowing, because it
  suggests 256 KiB is the platform's own frame ceiling, and the contract sits exactly on it.
- **What is unverified:** that a hand-rolled `upgrade` handler writing its own
  `101 Switching Protocols` and its own RFC 6455 frames survives Vercel's proxy unaltered, and that
  binary opcodes pass through untouched. The docs never say frames are transformed, and a WebSocket
  proxy that rewrote opcodes would break `ws` too — but I did not run it. **If one thing in this plan
  fails on first deploy, expect it to be this.** The fallback is to install `ws` and use
  `WebSocketServer({ server })`, which is what Vercel documents; that requires adding `ws` to
  `package.json`, which I did not touch (§7).

### 5.6 Other things that stop working

- **The handshake.** The mock lane reports the C++ host sends no first message and
  `src/transport/client.ts` drops any text message with neither an `event` string nor a numeric `id`,
  so the handshake is inert. It stays inert here. It cannot carry the "this is synthetic" warning to
  the user.
- **Host logs.** All the mock host's excellent `[transport]`/`[service]`/`[device]` output goes to
  Vercel's runtime logs, not a terminal. Nobody watching the page sees it.
- **`hosts/mock-ts/src/transport/websocket-and-static-file-server.ts` is unexercised** in this
  deployment — including its path-escape refusals, which are the fix for a real past defect. The
  local run remains the only place that code is tested.

## 6. Cost and plan tier

Vercel's documentation, current as fetched today:

- **WebSockets require Fluid compute** to be enabled — the default for projects created on or after
  2025-04-23. WebSocket support is documented as **Public Beta**. The docs page carries a
  "Permissions Required: WebSockets" marker; whether that is an account-level enrollment gate is
  **unverified** — the changelog does not say, and the docs never name a minimum plan.
- **Pricing is ordinary Fluid compute pricing**: Active CPU + Provisioned Memory + Invocations, plus
  Fast Data Transfer and Fast Origin Transfer for bytes over the connection. Crucially, **Provisioned
  Memory bills for the whole instance lifetime, including time spent waiting on I/O**, and a held-open
  WebSocket keeps the instance alive. Idle CPU is free; idle *memory* is not.
- **Hobby includes** 4 hours Active CPU, 360 GB-hrs Provisioned Memory, 1 million Invocations per
  month. Hobby is non-commercial.
- **Pro** bills on demand against a monthly usage credit. In `iad1`: **$0.128 per CPU-hour**,
  **$0.0106 per GB-hour** provisioned memory, **$0.60 per million invocations**.

A worked figure, using the documented rates and this configuration (2 GB, `iad1`) — arithmetic mine,
so treat the conclusion, not the digits, as the point:

> One visitor holding a connection for the full 300 s costs
> `2 GB x 300 s / 3600 x $0.0106` = **$0.0018** in provisioned memory, plus whatever Active CPU the
> 10 Hz waveform pump burns. Fluid compute lets one instance hold many connections, so the memory
> cost is shared, not multiplied — but only up to the concurrency the instance can carry.
> Hobby's 360 GB-hr allowance is roughly 648,000 connection-seconds at 2 GB, i.e. **about 2,100
> full-length visitor sessions a month** before the allowance is gone. That is a demo budget, not a
> product budget.

**Recommendation: Hobby is sufficient for a demo sandbox and its 300 s hard ceiling is the thing you
would actually feel.** Pro buys 800 s connections and a second region, not a different architecture.
Set spend management before the URL is shared.

## 7. What must change in `src/**` and `package.json` — deliberately not touched

Those paths belong to other lanes. Each item below is a request, not an edit.

| Where | Change | Why |
|---|---|---|
| **`src/App.tsx` (or `index.html`)** | **A permanent, always-visible banner: "Synthetic device. No openDAQ SDK is running. This sandbox does not talk to real hardware."** | **Blocking.** A visitor on a public URL will otherwise believe they are driving openDAQ. Nothing I own can put text on that page: `vercel.json` cannot inject a body, the function serves no HTML, and the handshake is dropped by the client. This is the one requirement in my brief I could not satisfy without editing a path I do not own. |
| `src/transport/client.ts` | Reconnect with backoff on `onclose`, and re-subscribe after reopening | §5.1: the 300 s ceiling closes every connection, and today that dumps the user back to the connect screen with no plot |
| `src/transport/index.ts` | Nothing | Already correct — the production branch derives `wss://<host>/ws` from `window.location` |
| `package.json` | Nothing required today. **If** §5.5 fails on first deploy, add `ws` as a dependency and rewrite the entry point around `WebSocketServer({ server })` | Only the documented fallback; the current entry point is dependency-free |
| Repo root | `.node-version` naming the Node major the mock host's `.ts` sources need | See §8 |

## 8. The unverified list, in one place

I ran nothing against Vercel. Specifically **unverified**:

1. **That the build succeeds.** I did not run `pnpm build` — the `extract-opendaq-snippets-from-host-sources`
   step writes into `generated/`, which another lane owns and is actively editing. `tsc` has also not
   been run over `api/`.
2. **That Vercel's bundler resolves the mock host's `.ts` import specifiers.** The mock host is
   written for Node 24's type stripping and imports `./session-hub.ts` *with the extension*. Vercel's
   Node builder compiles TypeScript entry points itself; whether it resolves explicit `.ts`
   specifiers across a relative path out of `api/` into `hosts/mock-ts/` is the second-most-likely
   first-deploy failure after §5.5. Mitigation if it fails: set the Node version via `.node-version`,
   or `includeFiles` the mock host sources.
3. **That binary frames survive the platform's WebSocket path** (§5.5).
4. **Whether "Permissions Required: WebSockets" is a plan gate or an enrollment gate** (§6).
5. **Cold start duration** (§5.2).
6. Every cost figure in §6 beyond the published per-unit rates is my arithmetic.

## 9. Blunt assessment: is this worth doing?

**Yes, narrowly — as a demo of the UI and the wire contract. No, if anyone expects it to demonstrate
openDAQ.**

What you get: a public URL where a stranger can see the tree, the property grid with every
`value_type`, the coerced write, the reshaping write, `component_added`/`removed`, and a live plot
fed by real min/max-envelope binary frames — with no install, no SDK, no Windows. For showing what
Quackoscope *looks and feels like*, that is genuinely valuable and there is no cheaper way to get it.

What you do not get, and what makes me hesitate:

- **The interesting half of this project is the openDAQ integration, and none of it is there.** The
  synthetic device is a schema-complete fake. A visitor learns nothing about whether Quackoscope
  drives real hardware well.
- **The 300 s disconnect is not a rough edge, it is the demo's dominant behaviour.** Until
  `client.ts` reconnects, a visitor who leaves a plot running for five minutes is thrown back to the
  connect screen. Deploying before that reconnect lands would make the sandbox look broken rather
  than impressive.
- **The banner is a hard prerequisite, not a polish item.** A public Quackoscope URL that silently
  serves a fake device is misleading, and the moment it is shared that is out of your hands.
- **The whole thing rests on two unverified platform behaviours** (§8.2, §8.3), either of which
  turns "prepared" into an afternoon of debugging someone else's proxy.

**My recommendation: do not deploy on the strength of this file alone.** Land the banner and the
reconnect first, commit the untracked mock host, then do one throwaway preview deploy to settle §5.5
and §8.2 before any URL is shared with anyone.
