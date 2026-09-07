# Quackoscope CI: what runs where, and what it does not prove

The plan says "enforced in CI", "CI fails on an empty or missing region" and "a
missing C++ handler is a build failure" in a dozen places. Until now there was no
`.github` directory and no pipeline of any kind, while a dozen real verification
scripts sat in `tools/` and `conformance/` with nothing calling them. This
directory is those scripts, wired up, split honestly into the tier a hosted
GitHub runner can execute and the tier it cannot.

## The two commands

```
pnpm verify-quackoscope-without-the-opendaq-sdk
pnpm verify-quackoscope-against-the-local-opendaq-build
```

Both accept `--port-range <first>-<last>` to move the window the host-starting
steps may bind (default `7811-7830`, the window
`conformance/generate-cross-host-conformance-report.mjs` documents as its own,
chosen to sit above the `7788` / `7789` / `7791` demo ports):

```
pnpm verify-quackoscope-without-the-opendaq-sdk --port-range 8061-8080
```

Both honour `QUACKOSCOPE_PYTHON` (the interpreter to use, default `python`) and
`QUACKOSCOPE_VERIFICATION_SCRATCH_ROOT` (where scratch output goes, default the
system temporary directory).

The workflows call these same commands. There is no second copy of the step list,
so what CI runs and what you run are the same argument vectors.

## Tier 1 — no openDAQ SDK required

Workflow: `.github/workflows/verify-quackoscope-without-the-opendaq-sdk.yml`,
`windows-latest`, hosted. **This is the tier that should gate merges**, because it
is the only one a hosted runner can execute.

| # | Step | Why it needs no SDK |
|---|---|---|
| 1 | parse the workflow files and print their jobs | reads `.github/workflows/*.yml`. This is the one verification that verifies the pipeline itself: a workflow with a YAML error does not fail loudly on GitHub, it fails to *run* |
| 2 | compile `contract.yaml` into every target, in a scratch directory | reads `contract/contract.yaml`, writes text |
| 3 | compare a fresh compile, the golden files and the committed `generated/` tree | three text trees, compared |
| 4 | assert operation names match the contract's casing table | pure name derivation |
| 5 | import `generated/python` and satisfy its handler protocol | imports generated Python, calls generated methods |
| 6 | extract openDAQ snippets from host sources | reads host source **text** out of `hosts/`, which is in the repository. It never loads the SDK those sources call, so it belongs here and not in tier 2 |
| 7 | type-check every TypeScript source with no emit | `tsc --noEmit` |
| 8 | build the frontend for production with vite | bundles `src/` |
| 9 | sweep the wire contract against the mock host alone | `hosts/mock-ts` is a synthetic device built to run with no SDK in its process |

### What a green tier 1 does NOT prove

- `hosts/cpp`, `hosts/python`, `hosts/csharp` and `hosts/rust` are never
  compiled, never started, and never asked a single question.
- `generated/cpp/quackoscope-contract.hpp` is never compiled, so the mechanism
  the plan describes — a missing C++ handler leaves the generated class abstract
  and the build fails — **is not enforced by tier 1**.
- The C++ host's static file serving is never verified; that step starts the real
  host binary.
- `manifest.json` is never resolved against a real openDAQ build tree.
- No openDAQ call inside any extracted snippet is compiled or run. Step 6 proves
  the regions exist, are closed and resolve. It says nothing about what they do.
- That the runner labels and action versions in the workflow files exist on
  GitHub. Step 1 proves only that GitHub would not silently ignore these files;
  nothing local can ask GitHub whether `windows-latest` or `pnpm/action-setup@v4`
  resolves. The first real push is what answers that.
- Only Windows is observed. Every step is portable Node and Python, but nobody
  has watched `ubuntu-latest` go green, so it is not in the matrix.

### The manifest problem, and how tier 1 answers it

`conformance/generate-cross-host-conformance-report.mjs` reads `manifest.json` for
the `sdk.commit` gate, and `manifest.json` is gitignored — it holds absolute paths
into one developer's openDAQ build tree. Point it at a path that does not exist
and it exits 2, "the run could not happen at all", **even for a mock-only run**.
Verified:

```
node conformance/generate-cross-host-conformance-report.mjs --hosts mock \
  --port-range 8061-8080 --manifest <a path that does not exist>
-> quackoscope cross-host report: could not read ...: ENOENT
   exit 2
```

So tier 1 writes a manifest **outside the repository** whose values say, in words,
that there is no openDAQ build on this machine, and passes it with `--manifest`:

```json
{
  "commit": "no-opendaq-build-on-this-machine",
  "sdk_version": "none",
  "mode": "no_local_build",
  "build_dir": null,
  "module_path": null,
  "log_level": 0,
  "rust": { "mode": "none", "crate_version": null, "provenance": "none" }
}
```

It writes that manifest on **every** machine, including one that has a real
`manifest.json`, so the local answer and the CI answer come from identical inputs.
A plausible-looking commit hash was deliberately not used: the report prints
`keyed to sdk.commit <commit>`, and a fake hash there would be a quiet lie. Only
`commit` and `sdk_version` are read on this path, and `hosts/mock-ts` is started
with no `--manifest` argument at all.

## Tier 2 — the local openDAQ build required

Workflow: `.github/workflows/verify-quackoscope-against-a-local-opendaq-build.yml`,
**self-hosted Windows**, `workflow_dispatch` and nightly. It runs all nine tier-1
steps first, then four more. Do not make it a required status until a runner is
registered; on an offline runner the job queues and never starts.

