// Compares the conformance reports of two or more hosts - and refuses to, when
// they were not built against the same openDAQ.
//
//   node conformance/compare-host-conformance-reports.mjs a.json b.json [c.json ...]
//
// THE REFUSAL IS THE POINT. A difference between two hosts is only worth
// reporting as a difference between the HOSTS. If one host loaded a different
// openDAQ than another, or a different one from the manifest the repository is
// pinned to, then any behavioural difference the comparison finds might be a
// version difference wearing a host's name: a property that exists in one SDK
// build and not the other, an error mapped differently, a descriptor field
// added between commits. Reporting that as "host A does X, host B does not"
// would be a lie of omission. So the comparison stops, names every commit it
// saw and where each came from, and produces no table at all.
//
// A host that loaded NO openDAQ - hosts/mock-ts reports sdk.version "none ..."
// and sdk.commit "none" - is not one of those disagreements. It is REPORTED
// ALONGSIDE: its column is printed and marked (no SDK), and it is left out of
// the "capabilities declared differently" and "wire methods behaving
// differently" counts, so it can never be silently compared as if it shared the
// build. The rule is decide-whether-hosts-share-the-manifest-opendaq-build.mjs,
// the same one the cross-host report generator uses; there is one copy of it.
//
// Exit codes: 0 compared and the hosts agree, 1 compared and they differ,
// 3 refused to compare, 2 could not run.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOST_SDK_PROVENANCE,
  decideWhetherTheseHostsMayBeComparedAsEquals,
} from "./decide-whether-hosts-share-the-manifest-opendaq-build.mjs";

const conformanceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(conformanceDirectory, "..");

function parseArguments(argv) {
  const options = { reportPaths: [], manifestPath: resolve(repositoryRoot, "manifest.json") };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--manifest") {
      if (i + 1 >= argv.length) throw new Error("--manifest needs a value");
      options.manifestPath = resolve(process.cwd(), argv[++i]);
    } else if (argument === "--help" || argument === "-h") return null;
    else if (argument.startsWith("--")) throw new Error(`unknown argument: ${argument}`);
    else options.reportPaths.push(resolve(process.cwd(), argument));
  }
  if (options.reportPaths.length < 2) {
    throw new Error(`comparing needs at least two reports; ${options.reportPaths.length} were given`);
  }
  return options;
}

