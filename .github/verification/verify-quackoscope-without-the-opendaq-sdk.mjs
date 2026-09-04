// Runs every Quackoscope verification that needs no openDAQ SDK, and nothing else.
//
//   pnpm verify-quackoscope-without-the-opendaq-sdk
//   node .github/verification/verify-quackoscope-without-the-opendaq-sdk.mjs --port-range 8061-8080
//
// This is the command .github/workflows/verify-quackoscope-without-the-opendaq-sdk.yml
// runs. Its matrix is windows-latest and nothing else, deliberately: every step
// here is portable Node and Python, but the list has only ever been watched go
// green on Windows, and that workflow's "WHY THERE IS NO ubuntu-latest ENTRY"
// comment says a matrix entry nobody has watched pass is how a pipeline starts
// lying. Running this locally gives the answer CI gives, because it is the same
// file executing the same argument vectors.
//
// Exit codes
//   0  every step exited 0
//   1  at least one step failed; the summary names each one and how to repeat it

import {
  DEFAULT_HIGHEST_PORT,
  DEFAULT_LOWEST_PORT,
  REPOSITORY_ROOT,
  SCRATCH_ROOT_PATH,
  WHAT_THE_NO_SDK_TIER_DOES_NOT_PROVE,
  buildStepsThatNeedNoOpenDaqSdk,
} from "./steps-that-need-no-opendaq-sdk.mjs";
import { executeVerificationStepsInOrder, parsePortRange } from "./execute-verification-steps-in-order.mjs";

const portRange = parsePortRange(process.argv.slice(2), DEFAULT_LOWEST_PORT, DEFAULT_HIGHEST_PORT);
const pythonExecutable = process.env.QUACKOSCOPE_PYTHON ?? "python";

process.exit(
  executeVerificationStepsInOrder({
    tierName: "no openDAQ SDK required",
    tierDescription: [
      "Everything a hosted GitHub runner can honestly decide about this repository:",
      "the contract and its generated output, the snippet bundle, the frontend, and the",
      "wire behaviour of the one host that was built to run with no SDK in its process.",
      `mock host port window: ${portRange.lowest}-${portRange.highest} (${portRange.source})`,
      `scratch directory:     ${SCRATCH_ROOT_PATH}`,
      `python executable:     ${pythonExecutable}  (override with QUACKOSCOPE_PYTHON)`,
    ].join("\n"),
    tierDoesNotProve: WHAT_THE_NO_SDK_TIER_DOES_NOT_PROVE,
    repositoryRoot: REPOSITORY_ROOT,
    steps: buildStepsThatNeedNoOpenDaqSdk({ portRange, pythonExecutable }),
  }),
);
