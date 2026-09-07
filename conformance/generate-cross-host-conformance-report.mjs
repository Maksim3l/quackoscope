// ONE command that starts every available Quackoscope host, runs the wire
// conformance suite against each, sends every one of them the same wrong inputs,
// and writes a markdown document comparing them.
//
//   node conformance/generate-cross-host-conformance-report.mjs
//   node conformance/generate-cross-host-conformance-report.mjs --hosts cpp,python,csharp,rust
//
// This is the generated successor to a hand-maintained compatibility matrix. No
// cell of the output is written by a human: every one comes from a handshake
// message, a conformance ledger entry, or the answer a host gave to a request
// this run sent it.
//
// THE SDK.COMMIT GATE RUNS FIRST, AND IT REFUSES.
// The run has two phases. Phase 1 starts each host only long enough to read its
// handshake, and stops it again. If two SDK-loading hosts report different
// commits, or any of them reports a commit that is not the manifest's, the run
// stops there: no conformance sweep is started, no wrong input is sent, no
// markdown is written. A behavioural difference between hosts that loaded
// different openDAQ builds is not a host difference, and publishing it as one
// would be a lie of omission. Phase 2 - the sweeps, the wrong inputs and the
// document - only happens once every SDK-loading host agrees on the commit.
//
// A host that loads NO openDAQ at all - hosts/mock-ts, a synthetic device built
// to be run with no SDK present - is not one of those disagreements, and does
// not stop the run. It is REPORTED ALONGSIDE: its sweep runs, it is sent the
// same wrong inputs, its column is printed and marked `(no SDK)`, and it is
// counted in no agreement column. The rule, and what makes a handshake say "no
// SDK", live in decide-whether-hosts-share-the-manifest-opendaq-build.mjs.
//
// Exit codes:
//   0  the report was written and no host failed
//   1  the report was written and at least one host has a class (b) failure, or
//      the suite left an operation of contract.yaml undriven, which makes every
//      table here a report on a smaller contract than the one it cites
//   2  the run could not happen at all (no host started, unreadable contract)
//   3  REFUSED: SDK-loading hosts do not agree on sdk.commit, so nothing was compared

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { readWireContract } from "./contract/read-wire-contract-yaml.mjs";
import {
  HOST_SDK_PROVENANCE,
  WHAT_REPORTED_ALONGSIDE_MEANS,
  decideWhetherTheseHostsMayBeComparedAsEquals,
} from "./decide-whether-hosts-share-the-manifest-opendaq-build.mjs";
import { interrogateHostWithIdenticalWrongInputs } from "./cross-host-report/interrogate-a-host-with-identical-wrong-inputs.mjs";
import { renderCrossHostConformanceMarkdown } from "./cross-host-report/render-cross-host-conformance-markdown.mjs";

const conformanceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(conformanceDirectory, "..");

// The window of ports this run may bind, one port per host. It is only a
// DEFAULT: which ports are free is a fact about the machine and the moment, not
// about this file, so --port-range moves the whole window and --first-port picks
// where inside it the hosts start. The run still refuses to bind outside
// whatever window is in force, so it can never wander onto a listener someone
// else is using. This default sits above the demo ports 7788, 7789 and 7791.
const DEFAULT_LOWEST_PORT_THIS_REPORT_MAY_BIND = 7811;
const DEFAULT_HIGHEST_PORT_THIS_REPORT_MAY_BIND = 7830;

