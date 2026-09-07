// Every Quackoscope verification that can reach a verdict with NO openDAQ SDK
// present on the machine, as a step list two runners share:
//
//   .github/verification/verify-quackoscope-without-the-opendaq-sdk.mjs
//       runs exactly this list; it is what the hosted GitHub workflow calls
//   .github/verification/verify-quackoscope-against-the-local-opendaq-build.mjs
//       runs this list first and then the steps that need the SDK
//
// There is no second copy of these commands anywhere, so a developer running
// the local command and the CI log are reading the same argument vectors.
//
// WHAT "NO SDK" MEANS HERE, PRECISELY
// Not one step in this file loads opendaq-64-3.dll, starts a process that links
// daq::opendaq, or reads the openDAQ build tree named in manifest.json. The
// contract compiler reads contract/contract.yaml; the snippet extractor reads
// host source TEXT out of hosts/ (which is in the repository) and never the SDK
// those sources call; the frontend build reads src/; the conformance sweep runs
// against hosts/mock-ts, a synthetic device deliberately built to run with no
// SDK in the process.
//
// THE MANIFEST PROBLEM, AND HOW THIS LIST ANSWERS IT
// conformance/generate-cross-host-conformance-report.mjs reads manifest.json for
// the sdk.commit gate, and manifest.json is gitignored: it holds absolute paths
// into one developer's multi-gigabyte openDAQ build tree, so a hosted runner
// never has one and the report exits 2 without it. This list therefore writes a
// manifest OUTSIDE the repository that says, in the values themselves, that
// there is no openDAQ build on this machine, and passes it with --manifest. It
// does this on every machine, including one that has a real manifest.json, so
// that the local answer and the CI answer come from identical inputs.
//
// NOTHING IN THE REPOSITORY IS MODIFIED
// The contract compiler is given --output-directory in a scratch directory (if
// it were allowed to rewrite generated/, the golden comparison that follows
// could no longer tell a stale committed generated/ tree from a fresh one). The
// conformance report is given --output-directory in a scratch directory, because
// its eleven output files under conformance/cross-host-report/generated/ are
// tracked. The snippet extractor has no output option and writes
// generated/snippets.json in place, so this list snapshots that file, compares
// it afterwards, and restores the committed bytes if the extractor changed them
// - reporting the change as a failure rather than leaving it on disk.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Everything either tier writes goes under here and nothing under here is in the
// repository. The workflows point it at a directory they can then upload as an
// artifact; on a developer machine it lands in the system temporary directory.
const SCRATCH_ROOT = process.env.QUACKOSCOPE_VERIFICATION_SCRATCH_ROOT
  ? resolve(process.env.QUACKOSCOPE_VERIFICATION_SCRATCH_ROOT)
  : resolve(tmpdir(), "quackoscope-verification-scratch");
const CONTRACT_COMPILER_SCRATCH_OUTPUT = resolve(SCRATCH_ROOT, "contract-compiler-output");
const CONFORMANCE_SCRATCH_OUTPUT_FOR_THE_MOCK_ALONE = resolve(SCRATCH_ROOT, "cross-host-report-mock-only");
const MANIFEST_FOR_A_MACHINE_WITH_NO_OPENDAQ_BUILD = resolve(
  SCRATCH_ROOT,
  "manifest-for-a-machine-with-no-opendaq-build.json",
);
const SNIPPET_BUNDLE = resolve(REPOSITORY_ROOT, "generated", "snippets.json");

// conformance/generate-cross-host-conformance-report.mjs documents 7811-7830 as
// its own default window, chosen to sit above the 7788/7789/7791 demo ports.
export const DEFAULT_LOWEST_PORT = 7811;
export const DEFAULT_HIGHEST_PORT = 7830;

export const SCRATCH_ROOT_PATH = SCRATCH_ROOT;

// The manifest a machine with no openDAQ build honestly has. Every value says so
// in words rather than carrying a plausible-looking commit hash, which would make
// the report's "keyed to sdk.commit" line a quiet lie. The cross-host report reads
// only `commit` and `sdk_version` from it, and hosts/mock-ts is started with no
// --manifest argument at all, so no other key is consulted on this path.
const MANIFEST_TEXT_FOR_A_MACHINE_WITH_NO_OPENDAQ_BUILD = `${JSON.stringify(
  {
    commit: "no-opendaq-build-on-this-machine",
    sdk_version: "none",
    mode: "no_local_build",
    build_dir: null,
    module_path: null,
    log_level: 0,
    rust: { mode: "none", crate_version: null, provenance: "none" },
  },
  null,
  2,
)}\n`;

