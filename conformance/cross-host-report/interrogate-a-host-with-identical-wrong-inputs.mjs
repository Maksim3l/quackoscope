// Sends every host the SAME wrong input and writes down the error code each one
// answers with.
//
// This is the column the cross-host report exists for. The conformance suite
// already decides whether a host is conformant; it cannot tell you that four
// hosts, all conformant, all built against the same openDAQ commit, answer the
// same malformed request with four different codes. That divergence is where
// bindings really differ, and the only way to see it is to put the identical
// bytes on every socket and record what comes back.
//
// Rules this module holds itself to:
//
//   1. Every case in `identicalWrongInputCases()` carries params that are
//      literally identical on every host: sentinel node ids, sentinel property
//      ids, a sentinel connection string, an unparseable subscription id, a
//      method name no contract declares. Nothing is discovered per host, so a
//      difference in the answer is a difference in the host.
//   2. The two cases that CANNOT be host-independent - a pixel_columns range
//      test needs a signal that exists - are kept in a separate list, marked
//      paramsAreIdenticalAcrossHosts: false, and the report prints the exact
//      params each host was sent.
//   3. Nothing here reads implementation.name. Which capability a host declared
//      comes from its own handshake, and a refusal of an operation whose
//      capability the host declared a gap is labelled as a gap refusal, so a
//      declared gap is never read as an error-code divergence.
//   4. The per-operation error subset comes from contract.yaml at run time, via
//      contract.operationsByWireMethod; no error code is written down here.

import { openWireSession } from "../wire/open-wire-session.mjs";

// Sentinels chosen so that no real openDAQ component, property, function block
// type or connection string can collide with them.
export const WRONG_INPUT_SENTINELS = {
  unknownNodeId: "/quackoscope-cross-host-report/no-such-node",
  unknownPropertyId: "QuackoscopeCrossHostReportNoSuchProperty",
  unknownFunctionBlockTypeId: "quackoscope-cross-host-report-no-such-function-block-type",
  unknownConnectionString: "quackoscope-cross-host-report://no-such-device",
  unparseableSubscriptionId: "not-a-subscription-id",
  unknownSubscriptionId: "4294967295",
  methodNoContractDeclares: "quackoscope_cross_host_report_unknown_method",
  unknownOperationMode: "quackoscope-cross-host-report-no-such-operation-mode",
  // Two spellings of one absent module file. load_module_from_host_path resolves
  // its path on the HOST's filesystem, and exactly one of these is an absolute
  // path on any given platform, so which of the two a host treats as absolute -
  // and what it answers to the other - is itself one of the divergences this
  // table exists to show.
  absentModulePathSpelledForPosix: "/quackoscope-cross-host-report/no-such-directory/no-such-module.module.dll",
  absentModulePathSpelledForWindows: "C:/quackoscope-cross-host-report/no-such-directory/no-such-module.module.dll",
};

const CONNECTION_STRING_WHEN_A_HOST_SERVES_NO_SCAN = "daqref://device0";

/**
 * The cases whose request params are byte-for-byte identical on every host.
 *
 * `phase` says whether the case is asked before this session has connected any
 * device or after, because "no device is connected" is itself part of the input
 * and must be the same on every host for the answers to be comparable.
 */
