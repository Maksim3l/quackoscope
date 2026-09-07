// The Quackoscope verifications that CANNOT reach a verdict without the openDAQ
// SDK build tree named in manifest.json, plus the MSVC toolset that produced it.
//
// Used only by
//   .github/verification/verify-quackoscope-against-the-local-opendaq-build.mjs
// which is what .github/workflows/verify-quackoscope-against-a-local-opendaq-build.yml
// calls on a SELF-HOSTED Windows runner. A hosted GitHub runner cannot execute
// one line of this file, and the workflow says so rather than pretending.
//
// WHAT EACH STEP NEEDS THAT A HOSTED RUNNER HAS NOT GOT
//   resolve the openDAQ build tree  the openDAQ source checkout and its
//                                   configured build tree, whose CMakeCache.txt
//                                   names the generator, plus the built
//                                   opendaq-64-3.dll whose version resource is
//                                   where sdk_version comes from
//   compile the generated header    MSVC (the same toolset that built the SDK)
//                                   and nlohmann_json, which lives inside the
//                                   openDAQ build tree under _deps/
//   static file serving            the built quackoscope-host-cpp.exe, which
//                                   links daq::opendaq and will not start
//                                   without the module path in manifest.json
//   five-host conformance          all four SDK-loading host binaries, every one
//                                   of which loads the same openDAQ build; the
//                                   report REFUSES (exit 3) if they disagree
//
// NOTHING IN THE REPOSITORY IS MODIFIED
// resolve_sdk.py is pointed at a scratch --manifest and its output is then
// compared byte-for-byte against the repository's manifest.json, so a stale
// manifest is reported rather than silently rewritten under a developer who has
// hosts running against the old one. The cross-host report is given a scratch
// --output-directory for the same reason the no-SDK list gives it one: its
// eleven output files under conformance/cross-host-report/generated/ are tracked.

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { REPOSITORY_ROOT, SCRATCH_ROOT_PATH } from "./steps-that-need-no-opendaq-sdk.mjs";

const MANIFEST_IN_THE_REPOSITORY = resolve(REPOSITORY_ROOT, "manifest.json");
const MANIFEST_RESOLVED_FRESH = resolve(SCRATCH_ROOT_PATH, "manifest-resolved-fresh-from-the-opendaq-build-tree.json");
const CONFORMANCE_SCRATCH_OUTPUT_FOR_EVERY_HOST = resolve(SCRATCH_ROOT_PATH, "cross-host-report-every-host");

export const EVERY_HOST_THE_REPORT_STARTS = "cpp,python,csharp,rust,mock";

export const WHAT_THE_LOCAL_OPENDAQ_BUILD_TIER_DOES_NOT_PROVE = [
  "that the same result would appear against a different openDAQ commit - every verdict here is keyed to the commit in manifest.json and is void the moment that build tree changes",
  "that the hosts behave against real hardware - the conformance report drives a reference device, not an instrument on a bench",
  "that a second developer's machine agrees; nothing here is reproducible from the repository alone, because the openDAQ build tree it depends on is not in the repository",
  "that the Rust host was built from the same openDAQ source as the others - manifest.rust.provenance already records that it is a crates.io crate of different provenance",
];

/**
 * @param {object} input
 * @param {{lowest:number, highest:number}} input.portRange
 * @param {string} input.pythonExecutable
 */
