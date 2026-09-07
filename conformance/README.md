# conformance/ — the Quackoscope wire conformance harness

A wire-level suite that runs against ANY host by URL and never learns which host
it is talking to. It reads `contract/contract.yaml` at run time — the capability
baseline, the 19 operations, the closed error set, the five events, the record
types, the handshake shape and the binary frame layout — and judges whatever
answers on the socket against that. Nothing in this directory hand-writes a
capability id, a wire method name or an error code.

## Run it against a URL

```
node conformance/run-wire-conformance-against-url.mjs --url ws://127.0.0.1:7813/ws
```

Options: `--contract <path>` (default `contract/contract.yaml`), `--manifest <path>`
(default `manifest.json`), `--connection-string <s>` (default `daqref://device0`;
replaced by a scan result when the host serves `device.scan`), `--report <path.json>`,
`--request-timeout-ms <n>`.

Exit codes: `0` no failures, `1` failures, `2` could not run (nothing listening,
a reserved port, an unreadable contract).

The suite starts no host. It refuses ports 7788, 7789, 7791 and 7801–7810
outright, because a live demo and other work hold them on this machine.

## Start a host and run it in one command

```
node conformance/start-host-then-run-wire-conformance.mjs --host mock   --port 7813
node conformance/start-host-then-run-wire-conformance.mjs --host rust   --port 7814 --report rust.json
node conformance/start-host-then-run-wire-conformance.mjs --host csharp --port 7815 --report csharp.json
```

`--host` is one of `mock`, `cpp`, `python`, `csharp`, `rust`. This launcher is the
only file here that knows a host is a program with a command line; the suite
itself does not import it. `--port` must be in 7811–7830, the launcher refuses to
attach to a listener it did not start, and it stops exactly the process it
started.

## The two failure classes

This split is the whole reason the harness exists.

| verdict | meaning | counts as |
|---|---|---|
| `held` | asserted and true | pass |
| `gap_declared_and_consistent` | **class (a)** the host did not claim the capability, and the operation is indeed refused | pass |
| `capability_claimed_and_broken` | **class (b)** the host listed the capability in its handshake and then broke the operation | **failure** |
| `handshake_nonconformant` | the handshake does not match contract 1.6, so its capability list cannot be trusted to classify anything | **failure** |
| `wire_protocol_broken` | a rule binding every host: handshake ordinal, envelope shape, the closed error set | **failure** |
| `gap_declared_but_served` | the host called the capability a gap and served it anyway — under-claiming | warning |
| `suite_coverage_incomplete` | an operation of `contract.yaml` this run put on no socket and wrote no assertion about — **this suite's fault, not the host's** | **failure** |
| `not_provokable_by_a_wire_client` | e.g. `internal` and `timeout`, which no well-formed request can force | not a verdict |
| `unconstrained_by_the_contract` | e.g. event occurrence, which the contract never requires | not a verdict |

A host that declares every baseline capability as a gap passes. A host that
advertises everything and fails does not.

## The coverage guard: an operation added to the contract cannot go unasked

```
--- the coverage guard: did this run drive every operation in the contract? ---
operation coverage: 19 of 19 driven
```

Every table this harness produces is built out of ledger entries, and a ledger
records nothing at all about a row nobody asked. So a suite that skips an
operation does not produce a gap, a warning or a failure — it produces silence,
and silence reads as "fine". That is not hypothetical: `contract.yaml` grew six
operations after the sweeps were written — `get_device_operation_modes`,
`set_device_operation_mode`, `lock_device`, `unlock_device`,
`list_loaded_modules`, `load_module_from_host_path` — and every host was reported
against a third of the contract that nothing ever put on a socket.

`sweeps/require-every-contract-operation-to-be-driven.mjs` runs after every sweep
and requires, per operation of `contract.yaml`, that **a request was actually
sent** — counted inside `WireSession` at the moment the frame goes out, so no
list a sweep keeps of its own can claim coverage the wire never saw — **and** that
at least one ledger entry names it. The one honest way to be uncovered is an
explicit `not_provokable_by_a_wire_client` entry, which costs a printed reason in
the report. Anything else is `suite_coverage_incomplete`: exit 1 for the suite,
exit 1 for the cross-host report, and a verdict that names conformance/ rather
than the host, because a host cannot be judged on a row nobody asked it.

To watch it fire, add a row to a copy of the contract and point the suite at it:

```
node conformance/start-host-then-run-wire-conformance.mjs --host mock --port 7813 \
  --contract /path/to/contract-with-a-twentieth-operation.yaml
```