export function identicalWrongInputCases() {
  const { unknownNodeId, unknownPropertyId, unknownFunctionBlockTypeId } = WRONG_INPUT_SENTINELS;
  const { unknownConnectionString, unparseableSubscriptionId, unknownSubscriptionId, methodNoContractDeclares } =
    WRONG_INPUT_SENTINELS;
  const { unknownOperationMode, absentModulePathSpelledForPosix, absentModulePathSpelledForWindows } = WRONG_INPUT_SENTINELS;
  return [
    {
      id: "get_component_tree_with_no_device_connected",
      phase: "before_this_session_connected_any_device",
      wireMethod: "get_component_tree",
      params: {},
      wrongInputInWords: "the component tree, on a session that has connected no device",
    },
    {
      id: "list_function_block_types_with_no_device_connected",
      phase: "before_this_session_connected_any_device",
      wireMethod: "list_function_block_types",
      params: {},
      wrongInputInWords: "the function block types, on a session that has connected no device",
    },
    {
      id: "get_property_value_unknown_node_and_property_with_no_device_connected",
      phase: "before_this_session_connected_any_device",
      wireMethod: "get_property_value",
      params: { node_id: unknownNodeId, property_id: unknownPropertyId },
      wrongInputInWords: "an unknown property on an unknown node, with no device connected: not_found and not_connected are both true of it",
    },
    {
      id: "subscribe_signal_unknown_signal_with_no_device_connected",
      phase: "before_this_session_connected_any_device",
      wireMethod: "subscribe_signal",
      params: { signal_id: unknownNodeId, pixel_columns: 64 },
      wrongInputInWords: "a subscription to an unknown signal, with no device connected",
    },

    // The four device-row and module operations, asked before any device is
    // connected. contract.yaml gives get_device_operation_modes both not_found
    // and not_connected and never says which a node id belongs to in this state;
    // it gives list_loaded_modules not_connected but calls the module list a
    // fact about the host PROCESS; and it gives load_module_from_host_path four
    // codes at once for a path that is absent on a session with no instance.
    // Which of those each binding picks is precisely this table's question.
    {
      id: "get_device_operation_modes_of_an_unknown_node_with_no_device_connected",
      phase: "before_this_session_connected_any_device",
      wireMethod: "get_device_operation_modes",
      params: { node_id: unknownNodeId },
      wrongInputInWords: "the operation modes of an unknown node, with no device connected: not_found and not_connected are both true of it",
    },
    {
      id: "list_loaded_modules_with_no_device_connected",
      phase: "before_this_session_connected_any_device",
      wireMethod: "list_loaded_modules",
      params: {},
      wrongInputInWords: "the loaded module list, on a session that has connected no device",
      contractIsSilentHere:
        "contract.yaml operations[list_loaded_modules].errors includes not_connected, but the row's own comment calls the module list a fact about the host PROCESS - the reference reads instance.module_manager.modules, not a device - so answering the list here is as conformant as refusing not_connected",
    },
    {
      id: "load_module_from_host_path_of_an_absent_file_with_no_device_connected",
      phase: "before_this_session_connected_any_device",
      wireMethod: "load_module_from_host_path",
      params: { host_path: absentModulePathSpelledForWindows },
      wrongInputInWords: `a load of "${absentModulePathSpelledForWindows}", which exists on no host, with no device connected: not_found and not_connected are both true of it`,
    },

    {
      id: "get_component_tree_rooted_at_an_unknown_node",
      phase: "after_this_session_connected_a_device",
      wireMethod: "get_component_tree",
      params: { root_id: unknownNodeId },
      wrongInputInWords: "the component tree rooted at a node that does not exist",
    },
    {
      id: "get_property_descriptors_of_an_unknown_node",
      phase: "after_this_session_connected_a_device",
      wireMethod: "get_property_descriptors",
      params: { node_id: unknownNodeId },
      wrongInputInWords: "the property descriptors of a node that does not exist",
    },
    {
      id: "get_property_value_of_an_unknown_property_on_an_unknown_node",
      phase: "after_this_session_connected_a_device",
      wireMethod: "get_property_value",
      params: { node_id: unknownNodeId, property_id: unknownPropertyId },
      wrongInputInWords: "the value of an unknown property on an unknown node",
    },
    {
      id: "set_property_value_of_an_unknown_property_on_an_unknown_node",
      phase: "after_this_session_connected_a_device",
      wireMethod: "set_property_value",
      params: { node_id: unknownNodeId, property_id: unknownPropertyId, value: 1 },
      wrongInputInWords: "a write of 1 to an unknown property on an unknown node",
    },
    {
      id: "add_function_block_of_an_unknown_type_under_an_unknown_parent",
      phase: "after_this_session_connected_a_device",
      wireMethod: "add_function_block",
      params: { parent_id: unknownNodeId, type_id: unknownFunctionBlockTypeId },
      wrongInputInWords: "a function block of an unknown type, under a parent that does not exist",
    },
    {
      id: "remove_function_block_that_does_not_exist",
      phase: "after_this_session_connected_a_device",
      wireMethod: "remove_function_block",
      params: { node_id: unknownNodeId },
      wrongInputInWords: "the removal of a function block node that does not exist",
    },
    {
      id: "subscribe_signal_that_does_not_exist",
      phase: "after_this_session_connected_a_device",
      wireMethod: "subscribe_signal",
      params: { signal_id: unknownNodeId, pixel_columns: 64 },
      wrongInputInWords: "a subscription to a signal that does not exist, with a device connected",
    },
    {
      id: "unsubscribe_signal_with_an_unparseable_subscription_id",
      phase: "after_this_session_connected_a_device",
      wireMethod: "unsubscribe_signal",
      params: { subscription_id: unparseableSubscriptionId },
      wrongInputInWords: `an unsubscribe of the subscription id "${unparseableSubscriptionId}", which the contract's subscription_id_encoding cannot parse`,
      contractIsSelfContradictoryHere:
        "contract.yaml subscription_id_encoding.on_unparseable says invalid_value, while operations[unsubscribe_signal].errors is [not_found]; both are cited by the contract and they do not agree",
    },
    {
      id: "unsubscribe_signal_with_a_parseable_but_unknown_subscription_id",
      phase: "after_this_session_connected_a_device",
      wireMethod: "unsubscribe_signal",
      params: { subscription_id: unknownSubscriptionId },
      wrongInputInWords: `an unsubscribe of the subscription id "${unknownSubscriptionId}", which parses but was never handed out`,
    },
    {
      id: "read_samples_raw_from_a_signal_that_does_not_exist",
      phase: "after_this_session_connected_a_device",
      wireMethod: "read_samples_raw",
      params: { signal_id: unknownNodeId, count: 16 },
      wrongInputInWords: "16 raw samples from a signal that does not exist",
    },
    {
      id: "get_device_operation_modes_of_a_node_that_does_not_exist",
      phase: "after_this_session_connected_a_device",
      wireMethod: "get_device_operation_modes",
      params: { node_id: unknownNodeId },
      wrongInputInWords: "the available operation modes of a node that does not exist",
    },
    {
      id: "set_device_operation_mode_to_a_mode_name_outside_the_enum",
      phase: "after_this_session_connected_a_device",
      wireMethod: "set_device_operation_mode",
      params: { node_id: unknownNodeId, mode: unknownOperationMode },
      wrongInputInWords: `a move to the mode "${unknownOperationMode}", which types.Node.operation_mode does not enumerate, on a node that does not exist: not_found and invalid_value are both true of it`,
    },
    {
      id: "lock_device_naming_a_node_that_does_not_exist",
      phase: "after_this_session_connected_a_device",
      wireMethod: "lock_device",
      params: { node_id: unknownNodeId },
      wrongInputInWords: "a lock of a device node that does not exist",
    },
    {
      id: "unlock_device_naming_a_node_that_does_not_exist",
      phase: "after_this_session_connected_a_device",
      wireMethod: "unlock_device",
      params: { node_id: unknownNodeId },
      wrongInputInWords: "an unlock of a device node that does not exist",
    },
    {
      id: "unlock_device_with_force_true_naming_a_node_that_does_not_exist",
      phase: "after_this_session_connected_a_device",
      wireMethod: "unlock_device",
      params: { node_id: unknownNodeId, force: true },
      wrongInputInWords: "a FORCED unlock of a device node that does not exist: the node is absent and the forced path may also be unreachable, and unsupported covers the second while not_found covers the first",
    },
    {
      id: "load_module_from_host_path_spelled_absolute_for_posix",
      phase: "after_this_session_connected_a_device",
      wireMethod: "load_module_from_host_path",
      params: { host_path: absentModulePathSpelledForPosix },
      wrongInputInWords: `a load of "${absentModulePathSpelledForPosix}", a path that is absolute on POSIX and relative on Windows, and names no file on either`,
      contractIsSilentHere:
        'contract.yaml operations[load_module_from_host_path] requires host_path to be "Absolute, and resolved on the host\'s filesystem" but never says what a host does with a path that is not absolute on ITS platform: refusing invalid_value for the spelling and answering not_found for the missing file are both inside the declared subset',
    },
    {
      id: "load_module_from_host_path_spelled_absolute_for_windows",
      phase: "after_this_session_connected_a_device",
      wireMethod: "load_module_from_host_path",
      params: { host_path: absentModulePathSpelledForWindows },
      wrongInputInWords: `a load of "${absentModulePathSpelledForWindows}", a path that is absolute on Windows and relative on POSIX, and names no file on either`,
    },
    {
      id: "load_module_from_host_path_with_the_empty_string",
      phase: "after_this_session_connected_a_device",
      wireMethod: "load_module_from_host_path",
      params: { host_path: "" },
      wrongInputInWords: "a load of the empty path, which is both nothing-is-there and not-a-loadable-module",
    },
    {
      id: "disconnect_device_naming_a_node_that_does_not_exist",
      phase: "after_this_session_connected_a_device",
      wireMethod: "disconnect_device",
      params: { node_id: unknownNodeId },
      wrongInputInWords: "a disconnect of a device node that does not exist",
    },
    {
      id: "connect_device_with_a_connection_string_that_names_nothing",
      phase: "after_this_session_connected_a_device",
      wireMethod: "connect_device",
      params: { connection_string: unknownConnectionString },
      wrongInputInWords: `a connect to "${unknownConnectionString}", a connection string of an unknown scheme naming no device`,
    },
    {
      id: "a_method_name_the_contract_does_not_declare",
      phase: "after_this_session_connected_a_device",
      wireMethod: methodNoContractDeclares,
      params: {},
      methodIsNotInTheContract: true,
      wrongInputInWords: `the method "${methodNoContractDeclares}", which is in no version of the contract`,
    },
  ];
}

