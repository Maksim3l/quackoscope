// Starts one host on a port this workflow owns, waits for it to accept a TCP
// connection, runs the conformance suite against it, and then stops exactly the
// process it started.
//
// The split matters. run-wire-conformance-against-url.mjs knows nothing about
// hosts: it takes a URL and judges whatever answers. THIS file is the only place
// in conformance/ that knows a host exists as a program with a command line, and
// it is not imported by the suite. Pointing the suite at a host somebody else
// started, or at a host on another machine, needs none of this file.
//
//   node conformance/start-host-then-run-wire-conformance.mjs --host mock --port 7813
//   node conformance/start-host-then-run-wire-conformance.mjs --host rust --port 7814 --report out.json
//
// Exit code is the suite's own: 0 no failures, 1 failures, 2 could not run.

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const conformanceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(conformanceDirectory, "..");

// The default window of ports this launcher may bind. Starting a listener
// outside the window in force would collide with the live demo or with other
// work in flight, so it refuses; which ports are free is a fact about the
// machine and the moment, not about this file, so --port-range moves the window.
const DEFAULT_FIRST_PORT_THIS_LAUNCHER_MAY_BIND = 7811;
const DEFAULT_LAST_PORT_THIS_LAUNCHER_MAY_BIND = 7830;

const HOSTS_THIS_LAUNCHER_CAN_START = {
  mock: {
    describedAs: "hosts/mock-ts, a synthetic reference device with no openDAQ SDK in the process",
    command: process.execPath,
    argumentsForPort: (port) => [resolve(repositoryRoot, "hosts/mock-ts/src/start-mock-host.ts"), "--port", String(port)],
    executableToCheck: () => resolve(repositoryRoot, "hosts/mock-ts/src/start-mock-host.ts"),
  },
  cpp: {
    describedAs: "hosts/cpp, the reference implementation, against the openDAQ build named in manifest.json",
    command: resolve(repositoryRoot, "hosts/cpp/build/Release/quackoscope-host-cpp.exe"),
    argumentsForPort: (port) => ["--manifest", resolve(repositoryRoot, "manifest.json"), "--port", String(port)],
    executableToCheck: () => resolve(repositoryRoot, "hosts/cpp/build/Release/quackoscope-host-cpp.exe"),
  },
  python: {
    describedAs: "hosts/python, against the openDAQ build named in manifest.json",
    command: "python",
    argumentsForPort: (port) => [
      resolve(repositoryRoot, "hosts/python/quackoscope_host.py"),
      "--manifest",
      resolve(repositoryRoot, "manifest.json"),
      "--port",
      String(port),
    ],
    executableToCheck: () => resolve(repositoryRoot, "hosts/python/quackoscope_host.py"),
  },
  csharp: {
    describedAs: "hosts/csharp, against the openDAQ build named in manifest.json",
    command: resolve(repositoryRoot, "hosts/csharp/bin/Release/net8.0/quackoscope-host-csharp.exe"),
    argumentsForPort: (port) => ["--manifest", resolve(repositoryRoot, "manifest.json"), "--port", String(port)],
    executableToCheck: () => resolve(repositoryRoot, "hosts/csharp/bin/Release/net8.0/quackoscope-host-csharp.exe"),
  },
  rust: {
    describedAs: "hosts/rust, against the openDAQ build named in manifest.json",
    command: resolve(repositoryRoot, "hosts/rust/target/release/quackoscope-host-rust.exe"),
    argumentsForPort: (port) => [
      "--manifest",
      resolve(repositoryRoot, "manifest.json"),
      "--symbol-list",
      resolve(repositoryRoot, "generated/rust/symbol-list.json"),
      "--port",
      String(port),
    ],
    executableToCheck: () => resolve(repositoryRoot, "hosts/rust/target/release/quackoscope-host-rust.exe"),
  },
};