// How each host is started. The relative executable paths here are the same ones
// conformance/start-host-then-run-wire-conformance.mjs uses, and
// warnIfTheHostCommandTableDriftedFromTheLauncher below reads that file and says
// so, loudly, if the two ever stop agreeing. This report cannot reuse that
// launcher: the launcher starts a host, runs exactly one consumer against it and
// stops it, and this report needs two consumers - the conformance suite and the
// wrong-input interrogation - against one live host.
const HOSTS_THIS_REPORT_CAN_START = {
  cpp: {
    describedAs: "hosts/cpp, the reference implementation, against the openDAQ build named in manifest.json",
    relativeExecutable: "hosts/cpp/build/Release/quackoscope-host-cpp.exe",
    command: () => resolve(repositoryRoot, "hosts/cpp/build/Release/quackoscope-host-cpp.exe"),
    argumentsForPort: (port) => ["--manifest", resolve(repositoryRoot, "manifest.json"), "--port", String(port)],
  },
  python: {
    describedAs: "hosts/python, against the openDAQ build named in manifest.json",
    relativeExecutable: "hosts/python/quackoscope_host.py",
    command: () => "python",
    argumentsForPort: (port) => [
      resolve(repositoryRoot, "hosts/python/quackoscope_host.py"),
      "--manifest",
      resolve(repositoryRoot, "manifest.json"),
      "--port",
      String(port),
    ],
  },
  csharp: {
    describedAs: "hosts/csharp, against the openDAQ build named in manifest.json",
    relativeExecutable: "hosts/csharp/bin/Release/net8.0/quackoscope-host-csharp.exe",
    command: () => resolve(repositoryRoot, "hosts/csharp/bin/Release/net8.0/quackoscope-host-csharp.exe"),
    argumentsForPort: (port) => ["--manifest", resolve(repositoryRoot, "manifest.json"), "--port", String(port)],
  },
  rust: {
    describedAs: "hosts/rust, against the openDAQ build named in manifest.json",
    relativeExecutable: "hosts/rust/target/release/quackoscope-host-rust.exe",
    command: () => resolve(repositoryRoot, "hosts/rust/target/release/quackoscope-host-rust.exe"),
    argumentsForPort: (port) => [
      "--manifest",
      resolve(repositoryRoot, "manifest.json"),
      "--symbol-list",
      resolve(repositoryRoot, "generated/rust/symbol-list.json"),
      "--port",
      String(port),
    ],
  },
  mock: {
    describedAs: "hosts/mock-ts, a synthetic reference device with no openDAQ SDK in the process",
    relativeExecutable: "hosts/mock-ts/src/start-mock-host.ts",
    command: () => process.execPath,
    argumentsForPort: (port) => [resolve(repositoryRoot, "hosts/mock-ts/src/start-mock-host.ts"), "--port", String(port)],
  },
};

const EVERY_HOST_KEY = Object.keys(HOSTS_THIS_REPORT_CAN_START);

function warnIfTheHostCommandTableDriftedFromTheLauncher() {
  const launcherPath = resolve(conformanceDirectory, "start-host-then-run-wire-conformance.mjs");
  let launcherSource;
  try {
    launcherSource = readFileSync(launcherPath, "utf8");
  } catch (failure) {
    console.log(`  could not read ${launcherPath} to compare host command lines against it: ${failure.message}`);
    return;
  }
  const drifted = EVERY_HOST_KEY.filter((hostKey) => !launcherSource.includes(HOSTS_THIS_REPORT_CAN_START[hostKey].relativeExecutable));
  if (drifted.length === 0) {
    console.log(`  all ${EVERY_HOST_KEY.length} host executable paths below also appear in ${launcherPath}, so the two files still agree`);
    return;
  }
  console.log(`  WARNING: ${drifted.join(", ")} - this file starts an executable that ${launcherPath} does not mention:`);
  for (const hostKey of drifted) {
    console.log(`    ${hostKey}: ${HOSTS_THIS_REPORT_CAN_START[hostKey].relativeExecutable}`);
  }
  console.log(`  the two files have drifted; one of them is starting the wrong binary.`);
}