```
  FAIL SUITE COVERAGE   every one of the 20 operations in contract.yaml was put on the socket and judged
                        actual: 19 of 20 driven. NEVER DRIVEN: get_device_health (capability device.mode):
                        0 request(s) sent, 0 ledger entry/entries.
```

## Compare two hosts — and the refusal

```
node conformance/compare-host-conformance-reports.mjs rust.json csharp.json
```

It **refuses** (exit 3, no table produced) when the `sdk.commit` values of two
hosts that loaded an openDAQ differ from each other or from `manifest.json`. A
behavioural difference between hosts built against different openDAQ commits
might be a version difference wearing a host's name; reporting it as a host
difference would be a lie of omission.

A host that loaded **no** openDAQ at all — `hosts/mock-ts` reports `sdk.version
"none (synthetic device, no openDAQ SDK is loaded)"` and `sdk.commit "none"` — is
not one of those disagreements and does not refuse the run. It is *reported
alongside*: its column is printed and marked `(no SDK)`, and it is counted in
neither the capability-difference nor the wire-method-difference tally. Both
consumers of the gate read the same rule, in
`decide-whether-hosts-share-the-manifest-opendaq-build.mjs`; a host that reports
`sdk.commit "none"` while naming a real `sdk.version` is an SDK-loading host
withholding its commit, and still refuses.

## Seed a fault, to see the harness catch one

```
node conformance/start-host-then-run-wire-conformance.mjs --host mock --port 7817 \
  --through-seeded-fault-proxy-on-port 7818 \
  --proxy-declare every-baseline-capability \
  --proxy-break-method set_property_value --proxy-break-as refuse-with-internal
```

`conformance/seeded-fault-proxy/` sits between the suite and a real host and
misrepresents that host on purpose. Every byte still comes from a running host;
only what it *says about itself*, and optionally one operation's answer, is
changed.

- `--proxy-declare every-baseline-capability` — claim every baseline capability `contract.yaml` declares (12 today), declare no gaps
- `--proxy-declare no-capability-at-all` — claim nothing, declare every one of them as a gap
- `--proxy-declare as-upstream-sent-it` — leave the handshake alone
- `--proxy-break-method <wire method>` with `--proxy-break-as refuse-with-internal`
  or `--proxy-break-as strip-a-required-field`
- `--proxy-misreport-sdk-commit-as <commit>` — rewrite the handshake's
  `sdk.commit` and leave `sdk.version` alone, so a host that really did load the
  manifest's openDAQ tells its consumer it loaded another one. This is how the
  refusal above is shown firing on a genuine version disagreement between two
  real SDK hosts.

`--port` and `--through-seeded-fault-proxy-on-port` must sit inside the launcher's
port window, `7811-7830` by default; `--port-range <first>-<last>` moves that
window when those ports are not yours to bind.

## Files

```
run-wire-conformance-against-url.mjs         the suite; takes a URL, knows no host
start-host-then-run-wire-conformance.mjs     starts a host, runs the suite, stops the host
compare-host-conformance-reports.mjs         cross-host comparison, with the sdk.commit refusal
decide-whether-hosts-share-the-manifest-opendaq-build.mjs
                                             the one copy of the sdk.commit rule: who is compared
                                             as an equal, who is reported alongside, who refuses
contract/read-wire-contract-yaml.mjs         reads contract/contract.yaml
wire/open-wire-session.mjs                   the WebSocket session and the binary frame decoder
wire/validate-record-against-contract-type.mjs   record shapes against contract `types`
sweeps/conformance-ledger.mjs                the verdict vocabulary and the two failure classes
sweeps/judge-response-envelope.mjs           envelope shape and the two error-code rules
sweeps/sweep-handshake-against-contract-1-6.mjs
sweeps/sweep-every-contract-operation.mjs
sweeps/sweep-device-operation-mode-device-lock-and-modules.mjs
                                             device.mode, device.lock, module.read and module.load; opens
                                             a SECOND socket, because the read_only wording of lock_device
                                             can only be asserted from a client that is not the lock holder
sweeps/sweep-subscription-lifecycle-and-binary-frames.mjs
sweeps/sweep-disconnect-and-event-delivery.mjs
sweeps/require-every-contract-operation-to-be-driven.mjs
                                             the coverage guard: refuses to call a sweep clean while an
                                             operation of contract.yaml went to no socket
seeded-fault-proxy/misrepresent-a-host-to-seed-a-conformance-fault.mjs
seeded-fault-proxy/websocket-server-frame-codec.mjs   RFC 6455 server side, no dependencies
```

No dependencies. Node's global `WebSocket` is the client; the proxy carries its
own server-side codec because Node ships no WebSocket server.
