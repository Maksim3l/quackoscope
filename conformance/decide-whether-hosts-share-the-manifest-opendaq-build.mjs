// The one place that decides whether a set of hosts may be compared as equals,
// used by every consumer of the sdk.commit gate: the cross-host report
// generator and compare-host-conformance-reports.mjs. There is exactly one copy
// of this rule so it cannot be tightened in one file and loosened in another.
//
// WHY THE GATE EXISTS. A behavioural difference between two hosts is only a
// difference between the HOSTS if both loaded the same openDAQ. If one loaded a
// different build, the difference may be a version difference wearing a host's
// name, and printing it as a host difference would be a lie of omission. So two
// SDK-loading hosts on different commits, or any SDK-loading host that does not
// report the manifest's commit, REFUSE the comparison outright.
//
// THE ONE CASE THAT IS NOT A DISAGREEMENT. A host can load no openDAQ at all -
// hosts/mock-ts is a synthetic device that exists precisely so the suite can be
// run with no SDK on the machine. Such a host is not a host that disagrees about
// which openDAQ it loaded; it is a host that has none. Refusing the whole run
// because of it would delete four hosts' evidence to punish a fifth for being
// what it was built to be. It is instead REPORTED ALONGSIDE: it keeps its
// column, its sweep runs, it is sent the same wrong inputs, every cell of its is
// printed and visibly marked, and it is counted in no agreement column. It is
// never silently compared as if it shared the build.
//
// HOW A HOST SAYS "I LOAD NO SDK". Both halves of the handshake's `sdk` record
// have to say it, and nothing reads implementation.name to decide anything:
//
//   sdk.commit  is exactly the string "none" (case-insensitive, trimmed)
//   sdk.version begins with the word "none"
//
// hosts/mock-ts sends sdk.version "none (synthetic device, no openDAQ SDK is
// loaded)" and sdk.commit "none", so it qualifies. A host that reports
// sdk.commit "none" while naming a real sdk.version is NOT declaring "no SDK":
// it is an SDK-loading host withholding its commit, which is exactly the case
// the gate was built to catch, and it still refuses.

/** The three provenances a host's handshake can put it in. */
export const HOST_SDK_PROVENANCE = {
  /** sdk.commit is the manifest's commit: comparable with the other such hosts. */
  sameOpenDaqBuildAsTheManifest: "same_opendaq_build_as_the_manifest",
  /** The handshake declares no openDAQ at all: reported alongside, never compared as an equal. */
  loadsNoOpenDaqAtAll: "loads_no_opendaq_at_all",
  /** Some other openDAQ, or a withheld commit: the comparison refuses. */
  aDifferentOpenDaqBuild: "a_different_opendaq_build",
};

const NO_SDK_COMMIT_SPELLING = "none";

function commitAsWritten(sdk) {
  const commit = sdk?.commit;
  return typeof commit === "string" ? commit : null;
}

function versionAsWritten(sdk) {
  const version = sdk?.version;
  return typeof version === "string" ? version : null;
}

function theCommitFieldSaysNone(sdk) {
  const commit = commitAsWritten(sdk);
  return commit !== null && commit.trim().toLowerCase() === NO_SDK_COMMIT_SPELLING;
}

function theVersionFieldSaysNone(sdk) {
  const version = versionAsWritten(sdk);
  return version !== null && /^none\b/i.test(version.trim());
}

/**
 * Classifies ONE host's handshake `sdk` record against the manifest's commit.
 *
 * @param {object}      input
 * @param {object|null} input.sdk             the handshake's `sdk` record, verbatim
 * @param {string}      input.manifestCommit  manifest.json's `commit`
 * @returns {{provenance: string, sdkVersion: string|null, sdkCommit: string|null, inWords: string}}
 *          `inWords` is a full sentence naming the literal values it read.
 */
export function classifyOneHostSdkProvenance({ sdk, manifestCommit }) {
  const sdkCommit = commitAsWritten(sdk);
  const sdkVersion = versionAsWritten(sdk);

  if (sdkCommit === null) {
    return {
      provenance: HOST_SDK_PROVENANCE.aDifferentOpenDaqBuild,
      sdkVersion,
      sdkCommit,
      inWords: `reported no sdk.commit at all in its handshake (sdk.version ${sdkVersion === null ? "was absent too" : `was "${sdkVersion}"`}), so there is nothing to compare against the manifest's ${manifestCommit}`,
    };
  }

  if (theCommitFieldSaysNone(sdk)) {
    if (theVersionFieldSaysNone(sdk)) {
      return {
        provenance: HOST_SDK_PROVENANCE.loadsNoOpenDaqAtAll,
        sdkVersion,
        sdkCommit,
        inWords: `declares no openDAQ at all: sdk.version "${sdkVersion}" and sdk.commit "${sdkCommit}". It is not a host that disagrees about the build; it has no build. It is reported alongside the hosts on ${manifestCommit}, and counted in no agreement column`,
      };
    }
    return {
      provenance: HOST_SDK_PROVENANCE.aDifferentOpenDaqBuild,
      sdkVersion,
      sdkCommit,
      inWords: `reported sdk.commit "${sdkCommit}" while naming sdk.version "${sdkVersion}", so it is an SDK-loading host withholding which openDAQ it loaded, not a host declaring it loads none; the manifest's commit is ${manifestCommit}`,
    };
  }

  if (sdkCommit === manifestCommit) {
    return {
      provenance: HOST_SDK_PROVENANCE.sameOpenDaqBuildAsTheManifest,
      sdkVersion,
      sdkCommit,
      inWords: `reported sdk.commit ${sdkCommit}, which is the manifest's, with sdk.version "${sdkVersion}"`,
    };
  }

  return {
    provenance: HOST_SDK_PROVENANCE.aDifferentOpenDaqBuild,
    sdkVersion,
    sdkCommit,
    inWords: `reported sdk.commit ${sdkCommit}, which is not the manifest's ${manifestCommit}`,
  };
}