function parseArguments(argv) {
  const options = {
    host: null,
    port: null,
    passThroughToSuite: [],
    secondsToWaitForTheListener: 90,
    seededFaultProxyPort: null,
    proxyDeclare: "as-upstream-sent-it",
    proxyBreakMethod: null,
    proxyBreakAs: "refuse-with-internal",
    proxyMisreportSdkCommitAs: null,
    lowestPortAllowed: DEFAULT_FIRST_PORT_THIS_LAUNCHER_MAY_BIND,
    highestPortAllowed: DEFAULT_LAST_PORT_THIS_LAUNCHER_MAY_BIND,
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const nextValue = (name) => {
      if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
      return argv[++i];
    };
    if (argument === "--host") options.host = nextValue("--host");
    else if (argument === "--port") options.port = Number(nextValue("--port"));
    else if (argument === "--seconds-to-wait-for-the-listener") options.secondsToWaitForTheListener = Number(nextValue(argument));
    else if (argument === "--through-seeded-fault-proxy-on-port") options.seededFaultProxyPort = Number(nextValue(argument));
    else if (argument === "--proxy-declare") options.proxyDeclare = nextValue(argument);
    else if (argument === "--proxy-break-method") options.proxyBreakMethod = nextValue(argument);
    else if (argument === "--proxy-break-as") options.proxyBreakAs = nextValue(argument);
    else if (argument === "--proxy-misreport-sdk-commit-as") options.proxyMisreportSdkCommitAs = nextValue(argument);
    else if (argument === "--port-range") {
      const spelling = nextValue("--port-range");
      const bounds = /^(\d+)-(\d+)$/.exec(spelling.trim());
      if (!bounds) {
        throw new Error(
          `--port-range was given "${spelling}"; it takes two port numbers joined by a hyphen, for example --port-range ${DEFAULT_FIRST_PORT_THIS_LAUNCHER_MAY_BIND}-${DEFAULT_LAST_PORT_THIS_LAUNCHER_MAY_BIND}`,
        );
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
    else if (argument === "--help" || argument === "-h") return null;
    else options.passThroughToSuite.push(argument);
  }
  if (options.host === null) {
    throw new Error(`--host is required; this launcher can start ${Object.keys(HOSTS_THIS_LAUNCHER_CAN_START).join(", ")}`);
  }
  if (!(options.host in HOSTS_THIS_LAUNCHER_CAN_START)) {
    throw new Error(
      `--host ${JSON.stringify(options.host)} is not one this launcher knows; it can start ${Object.keys(HOSTS_THIS_LAUNCHER_CAN_START).join(", ")}`,
    );
  }
  if (options.port === null) throw new Error("--port is required");
  if (!Number.isInteger(options.port) || options.port < options.lowestPortAllowed || options.port > options.highestPortAllowed) {
    throw new Error(
      `--port ${options.port} is outside ${options.lowestPortAllowed}-${options.highestPortAllowed}, the window this launcher may bind. Refusing to start a listener there. Move the window with --port-range <first>-<last> if those ports are yours to bind.`,
    );
  }
  if (options.seededFaultProxyPort !== null) {
    if (
      !Number.isInteger(options.seededFaultProxyPort) ||
      options.seededFaultProxyPort < options.lowestPortAllowed ||
      options.seededFaultProxyPort > options.highestPortAllowed
    ) {
      throw new Error(
        `--through-seeded-fault-proxy-on-port ${options.seededFaultProxyPort} is outside ${options.lowestPortAllowed}-${options.highestPortAllowed}, the window this launcher may bind. Refusing to start a listener there.`,
      );
    }
    if (options.seededFaultProxyPort === options.port) {
      throw new Error(`the proxy port and the host port are both ${options.port}; they must differ`);
    }
  }
  return options;
}

function tryToConnect(port, milliseconds) {
  return new Promise((resolve_) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const giveUp = setTimeout(() => {
      socket.destroy();
      resolve_(false);
    }, milliseconds);
    socket.once("connect", () => {
      clearTimeout(giveUp);
      socket.end();
      resolve_(true);
    });
    socket.once("error", () => {
      clearTimeout(giveUp);
      socket.destroy();
      resolve_(false);
    });
  });
}

async function refuseIfSomethingIsAlreadyListening(port, lowestPortAllowed, highestPortAllowed) {
  if (await tryToConnect(port, 400)) {
    throw new Error(
      `something is already listening on 127.0.0.1:${port}. This launcher starts its own host and stops it again, so it will not attach to a listener it did not start. Choose another port in ${lowestPortAllowed}-${highestPortAllowed}.`,
    );
  }
}

function stopTheProcessThisLauncherStarted(child, describedAs) {
  return new Promise((resolve_) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      console.log(`[launcher] ${describedAs} had already exited with code ${child.exitCode}; nothing to stop`);
      resolve_();
      return;
    }
    console.log(`[launcher] stopping pid ${child.pid} (${describedAs}); this launcher started it, and it stops nothing else`);
    child.once("exit", (code, signal) => {
      console.log(`[launcher] pid ${child.pid} exited with code ${code}, signal ${signal}`);
      resolve_();
    });
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
    setTimeout(() => resolve_(), 8000);
  });
}

