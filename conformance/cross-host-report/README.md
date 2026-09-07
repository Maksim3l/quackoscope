# conformance/cross-host-report/ — the generated compatibility matrix

One command starts every available host, runs the wire conformance suite against
each, sends every one of them the same wrong inputs, and writes a markdown
document comparing them.

```
node conformance/generate-cross-host-conformance-report.mjs
node conformance/generate-cross-host-conformance-report.mjs --hosts cpp,python,csharp,rust
```

Options: `--hosts <comma list of cpp,python,csharp,rust,mock>` (default: all
five), `--port-range <first>-<last>` (default `7811-7830`; the only ports the run
may bind, and it refuses outside them — move the window when those ports are not
yours), `--first-port <n>` (where inside that window the hosts start, one port
each in `--hosts` order; default: the first port of the window),
`--output-directory <dir>` (default
`conformance/cross-host-report/generated`), `--contract`, `--manifest`,
`--request-timeout-ms`, `--seconds-to-wait-for-the-listener`.

Exit codes: `0` the report was written and no host failed, `1` the report was
written and at least one host has a class (b) failure, `2` the run could not
happen at all, `3` **refused**: two hosts that loaded an openDAQ do not agree on
`sdk.commit`, or one of them disagrees with the manifest.

## Nothing in the output is hand-written

Every cell comes from one of exactly three places, and section 8 of the document
says which per table:

| source | what it fills in |
|---|---|
| the host's own handshake | capability sets, gap reasons and kinds, implementation name and version, sdk version and commit |
| a conformance ledger entry | failure classes, the class (b) failures in full, per-wire-method behaviour |
| the answer a host gave to a request this run sent | the error-code fidelity matrix |

The capability rows come from `contract.yaml`'s own baseline and the wire method
rows from its own operations table, so an id added to the contract appears in the
document without anyone editing this directory.

## The gate runs before the sweeps, and it refuses

The run has two phases. **Phase 1** starts each host only long enough to read its
handshake and stops it again. If two hosts that loaded an openDAQ report
different `sdk.commit`s, or one of them reports a commit that is not the
manifest's, the run stops there: no conformance sweep is started, no wrong input
is sent, and no markdown is written. A behavioural difference between hosts that
loaded different openDAQ builds is not a host difference, and publishing it as
one would be a lie of omission. **Phase 2** — the sweeps, the wrong inputs and
the document — only happens once every SDK-loading host agrees.

## A host that loads no openDAQ is reported alongside, not refused

`hosts/mock-ts` has no SDK by construction: it is the schema-complete reference
target the suite can be run against with no openDAQ on the machine, and it
reports `sdk.version "none (synthetic device, no openDAQ SDK is loaded)"` and
`sdk.commit "none"`. It is not a host that disagrees about which openDAQ it
loaded; it is a host that has none, so it does not refuse the run. It is
**reported alongside**: its sweep runs, it is sent the identical wrong inputs, it
keeps its column, every cell it produced is printed with the marker `(no SDK)`,
and it is counted in **no agreement column** in any section. §2.1 of the
generated document says that in words, for a reader who has only the markdown.

A host qualifies for this only by saying so in both halves of its handshake's
`sdk` record — `sdk.commit` exactly `none` **and** an `sdk.version` beginning
with the word `none`. A host that reports `sdk.commit "none"` while naming a real
`sdk.version` is an SDK-loading host withholding its commit, and the run refuses
on it like any other disagreement. Nothing reads `implementation.name` to decide
this. The rule has exactly one copy, in
`../decide-whether-hosts-share-the-manifest-opendaq-build.mjs`, which
`../compare-host-conformance-reports.mjs` uses too.

To see the refusal still fire on a real disagreement, seed one: the proxy under
`../seeded-fault-proxy/` will misreport a real host's commit.

```
node conformance/start-host-then-run-wire-conformance.mjs --host cpp --port 7971 \
  --port-range 7971-7990 --through-seeded-fault-proxy-on-port 7972 \
  --proxy-misreport-sdk-commit-as 0000000000000000000000000000000000000000 \
  --report cpp-misreporting-its-commit.json
node conformance/compare-host-conformance-reports.mjs cpp-misreporting-its-commit.json <another host>.json
```

## Error-code fidelity: the column that needs its own file

`interrogate-a-host-with-identical-wrong-inputs.mjs` sends every host the same
wrong input and writes down the code each one answers with. The conformance suite
cannot tell you this: it decides whether a host is conformant, and four hosts can
all be conformant, all on the same openDAQ commit, and still answer the identical
malformed request with four different codes.

Rules the interrogation holds itself to:

- every case in `identicalWrongInputCases()` carries params that are literally
  identical on every host — sentinel node and property ids, a sentinel connection
  string, an unparseable subscription id, a method name no contract declares — so
  a difference in the answer is a difference in the host;
- the two cases that **cannot** be host-independent (a `pixel_columns` range needs
  a signal that exists) are kept in their own list, marked as such, and the exact
  params each host was sent are printed in the cell;
- whether a device is connected is part of the input, so `connect_device` is
  attempted on every host — including one that declared `device.connect` a gap,
  because a host can serve a method it under-claimed — and a host whose session
  holds no device is marked `(no device)` and excluded from the agreement column
  rather than compared against hosts whose session does;
- a refusal of an operation whose capability the host declared a gap, and which
  that host did not serve in this session, is class (a) and is excluded from the
  agreement column, so a declared gap is never read as an error-code divergence;
- an answer from a host that loaded no openDAQ is marked `(no SDK)` and excluded
  from the agreement column for the same kind of reason: this table asks which
  code an openDAQ *binding* chooses, and a host with no binding is not evidence
  about one — its choice comes out of its own hand-written error table, so
  agreeing with it is not corroboration and differing from it is not a binding
  divergence. The cell is printed in full rather than dropped, because that host
  is the reference target and its answer shows what the contract alone makes of
  the same wrong input;
- nothing reads `implementation.name` to decide anything.

Two findings fall out of the matrix that belong to different owners, and the
document keeps them apart. A row where the hosts **disagree** is a binding
divergence. A row where every host **agrees** on a code the operation's own
`errors` list does not contain is the contract being wrong about itself, and no
amount of host work will fix it.

## Files

```
../generate-cross-host-conformance-report.mjs        the one command; owns the host lifecycle and the gate
interrogate-a-host-with-identical-wrong-inputs.mjs   the same wrong input on every host
render-cross-host-conformance-markdown.mjs           the document; holds no compatibility knowledge of its own
generated/                                           the last run's output: the markdown, and one JSON report and sweep log per host
```

No dependencies. The conformance suite itself
(`../run-wire-conformance-against-url.mjs`) is used unmodified, driven by URL,
which is the usage it was written for.

This is the second file in `conformance/` that knows a host is a program with a
command line; `../start-host-then-run-wire-conformance.mjs` is the first. It
cannot reuse that launcher, which starts a host, runs exactly one consumer and
stops it, because this report needs two consumers — the conformance suite and the
wrong-input interrogation — against one live host. The executable paths are the
same in both files, and the command prints, on every run, whether they still
agree.
