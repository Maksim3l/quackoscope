// Sweep 3: the six operations contract.yaml grew after the other sweeps were
// written - get_device_operation_modes, set_device_operation_mode, lock_device,
// unlock_device, list_loaded_modules and load_module_from_host_path.
//
// Same shape as sweep 2, and for the same reasons: one question is asked first,
// did the handshake claim this operation's capability, and everything follows
// from the answer. A claimed capability is driven for real and anything wrong is
// failure class (b); a gapped one is driven anyway through driveGappedOperation
// and a refusal is class (a), which passes.
//
// Three things make these four capabilities need a file rather than another
// paragraph inside sweep 2.
//
// A SECOND SOCKET. contract.yaml gives lock_device the error read_only, worded
// "the device is already locked, and not by this session", and gives
// unlock_device the same code because "openDAQ permits an unlock only by the
// user who locked it". Neither sentence can be asserted from one session: the
// only client that can be refused is a client that is not the holder. So this
// sweep opens a SECOND WebSocket to the same URL, connects it to the same
// device, and drives the refusals from there. It closes it again before it
// returns, and it hands the session back so the coverage guard can count the
// requests it sent.
//
// A DEVICE LEFT AS IT WAS FOUND. The operation mode is moved and moved back; the
// lock is taken and released; a property write made from the second session to
// prove a locked device refuses one is read back and restored if the host
// accepted it. Nothing this sweep does may change what the next sweep, or the
// next host comparison, sees.
//
// A SUCCESS PATH THIS SUITE WILL NOT DRIVE. load_module_from_host_path makes the
// host dlopen a file off its own disk and run that file's initialisation - which
// is arbitrary code execution inside the host, and permanent for that process:
// its module list, its device types and its function block types all change, and
// every one of those is read by assertions in this same run. The suite addresses
// a host by URL and knows nothing about its filesystem, so it has no honest
// module path to offer either. The failure paths are driven; the success path is
// recorded, in the report, as not driven and why.

import { findRecordViolations } from "../wire/validate-record-against-contract-type.mjs";
import { openWireSession } from "../wire/open-wire-session.mjs";
import { judgeResponseEnvelope } from "./judge-response-envelope.mjs";
import {
  CONFORMANCE_ABSENT_MODULE_HOST_PATHS,
  CONFORMANCE_UNKNOWN_NODE_ID,
  CONFORMANCE_UNKNOWN_OPERATION_MODE,
  driveGappedOperation,
} from "./sweep-every-contract-operation.mjs";

const EMPTY_HOST_PATH = "";

/** One response envelope in words, for a log line that is not an assertion. */
export function describeAnswer(response) {
  if (response && typeof response === "object" && "error" in response) {
    return `refused with ${response.error?.code}: ${String(response.error?.detail ?? "").slice(0, 160)}`;
  }
  return `accepted, result ${JSON.stringify(response?.result ?? null)}`;
}