export const WHAT_THE_NO_SDK_TIER_DOES_NOT_PROVE = [
  "that hosts/cpp, hosts/python, hosts/csharp or hosts/rust compile, start, or answer anything",
  "that generated/cpp/quackoscope-contract.hpp compiles - that needs MSVC and the openDAQ build tree's nlohmann_json",
  "that the four SDK-loading hosts agree with each other or with the mock",
  "that manifest.json resolves to a real openDAQ build tree",
  "that the C++ host's static file serving stays inside dist/ - that step starts the real host binary",
  "that any openDAQ call in an extracted snippet compiles or does what the snippet claims",
];

/**
 * @param {object} input
 * @param {{lowest:number, highest:number}} input.portRange window the mock host may bind
 * @param {string} input.pythonExecutable
 */
export function buildStepsThatNeedNoOpenDaqSdk({ portRange, pythonExecutable }) {
  let snippetBundleBytesBeforeTheExtractorRan = null;

  return [
    {
      name: "parse the workflow files and print their jobs",
      proves:
        "every file under .github/workflows/ parses as YAML, declares a trigger, a runs-on and named steps, and pins every action it uses to a version rather than to a branch",
      doesNotProve:
        "that the runner labels or action versions named there exist on GitHub - nothing local can ask GitHub that; it proves only that GitHub would not silently ignore these files",
      program: pythonExecutable,
      argv: [resolve(REPOSITORY_ROOT, ".github/verification/parse-the-workflow-files-and-print-their-jobs.py")],
      cwd: REPOSITORY_ROOT,
    },
    {
      name: "compile contract.yaml into every target, in a scratch directory",
      proves:
        "contract/contract.yaml parses, its six fail_build lints hold, and all four generators emit without throwing",
      doesNotProve:
        "that the committed generated/ tree matches what was just emitted - that is the next step's job, which is why this one writes to a scratch directory",
      program: pythonExecutable,
      argv: [
        resolve(REPOSITORY_ROOT, "tools/contract-compiler/compile_contract_to_generated_targets.py"),
        "--output-directory",
        CONTRACT_COMPILER_SCRATCH_OUTPUT,
      ],
      cwd: REPOSITORY_ROOT,
      prepare() {
        mkdirSync(CONTRACT_COMPILER_SCRATCH_OUTPUT, { recursive: true });
        return [
          `compiling into ${CONTRACT_COMPILER_SCRATCH_OUTPUT} and NOT into ${resolve(REPOSITORY_ROOT, "generated")},`,
          `so that the next step can still tell a stale committed generated/ tree from a fresh one`,
        ];
      },
    },
    {
      name: "compare a fresh compile, the golden files and the committed generated/ tree",
      proves:
        "a fresh compile, tools/contract-compiler/golden/ and generated/ are byte-identical, so neither a generator nor the committed output has drifted from contract.yaml",
      program: pythonExecutable,
      argv: [resolve(REPOSITORY_ROOT, "tools/contract-compiler/compare_generated_output_against_golden_files.py")],
      cwd: REPOSITORY_ROOT,
    },
    {
      name: "assert operation names match the contract's casing table",
      proves:
        "every wire method resolves to exactly one symbol in each of the five language targets, reserved words are escaped as casing.targets declares, and the getter/setter collapse behaves per target",
      program: pythonExecutable,
      argv: [resolve(REPOSITORY_ROOT, "tools/contract-compiler/assert_operation_names_match_casing_table.py")],
      cwd: REPOSITORY_ROOT,
    },
    {
      name: "import generated/python and satisfy its handler protocol",
      proves:
        "generated/python imports, all seven records round-trip their wire form, and both runtime_checkable Protocols are satisfied by a class whose 24 methods are generated from contract.yaml and then actually called",
      doesNotProve:
        "that hosts/python implements those protocols - this instantiates a class generated from the contract, not the real host",
      program: pythonExecutable,
      argv: [
        resolve(
          REPOSITORY_ROOT,
          "tools/contract-compiler/verify_generated_python_imports_and_protocol_is_satisfiable.py",
        ),
      ],
      cwd: REPOSITORY_ROOT,
    },
    {
      name: "extract openDAQ snippets from host sources",
      proves:
        "every operation id the frontend puts in an `op` prop resolves to a non-empty, closed, resolvable set of quack-snippet regions in the host sources, and generated/snippets.json is not stale",
      doesNotProve:
        "that the SDK calls inside those regions compile or run - this step reads host source text only, which is why it needs no SDK",
      program: process.execPath,
      argv: [resolve(REPOSITORY_ROOT, "tools/snippet-extractor/extract-opendaq-snippets-from-host-sources.mjs")],
      cwd: REPOSITORY_ROOT,
      prepare() {
        if (!existsSync(SNIPPET_BUNDLE)) {
          throw new Error(
            `${SNIPPET_BUNDLE} does not exist, but it is a committed file, so there is nothing to compare the extractor's output against.`,
          );
        }
        snippetBundleBytesBeforeTheExtractorRan = readFileSync(SNIPPET_BUNDLE);
        return [
          `snapshotting the committed bundle before the extractor may overwrite it:`,
          `  ${SNIPPET_BUNDLE}  (${snippetBundleBytesBeforeTheExtractorRan.length} bytes)`,
        ];
      },
      judge(exitCode) {
        const after = readFileSync(SNIPPET_BUNDLE);
        if (after.equals(snippetBundleBytesBeforeTheExtractorRan)) {
          return {
            exitCode,
            lines: [
              `generated/snippets.json is unchanged: ${after.length} bytes, byte-identical to the committed bundle`,
            ],
          };
        }
        writeFileSync(SNIPPET_BUNDLE, snippetBundleBytesBeforeTheExtractorRan);
        return {
          exitCode: exitCode === 0 ? 1 : exitCode,
          lines: [
            `generated/snippets.json IS STALE: the extractor wrote ${after.length} bytes where the committed bundle ` +
              `has ${snippetBundleBytesBeforeTheExtractorRan.length}. The committed bytes have been written back, so this run left ` +
              `nothing on disk. Regenerate and commit with: ` +
              `node tools/snippet-extractor/extract-opendaq-snippets-from-host-sources.mjs`,
          ],
        };
      },
    },
    {
      name: "type-check every TypeScript source with no emit",
      proves: "src/, generated/typescript/ and hosts/mock-ts/ type-check together under the repository's tsconfig.json",
      program: process.execPath,
      argv: [resolve(REPOSITORY_ROOT, "node_modules/typescript/bin/tsc"), "--noEmit"],
      cwd: REPOSITORY_ROOT,
    },
    {
      name: "build the frontend for production with vite",
      proves: "the SPA bundles: every import resolves and the production build emits dist/",
      doesNotProve: "that the SPA works against any host - nothing is served or loaded here",
      program: process.execPath,
      argv: [resolve(REPOSITORY_ROOT, "node_modules/vite/bin/vite.js"), "build"],
      cwd: REPOSITORY_ROOT,
    },
    {
      name: "sweep the wire contract against the mock host alone",
      proves:
        "hosts/mock-ts answers the contract operations it declares, declares its gaps, and refuses 19 deliberately wrong inputs with contract error codes",
      doesNotProve:
        "anything at all about hosts/cpp, hosts/python, hosts/csharp or hosts/rust, and nothing about openDAQ itself: the mock is a synthetic device with no SDK in the process, so it is reported alongside and counted in no agreement column",
      program: process.execPath,
      argv: [
        resolve(REPOSITORY_ROOT, "conformance/generate-cross-host-conformance-report.mjs"),
        "--hosts",
        "mock",
        "--port-range",
        `${portRange.lowest}-${portRange.highest}`,
        "--manifest",
        MANIFEST_FOR_A_MACHINE_WITH_NO_OPENDAQ_BUILD,
        "--output-directory",
        CONFORMANCE_SCRATCH_OUTPUT_FOR_THE_MOCK_ALONE,
      ],
      cwd: REPOSITORY_ROOT,
      prepare() {
        mkdirSync(CONFORMANCE_SCRATCH_OUTPUT_FOR_THE_MOCK_ALONE, { recursive: true });
        writeFileSync(
          MANIFEST_FOR_A_MACHINE_WITH_NO_OPENDAQ_BUILD,
          MANIFEST_TEXT_FOR_A_MACHINE_WITH_NO_OPENDAQ_BUILD,
        );
        return [
          `wrote the manifest this tier hands the report, outside the repository so a real manifest.json is never touched:`,
          `  ${MANIFEST_FOR_A_MACHINE_WITH_NO_OPENDAQ_BUILD}`,
          ...MANIFEST_TEXT_FOR_A_MACHINE_WITH_NO_OPENDAQ_BUILD.trimEnd()
            .split("\n")
            .map((line) => `  | ${line}`),
          `the report writes its output files to ${CONFORMANCE_SCRATCH_OUTPUT_FOR_THE_MOCK_ALONE},`,
          `not to conformance/cross-host-report/generated/, whose eleven files are tracked`,
        ];
      },
    },
  ];
}