/**
 * The cases that cannot be host-independent: a pixel_columns range is only
 * exercisable against a signal that exists, and every host's signal ids are its
 * own. Kept separate, and the report prints the exact params each host was sent.
 */
export function wrongInputCasesNeedingOneIdFromTheHostItself() {
  return [
    {
      id: "subscribe_signal_with_pixel_columns_zero",
      wireMethod: "subscribe_signal",
      paramsFromDiscovery: (discovered) => ({ signal_id: discovered.firstSignalNodeId, pixel_columns: 0 }),
      needs: "firstSignalNodeId",
      wrongInputInWords: "a subscription with pixel_columns 0, to the first signal this host's own component tree offered",
      contractIsSilentHere:
        "contract.yaml operations[subscribe_signal].params.pixel_columns declares no range, and operations[subscribe_signal].errors is [not_found, not_connected], which contains no code for an out-of-range column count",
    },
    {
      id: "subscribe_signal_with_pixel_columns_one_hundred_million",
      wireMethod: "subscribe_signal",
      paramsFromDiscovery: (discovered) => ({ signal_id: discovered.firstSignalNodeId, pixel_columns: 100000000 }),
      needs: "firstSignalNodeId",
      wrongInputInWords: "a subscription with pixel_columns 100000000, to the first signal this host's own component tree offered",
      contractIsSilentHere:
        "contract.yaml operations[subscribe_signal].params.pixel_columns declares no range, so a host that accepts 100000000 and a host that refuses it are both conformant",
    },
  ];
}

