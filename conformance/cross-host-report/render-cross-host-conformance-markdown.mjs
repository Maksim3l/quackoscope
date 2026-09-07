// Renders the cross-host comparison as markdown.
//
// This file writes NO cell content of its own. Every value in every table comes
// from one of exactly three places, and each table says which:
//
//   the host's own handshake        capability sets, gap reasons and kinds,
//                                   implementation name and version, sdk
//                                   version and commit, limits
//   a conformance ledger entry      failure classes, per-wire-method behaviour
//   a wrong-input answer            the error-code fidelity matrix
//
// The prose in this file is the scaffolding - column headings, legends, the
// citation of which contract clause a row is judged against. There is no
// hand-maintained compatibility knowledge anywhere in it: the capability rows
// come from contract.yaml's own baseline, the wire method rows from
// contract.yaml's own operations table, and the fidelity rows from the case
// list the interrogation module sent.
//
// REPORTED ALONGSIDE. A host that declared no openDAQ at all arrives here with
// isReportedAlongsideRatherThanComparedAsEqual === true, decided by
// ../decide-whether-hosts-share-the-manifest-opendaq-build.mjs from that host's
// own handshake. Such a host keeps every column and every cell it earned, its
// column heading and its cells carry the marker `(no SDK)`, and it is counted in
// no agreement column in any section - the same treatment, and the same legend
// idiom, this document already gives a cell excluded from agreement for being a
// declared gap or for coming from a session that holds no device.

const VERDICT_CLASSES = [
  ["held", "pass", "asserted and true"],
  ["gap_declared_and_consistent", "class (a) declared gap - PASS", "the host did not claim the capability, and it did refuse the operation"],
  ["capability_claimed_and_broken", "class (b) claimed and failed - FAILURE", "the host listed the capability in its handshake and then broke the operation"],
  ["handshake_nonconformant", "FAILURE", "the handshake does not match the contract, so its capability list cannot classify anything"],
  ["wire_protocol_broken", "FAILURE", "a rule binding every host regardless of what it claims"],
  ["gap_declared_but_served", "warning", "the host called the capability a gap and served it anyway: under-claimed, not a broken promise"],
  [
    "suite_coverage_incomplete",
    "FAILURE, and the only one that is not about the host",
    "an operation of contract.yaml this run put on no socket and wrote no assertion about; the host is not being judged on it at all, conformance/ is",
  ],
  ["not_provokable_by_a_wire_client", "not a verdict", "no well-formed request can force this out of a healthy host"],
  ["unconstrained_by_the_contract", "not a verdict", "the contract constrains the shape but never the occurrence"],
];

function escapeTableCell(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function renderTable(headerCells, rows) {
  const header = `| ${headerCells.map(escapeTableCell).join(" | ")} |`;
  const rule = `| ${headerCells.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`);
  return [header, rule, ...body].join("\n");
}

function codeSpan(text) {
  return `\`${String(text).replace(/`/g, "'")}\``;
}

/**
 * @param {object} input
 * @param {string} input.commandLine            the exact command that produced this
 * @param {object} input.contract               the parsed contract.yaml view
 * @param {string} input.contractPath
 * @param {object} input.manifest               manifest.json, verbatim
 * @param {string} input.manifestPath
 * @param {Array}  input.hosts                  one record per host that was asked for
 * @param {object} input.sdkCommitGate          the result of the sdk.commit gate
 * @param {Date}   input.startedAt
 * @param {Date}   input.finishedAt
 */