function parseArguments(argv) {
  const options = {
    hostKeys: [...EVERY_HOST_KEY],
    lowestPortAllowed: DEFAULT_LOWEST_PORT_THIS_REPORT_MAY_BIND,
    highestPortAllowed: DEFAULT_HIGHEST_PORT_THIS_REPORT_MAY_BIND,
    // Left null until every argument is read, so that --port-range given
    // without --first-port moves the starting port with the window.
    firstPort: null,
    outputDirectory: resolve(repositoryRoot, "conformance/cross-host-report/generated"),
    contractPath: resolve(repositoryRoot, "contract", "contract.yaml"),
    manifestPath: resolve(repositoryRoot, "manifest.json"),
    requestTimeoutMs: 15000,
    secondsToWaitForTheListener: 90,
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const nextValue = (name) => {
      if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
      return argv[++i];
    };
    if (argument === "--hosts") options.hostKeys = nextValue("--hosts").split(",").map((key) => key.trim()).filter(Boolean);
    else if (argument === "--first-port") options.firstPort = Number(nextValue("--first-port"));
    else if (argument === "--port-range") {
      const spelling = nextValue("--port-range");
      const bounds = /^(\d+)-(\d+)$/.exec(spelling.trim());
      if (!bounds) {
        throw new Error(`--port-range was given "${spelling}"; it takes two port numbers joined by a hyphen, for example --port-range 7811-7830`);
      }
      options.lowestPortAllowed = Number(bounds[1]);
      options.highestPortAllowed = Number(bounds[2]);
      if (options.lowestPortAllowed < 1 || options.highestPortAllowed > 65535) {
        throw new Error(`--port-range ${options.lowestPortAllowed}-${options.highestPortAllowed} leaves the TCP port numbers 1-65535`);
      }
      if (options.highestPortAllowed < options.lowestPortAllowed) {
        throw new Error(`--port-range ${options.lowestPortAllowed}-${options.highestPortAllowed} ends below where it starts`);
      }
    }
    else if (argument === "--output-directory") options.outputDirectory = resolve(process.cwd(), nextValue("--output-directory"));
    else if (argument === "--contract") options.contractPath = resolve(process.cwd(), nextValue("--contract"));
    else if (argument === "--manifest") options.manifestPath = resolve(process.cwd(), nextValue("--manifest"));
    else if (argument === "--request-timeout-ms") options.requestTimeoutMs = Number(nextValue("--request-timeout-ms"));
    else if (argument === "--seconds-to-wait-for-the-listener") options.secondsToWaitForTheListener = Number(nextValue(argument));
    else if (argument === "--help" || argument === "-h") return null;
    else throw new Error(`unknown argument: ${argument}`);
  }
  for (const hostKey of options.hostKeys) {
    if (!(hostKey in HOSTS_THIS_REPORT_CAN_START)) {
      throw new Error(`--hosts names "${hostKey}", which is not one this report can start; it knows ${EVERY_HOST_KEY.join(", ")}`);
    }
  }
  if (options.hostKeys.length === 0) throw new Error("--hosts named no host at all");
  if (options.firstPort === null) options.firstPort = options.lowestPortAllowed;
  if (!Number.isInteger(options.firstPort)) {
    throw new Error(`--first-port must be a whole port number; it was given ${options.firstPort}`);
  }
  const lastPort = options.firstPort + options.hostKeys.length - 1;
  if (options.firstPort < options.lowestPortAllowed || lastPort > options.highestPortAllowed) {
    throw new Error(
      `--first-port ${options.firstPort} with ${options.hostKeys.length} host(s) (${options.hostKeys.join(", ")}) would bind ${options.firstPort}-${lastPort}, outside the allowed window ${options.lowestPortAllowed}-${options.highestPortAllowed}. Refusing to start a listener there. Move the window with --port-range <first>-<last> if those ports are yours to bind.`,
    );
  }
  return options;
}

function tryToConnect(port, milliseconds) {
  return new Promise((resolveConnected) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const giveUp = setTimeout(() => {
      socket.destroy();
      resolveConnected(false);
    }, milliseconds);
    socket.once("connect", () => {
      clearTimeout(giveUp);
      socket.end();
      resolveConnected(true);
    });
    socket.once("error", () => {
      clearTimeout(giveUp);
      socket.destroy();
      resolveConnected(false);
    });
  });
}

/**
 * Starts one host and waits for its port to accept a TCP connection. Returns
 * {child, outputLines} on success, or {failedBecause} with the real reason.
 */
async function startOneHostAndWaitForItsPort(hostKey, port, secondsToWaitForTheListener) {
  const host = HOSTS_THIS_REPORT_CAN_START[hostKey];
  const executable = resolve(repositoryRoot, host.relativeExecutable);
  if (!existsSync(executable)) {
    return {
      failedBecause: `${executable} does not exist, so ${hostKey} has never been built on this machine; this report builds nothing`,
    };
  }
  if (await tryToConnect(port, 400)) {
    return {
      failedBecause: `something is already listening on 127.0.0.1:${port}; this report starts its own hosts and stops them again, so it will not attach to a listener it did not start`,
    };
  }

  const command = host.command();
  const argumentsForHost = host.argumentsForPort(port);
  console.log(`    command: ${command} ${argumentsForHost.join(" ")}`);
  console.log(`    cwd:     ${repositoryRoot}`);
  const child = spawn(command, argumentsForHost, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
  const outputLines = [];
  const absorb = (stream) => (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() === "") continue;
      outputLines.push(`[${hostKey} ${stream}] ${line}`);
    }
  };
  child.stdout.on("data", absorb("stdout"));
  child.stderr.on("data", absorb("stderr"));

  let exitedEarly = null;
  child.once("exit", (code, signal) => {
    if (exitedEarly === null) exitedEarly = { code, signal };
  });
  child.once("error", (failure) => {
    if (exitedEarly === null) exitedEarly = { code: null, signal: null, spawnFailure: failure.message };
  });

  console.log(`    pid ${child.pid ?? "(none)"}; waiting up to ${secondsToWaitForTheListener} s for 127.0.0.1:${port} to accept a connection`);
  const waitStartedAt = Date.now();
  let listening = false;
  while (Date.now() - waitStartedAt < secondsToWaitForTheListener * 1000) {
    if (exitedEarly !== null) break;
    if (await tryToConnect(port, 300)) {
      listening = true;
      break;
    }
    await sleep(250);
  }

  if (!listening) {
    const lastLines = outputLines.slice(-6);
    await stopTheProcessThisRunStarted(child, `${hostKey} on port ${port}`);
    const why = exitedEarly?.spawnFailure
      ? `the process could not be spawned: ${exitedEarly.spawnFailure}`
      : exitedEarly
        ? `it exited early with code ${exitedEarly.code}, signal ${exitedEarly.signal}, before ever listening on 127.0.0.1:${port}`
        : `127.0.0.1:${port} never accepted a connection within ${secondsToWaitForTheListener} s`;
    return {
      failedBecause: `${why}${lastLines.length ? `; last output: ${lastLines.join(" / ")}` : "; it printed nothing"}`,
      outputLines,
    };
  }
  console.log(`    127.0.0.1:${port} accepted a connection after ${Date.now() - waitStartedAt} ms`);
  return { child, outputLines };
}