export function buildStepsThatNeedTheLocalOpenDaqBuild({ portRange, pythonExecutable }) {
  const manifest = readManifestOrExplainWhyNot();

  // One port per host, in --hosts order, taken from the low end of the window.
  const hostCount = EVERY_HOST_THE_REPORT_STARTS.split(",").length;
  const portForTheStaticFileServingStep = portRange.highest;

  return [
    {
      name: "resolve the openDAQ build tree and confirm manifest.json is current",
      proves:
        "the openDAQ source checkout, its configured build tree, its CMake generator, its 14 module DLLs and the sdk_version stamped into opendaq-64-3.dll all resolve, and the repository's manifest.json is byte-identical to what resolving them right now produces",
      doesNotProve:
        "that the openDAQ binaries were built from the source tree's current HEAD - resolve_sdk.py reports that divergence loudly and --allow-commit-mismatch is what lets this step proceed anyway",
      program: pythonExecutable,
      argv: [
        resolve(REPOSITORY_ROOT, "tools/sdk-build/resolve_sdk.py"),
        manifest.commit,
        "--allow-commit-mismatch",
        "--manifest",
        MANIFEST_RESOLVED_FRESH,
      ],
      cwd: REPOSITORY_ROOT,
      prepare() {
        mkdirSync(SCRATCH_ROOT_PATH, { recursive: true });
        return [
          `commit taken from ${MANIFEST_IN_THE_REPOSITORY}: ${manifest.commit}`,
          `sdk_version recorded there:                        ${manifest.sdk_version}`,
          `module_path recorded there:                        ${manifest.module_path}`,
          `writing the freshly resolved manifest to ${MANIFEST_RESOLVED_FRESH}`,
          `and NOT to ${MANIFEST_IN_THE_REPOSITORY}, which hosts may be running against right now`,
        ];
      },
      judge(exitCode) {
        if (exitCode !== 0) {
          return { exitCode, lines: [`resolve_sdk.py exited ${exitCode}; the two manifests were not compared`] };
        }
        const fresh = readFileSync(MANIFEST_RESOLVED_FRESH);
        const committed = readFileSync(MANIFEST_IN_THE_REPOSITORY);
        if (fresh.equals(committed)) {
          return {
            exitCode: 0,
            lines: [
              `${MANIFEST_IN_THE_REPOSITORY} (${committed.length} bytes) is byte-identical to the manifest just resolved`,
              `from C:/…/openDAQ: commit ${manifest.commit}, sdk_version ${manifest.sdk_version}`,
            ],
          };
        }
        return {
          exitCode: 1,
          lines: [
            `manifest.json IS STALE: resolving the openDAQ build tree right now produces ${fresh.length} bytes,`,
            `while ${MANIFEST_IN_THE_REPOSITORY} holds ${committed.length}. Nothing was overwritten.`,
            `The freshly resolved manifest is at ${MANIFEST_RESOLVED_FRESH}; diff it, then refresh yours with:`,
            `  python tools/sdk-build/resolve_sdk.py ${manifest.commit} --allow-commit-mismatch`,
          ],
        };
      },
    },
    {
      name: "compile generated/cpp/quackoscope-contract.hpp with MSVC and instantiate every handler",
      proves:
        "the generated C++ header compiles at /W4 /WX with the same MSVC that built the SDK, and a class overriding all 19 handler methods and 5 event methods links and runs - which is the mechanism that makes a missing C++ handler a build failure rather than a runtime surprise",
      doesNotProve:
        "that hosts/cpp implements those handlers - this compiles a scratch class generated from contract.yaml, not the real host's backend",
      program: pythonExecutable,
      argv: [resolve(REPOSITORY_ROOT, "tools/contract-compiler/compile_generated_cpp_header_with_msvc.py")],
      cwd: REPOSITORY_ROOT,
      prepare() {
        const nlohmannInclude = resolve(manifest.build_dir, "..", "..", "_deps", "nlohmann_json-src", "include");
        return [
          `the scratch CMake project is created under the system temporary directory and removed again;`,
          `hosts/cpp/build is never touched`,
          `nlohmann_json comes from the openDAQ build tree, nothing is downloaded:`,
          `  ${nlohmannInclude}  (${existsSync(nlohmannInclude) ? "present" : "MISSING"})`,
        ];
      },
    },
    {
      name: "verify the C++ host's static file serving stays inside dist/",
      proves:
        "the real quackoscope-host-cpp.exe refuses 9 path-escape attempts with HTTP 403, still serves /index.html out of dist/, and answers HEAD with no body",
      doesNotProve:
        "anything about the other three SDK-loading hosts' static file serving - only hosts/cpp serves the SPA",
      program: pythonExecutable,
      argv: [
        resolve(REPOSITORY_ROOT, "tools/host-verification/verify-static-file-serving-stays-inside-dist.py"),
        "--port",
        String(portForTheStaticFileServingStep),
      ],
      cwd: REPOSITORY_ROOT,
      prepare() {
        const hostExecutable = resolve(REPOSITORY_ROOT, "hosts/cpp/build/Release/quackoscope-host-cpp.exe");
        const distIndex = resolve(REPOSITORY_ROOT, "dist/index.html");
        return [
          `host binary  ${hostExecutable}  (${existsSync(hostExecutable) ? "present" : "MISSING - build hosts/cpp first"})`,
          `SPA to serve ${distIndex}  (${existsSync(distIndex) ? "present" : "MISSING - the vite build step of the no-SDK tier produces it"})`,
          `port         127.0.0.1:${portForTheStaticFileServingStep}, the top of the allowed window ${portRange.lowest}-${portRange.highest}`,
        ];
      },
    },
    {
      name: "sweep and compare all five hosts against the wire contract",
      proves:
        "every SDK-loading host reports the manifest's sdk.commit, all five hosts answer the same 19 wrong inputs, and no host claimed a capability and then broke it",
      doesNotProve:
        "that the hosts are equivalent where they declare gaps - a declared gap is class (a) and passes; only a claimed-then-broken capability is class (b) and fails",
      program: process.execPath,
      argv: [
        resolve(REPOSITORY_ROOT, "conformance/generate-cross-host-conformance-report.mjs"),
        "--hosts",
        EVERY_HOST_THE_REPORT_STARTS,
        "--port-range",
        `${portRange.lowest}-${portRange.highest}`,
        "--manifest",
        MANIFEST_IN_THE_REPOSITORY,
        "--output-directory",
        CONFORMANCE_SCRATCH_OUTPUT_FOR_EVERY_HOST,
      ],
      cwd: REPOSITORY_ROOT,
      prepare() {
        mkdirSync(CONFORMANCE_SCRATCH_OUTPUT_FOR_EVERY_HOST, { recursive: true });
        const ports = EVERY_HOST_THE_REPORT_STARTS.split(",")
          .map((hostKey, index) => `${hostKey}=${portRange.lowest + index}`)
          .join(", ");
        return [
          `${hostCount} hosts, one port each from the low end of ${portRange.lowest}-${portRange.highest}: ${ports}`,
          `exit 3 from this step means the SDK-loading hosts disagreed about sdk.commit and NOTHING was compared`,
          `the report writes its output files to ${CONFORMANCE_SCRATCH_OUTPUT_FOR_EVERY_HOST},`,
          `not to conformance/cross-host-report/generated/, whose eleven files are tracked`,
        ];
      },
    },
  ];
}