| # | Step | What it needs that a hosted runner has not got |
|---|---|---|
| 10 | resolve the openDAQ build tree and confirm `manifest.json` is current | the openDAQ source checkout, its configured build tree (whose `CMakeCache.txt` names the generator), and the built `opendaq-64-3.dll` whose version resource is where `sdk_version` comes from |
| 11 | compile `generated/cpp/quackoscope-contract.hpp` with MSVC and instantiate every handler | MSVC — the same toolset that built the SDK — and `nlohmann_json`, which lives inside the openDAQ build tree under `_deps/` |
| 12 | verify the C++ host's static file serving stays inside `dist/` | the built `quackoscope-host-cpp.exe`, which links `daq::opendaq` and will not start without the module path in `manifest.json` |
| 13 | sweep and compare all five hosts against the wire contract | all four SDK-loading host binaries, every one of which must load the same openDAQ build; the report refuses with exit 3 if they disagree |

Step 11 is the one the plan means by "a missing C++ handler is a build failure".
It is in tier 2, so **that guarantee is nightly and self-hosted, not per-push**.

### What a green tier 2 does NOT prove

- That the same result would appear against a different openDAQ commit. Every
  verdict is keyed to the commit in `manifest.json` and is void the moment that
  build tree changes.
- That the hosts behave against real hardware. The conformance report drives a
  reference device, not an instrument on a bench.
- That a second developer's machine agrees. Nothing in tier 2 is reproducible
  from the repository alone, because the tree it depends on is not in the
  repository.
- That the Rust host was built from the same openDAQ source as the others.
  `manifest.rust.provenance` already records that it is a crates.io crate of
  different provenance.

## Nothing in the repository is modified by either tier

This is a property of the runners, not luck, and it matters because tier 2 runs on
a machine a developer is using.

- The contract compiler is given `--output-directory` in a scratch directory. If
  it were allowed to rewrite `generated/`, the golden comparison that follows
  could no longer tell a stale committed `generated/` tree from a fresh one.
- The cross-host report is given `--output-directory` in a scratch directory. Its
  eleven output files under `conformance/cross-host-report/generated/` are
  tracked, and a verification run that dirties tracked files is not a
  verification run.
- `resolve_sdk.py` is given a scratch `--manifest`, and its output is then
  compared byte-for-byte against the repository's `manifest.json`. A stale
  manifest is **reported**, never silently rewritten under hosts that are running
  against the old one.
- The snippet extractor has no output option and writes `generated/snippets.json`
  in place, so the runner snapshots that file, compares it afterwards, and writes
  the committed bytes back if the extractor changed them — reporting the change
  as a failure rather than leaving it on disk.

## What cannot be verified in CI at all

Not "not yet wired up" — these have no honest automated form here.

1. **That the openDAQ binaries were built from the source they claim.**
   `resolve_sdk.py` already reports that this machine's binaries are `bec37b44`
   while the openDAQ source tree's HEAD is `6e54a041`. `--allow-commit-mismatch`
   is what lets the tier proceed. CI can print the divergence; it cannot resolve
   it, because resolving it means a multi-gigabyte rebuild that no CI run should
   start on a developer's machine.
2. **Behaviour against real instruments.** Every host is exercised against a
   reference device. Nothing in this repository can put hardware on a runner.
3. **That an extracted snippet is the code that actually ran.** The extractor
   proves a region exists and is closed. Whether the lines inside it are the SDK
   calls that produced the result the panel shows is a claim about the host
   author's marker placement, and no script here can check it.
4. **Reproducibility of tier 2 from a clean clone.** It depends on a build tree
   referenced by absolute path in a gitignored file. A second machine can run
   tier 2 only after building openDAQ itself, and there is no way to assert from
   inside CI that two machines built the same thing beyond the `sdk.commit` gate
   the conformance report already enforces.
5. **The GUI.** `vite build` proves the SPA bundles. Nothing here opens it,
   renders it, or clicks anything.

## Findings from the first real run

Both tiers were executed on the developer machine before this was committed. Eleven
of thirteen steps passed. Two failed, and both are the same defect: a table
hand-maintained inside a tool has drifted behind `contract/contract.yaml`.

**`tools/contract-compiler/assert_operation_names_match_casing_table.py` exits 1.**
2 of 251 assertions fail. `contract.yaml` declares 19 operations; the expected
table inside the script has 18. `load_module_from_host_path` is in the contract
and has no expected row.

**`tools/snippet-extractor/extract-opendaq-snippets-from-host-sources.mjs` exits
1**, over 560 lines of complaints. It hardcodes an eight-entry
`CONTRACT_CAPABILITY_IDS` list; `contract.yaml` declares twelve. The four newer
ids — `device.mode`, `device.lock`, `module.read`, `module.load` — are marked in
`hosts/python/opendaq_backend/daq_backend.py` and `hosts/rust/src/opendaq/daq_backend.rs`
and used by `src/component-tree/TreeRowActionMenu.tsx`, and the extractor rejects
every one of them.

That second one means **`pnpm build` currently fails**, because `build` is
`extract-opendaq-snippets-from-host-sources && tsc && vite build` and the first
command exits 1. `tsc --noEmit` and `vite build` both pass on their own.

Neither was fixed here. Fixing them means editing `tools/`, and the point of
standing this pipeline up was to find out what it says, not to make it say
something nicer.
