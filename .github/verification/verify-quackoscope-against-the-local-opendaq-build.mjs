// Runs every Quackoscope verification there is: first the steps that need no
// openDAQ SDK, then the steps that need the openDAQ build tree named in
// manifest.json and the MSVC toolset that produced it.
//
//   pnpm verify-quackoscope-against-the-local-opendaq-build
//   node .github/verification/verify-quackoscope-against-the-local-opendaq-build.mjs --port-range 8061-8080
//
// This is the command .github/workflows/verify-quackoscope-against-a-local-opendaq-build.yml
// runs on a SELF-HOSTED Windows runner that has that build tree. It cannot run on
// a hosted GitHub runner, and it says why and exits 2 rather than skipping
// quietly, if manifest.json is absent.
//
// WHY THE NO-SDK STEPS RUN FIRST
// They are the cheap ones, and two of the SDK steps depend on their output: the
// static-file-serving step serves the dist/ the vite build produces, and the
// MSVC header compile compiles the generated/cpp header the contract compiler
// is responsible for. Running them first means a contract that no longer
// compiles is reported in two seconds instead of after a five-host sweep.
//
// PORT WINDOW
// One window covers both host-starting steps, and they run one after another, so
// nothing binds twice at once. The cross-host report takes one port per host from
// the low end; the static-file-serving step takes the top of the window. The
// report refuses to bind outside the window it was given, so a window that is
// yours to bind is the whole guarantee needed here.
//
// Exit codes
//   0  every step exited 0
//   1  at least one step failed; the summary names each one and how to repeat it
//   2  manifest.json is missing or unusable, so the SDK steps cannot even be built

import {
  DEFAULT_HIGHEST_PORT,
  DEFAULT_LOWEST_PORT,
  REPOSITORY_ROOT,
  SCRATCH_ROOT_PATH,
  WHAT_THE_NO_SDK_TIER_DOES_NOT_PROVE,
  buildStepsThatNeedNoOpenDaqSdk,
} from "./steps-that-need-no-opendaq-sdk.mjs";
import {
  WHAT_THE_LOCAL_OPENDAQ_BUILD_TIER_DOES_NOT_PROVE,
  buildStepsThatNeedTheLocalOpenDaqBuild,
} from "./steps-that-need-the-local-opendaq-build.mjs";
import { executeVerificationStepsInOrder, parsePortRange } from "./execute-verification-steps-in-order.mjs";

const portRange = parsePortRange(process.argv.slice(2), DEFAULT_LOWEST_PORT, DEFAULT_HIGHEST_PORT);
const pythonExecutable = process.env.QUACKOSCOPE_PYTHON ?? "python";

const steps = [
  ...buildStepsThatNeedNoOpenDaqSdk({ portRange, pythonExecutable }),
  ...buildStepsThatNeedTheLocalOpenDaqBuild({ portRange, pythonExecutable }),
];

process.exit(
  executeVerificationStepsInOrder({
    tierName: "the local openDAQ build required",
    tierDescription: [
      "Every verification in this repository. The steps that need no SDK run first,",
      "then the four that need the openDAQ build tree recorded in manifest.json: the",
      "manifest resolver, the MSVC compile of the generated C++ header, the C++ host's",
      "static file serving, and the five-host conformance report.",
      `host port window:  ${portRange.lowest}-${portRange.highest} (${portRange.source})`,
      `scratch directory: ${SCRATCH_ROOT_PATH}`,
      `python executable: ${pythonExecutable}  (override with QUACKOSCOPE_PYTHON)`,
    ].join("\n"),
    tierDoesNotProve: [
      ...WHAT_THE_LOCAL_OPENDAQ_BUILD_TIER_DOES_NOT_PROVE,
      ...WHAT_THE_NO_SDK_TIER_DOES_NOT_PROVE.filter(
        (line) => !line.startsWith("that hosts/cpp") && !line.startsWith("that generated/cpp") && !line.startsWith("that the four SDK-loading hosts") && !line.startsWith("that manifest.json") && !line.startsWith("that the C++ host's"),
      ),
    ],
    repositoryRoot: REPOSITORY_ROOT,
    steps,
  }),
);
