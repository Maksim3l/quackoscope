// Sweep 1: the handshake, against contract 1.6 (contract.yaml `handshake`).
//
// This sweep runs first and is the only one whose result the others depend on:
// the capability list it validates is what decides, for every later assertion,
// whether a broken operation is failure class (b) or declared-gap class (a).
// So the handshake is judged on its own terms before it is trusted to classify
// anything.
//
// Nothing here reads implementation.name to decide anything. contract.yaml
// implementation_names.display_only is true and behavioural_branch_allowed is
// false; the name is asserted against the declared pattern and then never used
// again.

import { findRecordViolations } from "../wire/validate-record-against-contract-type.mjs";

const HOST_IMPLEMENTATION_NAME_PATTERN = /^quackoscope-host-[a-z0-9][a-z0-9-]*$/;

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function sweepHandshake(ledger, contract, firstMessage) {
  const handshakeSpec = contract.handshake;
  const citation = "contract.yaml handshake (contract 1.6)";

  ledger.recordWireProtocolAssertion({
    title: "message ordinal 1 on the session is a parseable JSON object",
    contractCitation: `${citation}: direction server_to_client, ordinal ${handshakeSpec.ordinal}`,
    expected: "the server speaks first, with one JSON object",
    actual:
      firstMessage.parsed === null || firstMessage.parsed === undefined
        ? `unparseable text (${firstMessage.parseFailure ?? "no JSON"}): ${String(firstMessage.text).slice(0, 200)}`
        : `${typeOf(firstMessage.parsed)}, ${firstMessage.text.length} bytes`,
    held: firstMessage.parsed !== null && typeof firstMessage.parsed === "object" && !Array.isArray(firstMessage.parsed),
  });

  const handshake = firstMessage.parsed;
  if (handshake === null || typeof handshake !== "object" || Array.isArray(handshake)) {
    ledger.setDeclaredCapabilities([]);
    return { handshake: null, declaredCapabilities: [], usable: false };
  }

  ledger.recordWireProtocolAssertion({
    title: "message ordinal 1 is the handshake and not a result, error or event envelope",
    contractCitation: `${citation}; contract.yaml envelopes discriminators has_key_result / has_key_error / has_key_event`,
    expected: "no id, result, error or event key on the first message",
    actual: `top-level keys: ${Object.keys(handshake).join(", ")}`,
    held: !("id" in handshake) && !("result" in handshake) && !("error" in handshake) && !("event" in handshake),
  });

  // --- every declared handshake field, by presence and type -----------------
  for (const [fieldName, fieldSpec] of Object.entries(handshakeSpec.fields)) {
    const present = fieldName in handshake;
    ledger.recordHandshakeAssertion({
      title: `handshake.${fieldName} is present`,
      contractCitation: `${citation}: fields.${fieldName}.presence = ${fieldSpec.presence}`,
      expected: `the key "${fieldName}" is present (presence ${fieldSpec.presence})`,
      actual: present ? `present, a ${typeOf(handshake[fieldName])}` : "the key is absent",
      held: present || fieldSpec.presence === "optional" || fieldSpec.presence === "optional_null",
    });
  }

  // --- protocol_version const ----------------------------------------------
  const protocolVersionConst = String(handshakeSpec.fields.protocol_version.const);
  ledger.recordHandshakeAssertion({
    title: "handshake.protocol_version equals the contract's constant",
    contractCitation: `${citation}: fields.protocol_version.const = "${protocolVersionConst}"`,
    expected: `"${protocolVersionConst}"`,
    actual: JSON.stringify(handshake.protocol_version) ?? "absent",
    held: handshake.protocol_version === protocolVersionConst,
  });

  // --- implementation -------------------------------------------------------
  const implementation = handshake.implementation;
  const implementationIsRecord = implementation !== null && typeof implementation === "object" && !Array.isArray(implementation);
  ledger.recordHandshakeAssertion({
    title: "handshake.implementation carries a string name and a string version",
    contractCitation: `${citation}: fields.implementation.fields name/version, both required strings`,
    expected: "{name: string, version: string}",
    actual: JSON.stringify(implementation) ?? "absent",
    held:
      implementationIsRecord &&
      typeof implementation.name === "string" &&
      implementation.name.length > 0 &&
      typeof implementation.version === "string" &&
      implementation.version.length > 0,
  });

  const implementationName = implementationIsRecord ? implementation.name : undefined;
  const nameIsInDeclaredValues = contract.implementationNames.includes(implementationName);
  ledger.recordHandshakeAssertion({
    title: "handshake.implementation.name matches the declared host-name pattern",
    contractCitation: `contract.yaml implementation_names.pattern = ${contract.rawDocument.implementation_names.pattern}; values = [${contract.implementationNames.join(", ")}]`,
    expected: `a name matching ${HOST_IMPLEMENTATION_NAME_PATTERN}`,
    actual:
      `${JSON.stringify(implementationName) ?? "absent"}` +
      (nameIsInDeclaredValues
        ? " (and it is one of implementation_names.values)"
        : " (NOT one of implementation_names.values; the pattern is asserted, the closed value list is only reported - see the contract-vagueness notes)"),
    held: typeof implementationName === "string" && HOST_IMPLEMENTATION_NAME_PATTERN.test(implementationName),
  });

  // --- sdk ------------------------------------------------------------------
  const sdk = handshake.sdk;
  const sdkIsRecord = sdk !== null && typeof sdk === "object" && !Array.isArray(sdk);
  ledger.recordHandshakeAssertion({
    title: "handshake.sdk carries a string version and a string commit",
    contractCitation: `${citation}: fields.sdk.fields version/commit, both required strings`,
    expected: "{version: string, commit: string}",
    actual: JSON.stringify(sdk) ?? "absent",
    held:
      sdkIsRecord &&
      typeof sdk.version === "string" &&
      sdk.version.length > 0 &&
      typeof sdk.commit === "string" &&
      sdk.commit.length > 0,
  });

  // --- capabilities ---------------------------------------------------------
  const rawCapabilities = Array.isArray(handshake.capabilities) ? handshake.capabilities : null;
  ledger.recordHandshakeAssertion({
    title: "handshake.capabilities is an array of strings",
    contractCitation: `${citation}: fields.capabilities is an array of string, references capabilities.id`,
    expected: "an array whose every element is a string",
    actual: JSON.stringify(handshake.capabilities) ?? "absent",
    held: rawCapabilities !== null && rawCapabilities.every((entry) => typeof entry === "string"),
  });

  const capabilityStrings = (rawCapabilities ?? []).filter((entry) => typeof entry === "string");
  const notBaselineIds = capabilityStrings.filter((id) => !contract.capabilityBaselineIds.includes(id));
  ledger.recordHandshakeAssertion({
    title: "every entry of handshake.capabilities is one of the contract's baseline capability ids",
    contractCitation: `${citation}: fields.capabilities.references = capabilities.id; the baseline read from contract.yaml is [${contract.capabilityBaselineIds.join(", ")}]`,
    expected: `every entry drawn from the ${contract.capabilityBaselineIds.length} baseline ids`,
    actual:
      notBaselineIds.length === 0
        ? `all ${capabilityStrings.length} entries are baseline capability ids`
        : `${notBaselineIds.length} of ${capabilityStrings.length} entries are not capability ids at all: ${notBaselineIds.map((id) => JSON.stringify(id)).join(", ")}`,
    held: notBaselineIds.length === 0,
  });

  const duplicateCapabilities = capabilityStrings.filter((id, index) => capabilityStrings.indexOf(id) !== index);
  ledger.recordHandshakeAssertion({
    title: "handshake.capabilities lists no id twice",
    contractCitation: `${citation}: fields.capabilities references capabilities.id, which is a set`,
    expected: "no duplicate ids",
    actual: duplicateCapabilities.length === 0 ? "no duplicates" : `duplicated: ${duplicateCapabilities.join(", ")}`,
    held: duplicateCapabilities.length === 0,
  });

  // Only baseline ids can classify an operation, so that intersection is what
  // the rest of the run uses. An id the contract does not know cannot claim an
  // operation, and the assertion above has already failed the handshake for it.
  const declaredCapabilities = contract.capabilityBaselineIds.filter((id) => capabilityStrings.includes(id));
  ledger.setDeclaredCapabilities(declaredCapabilities);

  // --- gaps -----------------------------------------------------------------
  const rawGaps = Array.isArray(handshake.gaps) ? handshake.gaps : null;
  ledger.recordHandshakeAssertion({
    title: "handshake.gaps is an array of Gap records",
    contractCitation: `${citation}: fields.gaps is an array of Gap; contract.yaml types.Gap fields capability/kind/reason`,
    expected: "an array of {capability, kind, reason}",
    actual: JSON.stringify(handshake.gaps) ?? "absent",
    held: rawGaps !== null,
  });

  const gapViolations = [];
  (rawGaps ?? []).forEach((gap, index) => {
    gapViolations.push(...findRecordViolations(gap, "Gap", contract, `handshake.gaps[${index}]`));
  });
  ledger.recordHandshakeAssertion({
    title: "every Gap record conforms to contract.yaml types.Gap",
    contractCitation: "contract.yaml types.Gap: capability required string, kind enum [binding, host], reason required string with min_length 1",
    expected: `${(rawGaps ?? []).length} conforming Gap records`,
    actual: gapViolations.length === 0 ? `all ${(rawGaps ?? []).length} Gap records conform` : gapViolations.join(" | "),
    held: gapViolations.length === 0,
  });

  const gapCapabilityIds = (rawGaps ?? [])
    .filter((gap) => gap !== null && typeof gap === "object")
    .map((gap) => gap.capability);
  const computedGapIds = contract.capabilityBaselineIds.filter((id) => !declaredCapabilities.includes(id));

  const missingFromGapList = computedGapIds.filter((id) => !gapCapabilityIds.includes(id));
  const inventedGapIds = gapCapabilityIds.filter((id) => !computedGapIds.includes(id));
  ledger.recordHandshakeAssertion({
    title: "handshake.gaps is exactly the baseline minus the declared capabilities",
    contractCitation: `contract.yaml gap_generation.computed_as = ${contract.gapComputedAs}; host_may_declare_gap_list = ${contract.hostMayDeclareGapList}; declared_by_host = reason_only`,
    expected: `gap capabilities exactly [${computedGapIds.join(", ") || "(none)"}]`,
    actual:
      `handshake gap capabilities [${gapCapabilityIds.join(", ") || "(none)"}]` +
      (missingFromGapList.length ? `; missing a gap for [${missingFromGapList.join(", ")}]` : "") +
      (inventedGapIds.length ? `; declares gaps the baseline does not compute: [${inventedGapIds.join(", ")}]` : ""),
    held: missingFromGapList.length === 0 && inventedGapIds.length === 0,
  });

  // --- limits ---------------------------------------------------------------
  const limits = handshake.limits;
  const limitsAreRecord = limits !== null && typeof limits === "object" && !Array.isArray(limits);
  const limitFieldNames = Object.keys(handshakeSpec.fields.limits.fields);
  const badLimits = limitFieldNames.filter(
    (name) => !limitsAreRecord || typeof limits[name] !== "number" || !Number.isInteger(limits[name]) || limits[name] <= 0,
  );
  ledger.recordHandshakeAssertion({
    title: `handshake.limits carries ${limitFieldNames.join(" and ")} as positive integers`,
    contractCitation: `${citation}: fields.limits.fields ${limitFieldNames.map((name) => `${name} (int, default ${handshakeSpec.fields.limits.fields[name].default})`).join(", ")}`,
    expected: limitFieldNames.map((name) => `${name}: int`).join(", "),
    actual: JSON.stringify(limits) ?? "absent",
    held: badLimits.length === 0,
  });

  const declaredHandshakeKeys = Object.keys(handshakeSpec.fields);
  const extraKeys = Object.keys(handshake).filter((key) => !declaredHandshakeKeys.includes(key));
  if (extraKeys.length > 0) {
    ledger.recordUnconstrained({
      title: "handshake carries top-level keys the contract does not declare",
      contractCitation: `${citation} declares exactly [${declaredHandshakeKeys.join(", ")}] and says nothing about additional keys`,
      reason: "contract.yaml neither permits nor forbids extra handshake keys, so this cannot be a pass or a fail",
      observation: extraKeys.join(", "),
    });
  }

  return {
    handshake,
    declaredCapabilities,
    gapCapabilityIds,
    computedGapIds,
    gapsByCapability: new Map(
      (rawGaps ?? []).filter((gap) => gap && typeof gap === "object").map((gap) => [gap.capability, gap]),
    ),
    limits: limitsAreRecord ? limits : { max_subscriptions: 0, max_frame_bytes: 0 },
    sdk: sdkIsRecord ? { version: sdk.version, commit: sdk.commit } : { version: null, commit: null },
    implementation: implementationIsRecord ? { name: implementation.name, version: implementation.version } : { name: null, version: null },
    usable: true,
  };
}