async function startHostThenRunWireConformance() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (failure) {
    console.error(`quackoscope conformance launcher: ${failure.message}`);
    return 2;
  }
  if (options === null) {
    console.log(
      `start-host-then-run-wire-conformance.mjs --host <${Object.keys(HOSTS_THIS_LAUNCHER_CAN_START).join("|")}> --port <${DEFAULT_FIRST_PORT_THIS_LAUNCHER_MAY_BIND}-${DEFAULT_LAST_PORT_THIS_LAUNCHER_MAY_BIND}> [--port-range <first>-<last>] [--through-seeded-fault-proxy-on-port <n> [--proxy-declare <mode>] [--proxy-break-method <wire method> --proxy-break-as <mode>] [--proxy-misreport-sdk-commit-as <commit>]] [any run-wire-conformance-against-url.mjs argument]`,
    );
    console.log(
      `  --port-range <first>-<last>          the only ports this launcher may bind, for the host and for the proxy. Default ${DEFAULT_FIRST_PORT_THIS_LAUNCHER_MAY_BIND}-${DEFAULT_LAST_PORT_THIS_LAUNCHER_MAY_BIND}.`,
    );
    console.log(
      `  --proxy-misreport-sdk-commit-as <commit>  the proxy rewrites the handshake's sdk.commit to <commit>, so the report this run writes says the host loaded an openDAQ it did not`,
    );
    for (const [name, host] of Object.entries(HOSTS_THIS_LAUNCHER_CAN_START)) {
      console.log(`  ${name.padEnd(8)} ${host.describedAs}`);
    }
    return 0;
  }

  const host = HOSTS_THIS_LAUNCHER_CAN_START[options.host];
  const executable = host.executableToCheck();
  if (!existsSync(executable)) {
    console.error(
      `quackoscope conformance launcher: --host ${options.host} needs ${executable}, which does not exist. Build that host first; this launcher builds nothing.`,
    );
    return 2;
  }

  try {
    await refuseIfSomethingIsAlreadyListening(options.port, options.lowestPortAllowed, options.highestPortAllowed);
  } catch (failure) {
    console.error(`quackoscope conformance launcher: ${failure.message}`);
    return 2;
  }

  const argumentsForHost = host.argumentsForPort(options.port);
  console.log(`[launcher] starting ${options.host}: ${host.describedAs}`);
  console.log(`[launcher] command: ${host.command} ${argumentsForHost.join(" ")}`);
  console.log(`[launcher] cwd:     ${repositoryRoot}`);

  const child = spawn(host.command, argumentsForHost, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
  const hostOutputLines = [];
  const absorb = (label) => (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() === "") continue;
      hostOutputLines.push(`[${label}] ${line}`);
      console.log(`[${label}] ${line}`);
    }
  };
  child.stdout.on("data", absorb(`${options.host} stdout`));
  child.stderr.on("data", absorb(`${options.host} stderr`));

  let childExitedEarly = null;
  child.once("exit", (code, signal) => {
    if (childExitedEarly === null) childExitedEarly = { code, signal };
  });

  console.log(`[launcher] pid ${child.pid}; waiting up to ${options.secondsToWaitForTheListener} s for 127.0.0.1:${options.port} to accept a connection`);
  const waitStartedAt = Date.now();
  let listening = false;
  while (Date.now() - waitStartedAt < options.secondsToWaitForTheListener * 1000) {
    if (childExitedEarly !== null) break;
    if (await tryToConnect(options.port, 300)) {
      listening = true;
      break;
    }
    await sleep(250);
  }

  if (!listening) {
    console.error(
      `[launcher] 127.0.0.1:${options.port} never accepted a connection` +
        (childExitedEarly ? `; the host exited early with code ${childExitedEarly.code}, signal ${childExitedEarly.signal}` : ` within ${options.secondsToWaitForTheListener} s`),
    );
    console.error(`[launcher] the host printed ${hostOutputLines.length} line(s); the last few:`);
    hostOutputLines.slice(-8).forEach((line) => console.error(`  ${line}`));
    await stopTheProcessThisLauncherStarted(child, `${options.host} on port ${options.port}`);
    return 2;
  }
  console.log(`[launcher] 127.0.0.1:${options.port} accepted a connection after ${Date.now() - waitStartedAt} ms`);

  // Optionally interpose the seeded-fault proxy, so the suite is driven against
  // a host that is deliberately misrepresenting itself.
  let proxyChild = null;
  let urlTheSuiteWillDrive = `ws://127.0.0.1:${options.port}/ws`;
  if (options.seededFaultProxyPort !== null) {
    try {
      await refuseIfSomethingIsAlreadyListening(options.seededFaultProxyPort, options.lowestPortAllowed, options.highestPortAllowed);
    } catch (failure) {
      console.error(`quackoscope conformance launcher: ${failure.message}`);
      await stopTheProcessThisLauncherStarted(child, `${options.host} on port ${options.port}`);
      return 2;
    }
    const proxyArguments = [
      resolve(conformanceDirectory, "seeded-fault-proxy", "misrepresent-a-host-to-seed-a-conformance-fault.mjs"),
      "--upstream",
      `ws://127.0.0.1:${options.port}/ws`,
      "--port",
      String(options.seededFaultProxyPort),
      "--port-range",
      `${options.lowestPortAllowed}-${options.highestPortAllowed}`,
      "--declare",
      options.proxyDeclare,
      ...(options.proxyBreakMethod ? ["--break-method", options.proxyBreakMethod, "--break-as", options.proxyBreakAs] : []),
      ...(options.proxyMisreportSdkCommitAs ? ["--misreport-sdk-commit-as", options.proxyMisreportSdkCommitAs] : []),
    ];
    console.log(`[launcher] starting the seeded-fault proxy: ${process.execPath} ${proxyArguments.join(" ")}`);
    proxyChild = spawn(process.execPath, proxyArguments, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    proxyChild.stdout.on("data", absorb("proxy stdout"));
    proxyChild.stderr.on("data", absorb("proxy stderr"));

    const proxyWaitStartedAt = Date.now();
    let proxyListening = false;
    while (Date.now() - proxyWaitStartedAt < 30000) {
      if (await tryToConnect(options.seededFaultProxyPort, 300)) {
        proxyListening = true;
        break;
      }
      await sleep(200);
    }
    if (!proxyListening) {
      console.error(`[launcher] the seeded-fault proxy never listened on 127.0.0.1:${options.seededFaultProxyPort}`);
      await stopTheProcessThisLauncherStarted(proxyChild, `seeded-fault proxy on port ${options.seededFaultProxyPort}`);
      await stopTheProcessThisLauncherStarted(child, `${options.host} on port ${options.port}`);
      return 2;
    }
    console.log(`[launcher] the seeded-fault proxy is listening on 127.0.0.1:${options.seededFaultProxyPort} after ${Date.now() - proxyWaitStartedAt} ms`);
    urlTheSuiteWillDrive = `ws://127.0.0.1:${options.seededFaultProxyPort}/ws`;
  }

  const url = urlTheSuiteWillDrive;
  const suiteArguments = [
    resolve(conformanceDirectory, "run-wire-conformance-against-url.mjs"),
    "--url",
    url,
    ...options.passThroughToSuite,
  ];
  console.log(`[launcher] running the suite: ${process.execPath} ${suiteArguments.join(" ")}\n`);

  const suiteExitCode = await new Promise((resolve_) => {
    const suite = spawn(process.execPath, suiteArguments, { cwd: repositoryRoot, stdio: "inherit" });
    suite.once("exit", (code) => resolve_(code ?? 1));
  });

  console.log("");
  if (proxyChild !== null) {
    await stopTheProcessThisLauncherStarted(proxyChild, `seeded-fault proxy on port ${options.seededFaultProxyPort}`);
  }
  await stopTheProcessThisLauncherStarted(child, `${options.host} on port ${options.port}`);
  const stillListening = await tryToConnect(options.port, 400);
  console.log(
    `[launcher] port ${options.port} after the stop: ${stillListening ? "STILL ACCEPTING - something is left over, check it" : "nothing is listening"}`,
  );
  if (proxyChild !== null) {
    const proxyStillListening = await tryToConnect(options.seededFaultProxyPort, 400);
    console.log(
      `[launcher] port ${options.seededFaultProxyPort} after the stop: ${proxyStillListening ? "STILL ACCEPTING - something is left over, check it" : "nothing is listening"}`,
    );
  }
  console.log(`[launcher] suite exit code ${suiteExitCode} for ${options.host} at ${url}`);
  return suiteExitCode;
}

const exitCode = await startHostThenRunWireConformance();
process.exit(exitCode);