export function renderCrossHostConformanceMarkdown(input) {
  const { commandLine, contract, contractPath, manifest, manifestPath, hosts, sdkCommitGate, startedAt, finishedAt } = input;
  const ran = hosts.filter((host) => host.conformanceReport !== null);
  const lines = [];
  const push = (...text) => lines.push(...text);

  // One marker, used in every table, for a host that loads no openDAQ: it keeps
  // its column and its cells, and it is in no agreement column anywhere.
  const NO_SDK_MARKER = "(no SDK)";
  const isReportedAlongside = (host) => host.isReportedAlongsideRatherThanComparedAsEqual === true;
  const hostsReportedAlongside = hosts.filter(isReportedAlongside);
  const columnNames = hosts.map((host) => (isReportedAlongside(host) ? `${host.hostKey} ${NO_SDK_MARKER}` : host.hostKey));
  const hostLabel = (host) => `\`${host.hostKey}\`${isReportedAlongside(host) ? ` ${NO_SDK_MARKER}` : ""}`;
  const comparableHosts = hosts.filter((host) => !isReportedAlongside(host));
  const cellFor = (host, valueWhenItRan) => (host.conformanceReport === null ? "unavailable" : valueWhenItRan(host));
  const alongsideCaveatForATable = (whatTheAgreementColumnMeans) =>
    hostsReportedAlongside.length === 0
      ? ""
      : `${hostsReportedAlongside.map((host) => `\`${host.hostKey}\``).join(", ")} ${hostsReportedAlongside.length === 1 ? "loads" : "load"} no openDAQ, so ${hostsReportedAlongside.length === 1 ? "its column is" : "their columns are"} marked ${codeSpan(NO_SDK_MARKER)} and left out of the agreement column: ${whatTheAgreementColumnMeans} See §2.1.`;

  // ---------------------------------------------------------------- heading
  push(
    `# Quackoscope cross-host conformance report`,
    "",
    `Generated by \`${commandLine}\` on ${startedAt.toISOString()}, finished ${finishedAt.toISOString()} (${Math.round((finishedAt - startedAt) / 1000)} s).`,
    "",
    `Every cell below was produced by a host that this run started and stopped. Nothing in this document is hand-maintained: each cell comes from a handshake message, a conformance ledger entry, or the answer a host gave to a request this run sent it. Section 8 says which, per table.`,
    "",
    `- contract: \`${contractPath}\` - ${contract.contractName} protocol_version ${contract.protocolVersion}; ${contract.capabilityBaselineIds.length} baseline capabilities, ${contract.operations.length} operations, closed error set of ${contract.errorCodes.length} codes: ${contract.errorCodes.map(codeSpan).join(", ")}`,
    `- manifest: \`${manifestPath}\` - sdk_version \`${manifest.sdk_version}\`, commit \`${manifest.commit}\`, module_path \`${manifest.module_path}\``,
    `- hosts asked for: ${hosts.map((host) => `\`${host.hostKey}\``).join(", ")} (${ran.length} produced a report, ${hosts.length - ran.length} did not)`,
    ...(hostsReportedAlongside.length > 0
      ? [
          `- reported alongside, not compared as equals: ${hostsReportedAlongside.map((host) => `\`${host.hostKey}\``).join(", ")} - ${hostsReportedAlongside.length === 1 ? "it loads" : "they load"} no openDAQ at all, so every cell of ${hostsReportedAlongside.length === 1 ? "that column carries" : "those columns carry"} the marker ${codeSpan(NO_SDK_MARKER)} and appears in no agreement column. §2.1 says what that means, in words.`,
        ]
      : []),
    "",
  );

  // ------------------------------------------------- 1. hosts in this report
  push(
    `## 1. Which hosts are in this report, and which are not`,
    "",
    `A host that could not be started keeps its column. Its cells read \`unavailable\` everywhere below, and the reason is here rather than being dropped from the document.`,
    "",
    renderTable(
      ["host", "started as", "port", "handshake", "conformance sweep", "wrong-input interrogation", "why not"],
      hosts.map((host) => [
        hostLabel(host),
        `\`${host.commandLine}\``,
        String(host.port),
        host.handshakeVerbatim ? `arrived, ${host.handshakeVerbatim.length} bytes` : "never arrived",
        host.conformanceReport
          ? `${host.conformanceReport.entries.length} assertions, exit ${host.suiteExitCode}`
          : "not run",
        host.interrogation ? `${host.interrogation.answers.length} wrong inputs sent` : "not run",
        host.unavailableBecause ?? "",
      ]),
    ),
    "",
  );

  // -------------------------------------------------------- 2. the sdk key
  push(
    `## 2. The key: sdk.commit`,
    "",
    `This report compares hosts. A behavioural difference between two hosts is only attributable to the hosts if both loaded the same openDAQ; otherwise the difference may be a version difference wearing a host's name. So the run gates on \`sdk.commit\` **before any conformance sweep is started**, and produces no comparison at all if two hosts that loaded an openDAQ disagree with each other, or if one of them disagrees with the manifest.`,
    "",
    renderTable(
      ["host", "implementation.name (display only)", "implementation.version", "sdk.version", "sdk.commit", "is the manifest's commit"],
      hosts.map((host) => {
        if (!host.handshake) return [hostLabel(host), "unavailable", "unavailable", "unavailable", "unavailable", "unavailable"];
        return [
          hostLabel(host),
          `\`${host.handshake.implementation?.name ?? "(absent)"}\``,
          host.handshake.implementation?.version ?? "(absent)",
          host.handshake.sdk?.version ?? "(absent)",
          `\`${host.handshake.sdk?.commit ?? "(absent)"}\``,
          isReportedAlongside(host)
            ? `no - it loads no openDAQ at all, so it is **reported alongside** (§2.1) rather than compared as an equal, and it is not a disagreement`
            : host.handshake.sdk?.commit === manifest.commit
              ? "yes"
              : `NO - the manifest says ${manifest.commit}`,
        ];
      }),
    ),
    "",
    `Gate result: **${sdkCommitGate.verdict}**. ${sdkCommitGate.explanation}`,
    "",
    hostsReportedAlongside.length === 0
      ? `Every table from here on is keyed to sdk.commit \`${sdkCommitGate.agreedCommit ?? "(no agreed commit)"}\`. A cell means "this host, on this commit".`
      : `Every comparison from here on is keyed to sdk.commit \`${sdkCommitGate.agreedCommit ?? "(no host loaded an openDAQ, so there is no agreed commit)"}\`. A cell in a column compared as an equal means "this host, on this commit"; a cell in a ${codeSpan(NO_SDK_MARKER)} column means "this host, on no openDAQ at all".`,
    "",
  );

  // ---------------------------------------------- 2.1 reported alongside
  push(`### 2.1 Reported alongside: a host that loads no openDAQ at all`, "");
  if (hostsReportedAlongside.length === 0) {
    push(
      `Every host in this run loaded an openDAQ build and reported the manifest's commit, so nothing here is reported alongside; every column below is a column compared as an equal.`,
      "",
    );
  } else {
    push(
      sdkCommitGate.whatReportedAlongsideMeans ??
        "**Reported alongside** means the host keeps its column and every cell it produced, marked `(no SDK)`, and is counted in no agreement column.",
      "",
      renderTable(
        ["host", "sdk.version, verbatim from its handshake", "sdk.commit, verbatim", "how the gate classified it"],
        (sdkCommitGate.reportedAlongside ?? []).map((alongside) => [
          `\`${alongside.hostKey}\` ${NO_SDK_MARKER}`,
          `\`${alongside.sdkVersion}\``,
          `\`${alongside.sdkCommit}\``,
          alongside.inWords,
        ]),
      ),
      "",
      `A host qualifies for this only by saying so in **both** halves of its handshake's \`sdk\` record: \`sdk.commit\` exactly \`none\`, and an \`sdk.version\` that begins with the word \`none\`. A host that reports \`sdk.commit\` \`none\` while naming a real \`sdk.version\` is an SDK-loading host withholding its commit, and the run refuses on it like any other disagreement. Nothing reads \`implementation.name\` to decide this.`,
      "",
    );
  }

  // ------------------------------------------------------ 3. capability sets
  const capabilityRows = contract.capabilityBaselineIds.map((capability) => {
    const declaredBy = (host) => (host.conformanceReport.declared_capabilities.includes(capability) ? "declared" : "gap");
    const cells = hosts.map((host) => cellFor(host, declaredBy));
    // Only hosts compared as equals are in the agreement column: a capability a
    // no-SDK host declares is a promise about its synthetic device, not about
    // this openDAQ build, so it can neither corroborate nor contradict.
    const answered = comparableHosts.filter((host) => host.conformanceReport !== null).map(declaredBy);
    // "every host" is only honest when every host in the table is in the
    // agreement column; with a column left out of it, the count is named.
    const everyHostIsCompared = hostsReportedAlongside.length === 0;
    const agreement =
      answered.length < 2
        ? `not comparable (${answered.length} host${answered.length === 1 ? "" : "s"} compared as equals)`
        : new Set(answered).size === 1
          ? answered[0] === "declared"
            ? everyHostIsCompared
              ? "every host declares it"
              : `all ${answered.length} compared as equals declare it`
            : everyHostIsCompared
              ? "every host calls it a gap"
              : `all ${answered.length} compared as equals call it a gap`
          : "**DIFFERS**";
    return [codeSpan(capability), ...cells, agreement];
  });
  const capabilitiesThatDiffer = contract.capabilityBaselineIds.filter((capability, index) => capabilityRows[index].at(-1) === "**DIFFERS**");
  push(
    `## 3. Capability sets, side by side`,
    "",
    `Rows are the ${contract.capabilityBaselineIds.length} baseline capability ids in \`${contractPath}\`. Cells come from each host's own handshake \`capabilities\` array; \`gap\` means the id is absent from it.`,
    ...(hostsReportedAlongside.length > 0
      ? ["", alongsideCaveatForATable("what a host with no openDAQ declares is a promise about its own synthetic device, not about this openDAQ build, so it can neither corroborate nor contradict the hosts that loaded one.")]
      : []),
    "",
    renderTable(["capability", ...columnNames, "agreement"], capabilityRows),
    "",
    `${capabilitiesThatDiffer.length} of ${contract.capabilityBaselineIds.length} capabilities are declared differently across the ${hostsReportedAlongside.length === 0 ? "hosts that ran" : `${comparableHosts.filter((host) => host.conformanceReport !== null).length} host(s) compared as equals`}${capabilitiesThatDiffer.length ? `: ${capabilitiesThatDiffer.map(codeSpan).join(", ")}` : ""}.`,
    "",
  );

  // -------------------------------------------------- 4. gap reasons + kinds
  const gapRows = [];
  for (const host of hosts) {
    const gaps = Array.isArray(host.handshake?.gaps) ? host.handshake.gaps : [];
    for (const gap of gaps) {
      const kindIsContractual = contract.gapKinds.includes(gap.kind);
      gapRows.push([
        hostLabel(host),
        codeSpan(gap.capability),
        kindIsContractual ? codeSpan(gap.kind) : `${codeSpan(gap.kind)} - **not one of ${contract.gapKinds.map(codeSpan).join(", ")}**`,
        gap.reason ?? "(the host declared no reason)",
      ]);
    }
  }
  gapRows.sort((left, right) => (left[1] + left[0]).localeCompare(right[1] + right[0]));
  push(
    `## 4. Gap reasons, with their kinds`,
    "",
    `A gap is a baseline capability the host does not claim. \`contract.yaml gap_generation.kinds\` fixes the vocabulary at ${contract.gapKinds.map(codeSpan).join(" and ")}: ${codeSpan("binding")} means the language binding cannot reach the SDK call, ${codeSpan("host")} means the host has not implemented it. The reason text is the host's own, verbatim from its handshake.`,
    "",
    gapRows.length === 0
      ? "No host that ran declared a single gap."
      : renderTable(["host", "capability", "kind", "reason, as the host worded it"], gapRows),
    "",
  );
  const gapKindTally = new Map();
  for (const row of gapRows) {
    const kind = row[2].replace(/`/g, "").split(" ")[0];
    gapKindTally.set(kind, (gapKindTally.get(kind) ?? 0) + 1);
  }
  push(
    `${gapRows.length} gap(s) declared across ${hosts.filter((host) => Array.isArray(host.handshake?.gaps) && host.handshake.gaps.length > 0).length} host(s); by kind: ${[...gapKindTally.entries()].map(([kind, count]) => `${codeSpan(kind)} ${count}`).join(", ") || "(none)"}.`,
    "",
  );

  // ----------------------------------------------------- 5. failure classes
  const verdictRows = VERDICT_CLASSES.map(([verdict, className, meaning]) => [
    codeSpan(verdict),
    className,
    ...hosts.map((host) => cellFor(host, () => String(host.conformanceReport.tallies[verdict] ?? 0))),
    meaning,
  ]);
  push(
    `## 5. Failure classes`,
    "",
    `The two classes the harness exists to keep apart. **Class (a)** is a host that declared a capability a gap and then refused the operation: it told the truth, and it passes. **Class (b)** is a host that listed the capability in its handshake and then broke the operation: it advertised something it does not do, and it fails. Collapsing them would let "declares everything as a gap" look like a failure and "claims everything, does nothing" look like a gap.`,
    ...(hostsReportedAlongside.length > 0
      ? [
          "",
          `This section has no agreement column and needs none, so a ${codeSpan(NO_SDK_MARKER)} column is judged here on exactly the same terms as every other. Class (a) and class (b) are a **self**-consistency verdict - what this host promised in its own handshake against what this host then did - and that question is as answerable for a host with no openDAQ as for one with. Only cross-host agreement is withheld from it, and there is none to withhold here.`,
        ]
      : []),
    "",
    renderTable(["verdict", "class", ...columnNames, "meaning"], verdictRows),
    "",
    renderTable(
      ["host", "class (a) declared gap, consistent", "class (b) claimed and failed", "other failures", "warnings", "assertions recorded", "suite exit"],
      hosts.map((host) => {
        if (!host.conformanceReport) return [hostLabel(host), "unavailable", "unavailable", "unavailable", "unavailable", "unavailable", "unavailable"];
        const tallies = host.conformanceReport.tallies;
        const otherFailures =
          (tallies.handshake_nonconformant ?? 0) + (tallies.wire_protocol_broken ?? 0) + (tallies.suite_coverage_incomplete ?? 0);
        return [
          hostLabel(host),
          String(tallies.gap_declared_and_consistent ?? 0),
          String(tallies.capability_claimed_and_broken ?? 0),
          String(otherFailures),
          String(host.conformanceReport.warning_count),
          String(host.conformanceReport.entries.length),
          String(host.suiteExitCode),
        ];
      }),
    ),
    "",
  );

  const hostsWithClassBFailures = ran.filter((host) =>
    host.conformanceReport.entries.some((entry) => entry.verdict === "capability_claimed_and_broken"),
  );
  push(`### 5.1 Every class (b) failure, in full`, "");
  if (hostsWithClassBFailures.length === 0) {
    push(`No host that ran claimed a capability and then broke it.`, "");
  } else {
    for (const host of hostsWithClassBFailures) {
      const failures = host.conformanceReport.entries.filter((entry) => entry.verdict === "capability_claimed_and_broken");
      push(`**${hostLabel(host)}** - ${failures.length} class (b) failure(s):`, "");
      for (const [index, entry] of failures.entries()) {
        push(
          `${index + 1}. ${entry.title}`,
          `   - capability claimed in the handshake: ${codeSpan(entry.capability)}${entry.wire_method ? `, wire method ${codeSpan(entry.wire_method)}` : ""}`,
          `   - contract: ${entry.contract_citation}`,
          `   - expected: ${entry.expected}`,
          `   - actual: ${entry.actual}`,
        );
      }
      push("");
    }
  }

  const hostsWithWarnings = ran.filter((host) => host.conformanceReport.warning_count > 0);
  push(`### 5.2 Under-claims: a capability called a gap and then served anyway`, "");
  if (hostsWithWarnings.length === 0) {
    push(`No host served an operation whose capability it had declared a gap.`, "");
  } else {
    for (const host of hostsWithWarnings) {
      const warnings = host.conformanceReport.entries.filter((entry) => entry.verdict === "gap_declared_but_served");
      for (const entry of warnings) {
        push(`- ${hostLabel(host)}: ${entry.title} - ${entry.actual}`);
      }
    }
    push("", `These are warnings, not failures: a host that does more than it promised has not broken a promise.`, "");
  }

  // --------------------------------- 5.3 whether the suite drove the contract
  // Every table in this document is drawn from ledger entries, and a ledger has
  // no entry for a row nobody asked. Until this section existed, an operation
  // conformance/sweeps never drove showed up in section 7 as "no assertion" -
  // indistinguishable, at a glance, from a host that answered nothing - and in
  // sections 3 and 6 as simple absence. Six of the contract's nineteen rows sat
  // like that. The count below comes from the request counter inside
  // WireSession, so it says what actually went on the socket.
  const coverageOf = (host) => host.conformanceReport?.operation_coverage ?? null;
  const hostsWithACoverageHole = ran.filter((host) => (coverageOf(host)?.never_driven ?? []).length > 0);
  const hostsWithNoCoverageFigure = ran.filter((host) => coverageOf(host) === null);
  push(
    `### 5.3 Did this run actually drive every operation in the contract?`,
    "",
    `Every other table here is built out of ledger entries, and a ledger records nothing about a row nobody asked. So a suite that skips an operation does not produce a gap or a failure anywhere - it produces silence, and silence reads as "fine". This row is the guard against that, and it is a **failure of the suite**, never of the host: \`conformance/sweeps/require-every-contract-operation-to-be-driven.mjs\` counts the requests each session actually sent, and requires that every one of the ${contract.operations.length} operations in \`${contractPath}\` was both sent and judged.`,
    "",
    renderTable(
      ["host", `operations driven of ${contract.operations.length}`, "requests sent, all wire methods", "never driven"],
      hosts.map((host) => {
        const coverage = coverageOf(host);
        if (!host.conformanceReport) return [hostLabel(host), "unavailable", "unavailable", "unavailable"];
        if (coverage === null) {
          return [hostLabel(host), "not reported", "not reported", "this host's report predates the coverage guard"];
        }
        const requestsSent = coverage.per_operation.reduce((total, row) => total + row.requests_sent, 0);
        return [
          hostLabel(host),
          `${coverage.driven.length}`,
          String(requestsSent),
          coverage.never_driven.length === 0 ? "none" : `**${coverage.never_driven.map(codeSpan).join(", ")}**`,
        ];
      }),
    ),
    "",
    hostsWithACoverageHole.length === 0 && hostsWithNoCoverageFigure.length === 0
      ? `Every host that ran was asked all ${contract.operations.length} operations. No cell anywhere in this document stands for a row that was never driven.`
      : `${[...hostsWithACoverageHole, ...hostsWithNoCoverageFigure].map((host) => hostLabel(host)).join(", ")}: this document's capability and error-code tables are drawn from a sweep that did not reach every row of the contract, and the cells for the rows it missed mean "not asked", not "not served".`,
    "",
  );

  // ------------------------------------------- 6. error-code fidelity matrix
  push(
    `## 6. Error-code fidelity: the same wrong input, on every host`,
    "",
    `This is the table that a capability matrix cannot give you. Every host below is conformant or not on its own terms${hostsReportedAlongside.length > 0 ? `, and every host below **except** ${hostsReportedAlongside.map((host) => `\`${host.hostKey}\``).join(", ")} loaded the same openDAQ commit` : ", and every host below loaded the same openDAQ commit"}. The question here is narrower and sharper: **sent the identical bytes, which error code does each one choose?** That is where bindings diverge, because the contract fixes a closed set of ${contract.errorCodes.length} codes and a per-operation subset, but almost never says which member of the subset a given wrong input must produce.`,
    "",
    `Legend: a bare code is the code the host refused with, and it is in that operation's declared subset. ${codeSpan("code (gap)")} is a refusal of an operation whose capability the host declared a gap and which it did not serve in this session - that is class (a), the host saying it does not do this at all, and it is excluded from the agreement column so a declared gap is never read as a divergence. ${codeSpan("code (gap, served anyway)")} is a host that declared the capability a gap and then served that very method here: it did make an error-code choice, so it stays in the comparison. ${codeSpan("code (no device)")} is an answer given by a session that holds no device, which is a different input state from the other hosts however identical the params were, so it is excluded too. ${hostsReportedAlongside.length === 0 ? "" : `${codeSpan(`code ${NO_SDK_MARKER}`)} is an answer from a host that loaded no openDAQ: it is printed in full, and excluded from the agreement column for the same reason as the other two markers - **this table asks which code an openDAQ binding chooses, and a host with no binding is not evidence about one**. Its choice comes out of that host's own hand-written error table, so agreeing with it is not corroboration and differing from it is not a binding divergence. `}${codeSpan("code +")} means the code is in the contract's closed set but **not** in the subset \`contract.yaml operations[...].errors\` declares for that operation. ${codeSpan("code !!")} means the code is outside the closed set entirely. ${codeSpan("ACCEPTED")} means the host answered a wrong input with a result instead of refusing.`,
    "",
    ...(hostsReportedAlongside.length > 0
      ? [
          `The ${codeSpan(NO_SDK_MARKER)} cells are still worth reading, and that is why they are kept in the table rather than dropped or given a section of their own: ${hostsReportedAlongside.map((host) => `\`${host.hostKey}\``).join(", ")} ${hostsReportedAlongside.length === 1 ? "is" : "are"} the schema-complete reference target the suite is written against, so ${hostsReportedAlongside.length === 1 ? "its" : "their"} answer shows what the contract alone, with no SDK to translate, makes of the same wrong input. What it never does is settle a row: §6.1 and §6.2 below are computed without it.`,
          "",
        ]
      : []),
    `Whether a device is connected is itself part of the input, so \`connect_device\` was attempted on every host before the second group of cases - including on hosts that declared \`device.connect\` a gap, since a host can serve an operation it under-claimed. This is the session each host was in:`,
    "",
    renderTable(
      ["host", "connection string it was sent", "device node the session holds for the cases below"],
      hosts.map((host) => {
        if (!host.interrogation) return [hostLabel(host), "unavailable", "unavailable"];
        const discovered = host.interrogation.discovered;
        return [
          hostLabel(host),
          `\`${discovered.connectionStringUsedToConnect}\``,
          discovered.connectedDeviceNodeId
            ? `\`${discovered.connectedDeviceNodeId}\``
            : "none - it connected no device, so its later answers are marked (no device) and left out of the agreement column",
        ];
      }),
    ),
    "",
  );

  const identicalCaseIds = [];
  for (const host of ran) {
    for (const answer of host.interrogation?.answers ?? []) {
      if (answer.paramsAreIdenticalAcrossHosts && !identicalCaseIds.includes(answer.caseId)) identicalCaseIds.push(answer.caseId);
    }
  }

  // A case asked of a session holding no device was asked in a different state
  // from the same case asked of a session holding one, so its answer is not
  // comparable with theirs however identical the params were.
  const sessionStateDiffers = (answer) =>
    answer.phase === "after_this_session_connected_a_device" && answer.sessionHadADeviceConnected === false;

  // An answer from a host that loaded no openDAQ is an error-code choice made
  // with no binding behind it, so it is marked and excluded from agreement for
  // the same reason `(gap)` and `(no device)` are.
  const answerIsNotEvidenceAboutABinding = (host, answer) => answer && isReportedAlongside(host);

  const renderFidelityCell = (host, answer) => {
    const withNoSdkMarker = (text) => (answerIsNotEvidenceAboutABinding(host, answer) ? `${text} ${NO_SDK_MARKER}` : text);
    if (!answer) return "not sent";
    if (answer.outcome === "not_driven") return `not driven`;
    if (answer.outcome === "no_answer") return `no answer`;
    if (answer.outcome === "answered_with_a_result") return withNoSdkMarker(`ACCEPTED`);
    // A refusal of an operation whose capability the host declared a gap is the
    // host saying it does not do this at all, so it carries no subset marker:
    // contract.yaml lists no error code for refusing a gap, and every host uses
    // `unsupported` for it.
    if (answer.refusalIsADeclaredGapRefusal) {
      return withNoSdkMarker(`${codeSpan(answer.errorCode)} (gap)`);
    }
    let marked = codeSpan(answer.errorCode);
    if (answer.errorCodeIsInTheClosedSet === false) marked += " !!";
    else if (answer.errorCodeIsInThisOperationsSubset === false) marked += " +";
    if (answer.capabilityIsAGapThisHostDeclared) marked += " (gap, served anyway)";
    if (sessionStateDiffers(answer)) marked += " (no device)";
    return withNoSdkMarker(marked);
  };

  const fidelityRows = [];
  const divergences = [];
  const unanimousCodesTheContractDoesNotList = [];
  for (const caseId of identicalCaseIds) {
    const answersByHost = new Map(
      hosts.map((host) => [host.hostKey, (host.interrogation?.answers ?? []).find((answer) => answer.caseId === caseId) ?? null]),
    );
    const anyAnswer = [...answersByHost.values()].find((answer) => answer !== null);
    const cells = hosts.map((host) => (host.conformanceReport === null ? "unavailable" : renderFidelityCell(host, answersByHost.get(host.hostKey))));

    // The agreement column compares only hosts that made an error-code CHOICE
    // that is evidence about an openDAQ binding: a host refusing an operation it
    // declared a gap made no choice at all, a host whose session holds no device
    // answered a different input, and a host that loaded no openDAQ has no
    // binding for the choice to be about.
    const answerCountsTowardsAgreement = (host, answer) =>
      answer &&
      !answer.refusalIsADeclaredGapRefusal &&
      !sessionStateDiffers(answer) &&
      !answerIsNotEvidenceAboutABinding(host, answer) &&
      (answer.outcome === "refused" || answer.outcome === "answered_with_a_result");
    const comparable = hosts
      .map((host) => ({ host, answer: answersByHost.get(host.hostKey) }))
      .filter(({ host, answer }) => answerCountsTowardsAgreement(host, answer))
      .map(({ answer }) => answer);
    const distinct = new Set(comparable.map((answer) => (answer.outcome === "refused" ? answer.errorCode : "ACCEPTED")));
    let agreement;
    if (comparable.length < 2) agreement = `not comparable (${comparable.length} host${comparable.length === 1 ? "" : "s"} made a choice)`;
    else if (distinct.size === 1) agreement = `all ${comparable.length} agree`;
    else {
      agreement = `**DIVERGES**`;
      divergences.push({
        caseId,
        wireMethod: anyAnswer?.wireMethod,
        wrongInputInWords: anyAnswer?.wrongInputInWords,
        contractErrors: anyAnswer?.contractErrorSubsetForThisOperation,
        byHost: hosts
          .map((host) => ({ hostKey: host.hostKey, host, answer: answersByHost.get(host.hostKey) }))
          .filter(({ host, answer }) => answerCountsTowardsAgreement(host, answer)),
      });
    }

    // Every host agreeing on a code the operation's own error list does not
    // contain is not a host difference at all: it is the contract being wrong
    // about its own operation, and it belongs in a different section.
    if (comparable.length >= 2 && distinct.size === 1 && comparable.every((answer) => answer.errorCodeIsInThisOperationsSubset === false)) {
      unanimousCodesTheContractDoesNotList.push({
        wireMethod: anyAnswer.wireMethod,
        wrongInputInWords: anyAnswer.wrongInputInWords,
        agreedCode: comparable[0].errorCode,
        hostCount: comparable.length,
        contractErrors: anyAnswer.contractErrorSubsetForThisOperation,
        contractIsSelfContradictoryHere: comparable.find((answer) => answer.contractIsSelfContradictoryHere)?.contractIsSelfContradictoryHere ?? null,
      });
    }

    fidelityRows.push([
      anyAnswer ? codeSpan(anyAnswer.wireMethod) : caseId,
      anyAnswer ? `${anyAnswer.wrongInputInWords}${anyAnswer.phase === "before_this_session_connected_any_device" ? " (asked before this session connected anything)" : ""}` : "",
      anyAnswer ? `\`${JSON.stringify(anyAnswer.paramsSent)}\`` : "",
      anyAnswer?.methodIsNotInTheContract
        ? "the contract declares no operation, so no subset"
        : (anyAnswer?.contractErrorSubsetForThisOperation ?? []).map(codeSpan).join(", ") || "(none)",
      ...cells,
      agreement,
    ]);
  }

  push(
    renderTable(
      ["wire method", "the wrong input", "params, identical on every host", "contract allows", ...columnNames, "agreement"],
      fidelityRows,
    ),
    "",
    hostsReportedAlongside.length === 0
      ? `${divergences.length} of ${identicalCaseIds.length} identical wrong inputs produced a different error code across the hosts that made a choice.`
      : `${divergences.length} of ${identicalCaseIds.length} identical wrong inputs produced a different error code across the hosts that made a choice this table counts - the hosts compared as equals, and none of ${hostsReportedAlongside.map((host) => `\`${host.hostKey}\``).join(", ")}.`,
    "",
  );

  if (divergences.length > 0) {
    push(`### 6.1 Each divergence, spelled out`, "");
    for (const divergence of divergences) {
      push(
        `**${codeSpan(divergence.wireMethod)}** - ${divergence.wrongInputInWords}`,
        `Contract allows ${(divergence.contractErrors ?? []).map(codeSpan).join(", ") || "(the contract declares no subset for this)"}.`,
        "",
      );
      for (const { hostKey, answer } of divergence.byHost) {
        push(
          `- \`${hostKey}\` -> ${answer.outcome === "refused" ? `${codeSpan(answer.errorCode)}: ${escapeTableCell(answer.detail)}` : `no refusal at all, result ${escapeTableCell(answer.detail)}`}`,
        );
      }
      const contradiction = divergence.byHost.find(({ answer }) => answer.contractIsSelfContradictoryHere)?.answer;
      if (contradiction) push("", `The contract does not settle this one: ${contradiction.contractIsSelfContradictoryHere}.`);
      push("");
    }
  }

  if (unanimousCodesTheContractDoesNotList.length > 0) {
    push(
      `### 6.2 Where the hosts agree and the contract is the odd one out`,
      "",
      `In these rows every host that made a choice chose the **same** code, and that code is not in the list \`contract.yaml\` gives for the operation. Unanimity across independent bindings is not a binding divergence: it is the contract's per-operation error list being wrong, and it is the one finding here that no amount of host work will fix.`,
      "",
    );
    for (const row of unanimousCodesTheContractDoesNotList) {
      push(
        `- ${codeSpan(row.wireMethod)} sent ${row.wrongInputInWords}: all ${row.hostCount} hosts answered ${codeSpan(row.agreedCode)}, which is not in \`operations[${row.wireMethod}].errors = [${(row.contractErrors ?? []).join(", ")}]\`.${row.contractIsSelfContradictoryHere ? ` ${row.contractIsSelfContradictoryHere}.` : ""}`,
      );
    }
    push("");
  }

  // the cases that cannot be host-independent
  const hostSpecificCaseIds = [];
  for (const host of ran) {
    for (const answer of host.interrogation?.answers ?? []) {
      if (!answer.paramsAreIdenticalAcrossHosts && !hostSpecificCaseIds.includes(answer.caseId)) hostSpecificCaseIds.push(answer.caseId);
    }
  }
  if (hostSpecificCaseIds.length > 0) {
    push(
      `### 6.3 Wrong inputs that cannot be byte-identical`,
      "",
      `A pixel_columns range can only be exercised against a signal that exists, and every host's signal ids are its own. These rows are therefore **not** an identical-input comparison, and the exact params each host was sent are printed in the cell so nothing is hidden.`,
      "",
    );
    const hostSpecificRows = [];
    for (const caseId of hostSpecificCaseIds) {
      const answersByHost = new Map(
        hosts.map((host) => [host.hostKey, (host.interrogation?.answers ?? []).find((answer) => answer.caseId === caseId) ?? null]),
      );
      const anyAnswer = [...answersByHost.values()].find((answer) => answer !== null);
      hostSpecificRows.push([
        anyAnswer ? codeSpan(anyAnswer.wireMethod) : caseId,
        anyAnswer?.wrongInputInWords ?? "",
        ...hosts.map((host) => {
          if (host.conformanceReport === null) return "unavailable";
          const answer = answersByHost.get(host.hostKey);
          if (!answer) return "not sent";
          if (answer.outcome === "not_driven") return `not driven: ${answer.detail}`;
          return `${renderFidelityCell(host, answer)} - sent \`${JSON.stringify(answer.paramsSent)}\``;
        }),
      ]);
    }
    push(renderTable(["wire method", "the wrong input", ...columnNames], hostSpecificRows), "");
    const silence = ran
      .flatMap((host) => host.interrogation?.answers ?? [])
      .find((answer) => answer.contractIsSilentHere);
    if (silence) push(`Where the contract is silent: ${silence.contractIsSilentHere}. Any of the answers above conforms.`, "");
  }

  // ------------------------------------------------- 7. per wire method
  const strongestVerdictFor = (host, wireMethod) => {
    const entries = host.conformanceReport.entries.filter((entry) => entry.wire_method === wireMethod);
    if (entries.some((entry) => entry.verdict === "capability_claimed_and_broken")) return "**BROKE (b)**";
    if (entries.some((entry) => entry.verdict === "wire_protocol_broken")) return "**BROKE wire**";
    if (entries.some((entry) => entry.verdict === "gap_declared_but_served")) return "gap, served anyway";
    if (entries.some((entry) => entry.verdict === "gap_declared_and_consistent")) return "gap (a)";
    if (entries.some((entry) => entry.verdict === "held")) return "served";
    if (entries.some((entry) => entry.verdict === "not_provokable_by_a_wire_client")) return "not provokable";
    // An empty cell here has two very different causes, and reading them as one
    // is what let six operations sit undriven behind a clean report: the host
    // may have been asked and said nothing, or the suite may never have asked.
    // The coverage guard's own count separates them.
    const coverage = host.conformanceReport.operation_coverage;
    if (coverage && coverage.never_driven.includes(wireMethod)) return "**THIS SUITE NEVER ASKED**";
    return "no assertion";
  };
  const wireMethodRows = contract.operations.map((operation) => {
    const cells = hosts.map((host) => cellFor(host, () => strongestVerdictFor(host, operation.wireMethod)));
    // Whether an operation is served can turn entirely on whether an SDK is
    // there to serve it, so only the hosts compared as equals set this column.
    const answered = comparableHosts
      .filter((host) => host.conformanceReport !== null)
      .map((host) => strongestVerdictFor(host, operation.wireMethod));
    return [
      codeSpan(operation.wireMethod),
      codeSpan(operation.capability),
      ...cells,
      answered.length < 2 ? `not comparable (${answered.length} host${answered.length === 1 ? "" : "s"} compared as equals)` : new Set(answered).size > 1 ? "**DIFFERS**" : "same",
    ];
  });
  push(
    `## 7. Every operation in the contract, across hosts`,
    "",
    `Rows are the ${contract.operations.length} operations in \`${contractPath}\`, so an operation added to the contract cannot quietly go missing from this table. Cells are the strongest verdict any ledger entry recorded for that wire method.`,
    ...(hostsReportedAlongside.length > 0
      ? ["", alongsideCaveatForATable("whether an operation is served can turn on whether there is an SDK to serve it at all, which is precisely the difference this column must not attribute to the host.")]
      : []),
    "",
    renderTable(["wire method", "capability", ...columnNames, "agreement"], wireMethodRows),
    "",
  );

  // ------------------------------------------------------- 8. provenance
  push(
    `## 8. Where every cell came from`,
    "",
    renderTable(
      ["section", "source of every cell in it"],
      [
        ["1. hosts", "this run's own process bookkeeping: the command line it spawned, the port it bound, whether the port ever accepted a connection"],
        ["2. sdk.commit key", "each host's handshake `implementation` and `sdk` objects, compared against `manifest.json`"],
        [
          "2.1 reported alongside",
          "the same handshake `sdk` record, classified by `conformance/decide-whether-hosts-share-the-manifest-opendaq-build.mjs`; the `(no SDK)` marker in every other section is that one classification, not a per-table judgement",
        ],
        ["3. capability sets", "each host's handshake `capabilities` array, against the baseline in `contract.yaml`"],
        ["4. gap reasons", "each host's handshake `gaps` array, verbatim, with the kind checked against `contract.yaml gap_generation.kinds`"],
        ["5. failure classes", "`conformance/run-wire-conformance-against-url.mjs` ledger entries, one JSON report per host"],
        ["6. error-code fidelity", "the answer each host gave to a request this run sent it; the params are printed in the table"],
        ["5.3 contract coverage", "the request counter inside `conformance/wire/open-wire-session.mjs`, read by `conformance/sweeps/require-every-contract-operation-to-be-driven.mjs`: what each session of the run actually put on the socket"],
        ["7. per operation", "the same ledger entries as section 5, grouped by `wire_method`, with `THIS SUITE NEVER ASKED` taken from the coverage count of 5.3"],
      ],
    ),
    "",
    `The per-host conformance reports this document was built from:`,
    "",
    ...hosts.map((host) =>
      host.conformanceReportPath
        ? `- ${hostLabel(host)}: \`${host.conformanceReportPath}\``
        : `- ${hostLabel(host)}: no report - ${host.unavailableBecause}`,
    ),
    "",
  );

  return `${lines.join("\n")}\n`;
}