function shortenForTheReport(value, characters = 150) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "undefined";
  return text.length > characters ? `${text.slice(0, characters)}...` : text;
}

/**
 * Drives one host and records, per case, the exact answer it gave.
 *
 * Returns one answer record per case:
 *   outcome            "refused" | "answered_with_a_result" | "no_answer" | "not_driven"
 *   errorCode          the code, when it refused
 *   capabilityIsAGapThisHostDeclared
 *                      true when the operation's capability is absent from this
 *                      host's own handshake capabilities, so the refusal is a
 *                      declared-gap refusal and not an error-code choice
 */
export async function interrogateHostWithIdenticalWrongInputs({ url, contract, requestTimeoutMs = 15000, log = () => {} }) {
  const { session, firstMessage } = await openWireSession(url, contract, { requestTimeoutMs });
  const handshake = firstMessage.parsed;
  const declaredCapabilities = new Set(Array.isArray(handshake?.capabilities) ? handshake.capabilities : []);
  const gapsByCapability = new Map(
    (Array.isArray(handshake?.gaps) ? handshake.gaps : []).map((gap) => [gap.capability, gap]),
  );

  const capabilityOfWireMethod = (wireMethod) => contract.operationsByWireMethod.get(wireMethod)?.capability ?? null;
  const contractErrorsOfWireMethod = (wireMethod) => contract.operationsByWireMethod.get(wireMethod)?.errors ?? null;

  const answers = [];
  const discovered = {
    connectionStringUsedToConnect: null,
    connectedDeviceNodeId: null,
    firstSignalNodeId: null,
    aDeviceIsConnectedForTheCasesBelow: false,
  };

  // Wire methods this host answered with a RESULT during this session, whatever
  // its handshake said about them. A host can serve an operation whose capability
  // it declared a gap - hosts/python serves connect_device while declaring
  // device.connect a gap - and when it does, its refusal of a wrong input to that
  // same method is a real error-code choice and belongs in the comparison, not a
  // "this host does not do that at all" that the comparison should step around.
  const wireMethodsThisHostServedEarlierInThisSession = new Set();

  const ask = async (caseRecord, params) => {
    const capability = caseRecord.methodIsNotInTheContract ? null : capabilityOfWireMethod(caseRecord.wireMethod);
    const contractErrors = caseRecord.methodIsNotInTheContract ? null : contractErrorsOfWireMethod(caseRecord.wireMethod);
    const capabilityIsAGap = capability !== null && !declaredCapabilities.has(capability);
    const servedEarlier = wireMethodsThisHostServedEarlierInThisSession.has(caseRecord.wireMethod);

    log(
      `  ${caseRecord.id}\n` +
        `    sending {"method":"${caseRecord.wireMethod}","params":${JSON.stringify(params)}}` +
        `${capability === null ? "  (this method is in no contract operation)" : `  (capability ${capability}: ${capabilityIsAGap ? "a gap this host declared" : "declared by this host"})`}`,
    );

    const answer = {
      caseId: caseRecord.id,
      wireMethod: caseRecord.wireMethod,
      paramsSent: params,
      paramsAreIdenticalAcrossHosts: caseRecord.paramsFromDiscovery === undefined,
      wrongInputInWords: caseRecord.wrongInputInWords,
      phase: caseRecord.phase ?? "after_this_session_connected_a_device",
      sessionHadADeviceConnected: discovered.aDeviceIsConnectedForTheCasesBelow,
      connectedDeviceNodeId: discovered.connectedDeviceNodeId,
      capability,
      capabilityIsAGapThisHostDeclared: capabilityIsAGap,
      hostServedThisWireMethodEarlierInThisSession: servedEarlier,
      refusalIsADeclaredGapRefusal: capabilityIsAGap && !servedEarlier,
      gapKindThisHostDeclared: capabilityIsAGap ? (gapsByCapability.get(capability)?.kind ?? null) : null,
      contractErrorSubsetForThisOperation: contractErrors,
      contractIsSelfContradictoryHere: caseRecord.contractIsSelfContradictoryHere ?? null,
      contractIsSilentHere: caseRecord.contractIsSilentHere ?? null,
      methodIsNotInTheContract: caseRecord.methodIsNotInTheContract === true,
    };

    let response;
    try {
      response = await session.request(caseRecord.wireMethod, params);
    } catch (failure) {
      answer.outcome = "no_answer";
      answer.errorCode = null;
      answer.detail = failure.message;
      log(`    -> no answer: ${failure.message}`);
      answers.push(answer);
      return answer;
    }

    if (response && typeof response === "object" && "error" in response) {
      answer.outcome = "refused";
      answer.errorCode = response.error && typeof response.error === "object" ? (response.error.code ?? null) : null;
      answer.detail = shortenForTheReport(response.error?.detail ?? response.error);
      answer.errorCodeIsInTheClosedSet = contract.errorCodes.includes(answer.errorCode);
      answer.errorCodeIsInThisOperationsSubset =
        contractErrors === null ? null : contractErrors.includes(answer.errorCode);
      log(`    -> refused with "${answer.errorCode}": ${answer.detail}`);
    } else {
      answer.outcome = "answered_with_a_result";
      answer.errorCode = null;
      answer.detail = shortenForTheReport(response?.result);
      log(`    -> answered with a result instead of refusing: ${answer.detail}`);
      // A host that actually accepted a subscription must not be left streaming.
      if (caseRecord.wireMethod === "subscribe_signal" && typeof response?.result === "string") {
        try {
          const undone = await session.request("unsubscribe_signal", { subscription_id: response.result });
          log(`    (undoing it: unsubscribe_signal subscription_id ${response.result} -> ${JSON.stringify(undone.result ?? undone.error)})`);
        } catch (failure) {
          log(`    (could not undo subscription ${response.result}: ${failure.message})`);
        }
      }
    }
    answers.push(answer);
    return answer;
  };

  const recordNotDriven = (caseRecord, params, reason) => {
    const capability = caseRecord.methodIsNotInTheContract ? null : capabilityOfWireMethod(caseRecord.wireMethod);
    log(`  ${caseRecord.id}\n    not driven: ${reason}`);
    answers.push({
      caseId: caseRecord.id,
      wireMethod: caseRecord.wireMethod,
      paramsSent: params,
      paramsAreIdenticalAcrossHosts: caseRecord.paramsFromDiscovery === undefined,
      wrongInputInWords: caseRecord.wrongInputInWords,
      phase: caseRecord.phase ?? "after_this_session_connected_a_device",
      sessionHadADeviceConnected: discovered.aDeviceIsConnectedForTheCasesBelow,
      connectedDeviceNodeId: discovered.connectedDeviceNodeId,
      capability,
      capabilityIsAGapThisHostDeclared: capability !== null && !declaredCapabilities.has(capability),
      hostServedThisWireMethodEarlierInThisSession: wireMethodsThisHostServedEarlierInThisSession.has(caseRecord.wireMethod),
      refusalIsADeclaredGapRefusal:
        capability !== null &&
        !declaredCapabilities.has(capability) &&
        !wireMethodsThisHostServedEarlierInThisSession.has(caseRecord.wireMethod),
      gapKindThisHostDeclared: null,
      contractErrorSubsetForThisOperation: capability === null ? null : contractErrorsOfWireMethod(caseRecord.wireMethod),
      contractIsSelfContradictoryHere: caseRecord.contractIsSelfContradictoryHere ?? null,
      contractIsSilentHere: caseRecord.contractIsSilentHere ?? null,
      methodIsNotInTheContract: caseRecord.methodIsNotInTheContract === true,
      outcome: "not_driven",
      errorCode: null,
      detail: reason,
    });
  };

  const allCases = identicalWrongInputCases();

  // --- the cases whose input includes "no device is connected" ---------------
  log(`  phase 1: with this session having connected no device (${allCases.filter((c) => c.phase === "before_this_session_connected_any_device").length} cases)`);
  for (const caseRecord of allCases.filter((c) => c.phase === "before_this_session_connected_any_device")) {
    await ask(caseRecord, caseRecord.params);
  }

  // --- connect a device, so the rest is asked of a connected session --------
  // The connection string is the ONLY per-host value in this module, and it is
  // never one of the measured inputs: it comes from the host's own scan when it
  // serves one, exactly as the conformance suite does it.
  if (declaredCapabilities.has("device.scan")) {
    try {
      const scan = await session.request("scan_available_devices", {});
      if (Array.isArray(scan.result)) wireMethodsThisHostServedEarlierInThisSession.add("scan_available_devices");
      if (Array.isArray(scan.result) && scan.result.length > 0 && typeof scan.result[0]?.connection_string === "string") {
        const preferred = scan.result.find((row) => row.connection_string === CONNECTION_STRING_WHEN_A_HOST_SERVES_NO_SCAN);
        discovered.connectionStringUsedToConnect = (preferred ?? scan.result[0]).connection_string;
      }
    } catch (failure) {
      log(`  scan_available_devices failed while looking for a connection string: ${failure.message}`);
    }
  }
  if (discovered.connectionStringUsedToConnect === null) {
    discovered.connectionStringUsedToConnect = CONNECTION_STRING_WHEN_A_HOST_SERVES_NO_SCAN;
  }
  // connect_device is ATTEMPTED on every host, whether or not the host declared
  // device.connect. Whether a device is connected is part of the input for every
  // case below, so it must be the same on every host for their answers to be
  // comparable - and a host can serve an operation whose capability it declared
  // a gap (hosts/python does exactly that with connect_device). Deciding not to
  // try, because the handshake said gap, would have left that host answering
  // every later case out of an unconnected session while the others answered out
  // of a connected one, and the report would have shown that state difference as
  // an error-code divergence. Whether the connect actually took is recorded on
  // every answer, and a host whose session holds no device is excluded from the
  // agreement column rather than compared against hosts whose session does.
  log(`  attempting connect_device with connection_string ${discovered.connectionStringUsedToConnect}, on every host and regardless of what its handshake declared, because "is a device connected" is part of the input for every case below`);
  try {
    const connected = await session.request("connect_device", { connection_string: discovered.connectionStringUsedToConnect });
    if (connected.result && typeof connected.result.id === "string") {
      discovered.connectedDeviceNodeId = connected.result.id;
      wireMethodsThisHostServedEarlierInThisSession.add("connect_device");
    }
    log(
      `  connect_device ${discovered.connectionStringUsedToConnect} -> ${discovered.connectedDeviceNodeId ?? `no device connected: ${JSON.stringify(connected.error ?? connected.result)}`}` +
        `${declaredCapabilities.has("device.connect") ? "" : "  (this host declared device.connect a gap; it was asked anyway)"}`,
    );
  } catch (failure) {
    log(`  connect_device ${discovered.connectionStringUsedToConnect} did not answer: ${failure.message}`);
  }
  discovered.aDeviceIsConnectedForTheCasesBelow = discovered.connectedDeviceNodeId !== null;
  if (!discovered.aDeviceIsConnectedForTheCasesBelow) {
    log(`  no device is connected on this host, so every case below is asked of an unconnected session; the report says so and excludes this host from those rows' agreement`);
  }
  try {
    const tree = await session.request("get_component_tree", {});
    if (Array.isArray(tree.result)) {
      wireMethodsThisHostServedEarlierInThisSession.add("get_component_tree");
      const signal = tree.result.find((node) => node?.kind === "signal");
      if (signal) discovered.firstSignalNodeId = signal.id;
    }
    log(`  get_component_tree -> ${Array.isArray(tree.result) ? `${tree.result.length} nodes; first signal ${discovered.firstSignalNodeId ?? "(none)"}` : JSON.stringify(tree.error)}`);
  } catch (failure) {
    log(`  get_component_tree did not answer: ${failure.message}`);
  }

  // --- the cases needing one id from the host itself ------------------------
  for (const caseRecord of wrongInputCasesNeedingOneIdFromTheHostItself()) {
    if (discovered[caseRecord.needs] === null || discovered[caseRecord.needs] === undefined) {
      recordNotDriven(
        caseRecord,
        null,
        `this host offered no ${caseRecord.needs}: its component tree contained no node of kind signal, so there is no signal to subscribe to`,
      );
      continue;
    }
    await ask(caseRecord, caseRecord.paramsFromDiscovery(discovered));
  }

  // --- the remaining identical cases ----------------------------------------
  const afterConnect = allCases.filter((c) => c.phase === "after_this_session_connected_a_device");
  log(`  phase 2: with the session above (${afterConnect.length} cases)`);
  for (const caseRecord of afterConnect) {
    await ask(caseRecord, caseRecord.params);
  }

  session.close();
  return { handshake, handshakeVerbatim: firstMessage.text, declaredCapabilities: [...declaredCapabilities], answers, discovered };
}
