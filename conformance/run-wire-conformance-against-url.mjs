// The Quackoscope wire conformance suite.
//
// Runs the whole sweep against ONE host, addressed by URL and nothing else. It
// does not know, and never asks, which host is at the other end: the handshake's
// capability list is the only thing that decides what is expected of it.
//
//   node conformance/run-wire-conformance-against-url.mjs --url ws://127.0.0.1:7813/ws
//
// Exit code 0 when nothing failed, 1 when something did, 2 when the suite could
// not run at all (nothing listening, a reserved port, an unreadable contract).
//
// The two failure classes this suite exists to keep apart:
//   (a) declared gap, consistent            -> passes
//   (b) claims a capability and fails it     -> fails
// See conformance/sweeps/conformance-ledger.mjs for the full verdict vocabulary.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readWireContract } from "./contract/read-wire-contract-yaml.mjs";
import { openWireSession } from "./wire/open-wire-session.mjs";
import { ConformanceLedger } from "./sweeps/conformance-ledger.mjs";
import { sweepHandshake } from "./sweeps/sweep-handshake-against-contract-1-6.mjs";
import { sweepEveryContractOperation } from "./sweeps/sweep-every-contract-operation.mjs";
import { sweepDeviceOperationModeDeviceLockAndModules } from "./sweeps/sweep-device-operation-mode-device-lock-and-modules.mjs";
import { sweepSubscriptionLifecycleAndBinaryFrames } from "./sweeps/sweep-subscription-lifecycle-and-binary-frames.mjs";
import { sweepComponentAttributesServersRecorderBatchedUpdatesAndInstanceConfiguration } from "./sweeps/sweep-component-attributes-servers-recorder-batched-updates-and-instance-configuration.mjs";
import { requireEveryContractOperationToBeDriven } from "./sweeps/require-every-contract-operation-to-be-driven.mjs";
import {
  sweepDisconnectBehaviour,
  sweepEventDelivery,
  sweepWireProtocolRules,
} from "./sweeps/sweep-disconnect-and-event-delivery.mjs";

const conformanceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(conformanceDirectory, "..");

// This machine runs a live demo and other agents' work. The suite refuses these
// ports outright rather than trusting the caller to remember which are held.
const PORTS_HELD_BY_THE_LIVE_DEMO_AND_OTHER_WORK = [7788, 7789, 7791];
const PORT_RANGE_HELD_BY_OTHER_WORK = { firstPort: 7801, lastPort: 7810 };

function parseArguments(argv) {
  const options = {
    url: null,
    contractPath: resolve(repositoryRoot, "contract", "contract.yaml"),
    manifestPath: resolve(repositoryRoot, "manifest.json"),
    connectionString: "daqref://device0",
    connectionStringWasGivenExplicitly: false,
    reportPath: null,
    requestTimeoutMs: 10000,
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const nextValue = (name) => {
      if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
      return argv[++i];
    };
    if (argument === "--url") options.url = nextValue("--url");
    else if (argument === "--contract") options.contractPath = resolve(process.cwd(), nextValue("--contract"));
    else if (argument === "--manifest") options.manifestPath = resolve(process.cwd(), nextValue("--manifest"));
    else if (argument === "--connection-string") {
      options.connectionString = nextValue("--connection-string");
      options.connectionStringWasGivenExplicitly = true;
    } else if (argument === "--report") options.reportPath = resolve(process.cwd(), nextValue("--report"));
    else if (argument === "--request-timeout-ms") options.requestTimeoutMs = Number(nextValue("--request-timeout-ms"));
    else if (argument === "--help" || argument === "-h") return null;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.url === null) throw new Error("--url is required, for example --url ws://127.0.0.1:7813/ws");
  return options;
}

function refuseReservedPorts(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`--url ${JSON.stringify(url)} is not a URL; it must look like ws://127.0.0.1:7813/ws`);
  }
  const port = Number(parsed.port);
  if (PORTS_HELD_BY_THE_LIVE_DEMO_AND_OTHER_WORK.includes(port)) {
    throw new Error(
      `refusing to drive port ${port}: it is one of ${PORTS_HELD_BY_THE_LIVE_DEMO_AND_OTHER_WORK.join(", ")}, held by the live demo hosts on this machine. Start your own host on a free port and point --url at that.`,
    );
  }
  if (port >= PORT_RANGE_HELD_BY_OTHER_WORK.firstPort && port <= PORT_RANGE_HELD_BY_OTHER_WORK.lastPort) {
    throw new Error(
      `refusing to drive port ${port}: ${PORT_RANGE_HELD_BY_OTHER_WORK.firstPort}-${PORT_RANGE_HELD_BY_OTHER_WORK.lastPort} is held by other work running on this machine. Start your own host on a free port and point --url at that.`,
    );
  }
  return { parsed, port };
}