export async function sweepDeviceOperationModeDeviceLockAndModules(ledger, contract, session, handshakeResult, discovered, options) {
  const claimed = (capability) => ledger.capabilityIsClaimed(capability);
  const gapsByCapability = handshakeResult.gapsByCapability ?? new Map();
  const operationOf = (wireMethod) => contract.operationsByWireMethod.get(wireMethod);
  const sessionsOpenedByThisSweep = [];

  const operationModeValues = contract.types.Node.fields.operation_mode.values;
  const deviceNodeId = discovered.deviceNodeId;
  const aNodeThatIsNotADevice = (discovered.treeNodes ?? []).find((node) => node.kind !== "device") ?? null;

  const capabilitiesThisSweepOwns = ["device.mode", "device.lock", "module.read", "module.load"];
  console.log(
    `capabilities this sweep drives: ${capabilitiesThisSweepOwns
      .map((capability) => `${capability} (${claimed(capability) ? "claimed" : "declared a gap"})`)
      .join(", ")}`,
  );
  console.log(
    `the device this sweep acts on: ${deviceNodeId ?? "(none; connect_device produced no node id)"}; ` +
      `a node that is not a device, for the unsupported corner: ${aNodeThatIsNotADevice?.id ?? "(none in the tree)"}`,
  );

  // -------------------------------------------------------------------------
  // A second session, opened before anything else so that the three operations
  // whose error list contains not_connected can be asked of a session that has
  // connected no device. This one socket serves both purposes: the unconnected
  // questions now, and the not-the-lock-holder refusals later, once it connects.
  // -------------------------------------------------------------------------
  let secondSession = null;
  let whyThereIsNoSecondSession = null;
  try {
    const opened = await openWireSession(options.url, contract, { requestTimeoutMs: options.requestTimeoutMs });
    secondSession = opened.session;
    sessionsOpenedByThisSweep.push(secondSession);
    console.log(
      `opened a second WebSocket to ${options.url}; its handshake was ${opened.firstMessage.text.length} bytes. ` +
        "It is the client that is NOT the lock holder, which is the only client contract.yaml's read_only wording can be asserted from.",
    );
  } catch (failure) {
    whyThereIsNoSecondSession = failure.message;
    console.log(`a second WebSocket to ${options.url} could not be opened: ${failure.message}`);
  }

  const askTheUnconnectedSession = async (wireMethod, params, title, contractCitation, expected, judge) => {
    const operation = operationOf(wireMethod);
    if (secondSession === null) {
      ledger.recordNotProvokable({
        capability: operation.capability,
        wireMethod,
        title,
        contractCitation,
        reason: `this assertion needs a second session that has connected no device, and a second WebSocket to ${options.url} could not be opened: ${whyThereIsNoSecondSession}`,
      });
      return null;
    }
    const response = await secondSession.request(wireMethod, params);
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod,
      capability: operation.capability,
      capabilityIsClaimed: true,
      describedAs: "on a second session that has connected no device",
    });
    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod,
      title,
      contractCitation,
      expected,
      actual: judged.isError
        ? `error ${judged.code}: ${judged.detail}`
        : `result ${JSON.stringify(judged.result)?.slice(0, 200)}`,
      held: judge(judged),
    });
    return judged;
  };

  // =========================================================================
  // device.mode
  // =========================================================================
  console.log("\ndevice.mode: get_device_operation_modes, set_device_operation_mode");
  if (!claimed("device.mode")) {
    await driveGappedOperation(ledger, contract, session, operationOf("get_device_operation_modes"), discovered, gapsByCapability);
    await driveGappedOperation(ledger, contract, session, operationOf("set_device_operation_mode"), discovered, gapsByCapability);
  } else if (!deviceNodeId) {
    for (const wireMethod of ["get_device_operation_modes", "set_device_operation_mode"]) {
      ledger.recordNotProvokable({
        capability: "device.mode",
        wireMethod,
        title: `${wireMethod} could not be driven`,
        contractCitation: `contract.yaml operations[${wireMethod}].params node_id, references Node.id`,
        reason: "connect_device produced no device node id in this session, so there is no device row to ask about",
      });
    }
  } else {
    // --- the available list -----------------------------------------------
    const modesResponse = await session.request("get_device_operation_modes", { node_id: deviceNodeId });
    const judgedModes = judgeResponseEnvelope(ledger, contract, {
      response: modesResponse,
      wireMethod: "get_device_operation_modes",
      capability: "device.mode",
      capabilityIsClaimed: true,
    });
    const availableModes = Array.isArray(judgedModes.result) ? judgedModes.result : [];
    const modesOutsideTheEnum = availableModes.filter((mode) => !operationModeValues.includes(mode));
    ledger.recordClaimedCapabilityAssertion({
      capability: "device.mode",
      wireMethod: "get_device_operation_modes",
      title: `get_device_operation_modes ${deviceNodeId} returns an array whose every element is a value of Node.operation_mode`,
      contractCitation: `contract.yaml operations[get_device_operation_modes].returns = array of string, semantic operation_mode_names, "Every element is one of the values of Node.operation_mode"; types.Node.operation_mode enumerates [${operationModeValues.join(", ")}]`,
      expected: `an array of strings drawn from [${operationModeValues.join(", ")}]`,
      actual: judgedModes.isError
        ? `error ${judgedModes.code}: ${judgedModes.detail}`
        : modesOutsideTheEnum.length === 0
          ? `${availableModes.length} mode(s): ${availableModes.join(", ")}`
          : `outside the enum: ${modesOutsideTheEnum.join(", ")} (whole answer: ${JSON.stringify(judgedModes.result)?.slice(0, 200)})`,
      held: !judgedModes.isError && Array.isArray(judgedModes.result) && modesOutsideTheEnum.length === 0,
    });
    if (availableModes.length > 0) discovered.anAvailableOperationMode = availableModes[0];

    const deviceRowBefore = (discovered.treeNodes ?? []).find((node) => node.id === deviceNodeId) ?? null;
    const modeBefore = deviceRowBefore?.operation_mode ?? null;
    // Carried into the lock section below, which drives one more mode change -
    // the one a session that does not hold the lock must be refused. A host that
    // takes that write instead of refusing it has MOVED the device, and the
    // sweep has to put it back: leaving an openDAQ reference device in idle
    // stops its acquisition, and the next sweep's subscription then waits for
    // sample frames that will never come.
    discovered.operationModeTheDeviceWasFoundIn = availableModes.includes(modeBefore) ? modeBefore : null;
    discovered.anOperationModeOtherThanTheOneInForce = availableModes.find((mode) => mode !== modeBefore) ?? null;
    ledger.recordUnconstrained({
      title: "whether the device's current Node.operation_mode is one of the modes it lists as available",
      contractCitation:
        "contract.yaml types.Node.operation_mode carries the CURRENT mode and operations[get_device_operation_modes] the AVAILABLE list, but nothing in the contract requires the current one to appear in the available one",
      reason: "the contract relates the two only through the enum they both draw from, never by membership",
      observation: `Node.operation_mode of ${deviceNodeId} is ${JSON.stringify(modeBefore)}; get_device_operation_modes answered [${availableModes.join(", ")}]`,
    });

    // --- not_found, unsupported on the read path ---------------------------
    await refuseWithOneOf(ledger, contract, session, {
      wireMethod: "get_device_operation_modes",
      params: { node_id: CONFORMANCE_UNKNOWN_NODE_ID },
      title: `get_device_operation_modes on the unknown node "${CONFORMANCE_UNKNOWN_NODE_ID}" is refused with not_found`,
      contractCitation: `contract.yaml operations[get_device_operation_modes].errors = [${operationOf("get_device_operation_modes").errors.join(", ")}]`,
      acceptableCodes: ["not_found"],
    });
    await refuseOnANodeThatIsNotADevice(ledger, contract, session, "get_device_operation_modes", aNodeThatIsNotADevice);

    // --- not_connected, from the session that has connected nothing --------
    await askTheUnconnectedSession(
      "get_device_operation_modes",
      { node_id: deviceNodeId },
      `get_device_operation_modes for ${deviceNodeId}, asked from a session that has connected no device, is refused`,
      `contract.yaml operations[get_device_operation_modes].errors = [${operationOf("get_device_operation_modes").errors.join(", ")}]. The contract lists both not_connected and not_found and never says which a node id that is real on another session must get, so both are accepted here - see the contract-vagueness notes`,
      'one of [not_connected, not_found]',
      (judged) => judged.isError && ["not_connected", "not_found"].includes(judged.code),
    );

    // --- the write path, and the read-back that proves it took -------------
    if (availableModes.length === 0) {
      ledger.recordNotProvokable({
        capability: "device.mode",
        wireMethod: "set_device_operation_mode",
        title: "set_device_operation_mode could not be driven with a round trip",
        contractCitation: "contract.yaml operations[set_device_operation_mode].params mode: one of the elements get_device_operation_modes returned for this node",
        reason: "get_device_operation_modes listed no mode, so there is no mode this device has said it accepts",
      });
    } else {
      const modeToSet = availableModes.find((mode) => mode !== modeBefore) ?? availableModes[0];
      const setResponse = await session.request("set_device_operation_mode", { node_id: deviceNodeId, mode: modeToSet });
      const judgedSet = judgeResponseEnvelope(ledger, contract, {
        response: setResponse,
        wireMethod: "set_device_operation_mode",
        capability: "device.mode",
        capabilityIsClaimed: true,
      });
      ledger.recordClaimedCapabilityAssertion({
        capability: "device.mode",
        wireMethod: "set_device_operation_mode",
        title: `set_device_operation_mode ${deviceNodeId} = "${modeToSet}" is accepted and returns void`,
        contractCitation: "contract.yaml operations[set_device_operation_mode].returns = void; envelopes.result.result presence nullable",
        expected: "a result envelope carrying null",
        actual: judgedSet.isError ? `error ${judgedSet.code}: ${judgedSet.detail}` : `result ${JSON.stringify(judgedSet.result)}`,
        held: !judgedSet.isError && (judgedSet.result === null || judgedSet.result === undefined),
      });

      if (!judgedSet.isError && claimed("tree.read")) {
        const treeAfter = await session.request("get_component_tree", {});
        const rowAfter = Array.isArray(treeAfter.result) ? treeAfter.result.find((node) => node.id === deviceNodeId) : null;
        ledger.recordClaimedCapabilityAssertion({
          capability: "device.mode",
          wireMethod: "set_device_operation_mode",
          title: `the mode written to ${deviceNodeId} is visible as Node.operation_mode on a later tree read`,
          contractCitation:
            'contract.yaml types.Node.operation_mode: "This is the current mode the reference appends to the row name"; the AVAILABLE modes are get_device_operation_modes, so a set that is not visible on the node makes the two halves of device.mode disagree',
          expected: `get_component_tree reports operation_mode "${modeToSet}" on ${deviceNodeId}`,
          actual:
            rowAfter === null || rowAfter === undefined
              ? `${deviceNodeId} is not in the tree that came back: ${JSON.stringify(treeAfter.error ?? treeAfter.result)?.slice(0, 200)}`
              : `operation_mode ${JSON.stringify(rowAfter.operation_mode)} (it was ${JSON.stringify(modeBefore)} before the write)`,
          held: rowAfter !== null && rowAfter !== undefined && rowAfter.operation_mode === modeToSet,
        });
      }

      // Put the device back in the mode it was found in.
      if (modeBefore !== null && availableModes.includes(modeBefore)) {
        const restored = await session.request("set_device_operation_mode", { node_id: deviceNodeId, mode: modeBefore });
        console.log(
          `restored ${deviceNodeId} to the operation mode it was found in, "${modeBefore}": the host ${describeAnswer(restored)}`,
        );
      } else {
        console.log(
          `${deviceNodeId} is left in operation mode "${modeToSet}": the mode it was found in was ${JSON.stringify(modeBefore)}, which this device does not list as available, so there is nothing to restore it to`,
        );
      }
    }

    // --- invalid_value, not_found, unsupported on the write path -----------
    await refuseWithOneOf(ledger, contract, session, {
      wireMethod: "set_device_operation_mode",
      params: { node_id: deviceNodeId, mode: CONFORMANCE_UNKNOWN_OPERATION_MODE },
      title: `set_device_operation_mode with the mode name "${CONFORMANCE_UNKNOWN_OPERATION_MODE}", which is outside types.Node.operation_mode, is refused with invalid_value`,
      contractCitation: `contract.yaml operations[set_device_operation_mode].errors = [${operationOf("set_device_operation_mode").errors.join(", ")}]; "invalid_value: a mode name outside Node.operation_mode's values, or one the device did not list as available"`,
      acceptableCodes: ["invalid_value"],
    });
    await refuseWithOneOf(ledger, contract, session, {
      wireMethod: "set_device_operation_mode",
      params: { node_id: CONFORMANCE_UNKNOWN_NODE_ID, mode: discovered.anAvailableOperationMode ?? operationModeValues[0] },
      title: `set_device_operation_mode on the unknown node "${CONFORMANCE_UNKNOWN_NODE_ID}" is refused with not_found`,
      contractCitation: `contract.yaml operations[set_device_operation_mode].errors = [${operationOf("set_device_operation_mode").errors.join(", ")}]`,
      acceptableCodes: ["not_found"],
    });
    await refuseOnANodeThatIsNotADevice(ledger, contract, session, "set_device_operation_mode", aNodeThatIsNotADevice, {
      mode: discovered.anAvailableOperationMode ?? operationModeValues[0],
    });
  }

  // =========================================================================
  // module.read
  // =========================================================================
  console.log("\nmodule.read: list_loaded_modules");
  if (!claimed("module.read")) {
    await driveGappedOperation(ledger, contract, session, operationOf("list_loaded_modules"), discovered, gapsByCapability);
  } else {
    const response = await session.request("list_loaded_modules", {});
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod: "list_loaded_modules",
      capability: "module.read",
      capabilityIsClaimed: true,
    });
    const modules = Array.isArray(judged.result) ? judged.result : [];
    const violations = [];
    if (!judged.isError && !Array.isArray(judged.result)) {
      violations.push(`expected an array of ModuleInfo; got ${JSON.stringify(judged.result)?.slice(0, 160)}`);
    }
    modules.forEach((module, index) =>
      violations.push(...findRecordViolations(module, "ModuleInfo", contract, `list_loaded_modules[${index}]`)),
    );
    const componentTypeCount = modules.reduce((total, module) => total + (module.component_types?.length ?? 0), 0);
    ledger.recordClaimedCapabilityAssertion({
      capability: "module.read",
      wireMethod: "list_loaded_modules",
      title: "list_loaded_modules returns an array of contract-shaped ModuleInfo records, each carrying its ComponentTypeInfo rows",
      contractCitation:
        "contract.yaml operations[list_loaded_modules].returns = array of ModuleInfo; types.ModuleInfo id/name/component_types required and version nullable; types.ComponentTypeInfo id/name/kind required, kind an enum over [device, function_block, server, streaming]",
      expected: "every element a ModuleInfo whose component_types are all ComponentTypeInfo",
      actual: judged.isError
        ? `error ${judged.code}: ${judged.detail}`
        : violations.length === 0
          ? `${modules.length} module(s) carrying ${componentTypeCount} component type(s) between them; ids: ${modules.map((module) => JSON.stringify(module.id)).join(", ").slice(0, 300)}`
          : violations.slice(0, 8).join(" | "),
      held: !judged.isError && violations.length === 0,
    });
    console.log(
      `list_loaded_modules answered with ${modules.length} module(s) and ${componentTypeCount} component type(s): ` +
        `${modules.map((module) => `${JSON.stringify(module.id)} ${JSON.stringify(module.version)}`).join(", ").slice(0, 400)}`,
    );

    await askTheUnconnectedSession(
      "list_loaded_modules",
      {},
      "list_loaded_modules, asked from a session that has connected no device, either answers the list or refuses not_connected",
      `contract.yaml operations[list_loaded_modules].errors = [${operationOf("list_loaded_modules").errors.join(", ")}] and params = []. The module list is a fact about the host PROCESS - the reference reads instance.module_manager.modules, not a device - and the contract never says which state not_connected belongs to, so both answers conform`,
      "an array of ModuleInfo, or error not_connected",
      (judged) => (judged.isError ? judged.code === "not_connected" : Array.isArray(judged.result)),
    );

    ledger.recordNotProvokable({
      capability: "module.read",
      wireMethod: "list_loaded_modules",
      title: 'the "internal" error code of list_loaded_modules was not provoked',
      contractCitation: `contract.yaml operations[list_loaded_modules].errors = [${operationOf("list_loaded_modules").errors.join(", ")}]`,
      reason:
        "internal here is a module manager that raises while being enumerated; it takes no parameters at all, so there is no input a wire client can shape to force one",
    });
  }

  // =========================================================================
  // module.load
  // =========================================================================
  console.log("\nmodule.load: load_module_from_host_path");
  if (!claimed("module.load")) {
    await driveGappedOperation(ledger, contract, session, operationOf("load_module_from_host_path"), discovered, gapsByCapability);
  } else {
    const declaredErrors = operationOf("load_module_from_host_path").errors;
    const answersByPath = new Map();
    for (const [spelling, hostPath] of Object.entries(CONFORMANCE_ABSENT_MODULE_HOST_PATHS)) {
      const response = await session.request("load_module_from_host_path", { host_path: hostPath });
      const judged = judgeResponseEnvelope(ledger, contract, {
        response,
        wireMethod: "load_module_from_host_path",
        capability: "module.load",
        capabilityIsClaimed: true,
        describedAs: `host_path "${hostPath}" (${spelling})`,
      });
      answersByPath.set(spelling, { hostPath, judged });
      console.log(
        `load_module_from_host_path "${hostPath}" (${spelling}) -> ` +
          `${judged.isError ? `${judged.code}: ${String(judged.detail).slice(0, 160)}` : `a module was loaded: ${JSON.stringify(judged.result)?.slice(0, 160)}`}`,
      );
    }
    const spellingsAnsweredNotFound = [...answersByPath.entries()]
      .filter(([, answer]) => answer.judged.isError && answer.judged.code === "not_found")
      .map(([spelling]) => spelling);
    ledger.recordClaimedCapabilityAssertion({
      capability: "module.load",
      wireMethod: "load_module_from_host_path",
      title: "an absent module file is refused with not_found, in whichever of the two path spellings is absolute on this host's own platform",
      contractCitation:
        'contract.yaml operations[load_module_from_host_path]: "not_found: nothing at host_path on the HOST\'s disk. Under design (a) this is the most likely answer a user will ever see from this row - it is what a path copied off the client\'s own machine produces". ' +
        "The suite addresses this host by URL and cannot know its path syntax, so both spellings are sent and the assertion is on the pair: whichever one is absolute there must land on \"no file there\", and the other may be refused invalid_value as a relative path.",
      expected: `at least one of ${[...answersByPath.values()].map((answer) => `"${answer.hostPath}"`).join(" and ")} refused with "not_found"`,
      actual:
        spellingsAnsweredNotFound.length > 0
          ? `${spellingsAnsweredNotFound.join(" and ")} answered not_found; ` +
            [...answersByPath.entries()].map(([spelling, answer]) => `${spelling} -> ${answer.judged.isError ? answer.judged.code : "a result"}`).join(", ")
          : [...answersByPath.entries()]
              .map(([spelling, answer]) => `${spelling} "${answer.hostPath}" -> ${answer.judged.isError ? `${answer.judged.code}: ${String(answer.judged.detail).slice(0, 120)}` : `LOADED SOMETHING: ${JSON.stringify(answer.judged.result)?.slice(0, 120)}`}`)
              .join(" | "),
      held: spellingsAnsweredNotFound.length > 0,
    });

    const emptyResponse = await session.request("load_module_from_host_path", { host_path: EMPTY_HOST_PATH });
    const judgedEmpty = judgeResponseEnvelope(ledger, contract, {
      response: emptyResponse,
      wireMethod: "load_module_from_host_path",
      capability: "module.load",
      capabilityIsClaimed: true,
      describedAs: 'host_path ""',
    });
    ledger.recordClaimedCapabilityAssertion({
      capability: "module.load",
      wireMethod: "load_module_from_host_path",
      title: 'load_module_from_host_path with the empty host_path is refused, never accepted',
      contractCitation:
        `contract.yaml operations[load_module_from_host_path].errors = [${declaredErrors.join(", ")}]; host_path is presence required and "Absolute, and resolved on the host's filesystem". ` +
        "The empty string is both nothing-is-there and not-a-loadable-module, and the contract does not order not_found against invalid_value, so either conforms and which one a host picks is recorded rather than judged.",
      expected: 'one of [not_found, invalid_value]',
      actual: judgedEmpty.isError
        ? `error ${judgedEmpty.code}: ${judgedEmpty.detail}`
        : `loaded something from the empty path: ${JSON.stringify(judgedEmpty.result)?.slice(0, 200)}`,
      held: judgedEmpty.isError && ["not_found", "invalid_value"].includes(judgedEmpty.code),
    });

    await askTheUnconnectedSession(
      "load_module_from_host_path",
      { host_path: CONFORMANCE_ABSENT_MODULE_HOST_PATHS.windowsAbsolute },
      "load_module_from_host_path for an absent file, asked from a session that has connected no device, is refused with a code from its own subset",
      `contract.yaml operations[load_module_from_host_path].errors = [${declaredErrors.join(", ")}]; "not_connected: no instance, so no module manager to load into. Same condition list_loaded_modules answers not_connected to." Whether a host has an instance before any device is connected is not something the contract settles, so not_connected, not_found and invalid_value are all conforming answers here`,
      `one of [${declaredErrors.join(", ")}]`,
      (judged) => judged.isError && declaredErrors.includes(judged.code),
    );

    ledger.recordNotProvokable({
      capability: "module.load",
      wireMethod: "load_module_from_host_path",
      title: "the success path of load_module_from_host_path was not driven, and neither was the invalid_value that a real non-module file produces",
      contractCitation:
        'contract.yaml operations[load_module_from_host_path]: the row "makes the host process dlopen a file off its own disk and run that file\'s initialisation, which is arbitrary code execution inside the host"; returns = ModuleInfo',
      reason:
        "two reasons, and the second is the harder one. (1) A load is PERMANENT for that host process: the module list, the device types and the function block types all change, and this same run asserts against all three, so a passing load would corrupt the sweep that follows it and every later comparison against that host. (2) The suite addresses a host by URL and knows nothing about its filesystem - a path off the machine running this suite is a path the host may not have - so it has no module file to name and no non-module file it can be sure exists there either. Driving this would need a host that offers a scratch module path over the wire, which contract.yaml does not have.",
    });
  }

  // =========================================================================
  // device.lock - the two-socket part
  // =========================================================================
  console.log("\ndevice.lock: lock_device, unlock_device, across two sessions");
  if (!claimed("device.lock")) {
    await driveGappedOperation(ledger, contract, session, operationOf("lock_device"), discovered, gapsByCapability);
    await driveGappedOperation(ledger, contract, session, operationOf("unlock_device"), discovered, gapsByCapability);
  } else if (!deviceNodeId) {
    for (const wireMethod of ["lock_device", "unlock_device"]) {
      ledger.recordNotProvokable({
        capability: "device.lock",
        wireMethod,
        title: `${wireMethod} could not be driven`,
        contractCitation: `contract.yaml operations[${wireMethod}].params node_id, references Node.id`,
        reason: "connect_device produced no device node id in this session, so there is no device row to lock",
      });
    }
  } else {
    // --- not_found and unsupported, from one session ----------------------
    for (const wireMethod of ["lock_device", "unlock_device"]) {
      await refuseWithOneOf(ledger, contract, session, {
        wireMethod,
        params: { node_id: CONFORMANCE_UNKNOWN_NODE_ID },
        title: `${wireMethod} on the unknown node "${CONFORMANCE_UNKNOWN_NODE_ID}" is refused with not_found`,
        contractCitation: `contract.yaml operations[${wireMethod}].errors = [${operationOf(wireMethod).errors.join(", ")}]`,
        acceptableCodes: ["not_found"],
      });
      await refuseOnANodeThatIsNotADevice(ledger, contract, session, wireMethod, aNodeThatIsNotADevice);
    }

    // --- this session takes the lock --------------------------------------
    const lockResponse = await session.request("lock_device", { node_id: deviceNodeId });
    const judgedLock = judgeResponseEnvelope(ledger, contract, {
      response: lockResponse,
      wireMethod: "lock_device",
      capability: "device.lock",
      capabilityIsClaimed: true,
    });
    ledger.recordClaimedCapabilityAssertion({
      capability: "device.lock",
      wireMethod: "lock_device",
      title: `lock_device ${deviceNodeId} is accepted and returns void`,
      contractCitation: "contract.yaml operations[lock_device].returns = void",
      expected: "a result envelope carrying null",
      actual: judgedLock.isError ? `error ${judgedLock.code}: ${judgedLock.detail}` : `result ${JSON.stringify(judgedLock.result)}`,
      held: !judgedLock.isError && (judgedLock.result === null || judgedLock.result === undefined),
    });
    const thisSessionHoldsTheLock = !judgedLock.isError;

    await assertTheTreeReportsTheLock(ledger, contract, session, {
      deviceNodeId,
      shouldBeLocked: true,
      whenItWasTaken: "after this session's own lock_device",
      claimed,
    });

    // --- the other session, which is not the holder ------------------------
    if (!thisSessionHoldsTheLock) {
      ledger.recordNotProvokable({
        capability: "device.lock",
        wireMethod: "lock_device",
        title: 'the "read_only" refusals a second session must get from a locked device were not driven',
        contractCitation: `contract.yaml operations[lock_device].errors = [${operationOf("lock_device").errors.join(", ")}]`,
        reason: `this session's own lock_device ${deviceNodeId} was refused (${judgedLock.code}: ${judgedLock.detail}), so no lock is held and there is nothing for a second session to be refused by`,
      });
    } else if (secondSession === null) {
      ledger.recordNotProvokable({
        capability: "device.lock",
        wireMethod: "lock_device",
        title: 'the "read_only" refusals a second session must get from a locked device were not driven',
        contractCitation: `contract.yaml operations[lock_device].errors: "read_only is the device is already locked, and not by this session"`,
        reason: `a second WebSocket to ${options.url} could not be opened, and read_only by definition needs a client that is not the lock holder: ${whyThereIsNoSecondSession}`,
      });
    } else {
      const secondSessionDeviceNodeId = await connectTheSecondSession(secondSession, discovered.connectionString);
      console.log(
        `the second session connected "${discovered.connectionString}" and got device node ${JSON.stringify(secondSessionDeviceNodeId)}; ` +
          `the first session holds the lock on ${deviceNodeId}`,
      );
      if (secondSessionDeviceNodeId !== deviceNodeId) {
        ledger.recordNotProvokable({
          capability: "device.lock",
          wireMethod: "lock_device",
          title: 'the "read_only" refusals a second session must get from a locked device were not driven',
          contractCitation: `contract.yaml operations[lock_device].errors: "read_only is the device is already locked, and not by this session"`,
          reason: `the second session does not hold the same device row: connect_device "${discovered.connectionString}" on it produced ${JSON.stringify(secondSessionDeviceNodeId)} while the first session holds "${deviceNodeId}", so a refusal from it would be about a different node, not about the lock`,
        });
      } else {
        await assertTheTreeReportsTheLock(ledger, contract, secondSession, {
          deviceNodeId,
          shouldBeLocked: true,
          whenItWasTaken: "as the OTHER session sees it, while this run's first session holds the lock",
          claimed,
        });

        // A write from the session that does not hold the lock.
        await assertALockedDeviceRefusesAWriteFromElsewhere(ledger, contract, secondSession, {
          deviceNodeId,
          discovered,
          claimed,
        });

        // The mode change from the session that does not hold the lock.
        if (claimed("device.mode") && discovered.anOperationModeOtherThanTheOneInForce) {
          const judgedModeChange = await refuseWithOneOf(ledger, contract, secondSession, {
            wireMethod: "set_device_operation_mode",
            params: { node_id: deviceNodeId, mode: discovered.anOperationModeOtherThanTheOneInForce },
            title: `set_device_operation_mode from a session that does not hold the lock on ${deviceNodeId} is refused with read_only`,
            contractCitation:
              'contract.yaml operations[set_device_operation_mode].errors: "read_only: the device is locked - the closed error set\'s expression of openDAQ refused the write because the component is protected, the same code set_property_value already uses for a locked target"',
            acceptableCodes: ["read_only"],
            capability: "device.lock",
          });
          if (!judgedModeChange.isError && discovered.operationModeTheDeviceWasFoundIn !== null) {
            // The host moved the device instead of refusing. Move it back from
            // the session that does hold the lock, before anything downstream -
            // a subscription waiting for sample frames, most of all - meets a
            // device this sweep left in another mode.
            const restored = await session.request("set_device_operation_mode", {
              node_id: deviceNodeId,
              mode: discovered.operationModeTheDeviceWasFoundIn,
            });
            console.log(
              `that mode change was ACCEPTED from the session that does not hold the lock, so ${deviceNodeId} was moved back to ` +
                `"${discovered.operationModeTheDeviceWasFoundIn}" from the holder's session: the host ${describeAnswer(restored)}`,
            );
          }
        }

        await refuseWithOneOf(ledger, contract, secondSession, {
          wireMethod: "lock_device",
          params: { node_id: deviceNodeId },
          title: `lock_device from a second session, on a device this run's first session already locked, is refused with read_only`,
          contractCitation:
            'contract.yaml operations[lock_device].errors: "read_only is the device is already locked, and not by this session - openDAQ permits an unlock only by the user who locked it"',
          acceptableCodes: ["read_only"],
        });

        await refuseWithOneOf(ledger, contract, secondSession, {
          wireMethod: "unlock_device",
          params: { node_id: deviceNodeId },
          title: `unlock_device from a second session, on a device this run's first session locked, is refused with read_only`,
          contractCitation:
            'contract.yaml operations[unlock_device]: "IDevice.unlock() takes no arguments and refuses when another user holds the lock"; errors: "read_only is the refusal the reference reacts to by offering the forced unlock, so it is the exact signal that enables that control"',
          acceptableCodes: ["read_only"],
        });

        // The optional force parameter, which is the control that refusal enables.
        const forcedResponse = await secondSession.request("unlock_device", { node_id: deviceNodeId, force: true });
        const judgedForced = judgeResponseEnvelope(ledger, contract, {
          response: forcedResponse,
          wireMethod: "unlock_device",
          capability: "device.lock",
          capabilityIsClaimed: true,
          describedAs: "force true, from the session that does not hold the lock",
        });
        ledger.recordClaimedCapabilityAssertion({
          capability: "device.lock",
          wireMethod: "unlock_device",
          title: `unlock_device force true, from the session that does not hold the lock, either takes the lock or answers unsupported`,
          contractCitation:
            'contract.yaml operations[unlock_device].params force, presence optional: "the reference then offers a forced unlock, which is IDevicePrivate.force_unlock() - a different interface, reached by a cast"; errors: "unsupported covers both not a device and force: true on a host that cannot reach IDevicePrivate"',
          expected: 'a result envelope carrying null, or error code "unsupported"',
          actual: judgedForced.isError
            ? `error ${judgedForced.code}: ${judgedForced.detail}`
            : `result ${JSON.stringify(judgedForced.result)}`,
          held: judgedForced.isError
            ? judgedForced.code === "unsupported"
            : judgedForced.result === null || judgedForced.result === undefined,
        });
      }
    }

    // --- the holder releases it, and the tree says so ----------------------
    const unlockResponse = await session.request("unlock_device", { node_id: deviceNodeId });
    const judgedUnlock = judgeResponseEnvelope(ledger, contract, {
      response: unlockResponse,
      wireMethod: "unlock_device",
      capability: "device.lock",
      capabilityIsClaimed: true,
    });
    ledger.recordClaimedCapabilityAssertion({
      capability: "device.lock",
      wireMethod: "unlock_device",
      title: `unlock_device ${deviceNodeId} by the session that locked it is accepted and returns void`,
      contractCitation: "contract.yaml operations[unlock_device].returns = void",
      expected: "a result envelope carrying null",
      actual: judgedUnlock.isError ? `error ${judgedUnlock.code}: ${judgedUnlock.detail}` : `result ${JSON.stringify(judgedUnlock.result)}`,
      held: !judgedUnlock.isError && (judgedUnlock.result === null || judgedUnlock.result === undefined),
    });
    await assertTheTreeReportsTheLock(ledger, contract, session, {
      deviceNodeId,
      shouldBeLocked: false,
      whenItWasTaken: "after the holder's unlock_device, which is how this sweep leaves the device",
      claimed,
    });
  }

  if (secondSession !== null) {
    secondSession.close();
    console.log(`\nclosed the second WebSocket to ${options.url}; it sent ${[...secondSession.requestsSentByWireMethod.values()].reduce((a, b) => a + b, 0)} request(s)`);
  }
  return { sessionsOpenedByThisSweep };
}