function stopTheProcessThisRunStarted(child, describedAs) {
  return new Promise((resolveStopped) => {
    if (!child || child.pid === undefined) {
      resolveStopped();
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      console.log(`    ${describedAs} had already exited with code ${child.exitCode}; nothing to stop`);
      resolveStopped();
      return;
    }
    console.log(`    stopping pid ${child.pid} (${describedAs}); this run started it, and it stops nothing else`);
    child.once("exit", (code, signal) => {
      console.log(`    pid ${child.pid} exited with code ${code}, signal ${signal}`);
      resolveStopped();
    });
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
    setTimeout(() => resolveStopped(), 8000);
  });
}

/** Runs conformance/run-wire-conformance-against-url.mjs against a URL this run's host is serving. */
function runTheConformanceSuiteAgainst(url, reportPath, options) {
  const suiteArguments = [
    resolve(conformanceDirectory, "run-wire-conformance-against-url.mjs"),
    "--url",
    url,
    "--report",
    reportPath,
    "--contract",
    options.contractPath,
    "--manifest",
    options.manifestPath,
  ];
  console.log(`    running the suite: ${process.execPath} ${suiteArguments.join(" ")}`);
  return new Promise((resolveFinished) => {
    const suite = spawn(process.execPath, suiteArguments, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    suite.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    suite.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    suite.once("exit", (code) => resolveFinished({ exitCode: code ?? 1, output }));
  });
}

async function generateCrossHostConformanceReport() {
  const startedAt = new Date();
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (failure) {
    console.error(`quackoscope cross-host report: ${failure.message}`);
    return 2;
  }
  if (options === null) {
    console.log(
      `generate-cross-host-conformance-report.mjs [--hosts ${EVERY_HOST_KEY.join(",")}] [--port-range ${DEFAULT_LOWEST_PORT_THIS_REPORT_MAY_BIND}-${DEFAULT_HIGHEST_PORT_THIS_REPORT_MAY_BIND}] [--first-port ${DEFAULT_LOWEST_PORT_THIS_REPORT_MAY_BIND}] [--output-directory <dir>] [--contract <path>] [--manifest <path>] [--request-timeout-ms <n>] [--seconds-to-wait-for-the-listener <n>]`,
    );
    console.log(
      `  --port-range <first>-<last>  the only ports this run may bind; it refuses outside them. Default ${DEFAULT_LOWEST_PORT_THIS_REPORT_MAY_BIND}-${DEFAULT_HIGHEST_PORT_THIS_REPORT_MAY_BIND}.`,
    );
    console.log(
      `  --first-port <n>             where inside that window the hosts start, one port each in --hosts order. Default: the first port of the window.`,
    );
    for (const hostKey of EVERY_HOST_KEY) console.log(`  ${hostKey.padEnd(8)} ${HOSTS_THIS_REPORT_CAN_START[hostKey].describedAs}`);
    return 0;
  }

  const commandLine = `node conformance/generate-cross-host-conformance-report.mjs ${process.argv.slice(2).join(" ")}`.trim();
  console.log("quackoscope cross-host conformance report");
  console.log(`  command             ${commandLine}`);
  console.log(`  repository root     ${repositoryRoot}`);
  console.log(`  contract            ${options.contractPath}`);
  console.log(`  manifest            ${options.manifestPath}`);
  console.log(`  output directory    ${options.outputDirectory}`);
  console.log(`  hosts asked for     ${options.hostKeys.join(", ")}`);
  console.log(`  ports it will bind  ${options.hostKeys.map((hostKey, index) => `${hostKey}=${options.firstPort + index}`).join(", ")}  (allowed window ${options.lowestPortAllowed}-${options.highestPortAllowed}${options.lowestPortAllowed === DEFAULT_LOWEST_PORT_THIS_REPORT_MAY_BIND && options.highestPortAllowed === DEFAULT_HIGHEST_PORT_THIS_REPORT_MAY_BIND ? ", the built-in default" : ", set by --port-range"})`);
  warnIfTheHostCommandTableDriftedFromTheLauncher();

  let contract;
  try {
    contract = readWireContract(options.contractPath);
  } catch (failure) {
    console.error(`quackoscope cross-host report: could not read the contract at ${options.contractPath}: ${failure.message}`);
    return 2;
  }
  console.log(
    `  contract read       ${contract.contractName} protocol_version ${contract.protocolVersion}: ` +
      `${contract.capabilityBaselineIds.length} baseline capabilities, ${contract.operations.length} operations, ` +
      `${contract.errorCodes.length} error codes, ${contract.events.length} events`,
  );

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(options.manifestPath, "utf8"));
  } catch (failure) {
    console.error(`quackoscope cross-host report: could not read ${options.manifestPath}: ${failure.message}`);
    return 2;
  }
  console.log(`  manifest sdk        version ${manifest.sdk_version}, commit ${manifest.commit}`);

  mkdirSync(options.outputDirectory, { recursive: true });

  const hosts = options.hostKeys.map((hostKey, index) => ({
    hostKey,
    port: options.firstPort + index,
    describedAs: HOSTS_THIS_REPORT_CAN_START[hostKey].describedAs,
    commandLine: `${HOSTS_THIS_REPORT_CAN_START[hostKey].command()} ${HOSTS_THIS_REPORT_CAN_START[hostKey].argumentsForPort(options.firstPort + index).join(" ")}`,
    handshake: null,
    handshakeVerbatim: null,
    conformanceReport: null,
    conformanceReportPath: null,
    suiteExitCode: null,
    interrogation: null,
    unavailableBecause: null,
    // Filled in by the gate below, from the host's own handshake `sdk` record.
    sdkProvenance: null,
    isReportedAlongsideRatherThanComparedAsEqual: false,
  }));

  // =========================================================================
  // PHASE 1: read every handshake, and nothing else, so the sdk.commit gate
  // runs before a single conformance sweep does.
  // =========================================================================
  console.log("\n=== phase 1: start each host, read its handshake, stop it ====================");
  for (const host of hosts) {
    console.log(`\n  ${host.hostKey} on port ${host.port}: ${host.describedAs}`);
    const started = await startOneHostAndWaitForItsPort(host.hostKey, host.port, options.secondsToWaitForTheListener);
    if (started.failedBecause) {
      host.unavailableBecause = started.failedBecause;
      console.log(`    ${host.hostKey} is UNAVAILABLE: ${started.failedBecause}`);
      continue;
    }
    const url = `ws://127.0.0.1:${host.port}/ws`;
    try {
      const { openWireSession } = await import("./wire/open-wire-session.mjs");
      const { session, firstMessage } = await openWireSession(url, contract, { requestTimeoutMs: options.requestTimeoutMs });
      host.handshakeVerbatim = firstMessage.text;
      host.handshake = firstMessage.parsed;
      session.close();
      console.log(`    handshake, message ordinal 1, ${firstMessage.text.length} bytes:`);
      console.log(`      implementation  ${host.handshake?.implementation?.name} ${host.handshake?.implementation?.version}`);
      console.log(`      sdk.version     ${host.handshake?.sdk?.version}`);
      console.log(`      sdk.commit      ${host.handshake?.sdk?.commit}`);
      console.log(`      capabilities    ${(host.handshake?.capabilities ?? []).join(", ") || "(none)"}`);
      console.log(`      gaps            ${(host.handshake?.gaps ?? []).map((gap) => `${gap.capability} (${gap.kind})`).join(", ") || "(none)"}`);
    } catch (failure) {
      host.unavailableBecause = `it listened on 127.0.0.1:${host.port} but produced no usable handshake: ${failure.message}`;
      console.log(`    ${host.hostKey} is UNAVAILABLE: ${host.unavailableBecause}`);
    }
    await stopTheProcessThisRunStarted(started.child, `${host.hostKey} on port ${host.port}`);
  }

  // =========================================================================
  // THE GATE
  // =========================================================================
  console.log("\n=== the sdk.commit gate ======================================================");
  const hostsThatHandshook = hosts.filter((host) => host.handshake !== null);
  if (hostsThatHandshook.length === 0) {
    console.error(`quackoscope cross-host report: not one of ${options.hostKeys.join(", ")} produced a handshake, so there is nothing to compare:`);
    for (const host of hosts) console.error(`  ${host.hostKey}: ${host.unavailableBecause}`);
    return 2;
  }

  const labelForTheGate = (host) =>
    `${host.hostKey} (handshake implementation.name "${host.handshake?.implementation?.name ?? "(absent)"}") at ws://127.0.0.1:${host.port}/ws`;

  const decision = decideWhetherTheseHostsMayBeComparedAsEquals({
    hosts: hostsThatHandshook.map((host) => ({ label: labelForTheGate(host), sdk: host.handshake?.sdk ?? null })),
    manifestCommit: manifest.commit,
    manifestSdkVersion: manifest.sdk_version,
    manifestPath: options.manifestPath,
  });

  // Hang the classification on the host record itself, so phase 2 and the
  // document read one decision rather than each re-deriving it.
  for (const host of hostsThatHandshook) {
    host.sdkProvenance = decision.provenanceByLabel.get(labelForTheGate(host));
    host.isReportedAlongsideRatherThanComparedAsEqual =
      host.sdkProvenance?.provenance === HOST_SDK_PROVENANCE.loadsNoOpenDaqAtAll;
  }
  const hostsComparedAsEquals = hostsThatHandshook.filter(
    (host) => host.sdkProvenance?.provenance === HOST_SDK_PROVENANCE.sameOpenDaqBuildAsTheManifest,
  );
  const hostsReportedAlongside = hostsThatHandshook.filter((host) => host.isReportedAlongsideRatherThanComparedAsEqual);

  const hostKeysByCommit = new Map();
  for (const host of hostsThatHandshook) {
    if (host.isReportedAlongsideRatherThanComparedAsEqual) continue;
    const commit = host.sdkProvenance?.sdkCommit ?? "(no sdk.commit in the handshake)";
    if (!hostKeysByCommit.has(commit)) hostKeysByCommit.set(commit, []);
    hostKeysByCommit.get(commit).push(host.hostKey);
  }
  for (const [commit, hostKeys] of hostKeysByCommit) console.log(`  sdk.commit ${commit}  <-  ${hostKeys.join(", ")}`);
  console.log(`  manifest   ${manifest.commit}  (${manifest.sdk_version}) from ${options.manifestPath}`);
  for (const host of hostsReportedAlongside) {
    console.log(
      `  no openDAQ at all  <-  ${host.hostKey}: sdk.version "${host.sdkProvenance.sdkVersion}", sdk.commit "${host.sdkProvenance.sdkCommit}"`,
    );
  }

  if (decision.refuse) {
    console.log("\n=== REFUSED TO GENERATE THE REPORT ===========================================");
    console.log("These hosts were not all running the same openDAQ, so a behavioural difference");
    console.log("between them cannot be attributed to the hosts. No conformance sweep was run,");
    console.log("no wrong input was sent, and no markdown was written.");
    console.log("");
    for (const disagreement of decision.disagreements) console.log(`  - ${disagreement}`);
    console.log("");
    console.log(`  manifest commit   ${manifest.commit}  (${manifest.sdk_version})`);
    console.log(`  commits reported  ${[...decision.commitsSeen.keys()].join(", ") || "(none)"}`);
    if (hostsReportedAlongside.length > 0) {
      console.log(
        `  reported alongside, and NOT the reason for this refusal: ${hostsReportedAlongside.map((host) => `${host.hostKey} (sdk.version "${host.sdkProvenance.sdkVersion}", sdk.commit "${host.sdkProvenance.sdkCommit}")`).join(", ")}`,
      );
    }
    console.log("");
    console.log("Rebuild the disagreeing host against the manifest's openDAQ, or leave it out of");
    console.log(
      `--hosts, and run again. For example: --hosts ${[...hostsComparedAsEquals, ...hostsReportedAlongside].map((host) => host.hostKey).join(",") || "<the hosts on the manifest's commit>"}`,
    );
    console.log("exit 3");
    return 3;
  }
  const sdkCommitGate = {
    verdict: decision.verdict,
    agreedCommit: hostsComparedAsEquals.length > 0 ? manifest.commit : null,
    explanation:
      `${decision.explanation} ` +
      `${hosts.length - hostsThatHandshook.length > 0 ? `${hosts.length - hostsThatHandshook.length} host(s) produced no handshake and are marked unavailable in section 1 rather than dropped.` : "Every host asked for answered."}`,
    comparedAsEquals: hostsComparedAsEquals.map((host) => host.hostKey),
    reportedAlongside: hostsReportedAlongside.map((host) => ({
      hostKey: host.hostKey,
      sdkVersion: host.sdkProvenance.sdkVersion,
      sdkCommit: host.sdkProvenance.sdkCommit,
      inWords: host.sdkProvenance.inWords,
    })),
    whatReportedAlongsideMeans: WHAT_REPORTED_ALONGSIDE_MEANS,
  };
  console.log(`\n  gate verdict: ${decision.verdict}`);
  console.log(
    `  compared as equals    ${hostsComparedAsEquals.map((host) => host.hostKey).join(", ") || "(none)"}${hostsComparedAsEquals.length ? `, all on sdk.commit ${manifest.commit}` : ""}`,
  );
  console.log(
    `  reported alongside    ${hostsReportedAlongside.map((host) => host.hostKey).join(", ") || "(none)"}${hostsReportedAlongside.length ? " - swept, interrogated and printed, marked (no SDK), counted in no agreement column" : ""}`,
  );
  console.log(`  the sweeps may run.`);

  // =========================================================================
  // PHASE 2: the conformance sweep and the wrong-input interrogation, against
  // one live host at a time.
  // =========================================================================
  console.log("\n=== phase 2: conformance sweep and identical wrong inputs, per host ==========");
  for (const host of hosts) {
    if (host.handshake === null) {
      console.log(`\n  ${host.hostKey}: skipped, it is unavailable (${host.unavailableBecause})`);
      continue;
    }
    console.log(`\n  ${host.hostKey} on port ${host.port}`);
    const started = await startOneHostAndWaitForItsPort(host.hostKey, host.port, options.secondsToWaitForTheListener);
    if (started.failedBecause) {
      host.unavailableBecause = `its handshake was read in phase 1, but it would not start again for the sweep: ${started.failedBecause}`;
      host.handshake = null;
      host.handshakeVerbatim = null;
      console.log(`    ${host.hostKey} is UNAVAILABLE: ${host.unavailableBecause}`);
      continue;
    }

    const url = `ws://127.0.0.1:${host.port}/ws`;
    const reportPath = resolve(options.outputDirectory, `${host.hostKey}-conformance-report.json`);
    const suiteOutputPath = resolve(options.outputDirectory, `${host.hostKey}-conformance-sweep-output.txt`);
    const suite = await runTheConformanceSuiteAgainst(url, reportPath, options);
    writeFileSync(suiteOutputPath, suite.output, "utf8");
    host.suiteExitCode = suite.exitCode;
    console.log(`    the suite exited ${suite.exitCode}; its ${suite.output.split("\n").length} output lines are in ${suiteOutputPath}`);
    for (const line of suite.output.split(/\r?\n/).slice(-10)) {
      if (line.trim() !== "") console.log(`      ${line}`);
    }
    try {
      host.conformanceReport = JSON.parse(readFileSync(reportPath, "utf8"));
      host.conformanceReportPath = reportPath;
    } catch (failure) {
      host.unavailableBecause = `the conformance suite exited ${suite.exitCode} and wrote no readable report at ${reportPath}: ${failure.message}`;
      console.log(`    ${host.hostKey} produced no report: ${host.unavailableBecause}`);
    }

    if (host.conformanceReport !== null) {
      console.log(`    sending ${host.hostKey} the identical wrong inputs`);
      try {
        host.interrogation = await interrogateHostWithIdenticalWrongInputs({
          url,
          contract,
          requestTimeoutMs: options.requestTimeoutMs,
          log: (text) => console.log(`      ${text.replace(/\n/g, "\n      ")}`),
        });
        console.log(`    ${host.interrogation.answers.length} wrong inputs sent to ${host.hostKey}`);
      } catch (failure) {
        console.log(`    the wrong-input interrogation of ${host.hostKey} could not run: ${failure.message}`);
      }
    }

    await stopTheProcessThisRunStarted(started.child, `${host.hostKey} on port ${host.port}`);
    const stillListening = await tryToConnect(host.port, 400);
    console.log(`    port ${host.port} after the stop: ${stillListening ? "STILL ACCEPTING - something is left over, check it" : "nothing is listening"}`);
  }

  // =========================================================================
  // The document
  // =========================================================================
  const finishedAt = new Date();
  const markdown = renderCrossHostConformanceMarkdown({
    commandLine,
    contract,
    contractPath: options.contractPath,
    manifest,
    manifestPath: options.manifestPath,
    hosts,
    sdkCommitGate,
    startedAt,
    finishedAt,
  });
  const markdownPath = resolve(options.outputDirectory, "quackoscope-cross-host-conformance-report.md");
  writeFileSync(markdownPath, markdown, "utf8");

  console.log("\n=== the report ===============================================================");
  console.log(`  wrote ${markdownPath} (${markdown.length} bytes, ${markdown.split("\n").length} lines)`);
  const ran = hosts.filter((host) => host.conformanceReport !== null);
  const unavailable = hosts.filter((host) => host.conformanceReport === null);
  console.log(
    `  hosts compared        ${ran.filter((host) => !host.isReportedAlongsideRatherThanComparedAsEqual).map((host) => host.hostKey).join(", ") || "(none)"}`,
  );
  console.log(
    `  hosts alongside       ${ran.filter((host) => host.isReportedAlongsideRatherThanComparedAsEqual).map((host) => `${host.hostKey} (sdk.commit "${host.sdkProvenance.sdkCommit}")`).join(", ") || "(none)"}${ran.some((host) => host.isReportedAlongsideRatherThanComparedAsEqual) ? " - swept and printed, marked (no SDK), counted in no agreement column" : ""}`,
  );
  console.log(`  hosts unavailable     ${unavailable.map((host) => host.hostKey).join(", ") || "(none)"}${unavailable.length ? " - each one keeps its column, with the reason in the cell" : ""}`);
  console.log(`  keyed to sdk.commit   ${manifest.commit}`);
  for (const host of ran) {
    const tallies = host.conformanceReport.tallies;
    const coverage = host.conformanceReport.operation_coverage ?? null;
    console.log(
      `  ${host.hostKey.padEnd(8)} class (a) declared gap ${String(tallies.gap_declared_and_consistent ?? 0).padStart(2)}, ` +
        `class (b) claimed and failed ${String(tallies.capability_claimed_and_broken ?? 0).padStart(2)}, ` +
        `warnings ${String(host.conformanceReport.warning_count).padStart(2)}, ` +
        `${host.interrogation?.answers.length ?? 0} wrong inputs answered, ` +
        `${coverage === null ? "operation coverage not reported by that run" : `${coverage.driven.length} of ${coverage.operations_in_the_contract} contract operations driven${coverage.never_driven.length === 0 ? "" : ` - NEVER DRIVEN: ${coverage.never_driven.join(", ")}`}`}`,
    );
  }

  // Two different things can make this report untrustworthy, and only one of
  // them is a host's fault. A class (b) failure is a host that advertised a
  // capability and then broke it. A suite_coverage_incomplete entry is this
  // suite never asking one of the contract's rows - and every table in the
  // document is then drawn from a sweep smaller than the contract it cites,
  // which is exactly how six operations rode along inside a report that exited
  // 0. Both make the run non-clean, and the message below says which happened.
  const hostsWithClassBFailures = ran.filter((host) => (host.conformanceReport.tallies.capability_claimed_and_broken ?? 0) > 0);
  const hostsWithACoverageHole = ran.filter((host) => (host.conformanceReport.tallies.suite_coverage_incomplete ?? 0) > 0);
  const exitCode = hostsWithClassBFailures.length > 0 || hostsWithACoverageHole.length > 0 ? 1 : 0;
  console.log(
    `\n${hostsWithClassBFailures.length > 0 ? `${hostsWithClassBFailures.map((host) => host.hostKey).join(", ")} claimed a capability and then broke it` : "no host claimed a capability and then broke it"}.`,
  );
  if (hostsWithACoverageHole.length > 0) {
    const neverDriven = [
      ...new Set(hostsWithACoverageHole.flatMap((host) => host.conformanceReport.operation_coverage?.never_driven ?? [])),
    ];
    console.log(
      `THE SUITE DID NOT DRIVE THE WHOLE CONTRACT against ${hostsWithACoverageHole.map((host) => host.hostKey).join(", ")}: ` +
        `${neverDriven.join(", ")} went to no socket. That is a hole in conformance/sweeps, not a fault of those hosts, and every ` +
        "table in the document above is then drawn from a sweep smaller than the contract it cites.",
    );
  }
  console.log(`exit ${exitCode}`);
  return exitCode;
}

const exitCode = await generateCrossHostConformanceReport();
process.exit(exitCode);