const VERDICT_TAGS = {
  held: "  HELD                 ",
  gap_declared_and_consistent: "  GAP (a) CONSISTENT   ",
  capability_claimed_and_broken: "  FAIL (b) CLAIMED     ",
  wire_protocol_broken: "  FAIL WIRE PROTOCOL   ",
  handshake_nonconformant: "  FAIL HANDSHAKE       ",
  gap_declared_but_served: "  WARN GAP BUT SERVED  ",
  suite_coverage_incomplete: "  FAIL SUITE COVERAGE  ",
  not_provokable_by_a_wire_client: "  NOT PROVOKABLE       ",
  unconstrained_by_the_contract: "  UNCONSTRAINED        ",
};

function printLedgerEntry(entry) {
  console.log(`${VERDICT_TAGS[entry.verdict] ?? entry.verdict} ${entry.title}`);
  console.log(`                         contract: ${entry.contract_citation}`);
  console.log(`                         expected: ${entry.expected}`);
  console.log(`                         actual:   ${entry.actual}`);
  if (entry.gap_reason_declared_by_host) {
    console.log(`                         host's declared reason for the gap: ${entry.gap_reason_declared_by_host}`);
  }
}

async function runWireConformanceAgainstUrl() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (failure) {
    console.error(`quackoscope wire conformance: ${failure.message}`);
    return 2;
  }
  if (options === null) {
    console.log(
      "run-wire-conformance-against-url.mjs --url ws://<host>:<port>/ws [--contract <path>] [--manifest <path>] [--connection-string <s>] [--report <path.json>] [--request-timeout-ms <n>]",
    );
    return 0;
  }

  let port;
  try {
    ({ port } = refuseReservedPorts(options.url));
  } catch (failure) {
    console.error(`quackoscope wire conformance: ${failure.message}`);
    return 2;
  }

  console.log("quackoscope wire conformance suite");
  console.log(`  target url          ${options.url}   (port ${port})`);
  console.log(`  contract            ${options.contractPath}`);
  console.log(`  manifest            ${options.manifestPath}`);
  console.log(`  connection_string   ${options.connectionString}${options.connectionStringWasGivenExplicitly ? "  (given on the command line)" : "  (default; a scan result replaces it if the host serves device.scan)"}`);
  console.log(`  request timeout     ${options.requestTimeoutMs} ms`);

  let contract;
  try {
    contract = readWireContract(options.contractPath);
  } catch (failure) {
    console.error(`quackoscope wire conformance: could not read the contract at ${options.contractPath}: ${failure.message}`);
    return 2;
  }
  console.log(
    `  contract read       ${contract.contractName} protocol_version ${contract.protocolVersion}: ` +
      `${contract.capabilityBaselineIds.length} baseline capabilities, ${contract.operations.length} operations, ` +
      `${contract.errorCodes.length} error codes, ${contract.events.length} events, ${Object.keys(contract.types).length} types`,
  );
  console.log(`  baseline            ${contract.capabilityBaselineIds.join(", ")}`);

  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(options.manifestPath, "utf8"));
    console.log(`  manifest sdk        version ${manifest.sdk_version}, commit ${manifest.commit}`);
  } catch (failure) {
    console.log(`  manifest sdk        unreadable at ${options.manifestPath}: ${failure.message}  (the sdk cross-check is left to compare-host-conformance-reports.mjs)`);
  }

  const startedAt = new Date();
  let session;
  let firstMessage;
  try {
    console.log(`\nopening one WebSocket to ${options.url} and waiting for message ordinal 1...`);
    ({ session, firstMessage } = await openWireSession(options.url, contract, { requestTimeoutMs: options.requestTimeoutMs }));
  } catch (failure) {
    console.error(`quackoscope wire conformance: ${failure.message}`);
    console.error(
      "  the suite starts no host of its own. Start one first, for example:\n" +
        "    node conformance/start-host-then-run-wire-conformance.mjs --host mock --port 7813",
    );
    return 2;
  }
  console.log(`message ordinal 1 arrived, ${firstMessage.text.length} bytes:\n${firstMessage.text}\n`);

  const ledger = new ConformanceLedger({ targetUrl: options.url, contract });
  // Every session this run opens, in the order it opens them. The coverage guard
  // counts the requests they sent; sweep 3 opens a second one, because the
  // read_only wording of lock_device can only be asserted from a client that is
  // not the lock holder, and sweep 5 opens one more, because a batch that was
  // abandoned needs a socket that can be closed while it holds one open.
  const sessionsOpened = [session];

  console.log("--- sweep 1: the handshake, against contract 1.6 -----------------------------");
  const handshakeResult = sweepHandshake(ledger, contract, firstMessage);
  console.log(
    `declared capabilities (${handshakeResult.declaredCapabilities.length} of ${contract.capabilityBaselineIds.length}): ` +
      `${handshakeResult.declaredCapabilities.join(", ") || "(none)"}`,
  );
  console.log(
    `computed gaps         (${(handshakeResult.computedGapIds ?? []).length}): ` +
      `${(handshakeResult.computedGapIds ?? []).join(", ") || "(none)"}`,
  );
  ledger.entries.forEach(printLedgerEntry);

  let discovered = {};
  let entriesPrinted = ledger.entries.length;
  const printNewEntries = () => {
    ledger.entries.slice(entriesPrinted).forEach(printLedgerEntry);
    entriesPrinted = ledger.entries.length;
  };

  if (handshakeResult.usable) {
    console.log("\n--- sweep 2: every operation in the contract table ---------------------------");
    discovered = await sweepEveryContractOperation(ledger, contract, session, handshakeResult, options);
    printNewEntries();

    console.log("\n--- sweep 3: device operation mode, device lock, loaded modules --------------");
    const sweepThree = await sweepDeviceOperationModeDeviceLockAndModules(
      ledger,
      contract,
      session,
      handshakeResult,
      discovered,
      options,
    );
    sessionsOpened.push(...sweepThree.sessionsOpenedByThisSweep);
    printNewEntries();

    console.log("\n--- sweep 4: the subscription lifecycle and the binary sample plane ----------");
    await sweepSubscriptionLifecycleAndBinaryFrames(ledger, contract, session, handshakeResult, discovered);
    printNewEntries();

    // Sweep 5 runs here and not earlier: a batched update HOLDS every property
    // write against a subtree and a configuration load replaces the
    // configuration of every device under the instance, so neither may happen
    // while sweep 4 is waiting for sample frames.
    console.log("\n--- sweep 5: component attributes, servers, the recorder, batched updates, instance configuration ---");
    const sweepFive = await sweepComponentAttributesServersRecorderBatchedUpdatesAndInstanceConfiguration(
      ledger,
      contract,
      session,
      handshakeResult,
      discovered,
      options,
    );
    sessionsOpened.push(...sweepFive.sessionsOpenedByThisSweep);
    printNewEntries();

    console.log("\n--- sweep 6: wire-protocol rules, event delivery, disconnect behaviour -------");
    await sweepWireProtocolRules(ledger, contract, session);
    await sweepDisconnectBehaviour(ledger, contract, session, handshakeResult, discovered);
    sweepEventDelivery(ledger, contract, session);
    printNewEntries();
  } else {
    console.log("\nthe handshake was not a usable JSON object, so no operation sweep was attempted.");
  }

  console.log("\n--- the coverage guard: did this run drive every operation in the contract? ---");
  // The guard asks whether conformance/sweeps has a case for every row of the
  // contract, and it can only ask that of a run whose sweeps actually ran. A
  // handshake this suite could not read stops them all, and reporting that as
  // "the suite has no case for these 19 operations" would blame conformance/ for
  // a host's broken first message - which the handshake verdict already covers.
  let operationCoverage = { driven: [], undriven: contract.operations.map((operation) => operation.wireMethod), perOperation: [] };
  if (handshakeResult.usable) {
    operationCoverage = requireEveryContractOperationToBeDriven(ledger, contract, sessionsOpened);
    printNewEntries();
  } else {
    console.log(
      `not asked: the handshake from ${options.url} was not a usable JSON object, so no sweep ran and none of the ` +
        `${contract.operations.length} operations was put on the socket. That is a handshake failure, already recorded above, ` +
        "and not a hole in conformance/sweeps.",
    );
  }
  console.log(
    `operation coverage: ${operationCoverage.driven.length} of ${contract.operations.length} driven` +
      `${operationCoverage.undriven.length === 0 ? "" : `; NEVER DRIVEN: ${operationCoverage.undriven.join(", ")}`}`,
  );
  for (const row of operationCoverage.perOperation) {
    console.log(
      `  ${row.driven ? "driven      " : "NEVER DRIVEN"} ${row.wire_method.padEnd(28)} ` +
        `${String(row.requests_sent).padStart(3)} request(s) sent, ${String(row.ledger_entries).padStart(3)} ledger entry/entries` +
        `${row.declared_undrivable_with_a_reason ? ", and the sweep recorded why a wire client cannot reach it" : ""}`,
    );
  }

  session.close();
  const finishedAt = new Date();

  // --- the report -----------------------------------------------------------
  const tally = ledger.tally();
  const failures = ledger.failures();
  const warnings = ledger.warnings();
  const failuresByClass = {
    capability_claimed_and_broken: failures.filter((entry) => entry.verdict === "capability_claimed_and_broken"),
    handshake_nonconformant: failures.filter((entry) => entry.verdict === "handshake_nonconformant"),
    wire_protocol_broken: failures.filter((entry) => entry.verdict === "wire_protocol_broken"),
    suite_coverage_incomplete: failures.filter((entry) => entry.verdict === "suite_coverage_incomplete"),
  };

  console.log("\n=== verdict ==================================================================");
  console.log(`target                       ${options.url}`);
  console.log(`implementation (display only) ${handshakeResult.implementation?.name ?? "(none)"} ${handshakeResult.implementation?.version ?? ""}`);
  console.log(`sdk reported by the host     version ${handshakeResult.sdk?.version ?? "(none)"}, commit ${handshakeResult.sdk?.commit ?? "(none)"}`);
  console.log(`assertions recorded          ${ledger.entries.length}`);
  for (const [verdict, count] of Object.entries(tally)) {
    console.log(`  ${verdict.padEnd(34)} ${count}`);
  }
  console.log("");
  console.log(`class (a) declared gap, consistent  ${tally.gap_declared_and_consistent ?? 0}   NOT failures: the host said it cannot, and it did not`);
  console.log(`class (b) claimed then broke        ${failuresByClass.capability_claimed_and_broken.length}   REAL failures: the host advertised the capability and then broke it`);
  console.log(`          handshake nonconformant   ${failuresByClass.handshake_nonconformant.length}`);
  console.log(`          wire protocol broken      ${failuresByClass.wire_protocol_broken.length}`);
  console.log(
    `          suite coverage incomplete ${failuresByClass.suite_coverage_incomplete.length}   ` +
      `THIS SUITE's fault, not the host's: ${operationCoverage.driven.length} of ${contract.operations.length} contract operations were driven`,
  );
  console.log(`          gap declared but served   ${warnings.length}   warnings: under-claimed, not a broken promise`);

  if (failures.length > 0) {
    console.log("\nfailures, in full:");
    failures.forEach((entry, index) => {
      console.log(`\n  [${index + 1}/${failures.length}] ${VERDICT_TAGS[entry.verdict].trim()}  ${entry.title}`);
      if (entry.capability) console.log(`        capability claimed in the handshake: ${entry.capability}`);
      if (entry.wire_method) console.log(`        wire method: ${entry.wire_method}`);
      console.log(`        contract: ${entry.contract_citation}`);
      console.log(`        expected: ${entry.expected}`);
      console.log(`        actual:   ${entry.actual}`);
    });
  }

  const report = {
    suite: "quackoscope wire conformance",
    target_url: options.url,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt - startedAt,
    contract_path: options.contractPath,
    contract_name: contract.contractName,
    contract_protocol_version: contract.protocolVersion,
    contract_operations: contract.operations.map((operation) => operation.wireMethod),
    manifest_path: options.manifestPath,
    manifest_sdk: manifest ? { version: manifest.sdk_version, commit: manifest.commit } : null,
    handshake_verbatim: firstMessage.text,
    implementation: handshakeResult.implementation ?? null,
    host_reported_sdk: handshakeResult.sdk ?? null,
    limits: handshakeResult.limits ?? null,
    baseline_capabilities: contract.capabilityBaselineIds,
    declared_capabilities: handshakeResult.declaredCapabilities,
    computed_gap_capabilities: handshakeResult.computedGapIds ?? [],
    connection_string_used: discovered.connectionString ?? options.connectionString,
    operation_coverage: {
      operations_in_the_contract: contract.operations.length,
      driven: operationCoverage.driven,
      never_driven: operationCoverage.undriven,
      per_operation: operationCoverage.perOperation,
    },
    tallies: tally,
    failure_count: failures.length,
    warning_count: warnings.length,
    entries: ledger.entries,
  };

  if (options.reportPath) {
    mkdirSync(dirname(options.reportPath), { recursive: true });
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nwrote the machine-readable report to ${options.reportPath} (${ledger.entries.length} entries)`);
  }

  const exitCode = failures.length === 0 ? 0 : 1;
  console.log(
    `\n${options.url}: ${failures.length === 0 ? "no failure of either class" : `${failures.length} failure(s)`}; ` +
      `${tally.gap_declared_and_consistent ?? 0} declared gap(s) behaved consistently. exit ${exitCode}`,
  );
  return exitCode;
}

const exitCode = await runWireConformanceAgainstUrl();
process.exit(exitCode);