// ---------------------------------------------------------------------------
// the small shapes the sections above share
// ---------------------------------------------------------------------------

/** Sends one request that must be refused, and records which code came back. */
export async function refuseWithOneOf(ledger, contract, session, { wireMethod, params, title, contractCitation, acceptableCodes, capability = null }) {
  const operation = contract.operationsByWireMethod.get(wireMethod);
  const response = await session.request(wireMethod, params);
  const judged = judgeResponseEnvelope(ledger, contract, {
    response,
    wireMethod,
    capability: operation.capability,
    capabilityIsClaimed: true,
    describedAs: JSON.stringify(params).slice(0, 120),
  });
  ledger.recordClaimedCapabilityAssertion({
    capability: capability ?? operation.capability,
    wireMethod,
    title,
    contractCitation,
    expected: acceptableCodes.length === 1 ? `error code "${acceptableCodes[0]}"` : `one of [${acceptableCodes.join(", ")}]`,
    actual: judged.isError
      ? `error ${judged.code}: ${judged.detail}`
      : `accepted it, result ${JSON.stringify(judged.result)?.slice(0, 200)}`,
    held: judged.isError && acceptableCodes.includes(judged.code),
  });
  return judged;
}

/**
 * contract.yaml gives all four device-row operations the code unsupported for a
 * node that exists and is not a device: "the node exists, so not_found would be
 * a lie, and it has no operation modes".
 */
