// The one place a Quackoscope verification step is started, timed, judged and
// printed. Both tier runners import it, and both GitHub workflows call those
// runners, so the sequence a developer sees on their machine and the sequence
// the CI log shows are produced by this same file.
//
// WHY EVERY STEP RUNS EVEN AFTER ONE FAILS
// A workflow that stops at the first red step tells you about one problem per
// push. These runners execute every step, print each verdict as it happens, and
// exit non-zero at the end if any step failed. The summary at the bottom names
// every failing step and the exact command line that produced it, so one run
// tells you everything that is broken right now.
//
// WHAT A STEP PRINTS
// Its name, the literal command line with every argument expanded, what a pass
// establishes, and - where the step's reach is narrower than its name suggests -
// what a pass still does NOT establish. Then the child's own output, unfiltered,
// then the exit code and the wall-clock milliseconds.

import { spawnSync } from "node:child_process";

const RULE = "=".repeat(78);
const THIN_RULE = "-".repeat(78);

/**
 * @typedef {object} VerificationStep
 * @property {string}   name          what this step verifies, in words
 * @property {string}   proves        what a pass establishes
 * @property {string}   [doesNotProve] what a pass still leaves unestablished
 * @property {string}   program       the executable to start
 * @property {string[]} argv          its arguments, already absolute
 * @property {string}   cwd           the directory to start it in
 * @property {Record<string,string>} [environmentAdditions]
 * @property {() => string[]} [prepare]
 *   Runs before the program. Returns lines to print. Throw to fail the step
 *   without starting the program.
 * @property {(exitCode: number) => {exitCode: number, lines: string[]}} [judge]
 *   Runs after the program and may overrule its exit code - used where the
 *   program's own exit code is not the whole verdict, such as a generator that
 *   exits 0 but wrote a file that differs from the committed one.
 */

function commandLineAsTyped(step) {
  // Wrapped in double quotes when it contains a space, and NOT JSON-escaped:
  // these lines are printed so they can be pasted back into a shell, and a
  // Windows path whose backslashes were doubled cannot be.
  const quote = (word) => (/\s/.test(word) ? `"${word}"` : word);
  return [step.program, ...step.argv].map(quote).join(" ");
}

/**
 * Executes every step in order and returns the process exit code to use.
 *
 * @param {object} input
 * @param {string} input.tierName          e.g. "no openDAQ SDK required"
 * @param {string} input.tierDescription   one paragraph: what this tier is for
 * @param {string[]} input.tierDoesNotProve one line per thing this tier cannot establish
 * @param {string} input.repositoryRoot
 * @param {VerificationStep[]} input.steps
 * @returns {number} 0 when every step passed, 1 when any step failed
 */