function readManifestOrExplainWhyNot() {
  if (!existsSync(MANIFEST_IN_THE_REPOSITORY)) {
    console.error(
      [
        `${MANIFEST_IN_THE_REPOSITORY} does not exist.`,
        ``,
        `Every step in this tier needs it: it is where the openDAQ build tree, the module`,
        `path and the sdk.commit the hosts must all agree on are recorded. It is gitignored`,
        `because it holds absolute paths particular to one machine, so a fresh clone never`,
        `has one. Produce it with:`,
        ``,
        `  python tools/sdk-build/resolve_sdk.py <opendaq commit> --allow-commit-mismatch`,
        ``,
        `If this machine has no openDAQ build tree at all, this tier cannot run here. Run`,
        `the tier that needs no SDK instead:`,
        ``,
        `  pnpm verify-quackoscope-without-the-opendaq-sdk`,
      ].join("\n"),
    );
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_IN_THE_REPOSITORY, "utf8"));
  for (const key of ["commit", "sdk_version", "build_dir", "module_path"]) {
    if (typeof manifest[key] !== "string" || manifest[key].length === 0) {
      console.error(
        `${MANIFEST_IN_THE_REPOSITORY} has no usable "${key}". It holds: ${JSON.stringify(manifest[key])}. ` +
          `Regenerate it with: python tools/sdk-build/resolve_sdk.py <opendaq commit> --allow-commit-mismatch`,
      );
      process.exit(2);
    }
  }
  return manifest;
}