async function refuseOnANodeThatIsNotADevice(ledger, contract, session, wireMethod, aNodeThatIsNotADevice, extraParams = {}) {
  const operation = contract.operationsByWireMethod.get(wireMethod);
  if (aNodeThatIsNotADevice === null) {
    ledger.recordNotProvokable({
      capability: operation.capability,
      wireMethod,
      title: `the "unsupported" error code of ${wireMethod} could not be provoked`,
      contractCitation: `contract.yaml operations[${wireMethod}].errors includes unsupported, for a node_id naming a component that is not a device`,
      reason: "the component tree this host returned carried no node of any kind other than device, so there is no existing non-device row to address",
    });
    return null;
  }
  return await refuseWithOneOf(ledger, contract, session, {
    wireMethod,
    params: { node_id: aNodeThatIsNotADevice.id, ...extraParams },
    title: `${wireMethod} on ${aNodeThatIsNotADevice.id}, a node of kind ${aNodeThatIsNotADevice.kind} and not a device, is refused with unsupported`,
    contractCitation: `contract.yaml operations[${wireMethod}].errors = [${operation.errors.join(", ")}]; "unsupported is node_id naming a component that is not a device: the node exists, so not_found would be a lie"`,
    acceptableCodes: ["unsupported"],
  });
}