/**
 * Decides whether a whole set of hosts may be compared as equals.
 *
 * @param {object} input
 * @param {Array<{label: string, sdk: object|null}>} input.hosts  one entry per host that handshook
 * @param {string} input.manifestCommit
 * @param {string} input.manifestSdkVersion
 * @param {string} input.manifestPath        printed in the refusal, so the reader knows which file said so
 * @returns {{
 *   refuse: boolean,
 *   disagreements: string[],
 *   comparedAsEquals: Array<{label: string, sdkCommit: string, sdkVersion: string|null}>,
 *   reportedAlongside: Array<{label: string, sdkCommit: string, sdkVersion: string|null, inWords: string}>,
 *   commitsSeen: Map<string, string[]>,
 *   provenanceByLabel: Map<string, object>,
 *   verdict: string,
 *   explanation: string,
 * }}
 */
export function decideWhetherTheseHostsMayBeComparedAsEquals({ hosts, manifestCommit, manifestSdkVersion, manifestPath }) {
  const disagreements = [];
  const comparedAsEquals = [];
  const reportedAlongside = [];
  const commitsSeen = new Map();
  const provenanceByLabel = new Map();

  for (const host of hosts) {
    const classified = classifyOneHostSdkProvenance({ sdk: host.sdk, manifestCommit });
    provenanceByLabel.set(host.label, classified);

    if (classified.provenance === HOST_SDK_PROVENANCE.loadsNoOpenDaqAtAll) {
      reportedAlongside.push({
        label: host.label,
        sdkCommit: classified.sdkCommit,
        sdkVersion: classified.sdkVersion,
        inWords: classified.inWords,
      });
      continue;
    }

    if (classified.provenance === HOST_SDK_PROVENANCE.aDifferentOpenDaqBuild) {
      disagreements.push(`${host.label} ${classified.inWords}`);
      if (classified.sdkCommit !== null) {
        if (!commitsSeen.has(classified.sdkCommit)) commitsSeen.set(classified.sdkCommit, []);
        commitsSeen.get(classified.sdkCommit).push(host.label);
      }
      continue;
    }

    comparedAsEquals.push({ label: host.label, sdkCommit: classified.sdkCommit, sdkVersion: classified.sdkVersion });
    if (!commitsSeen.has(classified.sdkCommit)) commitsSeen.set(classified.sdkCommit, []);
    commitsSeen.get(classified.sdkCommit).push(host.label);
  }

  if (commitsSeen.size > 1) {
    disagreements.push(
      `the SDK-loading hosts do not agree with each other: ${[...commitsSeen.entries()]
        .map(([commit, labels]) => `${commit} <- ${labels.join(", ")}`)
        .join("  ||  ")}`,
    );
  }

  const refuse = disagreements.length > 0;
  const alongsideSentence =
    reportedAlongside.length === 0
      ? ""
      : ` ${reportedAlongside
          .map((host) => `${host.label} reported sdk.version "${host.sdkVersion}" and sdk.commit "${host.sdkCommit}", which is no openDAQ at all`)
          .join("; ")} - ${reportedAlongside.length === 1 ? "that host is" : "those hosts are"} reported alongside rather than compared as equals: every cell of ${reportedAlongside.length === 1 ? "its" : "their"} column is printed and marked, and counted in no agreement column.`;

  return {
    refuse,
    disagreements,
    comparedAsEquals,
    reportedAlongside,
    commitsSeen,
    provenanceByLabel,
    verdict: refuse
      ? "the hosts do not agree on the openDAQ they loaded, so nothing was compared"
      : comparedAsEquals.length === 0
        ? "no host loaded an openDAQ build, so there is nothing to compare as equals and nothing to refuse"
        : "the hosts that loaded an openDAQ agree, so the comparison may proceed",
    explanation: refuse
      ? `The comparison was refused because of ${disagreements.length} disagreement(s) with the commit \`${manifestPath}\` pins (\`${manifestCommit}\`, \`${manifestSdkVersion}\`).`
      : `${comparedAsEquals.length === 0 ? "No host reported an openDAQ build." : `${comparedAsEquals.length} host(s) - ${comparedAsEquals.map((host) => host.label).join(", ")} - reported sdk.commit \`${manifestCommit}\`, which is the commit \`${manifestPath}\` pins (\`${manifestSdkVersion}\`), and they are compared as equals.`}${alongsideSentence}`,
  };
}

/**
 * The paragraph the report prints, in words, so a reader of the markdown alone
 * knows what a column marked "no SDK" means. Written here, beside the rule it
 * describes, so the two cannot drift apart.
 */
export const WHAT_REPORTED_ALONGSIDE_MEANS =
  "**Reported alongside** means exactly this: the host keeps its column, its conformance sweep was run, it was sent the identical wrong inputs, and every cell it produced is printed here - marked `(no SDK)` wherever it appears. What it is NOT is an equal in a comparison: it is counted in no agreement column anywhere in this document, because it did not load the openDAQ build the other hosts loaded. It loaded none at all, by construction. So its cells say what that host does on the wire, and they are never evidence about an openDAQ binding: where its column differs from another host's, that is not a binding divergence, and where it happens to match, that is not corroboration. A host that DOES load an openDAQ and reports a different commit from the others or from the manifest is a different matter entirely, and is not reported alongside: the run refuses outright, writes no document at all, and says which host disagreed.";