function compareHostConformanceReports() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (failure) {
    console.error(`quackoscope conformance comparison: ${failure.message}`);
    return 2;
  }
  if (options === null) {
    console.log("compare-host-conformance-reports.mjs <report-a.json> <report-b.json> [more.json ...] [--manifest <path>]");
    return 0;
  }

  const reports = [];
  for (const reportPath of options.reportPaths) {
    try {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      reports.push({ reportPath, report });
    } catch (failure) {
      console.error(`quackoscope conformance comparison: could not read the report at ${reportPath}: ${failure.message}`);
      return 2;
    }
  }

  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(options.manifestPath, "utf8"));
  } catch (failure) {
    console.error(`quackoscope conformance comparison: could not read ${options.manifestPath}: ${failure.message}`);
    return 2;
  }

  console.log(`comparing ${reports.length} host conformance reports`);
  console.log(`  manifest ${options.manifestPath}`);
  console.log(`    sdk_version ${manifest.sdk_version}`);
  console.log(`    commit      ${manifest.commit}`);
  console.log("  reports, with the sdk each host reported in its OWN handshake:");
  for (const { reportPath, report } of reports) {
    console.log(`    ${report.implementation?.name ?? "(no implementation.name)"}  ${report.target_url}`);
    console.log(`      report        ${reportPath}`);
    console.log(`      sdk.version   ${report.host_reported_sdk?.version ?? "(absent)"}`);
    console.log(`      sdk.commit    ${report.host_reported_sdk?.commit ?? "(absent)"}`);
  }

  // --- the refusal ----------------------------------------------------------
  const labelFor = ({ reportPath, report }) => `${report.implementation?.name ?? reportPath} at ${report.target_url}`;
  const decision = decideWhetherTheseHostsMayBeComparedAsEquals({
    hosts: reports.map((entry) => ({ label: labelFor(entry), sdk: entry.report.host_reported_sdk ?? null })),
    manifestCommit: manifest.commit,
    manifestSdkVersion: manifest.sdk_version,
    manifestPath: options.manifestPath,
  });
  for (const entry of reports) {
    entry.sdkProvenance = decision.provenanceByLabel.get(labelFor(entry));
    entry.isReportedAlongsideRatherThanComparedAsEqual =
      entry.sdkProvenance?.provenance === HOST_SDK_PROVENANCE.loadsNoOpenDaqAtAll;
  }

  if (decision.refuse) {
    console.log("\n=== REFUSED TO COMPARE =======================================================");
    console.log("These hosts were not all running the same openDAQ, so a behavioural difference");
    console.log("between them cannot be attributed to the hosts. The comparison is not produced.");
    console.log("");
    for (const disagreement of decision.disagreements) console.log(`  - ${disagreement}`);
    console.log("");
    console.log(`  manifest commit  ${manifest.commit}  (${manifest.sdk_version})`);
    console.log(`  commits reported ${[...decision.commitsSeen.keys()].join(", ") || "(none)"}`);
    if (decision.reportedAlongside.length > 0) {
      console.log(
        `  reported alongside, and NOT the reason for this refusal: ${decision.reportedAlongside.map((alongside) => `${alongside.label} (sdk.version "${alongside.sdkVersion}", sdk.commit "${alongside.sdkCommit}")`).join(", ")}`,
      );
    }
    console.log("");
    console.log("Rebuild the disagreeing host against the manifest's openDAQ and re-run its");
    console.log("sweep, then compare again. exit 3");
    return 3;
  }

  console.log(`\ngate verdict: ${decision.verdict}`);
  console.log(
    `  compared as equals  ${decision.comparedAsEquals.map((host) => host.label).join(", ") || "(none)"}${decision.comparedAsEquals.length ? `, all on sdk.commit ${manifest.commit}, the manifest's` : ""}`,
  );
  console.log(
    `  reported alongside  ${decision.reportedAlongside.map((alongside) => `${alongside.label} (sdk.version "${alongside.sdkVersion}", sdk.commit "${alongside.sdkCommit}")`).join(", ") || "(none)"}`,
  );
  if (decision.reportedAlongside.length > 0) {
    console.log(
      "  a column marked (no SDK) below is printed in full and counted in neither difference tally: it loaded no",
    );
    console.log("  openDAQ, so its cells are not evidence about one. The comparison may proceed.");
  }

  // --- the comparison -------------------------------------------------------
  const baseline = reports[0].report.baseline_capabilities;
  const baselineDisagreement = reports.find(
    ({ report }) => JSON.stringify(report.baseline_capabilities) !== JSON.stringify(baseline),
  );
  if (baselineDisagreement) {
    console.log("\n=== REFUSED TO COMPARE =======================================================");
    console.log("The reports were produced against different contract baselines, so their");
    console.log("capability columns do not line up:");
    for (const { reportPath, report } of reports) {
      console.log(`  ${reportPath}: [${report.baseline_capabilities.join(", ")}] from ${report.contract_path}`);
    }
    console.log("exit 3");
    return 3;
  }

  const comparedAsEquals = reports.filter((entry) => !entry.isReportedAlongsideRatherThanComparedAsEqual);
  const names = reports.map(
    (entry) => `${entry.report.implementation?.name ?? entry.report.target_url}${entry.isReportedAlongsideRatherThanComparedAsEqual ? " (no SDK)" : ""}`,
  );
  const columnWidth = Math.max(22, ...names.map((name) => name.length + 2));

  console.log("\n=== capability declared in the handshake =====================================");
  console.log(`${"capability".padEnd(22)}${names.map((name) => name.padEnd(columnWidth)).join("")}`);
  const capabilityDifferences = [];
  for (const capability of baseline) {
    const declaredBy = ({ report }) => (report.declared_capabilities.includes(capability) ? "declared" : "gap");
    const cells = reports.map(declaredBy);
    if (new Set(comparedAsEquals.map(declaredBy)).size > 1) capabilityDifferences.push(capability);
    console.log(`${capability.padEnd(22)}${cells.map((cell) => cell.padEnd(columnWidth)).join("")}`);
  }

  console.log("\n=== verdict tallies =========================================================");
  const verdictNames = [...new Set(reports.flatMap(({ report }) => Object.keys(report.tallies)))].sort();
  console.log(`${"verdict".padEnd(34)}${names.map((name) => name.padEnd(columnWidth)).join("")}`);
  for (const verdict of verdictNames) {
    console.log(`${verdict.padEnd(34)}${reports.map(({ report }) => String(report.tallies[verdict] ?? 0).padEnd(columnWidth)).join("")}`);
  }

  console.log("\n=== how much of the contract each run actually drove =========================");
  for (const { report } of reports) {
    const coverage = report.operation_coverage ?? null;
    const name = report.implementation?.name ?? report.target_url;
    if (coverage === null) {
      console.log(`${String(name).padEnd(34)}operation coverage not reported: that run predates the coverage guard`);
      continue;
    }
    console.log(
      `${String(name).padEnd(34)}${coverage.driven.length} of ${coverage.operations_in_the_contract} operations driven` +
        `${coverage.never_driven.length === 0 ? "" : `; NEVER DRIVEN: ${coverage.never_driven.join(", ")} - a hole in conformance/sweeps, not a fault of this host`}`,
    );
  }

  console.log("\n=== per wire method, across hosts ===========================================");
  // Only the contract's own operation table is tabulated. The sweep also sends a
  // method name that is deliberately not in the contract, and that row belongs
  // in the per-host report, not in a cross-host operation table.
  const wireMethods = [...new Set(reports.flatMap(({ report }) => report.contract_operations ?? []))];
  const methodDifferences = [];
  console.log(`${"wire method".padEnd(30)}${names.map((name) => name.padEnd(columnWidth)).join("")}`);
  for (const wireMethod of wireMethods) {
    const strongestVerdictFor = ({ report }) => {
      const entries = report.entries.filter((entry) => entry.wire_method === wireMethod);
      if (entries.some((entry) => entry.verdict === "capability_claimed_and_broken" || entry.verdict === "wire_protocol_broken")) return "BROKE";
      if (entries.some((entry) => entry.verdict === "gap_declared_but_served")) return "gap, served";
      if (entries.some((entry) => entry.verdict === "gap_declared_and_consistent")) return "gap (a)";
      if (entries.some((entry) => entry.verdict === "held")) return "served";
      if (entries.some((entry) => entry.verdict === "not_provokable_by_a_wire_client")) return "not provokable";
      // A row with no entry at all has two very different causes: the host was
      // asked and said nothing, or the suite never asked. The coverage figure
      // the run wrote into its own report separates them, and a bare "-" here
      // for the second is how six operations sat unasked behind a clean table.
      if ((report.operation_coverage?.never_driven ?? []).includes(wireMethod)) return "SUITE NEVER ASKED";
      if (entries.length === 0) return "-";
      return "served";
    };
    const cells = reports.map(strongestVerdictFor);
    if (new Set(comparedAsEquals.map(strongestVerdictFor)).size > 1) {
      methodDifferences.push(
        `${wireMethod}: ${comparedAsEquals.map((entry) => `${entry.report.implementation?.name ?? entry.report.target_url}=${strongestVerdictFor(entry)}`).join(", ")}`,
      );
    }
    console.log(`${wireMethod.padEnd(30)}${cells.map((cell) => cell.padEnd(columnWidth)).join("")}`);
  }

  console.log("\n=== summary =================================================================");
  console.log(
    `hosts compared as equals: ${comparedAsEquals.map((entry) => entry.report.implementation?.name ?? entry.report.target_url).join(", ") || "(none)"}`,
  );
  if (decision.reportedAlongside.length > 0) {
    console.log(
      `hosts reported alongside: ${decision.reportedAlongside.map((alongside) => alongside.label).join(", ")} - printed above, counted in neither tally below`,
    );
  }
  console.log(`capabilities declared differently across the hosts compared as equals: ${capabilityDifferences.length}${capabilityDifferences.length ? ` (${capabilityDifferences.join(", ")})` : ""}`);
  console.log(`wire methods behaving differently across the hosts compared as equals: ${methodDifferences.length}`);
  for (const difference of methodDifferences) console.log(`  ${difference}`);
  const anyFailures = reports.filter(({ report }) => report.failure_count > 0);
  console.log(`hosts with failures: ${anyFailures.length ? anyFailures.map(({ report }) => `${report.implementation?.name} (${report.failure_count})`).join(", ") : "none"}`);

  const different = capabilityDifferences.length > 0 || methodDifferences.length > 0 || anyFailures.length > 0;
  const alongsideCaveat =
    decision.reportedAlongside.length === 0
      ? ""
      : ` (the ${decision.reportedAlongside.length} column(s) marked (no SDK) fed neither tally, so nothing counted here rests on a host that loaded no openDAQ)`;
  console.log(
    `\n${different ? `the hosts differ; every difference above is a host difference, not a version difference${alongsideCaveat}` : `${decision.reportedAlongside.length === 0 ? "the hosts" : "the hosts compared as equals"} agree on every capability and every wire method${alongsideCaveat}`}. exit ${different ? 1 : 0}`,
  );
  return different ? 1 : 0;
}

process.exit(compareHostConformanceReports());