/** Reads the tree on one session and judges the device row's Node.locked. */
async function assertTheTreeReportsTheLock(ledger, contract, session, { deviceNodeId, shouldBeLocked, whenItWasTaken, claimed }) {
  if (!claimed("tree.read")) {
    ledger.recordNotProvokable({
      capability: "device.lock",
      wireMethod: "lock_device",
      title: `whether Node.locked is ${shouldBeLocked} ${whenItWasTaken} could not be read`,
      contractCitation: "contract.yaml types.Node.locked carries the effective lock state",
      reason: "this host declared tree.read a gap, so there is no tree to read the lock state out of",
    });
    return;
  }
  const response = await session.request("get_component_tree", {});
  const row = Array.isArray(response.result) ? response.result.find((node) => node.id === deviceNodeId) : null;
  const reported = row === null || row === undefined ? undefined : row.locked;
  if (reported === null) {
    // contract.yaml: every state field is nullable, and null means "this host
    // does not report it". A host that reports nothing cannot be failed for it.
    ledger.recordUnconstrained({
      title: `Node.locked on ${deviceNodeId} ${whenItWasTaken}`,
      contractCitation:
        'contract.yaml types.Node: "Every state field is nullable, and null means this host does not report it, which the client draws as no suffix and no colour. A host that cannot determine a field writes null rather than guessing a value."',
      reason: "null is the contract's own way for a host to say it does not report the lock state, so it is neither a gap nor a breach",
      observation: `this host reports Node.locked null on ${deviceNodeId}; the sweep expected ${shouldBeLocked} there`,
    });
    return;
  }
  ledger.recordClaimedCapabilityAssertion({
    capability: "device.lock",
    wireMethod: shouldBeLocked ? "lock_device" : "unlock_device",
    title: `get_component_tree reports Node.locked ${shouldBeLocked} on ${deviceNodeId} ${whenItWasTaken}`,
    contractCitation:
      'contract.yaml types.Node.locked: "The EFFECTIVE lock state, inheritance already applied host-side: a device reports its own IDevice.locked". lock_device and unlock_device are "the actions behind the lock and unlock icons the tree already ships", so a lock the tree does not show leaves the icon wrong.',
    expected: `Node.locked === ${shouldBeLocked}`,
    actual:
      row === null || row === undefined
        ? `${deviceNodeId} is not in the tree that came back: ${JSON.stringify(response.error ?? response.result)?.slice(0, 200)}`
        : `Node.locked ${JSON.stringify(reported)}`,
    held: reported === shouldBeLocked,
  });
}