export function executeVerificationStepsInOrder({
  tierName,
  tierDescription,
  tierDoesNotProve,
  repositoryRoot,
  steps,
}) {
  const startedAt = Date.now();

  console.log(RULE);
  console.log(`quackoscope verification tier: ${tierName}`);
  console.log(RULE);
  console.log(`repository root   ${repositoryRoot}`);
  console.log(`node              ${process.version} at ${process.execPath}`);
  console.log(`platform          ${process.platform} ${process.arch}`);
  console.log(`steps to execute  ${steps.length}`);
  for (const [index, step] of steps.entries()) {
    console.log(`  ${String(index + 1).padStart(2)}. ${step.name}`);
  }
  console.log("");
  console.log("what this tier is for:");
  for (const line of tierDescription.split("\n")) console.log(`  ${line}`);
  console.log("");
  console.log("what a green result of this tier does NOT establish:");
  for (const line of tierDoesNotProve) console.log(`  - ${line}`);
  console.log("");

  const outcomes = [];

  for (const [index, step] of steps.entries()) {
    const stepNumber = `${index + 1}/${steps.length}`;
    const commandLine = commandLineAsTyped(step);

    console.log(RULE);
    console.log(`step ${stepNumber}: ${step.name}`);
    console.log(RULE);
    console.log(`command   ${commandLine}`);
    console.log(`cwd       ${step.cwd}`);
    console.log(`proves    ${step.proves}`);
    if (step.doesNotProve) console.log(`does not  ${step.doesNotProve}`);
    console.log(THIN_RULE);

    const stepStartedAt = Date.now();
    let exitCode;
    let extraLines = [];

    try {
      if (step.prepare) {
        for (const line of step.prepare()) console.log(line);
        console.log(THIN_RULE);
      }

      const child = spawnSync(step.program, step.argv, {
        cwd: step.cwd,
        stdio: "inherit",
        env: { ...process.env, ...(step.environmentAdditions ?? {}) },
      });

      if (child.error) {
        throw new Error(
          `could not start "${step.program}": ${child.error.message}. ` +
            `The command line was: ${commandLine}`,
        );
      }
      exitCode = child.status === null ? 1 : child.status;

      if (step.judge) {
        const verdict = step.judge(exitCode);
        extraLines = verdict.lines;
        exitCode = verdict.exitCode;
      }
    } catch (failure) {
      exitCode = 1;
      extraLines = [`step failed before or after the program ran: ${failure.message}`];
    }

    const elapsedMilliseconds = Date.now() - stepStartedAt;
    console.log(THIN_RULE);
    for (const line of extraLines) console.log(line);
    console.log(
      exitCode === 0
        ? `step ${stepNumber} "${step.name}" exited 0 after ${elapsedMilliseconds} ms`
        : `step ${stepNumber} "${step.name}" exited ${exitCode} after ${elapsedMilliseconds} ms`,
    );
    console.log("");

    outcomes.push({ name: step.name, commandLine, exitCode, elapsedMilliseconds });
  }

  const failures = outcomes.filter((outcome) => outcome.exitCode !== 0);
  const totalMilliseconds = Date.now() - startedAt;

  console.log(RULE);
  console.log(`summary of the "${tierName}" tier`);
  console.log(RULE);
  const widestName = Math.max(...outcomes.map((outcome) => outcome.name.length));
  for (const [index, outcome] of outcomes.entries()) {
    console.log(
      `  ${String(index + 1).padStart(2)}. ${outcome.name.padEnd(widestName)}  ` +
        `exit ${String(outcome.exitCode).padStart(3)}  ${String(outcome.elapsedMilliseconds).padStart(7)} ms`,
    );
  }
  console.log("");

  if (failures.length === 0) {
    console.log(
      `all ${outcomes.length} steps of the "${tierName}" tier exited 0 in ${totalMilliseconds} ms total`,
    );
    return 0;
  }

  console.log(`${failures.length} of ${outcomes.length} steps failed in ${totalMilliseconds} ms total:`);
  for (const failure of failures) {
    console.log(`  "${failure.name}" exited ${failure.exitCode}`);
    console.log(`    reproduce with: ${failure.commandLine}`);
  }
  return 1;
}

export function parsePortRange(argumentList, defaultLowest, defaultHighest) {
  const index = argumentList.indexOf("--port-range");
  if (index === -1) return { lowest: defaultLowest, highest: defaultHighest, source: "the built-in default" };

  const spelling = argumentList[index + 1];
  if (spelling === undefined) throw new Error("--port-range was given no value; it takes <first>-<last>, for example --port-range 7811-7830");

  const match = /^(\d+)-(\d+)$/.exec(spelling);
  if (match === null) {
    throw new Error(`--port-range was given "${spelling}"; it takes two port numbers joined by a hyphen, for example --port-range 7811-7830`);
  }
  const lowest = Number(match[1]);
  const highest = Number(match[2]);
  if (lowest < 1 || highest > 65535) throw new Error(`--port-range ${lowest}-${highest} leaves the TCP port numbers 1-65535`);
  if (highest < lowest) throw new Error(`--port-range ${lowest}-${highest} ends below where it starts`);
  return { lowest, highest, source: `--port-range ${spelling}` };
}
