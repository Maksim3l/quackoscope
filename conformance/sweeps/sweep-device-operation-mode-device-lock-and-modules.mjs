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
// A SECOND SOCKET, AND THE ASSERTIONS IT NOW DRIVES ARE THE OPPOSITE OF THE ONES
// IT USED TO. This sweep used to quote two sentences of contract.yaml that have
// since been DELETED from it: lock_device's read_only worded "the device is
// already locked, and not by this session", and unlock_device's "openDAQ permits
// an unlock only by the user who locked it". Both were rules openDAQ does not
// have, so every assertion built on them was demanding a fiction, and the four
// SDK hosts were being marked BROKE for doing exactly what the SDK does.
//
// WHAT openDAQ DOES, which is what the contract now says and what this sweep now
// tests. With no authentication configured - this application's configuration -
// every connection is the one anonymous User("", "") object, and
// UserLockImpl::lock (core/opendaq/device/src/user_lock_impl.cpp:15-27) collapses
// an anonymous user to nullptr before storing it, refusing only when
// `userLock.has_value() && userLock != userPtr` (:22-23). A second anonymous lock
// therefore compares nullptr against nullptr and SUCCEEDS. UserLockImpl::unlock
// (:29-36) refuses only when `userLock.has_value() && userLock != nullptr &&
// userLock != user` (:31-32), and the `!= nullptr` term is why an
// anonymously-taken lock - the only kind these hosts can take - is cleared by ANY
// caller. openDAQ's own test states it: test_device.cpp:400-430,
// LockUnlockAnonymous, locks anonymously and then asserts that unlock(jure) and
// unlock(tomaz), two DIFFERENT users, each succeed.
//
// contract.yaml now says both in as many words. operations[lock_device].errors:
// read_only is reachable only "where authentication names users, so with this
// application's configuration a host will not produce this code and MUST NOT
// SYNTHESISE IT: a second lock of an anonymously-locked device compares nullptr
// against nullptr and succeeds". operations[unlock_device].errors: "this code is
// unreachable here too, and a host must not invent it to keep a second session
// out."
//
// AND A LOCKED DEVICE REFUSES NO WRITE. The lock is enforced in the
// config-protocol SERVER only - ConfigServerAccessControl::protectLockedComponent
// (config_server_access_control.h:75-81) - and never in core:
// GenericPropertyObjectImpl::setPropertyValue consults no lock and
// GenericDevice::setOperationMode (device_impl.h:1257-1281) consults no lock, so
// an in-process write to a property under a locked device SUCCEEDS and an
// in-process operation-mode change on a locked device SUCCEEDS. Every host in
// this repository holds an in-process Instance. contract.yaml states this on
// types.Node.locked ("THIS IS A LABEL, NOT A WRITE REFUSAL"), on
// operations[set_property_value].errors ("A LOCKED ANCESTOR DEVICE IS NOT A
// read_only CAUSE HERE, and a host must not manufacture one") and on
// operations[set_device_operation_mode].errors ("THERE IS NO read_only ON THIS
// ROW, and its removal is the correction of a rule this contract invented").
//
// So the second socket stays, and every assertion it carries is now an assertion
// that the second session is SERVED: it writes a property under the locked
// device, it moves the operation mode, it takes the lock, and it releases it. A
// host that refuses any of those is layering a rule openDAQ does not have, and
// the snippet the quack shows would then be openDAQ calls that do not produce
// what the user just saw. The socket is closed again before this sweep returns,
// and the session is handed back so the coverage guard can count its requests.
//
// A DEVICE LEFT AS IT WAS FOUND. The operation mode is moved and moved back, by
// both sessions; the lock is taken and released and the device is left unlocked;
// every property this sweep writes is read first and written back after.  Nothing
// this sweep does may change what the next sweep, or the next host comparison,
// sees.
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
        "It is the client that did NOT take the lock, which is the only client from which openDAQ's actual lock behaviour can be " +
        "observed: user_lock_impl.cpp:22-23 and :31-32 make an anonymously-taken lock takeable and releasable by anyone, and " +
        "config_server_access_control.h:75-81 is the only place a lock refuses a write, which is a path no in-process host is on.",
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

    // --- not_found and unsupported on the write path -----------------------
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

    // --- the two out-of-range modes, WHERE THE CONTRACT AND openDAQ DISAGREE --
    //
    // contract.yaml operations[set_device_operation_mode].errors says
    // "invalid_value: a mode name outside Node.operation_mode's values, or one
    // the device did not list as available". openDAQ answers neither of those
    // inputs with a refusal, and this sweep therefore ASSERTS NEITHER SIDE. It
    // drives both inputs, asserts the one thing both readings agree on - that
    // the device does not move - and records what the host answered as a
    // disagreement for whoever owns contract.yaml to settle.
    //
    // Why openDAQ refuses neither, in its own source and in this order:
    //
    //   1. THE STRING NEVER FAILS TO CONVERT. OperationModeTypeFromString
    //      (core/opendaq/component/include/opendaq/component_factory.h:55-64) is
    //      three string comparisons and then `return OperationModeType::Unknown`
    //      for everything else. There is no error return and no throw, so a mode
    //      name outside the enum becomes Unknown rather than becoming a refusal.
    //   2. AND AN UNAVAILABLE MODE IS IGNORED, NOT REFUSED.
    //      GenericDevice::setOperationMode (device_impl.h:1257-1260) opens with
    //          if (this->onGetAvailableOperationModes().count(modeType) == 0)
    //              return OPENDAQ_IGNORED;
    //      and OPENDAQ_IGNORED is 0x00000006u (coretypes/errors.h:39), whose top
    //      bit is clear, so OPENDAQ_SUCCEEDED (errors.h:29) is true of it: it is
    //      a SUCCESS that changes nothing and raises nothing. Nothing downstream
    //      can turn it into an exception, because nothing failed.
    //
    // Together those two make BOTH halves of the contract's sentence inputs that
    // an openDAQ-faithful host answers with success. A host whose binding maps
    // the wire string to an enum itself, rather than through
    // OperationModeTypeFromString, will genuinely fail that mapping and answer
    // invalid_value - which is the contract's answer, honestly produced by a
    // different binding. Neither host is wrong about openDAQ; the contract's row
    // and the SDK are what disagree, and a suite that asserted either code would
    // fail every host on the other side of a question the contract has not
    // settled.
    //
    // WHAT IS STILL ASSERTED, and it is a real class (b) check: the device must
    // be in the same operation mode afterwards. OPENDAQ_IGNORED changes nothing
    // and a refusal changes nothing, so a host that MOVED the device on one of
    // these inputs is doing something neither reading permits.
    const readTheOperationModeOffTheTree = async () => {
      if (!claimed("tree.read")) return { readable: false, mode: null, whyNot: "this host declared tree.read a gap, so there is no Node.operation_mode to read" };
      const tree = await session.request("get_component_tree", {});
      const row = Array.isArray(tree.result) ? tree.result.find((node) => node.id === deviceNodeId) : null;
      if (row === null || row === undefined) {
        return {
          readable: false,
          mode: null,
          whyNot: `${deviceNodeId} is not in the tree that came back: ${JSON.stringify(tree.error ?? tree.result)?.slice(0, 200)}`,
        };
      }
      return { readable: true, mode: row.operation_mode ?? null, whyNot: null };
    };

    const driveAnOutOfRangeOperationMode = async (mode, whyItIsOutOfRange) => {
      // Read the mode the device is in RIGHT NOW rather than assuming it is the
      // one this sweep found it in: the write path above restores modeBefore
      // only when the device lists it as available, and prints when it cannot.
      const before = await readTheOperationModeOffTheTree();
      const response = await session.request("set_device_operation_mode", { node_id: deviceNodeId, mode });
      const judged = judgeResponseEnvelope(ledger, contract, {
        response,
        wireMethod: "set_device_operation_mode",
        capability: "device.mode",
        capabilityIsClaimed: true,
        describedAs: `mode ${JSON.stringify(mode)}, ${whyItIsOutOfRange}`,
      });

      const after = await readTheOperationModeOffTheTree();
      let howTheModeWasRead = before.readable
        ? `Node.operation_mode was ${JSON.stringify(before.mode)} before the request and ${after.readable ? JSON.stringify(after.mode) : `unreadable after it (${after.whyNot})`}`
        : `the mode could not be compared: ${before.whyNot}`;
      if (before.readable && after.readable) {
        ledger.recordClaimedCapabilityAssertion({
          capability: "device.mode",
          wireMethod: "set_device_operation_mode",
          title: `set_device_operation_mode ${deviceNodeId} = ${JSON.stringify(mode)} leaves the device in the mode it was already in`,
          contractCitation:
            "the one thing contract.yaml and openDAQ agree on for this input. contract.yaml operations[set_device_operation_mode].errors makes it " +
            '"invalid_value", and a refused setter writes nothing; GenericDevice::setOperationMode (device_impl.h:1257-1260) returns OPENDAQ_IGNORED ' +
            "before it takes the tree lock guard or calls updateOperationModeInternal, so nothing is written on that path either. Under BOTH readings " +
            "the device stands still.",
          expected: `Node.operation_mode still ${JSON.stringify(before.mode)}, the value it carried one request earlier`,
          actual: `Node.operation_mode ${JSON.stringify(after.mode)}${judged.isError ? ` (the host refused the request: ${judged.code})` : " (the host accepted the request)"}`,
          held: after.mode === before.mode,
        });
        if (after.mode !== before.mode) {
          const restored = await session.request("set_device_operation_mode", { node_id: deviceNodeId, mode: before.mode });
          howTheModeWasRead +=
            `, so this host MOVED the device on an out-of-range mode; it was put back to ${JSON.stringify(before.mode)}: ` +
            `the host ${describeAnswer(restored)}`;
        }
      }

      console.log(
        `set_device_operation_mode ${deviceNodeId} = ${JSON.stringify(mode)} (${whyItIsOutOfRange}) -> ${describeAnswer(response)}; ${howTheModeWasRead}`,
      );
      ledger.recordUnconstrained({
        title: `which answer set_device_operation_mode gives to ${JSON.stringify(mode)}, ${whyItIsOutOfRange}`,
        contractCitation:
          'contract.yaml operations[set_device_operation_mode].errors: "invalid_value: a mode name outside Node.operation_mode\'s values, or one the ' +
          'device did not list as available" - AGAINST openDAQ, which refuses neither: OperationModeTypeFromString ' +
          "(core/opendaq/component/include/opendaq/component_factory.h:55-64) returns OperationModeType::Unknown for any unrecognised string rather " +
          "than failing, and GenericDevice::setOperationMode (core/opendaq/device/include/opendaq/device_impl.h:1257-1260) is " +
          '"if (this->onGetAvailableOperationModes().count(modeType) == 0) return OPENDAQ_IGNORED;", where OPENDAQ_IGNORED is 0x00000006u ' +
          "(core/coretypes/include/coretypes/errors.h:39) and OPENDAQ_SUCCEEDED(x) is !((x) & 0x80000000u) (errors.h:29) - a SUCCESS",
        reason:
          "the contract's row and the SDK give different answers to this exact input and no host can satisfy both: invalid_value is what the row " +
          "declares and is a refusal openDAQ never makes, while a success envelope is what openDAQ produces and is outside the row as written. Which " +
          "of the two a host lands on follows from whether its binding maps the wire string to the enum itself or hands it to " +
          "OperationModeTypeFromString, so both are honest reports of the same SDK. This suite reports the disagreement to whoever owns contract.yaml " +
          "instead of failing half the hosts for it; what it does assert is the assertion above, that the device did not move",
        observation:
          `${deviceNodeId} lists [${availableModes.join(", ")}] as available and types.Node.operation_mode enumerates ` +
          `[${operationModeValues.join(", ")}]; sent mode ${JSON.stringify(mode)} and the host ${describeAnswer(response)}; ${howTheModeWasRead}`,
      });
      return judged;
    };

    await driveAnOutOfRangeOperationMode(
      CONFORMANCE_UNKNOWN_OPERATION_MODE,
      "a name types.Node.operation_mode does not enumerate at all",
    );

    const aModeInTheEnumThisDeviceDidNotList = operationModeValues.find((mode) => !availableModes.includes(mode)) ?? null;
    if (aModeInTheEnumThisDeviceDidNotList === null) {
      ledger.recordNotProvokable({
        capability: "device.mode",
        wireMethod: "set_device_operation_mode",
        title: "a mode that is inside types.Node.operation_mode and outside this device's available list could not be sent",
        contractCitation:
          'contract.yaml operations[set_device_operation_mode].errors: "invalid_value: a mode name outside Node.operation_mode\'s values, or one the device did not list as available"',
        reason:
          `${deviceNodeId} lists every value of types.Node.operation_mode as available ([${availableModes.join(", ")}] against the enum ` +
          `[${operationModeValues.join(", ")}]), so there is no in-enum mode this device has not offered, and the second half of that sentence has no input`,
      });
    } else {
      await driveAnOutOfRangeOperationMode(
        aModeInTheEnumThisDeviceDidNotList,
        `a name types.Node.operation_mode does enumerate and get_device_operation_modes did not return for ${deviceNodeId}`,
      );
    }
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

    // --- the other session, which did not take the lock --------------------
    if (!thisSessionHoldsTheLock) {
      ledger.recordNotProvokable({
        capability: "device.lock",
        wireMethod: "lock_device",
        title: "what a second session may do to a device this session locked was not driven",
        contractCitation: `contract.yaml operations[lock_device].errors = [${operationOf("lock_device").errors.join(", ")}]`,
        reason: `this session's own lock_device ${deviceNodeId} was refused (${judgedLock.code}: ${judgedLock.detail}), so no lock is held and there is no locked device for a second session to act on`,
      });
    } else if (secondSession === null) {
      ledger.recordNotProvokable({
        capability: "device.lock",
        wireMethod: "lock_device",
        title: "what a second session may do to a device this session locked was not driven",
        contractCitation:
          'contract.yaml operations[lock_device].errors: read_only is reachable only "where authentication names users, so with this application\'s ' +
          'configuration a host will not produce this code and MUST NOT SYNTHESISE IT: a second lock of an anonymously-locked device compares nullptr ' +
          'against nullptr and succeeds"',
        reason: `a second WebSocket to ${options.url} could not be opened, and these assertions by definition need a client that did not take the lock: ${whyThereIsNoSecondSession}`,
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
          title: "what a second session may do to a device this session locked was not driven",
          contractCitation:
            'contract.yaml operations[lock_device].errors: read_only "a host will not produce this code and MUST NOT SYNTHESISE IT: a second lock of an ' +
            'anonymously-locked device compares nullptr against nullptr and succeeds"',
          reason: `the second session does not hold the same device row: connect_device "${discovered.connectionString}" on it produced ${JSON.stringify(secondSessionDeviceNodeId)} while the first session holds "${deviceNodeId}", so anything it was answered would be about a different node, not about the lock`,
        });
      } else {
        await assertTheTreeReportsTheLock(ledger, contract, secondSession, {
          deviceNodeId,
          shouldBeLocked: true,
          whenItWasTaken: "as the OTHER session sees it, while this run's first session holds the lock",
          claimed,
        });

        // A property write from the session that did not take the lock, which
        // openDAQ SERVES.
        await assertALockedDeviceStillAcceptsAWriteFromElsewhere(ledger, contract, secondSession, {
          deviceNodeId,
          discovered,
          claimed,
        });

        // The operation-mode change from the session that did not take the lock,
        // which openDAQ also serves: GenericDevice::setOperationMode consults no
        // lock at all.
        if (!claimed("device.mode")) {
          ledger.recordNotProvokable({
            capability: "device.lock",
            wireMethod: "set_device_operation_mode",
            title: `whether a locked ${deviceNodeId} still accepts an operation-mode change from another session could not be driven`,
            contractCitation:
              'contract.yaml operations[set_device_operation_mode].errors: "THERE IS NO read_only ON THIS ROW ... GenericDevice::setOperationMode (device_impl.h:1257-1281) consults no lock at all"',
            reason: "this host declared device.mode a gap, so there is no mode change to be served or refused",
          });
        } else if (!discovered.anOperationModeOtherThanTheOneInForce) {
          ledger.recordNotProvokable({
            capability: "device.lock",
            wireMethod: "set_device_operation_mode",
            title: `whether a locked ${deviceNodeId} still accepts an operation-mode change from another session could not be driven`,
            contractCitation:
              'contract.yaml operations[set_device_operation_mode].errors: "THERE IS NO read_only ON THIS ROW ... GenericDevice::setOperationMode (device_impl.h:1257-1281) consults no lock at all"',
            reason: `get_device_operation_modes offered ${deviceNodeId} no mode other than the one it is already in, so there is no change to make that would prove anything`,
          });
        } else {
          const modeChangeResponse = await secondSession.request("set_device_operation_mode", {
            node_id: deviceNodeId,
            mode: discovered.anOperationModeOtherThanTheOneInForce,
          });
          const judgedModeChange = judgeResponseEnvelope(ledger, contract, {
            response: modeChangeResponse,
            wireMethod: "set_device_operation_mode",
            capability: "device.mode",
            capabilityIsClaimed: true,
            describedAs: `${deviceNodeId} = "${discovered.anOperationModeOtherThanTheOneInForce}" from the session that did not take the lock`,
          });
          ledger.recordClaimedCapabilityAssertion({
            capability: "device.lock",
            wireMethod: "set_device_operation_mode",
            title:
              `set_device_operation_mode ${deviceNodeId} = "${discovered.anOperationModeOtherThanTheOneInForce}", sent from a session that did not take ` +
              "the lock while another session holds it, is ACCEPTED",
            contractCitation:
              'contract.yaml operations[set_device_operation_mode].errors: "THERE IS NO read_only ON THIS ROW, and its removal is the correction of a rule ' +
              'this contract invented. It used to read read_only: the device is locked, and openDAQ does not do that: GenericDevice::setOperationMode ' +
              '(device_impl.h:1257-1281) consults no lock at all - it checks onGetAvailableOperationModes, takes the tree lock guard and writes. The device ' +
              'lock refuses writes only in the config-protocol server (config_server_access_control.h:75-81), and these hosts are in-process, so no lock ' +
              'refusal can reach this row."',
            expected: "a result envelope carrying null, exactly as it would be answered on an unlocked device",
            actual: judgedModeChange.isError
              ? `error ${judgedModeChange.code}: ${judgedModeChange.detail} - a refusal openDAQ does not make, layered on top of the SDK`
              : `result ${JSON.stringify(judgedModeChange.result)}`,
            held: !judgedModeChange.isError && (judgedModeChange.result === null || judgedModeChange.result === undefined),
          });
          if (!judgedModeChange.isError && discovered.operationModeTheDeviceWasFoundIn !== null) {
            // The device really moved, which is the correct outcome. Move it
            // back before anything downstream - a subscription waiting for
            // sample frames, most of all - meets a device this sweep left in
            // another mode.
            const restored = await session.request("set_device_operation_mode", {
              node_id: deviceNodeId,
              mode: discovered.operationModeTheDeviceWasFoundIn,
            });
            console.log(
              `that mode change was accepted from the session that did not take the lock, which is what openDAQ does, so ${deviceNodeId} was moved back to ` +
                `"${discovered.operationModeTheDeviceWasFoundIn}" from the other session: the host ${describeAnswer(restored)}`,
            );
          }
        }

        // The second lock. openDAQ compares nullptr against nullptr and takes it.
        const secondLockResponse = await secondSession.request("lock_device", { node_id: deviceNodeId });
        const judgedSecondLock = judgeResponseEnvelope(ledger, contract, {
          response: secondLockResponse,
          wireMethod: "lock_device",
          capability: "device.lock",
          capabilityIsClaimed: true,
          describedAs: `${deviceNodeId}, already locked by this run's first session, from a second session`,
        });
        ledger.recordClaimedCapabilityAssertion({
          capability: "device.lock",
          wireMethod: "lock_device",
          title: `lock_device ${deviceNodeId} from a second session, on a device this run's first session already locked, is ACCEPTED`,
          contractCitation:
            'contract.yaml operations[lock_device].errors: read_only "is OPENDAQ_ERR_DEVICE_LOCKED ... which UserLockImpl::lock returns in exactly one ' +
            "case: `userLock.has_value() && userLock != userPtr` (user_lock_impl.cpp:21-22), i.e. a DIFFERENT NAMED user already holds it ... " +
            'reachable only where authentication names users, so with this application\'s configuration a host will not produce this code and MUST NOT ' +
            'SYNTHESISE IT: a second lock of an anonymously-locked device compares nullptr against nullptr and succeeds"',
          expected: "a result envelope carrying null",
          actual: judgedSecondLock.isError
            ? `error ${judgedSecondLock.code}: ${judgedSecondLock.detail} - a refusal openDAQ does not make with no authentication configured`
            : `result ${JSON.stringify(judgedSecondLock.result)}`,
          held: !judgedSecondLock.isError && (judgedSecondLock.result === null || judgedSecondLock.result === undefined),
        });

        // The unlock by the session that did not take it. openDAQ clears an
        // anonymously-taken lock for any caller, so the device is UNLOCKED after
        // this, and the tree read below is what proves it.
        const secondUnlockResponse = await secondSession.request("unlock_device", { node_id: deviceNodeId });
        const judgedSecondUnlock = judgeResponseEnvelope(ledger, contract, {
          response: secondUnlockResponse,
          wireMethod: "unlock_device",
          capability: "device.lock",
          capabilityIsClaimed: true,
          describedAs: `${deviceNodeId}, from the session that did not take the lock`,
        });
        ledger.recordClaimedCapabilityAssertion({
          capability: "device.lock",
          wireMethod: "unlock_device",
          title: `unlock_device ${deviceNodeId} from a second session, on a lock this run's first session took, is ACCEPTED`,
          contractCitation:
            'contract.yaml operations[unlock_device].errors: read_only is OPENDAQ_ERR_ACCESSDENIED, returned "only when `userLock.has_value() && ' +
            "userLock != nullptr && userLock != user` - the `!= nullptr` term is why an anonymously-taken lock, which is the only kind this application " +
            'can take, is cleared by ANY caller. So this code is unreachable here too, and a host must not invent it to keep a second session out." ' +
            "openDAQ's own test asserts the same: test_device.cpp:400-430, LockUnlockAnonymous, locks anonymously and then unlocks as jure and as tomaz.",
          expected: "a result envelope carrying null",
          actual: judgedSecondUnlock.isError
            ? `error ${judgedSecondUnlock.code}: ${judgedSecondUnlock.detail} - a refusal openDAQ does not make with no authentication configured`
            : `result ${JSON.stringify(judgedSecondUnlock.result)}`,
          held: !judgedSecondUnlock.isError && (judgedSecondUnlock.result === null || judgedSecondUnlock.result === undefined),
        });
        await assertTheTreeReportsTheLock(ledger, contract, session, {
          deviceNodeId,
          shouldBeLocked: false,
          whenItWasTaken: "after the OTHER session released a lock this run's first session took, which openDAQ permits any caller to do",
          claimed,
        });

        // The forced unlock needs a lock to force, so one is taken again here.
        // Nothing is asserted about this retake beyond what the log prints: the
        // assertion that lock_device is served is already recorded above.
        const retakeResponse = await session.request("lock_device", { node_id: deviceNodeId });
        console.log(
          `the lock on ${deviceNodeId} was taken again from this run's first session, so that unlock_device force:true has a lock to force: ` +
            `the host ${describeAnswer(retakeResponse)}`,
        );

        // The optional force parameter. forceUnlock is an unconditional
        // userLock.reset() (user_lock_impl.cpp:38-42), so the only conforming
        // refusal is unsupported, from a host whose binding cannot reach
        // IDevicePrivate.
        const forcedResponse = await secondSession.request("unlock_device", { node_id: deviceNodeId, force: true });
        const judgedForced = judgeResponseEnvelope(ledger, contract, {
          response: forcedResponse,
          wireMethod: "unlock_device",
          capability: "device.lock",
          capabilityIsClaimed: true,
          describedAs: "force true, from the session that did not take the lock",
        });
        ledger.recordClaimedCapabilityAssertion({
          capability: "device.lock",
          wireMethod: "unlock_device",
          title: `unlock_device force true, from the session that did not take the lock, either clears the lock or answers unsupported`,
          contractCitation:
            'contract.yaml operations[unlock_device].params force, presence optional: "the reference then offers a forced unlock, which is IDevicePrivate.force_unlock() - a different interface, reached by a cast"; errors: "unsupported covers both not a device and force: true on a host that cannot reach IDevicePrivate". forceUnlock is an unconditional userLock.reset() (user_lock_impl.cpp:38-42), so no ownership refusal is possible on this path.',
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

    // --- the session that took the lock releases it, and the tree says so ---
    //
    // By this point the lock may already be clear: the second session released
    // it, then this session took it again, then unlock_device force:true was
    // sent - and whether that last one cleared it depends on whether the host
    // can reach IDevicePrivate. Either way this call must be ACCEPTED, because
    // UserLockImpl::unlock (user_lock_impl.cpp:29-36) refuses only when a
    // DIFFERENT NAMED user holds the lock, and an unlock of a device that is not
    // locked falls straight through `userLock.has_value()` to reset().
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
      title: `unlock_device ${deviceNodeId} by the session that took the lock is accepted and returns void`,
      contractCitation:
        "contract.yaml operations[unlock_device].returns = void; errors: read_only is OPENDAQ_ERR_ACCESSDENIED and fires " +
        "only when `userLock.has_value() && userLock != nullptr && userLock != user`, so neither a lock this session took " +
        "anonymously nor a device that is already unlocked can refuse this call",
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
 * A property write from the session that did NOT take the lock, which openDAQ
 * SERVES. contract.yaml says so twice. types.Node.locked: "THIS IS A LABEL, NOT
 * A WRITE REFUSAL, and a client must not infer one from it ... the lock is
 * enforced in the config-protocol SERVER, by
 * ConfigServerAccessControl::protectLockedComponent
 * (config_server_access_control.h:75-81 ...), and nowhere in core -
 * GenericPropertyObjectImpl::setPropertyValue consults no lock, so an in-process
 * device.setPropertyValue on a locked device SUCCEEDS."
 * operations[set_property_value].errors: "A LOCKED ANCESTOR DEVICE IS NOT A
 * read_only CAUSE HERE, and a host must not manufacture one."
 */
async function assertALockedDeviceStillAcceptsAWriteFromElsewhere(ledger, contract, session, { deviceNodeId, discovered, claimed }) {
  if (!claimed("property.write")) {
    ledger.recordNotProvokable({
      capability: "device.lock",
      wireMethod: "set_property_value",
      title: "whether a locked device still serves a property write from another session could not be driven",
      contractCitation:
        'contract.yaml types.Node.locked: "THIS IS A LABEL, NOT A WRITE REFUSAL ... an in-process device.setPropertyValue on a locked device SUCCEEDS"',
      reason: "this host declared property.write a gap, so there is no write to be served or refused",
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
      wireMethod: "set_property_value",
      title: "whether a locked device still serves a property write from another session could not be driven",
      contractCitation:
        'contract.yaml operations[set_property_value].errors: "A LOCKED ANCESTOR DEVICE IS NOT A read_only CAUSE HERE, and a host must not manufacture one"',
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
    describedAs: `${writable.nodeId}.${writable.descriptor.id} from a session that did not take the lock`,
  });
  ledger.recordClaimedCapabilityAssertion({
    capability: "device.lock",
    wireMethod: "set_property_value",
    title: `set_property_value ${writable.nodeId}.${writable.descriptor.id}, from a session that did not take the lock on ${deviceNodeId}, is ACCEPTED`,
    contractCitation:
      'contract.yaml operations[set_property_value].errors: "read_only is openDAQ refusing THIS property\'s write - PropertyDescriptor.read_only, i.e. the ' +
      "property object's own refusal. A LOCKED ANCESTOR DEVICE IS NOT A read_only CAUSE HERE, and a host must not manufacture one. The device lock is " +
      "enforced only in the config-protocol server, by ConfigServerAccessControl::protectLockedComponent (config_server_access_control.h:75-81) ... Core " +
      "does not: GenericPropertyObjectImpl::setPropertyValue consults no lock, so an in-process write to a property under a locked device SUCCEEDS. Every " +
      'host in this repository holds an in-process Instance, so every one of them is on that path." This descriptor reports read_only false, so the one ' +
      "read_only cause the row does have is absent too.",
    expected: `a result envelope carrying null: the write of ${JSON.stringify(submitted)} lands exactly as it would on an unlocked device`,
    actual: judged.isError
      ? `error ${judged.code}: ${judged.detail} - a refusal openDAQ does not make in process, layered on top of the SDK`
      : `the write of ${JSON.stringify(submitted)} was accepted while another session held the lock, result ${JSON.stringify(judged.result)}`,
    held: !judged.isError && (judged.result === null || judged.result === undefined),
  });

  if (!judged.isError) {
    // The write landed, which is what openDAQ does. Put the property back before
    // anything else reads it.
    const restored = await session.request("set_property_value", {
      node_id: writable.nodeId,
      property_id: writable.descriptor.id,
      value: writable.value,
    });
    console.log(
      `the locked device accepted that write, which is what an in-process openDAQ does, so ${writable.nodeId}.${writable.descriptor.id} was restored to ` +
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