/**
 * A write from the session that does NOT hold the lock. contract.yaml states the
 * refusal twice: types.Node.locked is what greys a locked subtree, and
 * operations[set_device_operation_mode].errors calls read_only "the same code
 * set_property_value already uses for a locked target".
 */
async function assertALockedDeviceRefusesAWriteFromElsewhere(ledger, contract, session, { deviceNodeId, discovered, claimed }) {
  if (!claimed("property.write")) {
    ledger.recordNotProvokable({
      capability: "device.lock",
      wireMethod: "lock_device",
      title: "whether a locked device refuses a property write from another session could not be driven",
      contractCitation: 'contract.yaml operations[set_device_operation_mode].errors: read_only is "the same code set_property_value already uses for a locked target"',
      reason: "this host declared property.write a gap, so there is no write to be refused",
    });
    return;
  }
  const writable = (discovered.readableProperties ?? []).find(
    (row) =>
      row.descriptor.read_only === false &&
      (row.descriptor.value_type === "bool" || row.descriptor.value_type === "int" || row.descriptor.value_type === "float") &&
      (row.nodeId === deviceNodeId || row.nodeId.startsWith(`${deviceNodeId}/`)),
  );
  if (!writable) {
    ledger.recordNotProvokable({
      capability: "device.lock",
      wireMethod: "lock_device",
      title: "whether a locked device refuses a property write from another session could not be driven",
      contractCitation: 'contract.yaml operations[set_device_operation_mode].errors: read_only is "the same code set_property_value already uses for a locked target"',
      reason: `no descriptor under ${deviceNodeId} was both read_only=false and of value_type bool, int or float, so there is no write this sweep may make blind`,
    });
    return;
  }
  const submitted = writable.descriptor.value_type === "bool" ? !writable.value : Number(writable.value) + 1;
  const response = await session.request("set_property_value", {
    node_id: writable.nodeId,
    property_id: writable.descriptor.id,
    value: submitted,
  });
  const judged = judgeResponseEnvelope(ledger, contract, {
    response,
    wireMethod: "set_property_value",
    capability: "property.write",
    capabilityIsClaimed: true,
    describedAs: `${writable.nodeId}.${writable.descriptor.id} from a session that does not hold the lock`,
  });
  ledger.recordClaimedCapabilityAssertion({
    capability: "device.lock",
    wireMethod: "set_property_value",
    title: `set_property_value ${writable.nodeId}.${writable.descriptor.id}, from a session that does not hold the lock on ${deviceNodeId}, is refused with read_only`,
    contractCitation:
      'contract.yaml operations[set_device_operation_mode].errors names read_only "the closed error set\'s expression of openDAQ refused the write because the component is protected, the same code set_property_value already uses for a locked target"; types.Node.locked is the EFFECTIVE state, "any other component reports the nearest ancestor device\'s", so a property under a locked device is a locked target',
    expected: 'error code "read_only"',
    actual: judged.isError
      ? `error ${judged.code}: ${judged.detail}`
      : `the write of ${JSON.stringify(submitted)} was ACCEPTED while another session held the lock, result ${JSON.stringify(judged.result)}`,
    held: judged.isError && judged.code === "read_only",
  });

  if (!judged.isError) {
    // The host took the write. Put the property back before anything else reads it.
    const restored = await session.request("set_property_value", {
      node_id: writable.nodeId,
      property_id: writable.descriptor.id,
      value: writable.value,
    });
    console.log(
      `the locked device accepted that write, so ${writable.nodeId}.${writable.descriptor.id} was restored to ` +
        `${JSON.stringify(writable.value)}: the host ${describeAnswer(restored)}`,
    );
  }
}

/** Connects the second session to the same device, and returns its node id. */
async function connectTheSecondSession(secondSession, connectionString) {
  try {
    const connected = await secondSession.request("connect_device", { connection_string: connectionString });
    return connected.result && typeof connected.result.id === "string" ? connected.result.id : null;
  } catch {
    return null;
  }
}
