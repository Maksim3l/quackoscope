// Sweep 5: the twelve operations contract.yaml grew for the last reference
// panels - get_component_attributes, set_component_attribute, list_server_types,
// add_server, remove_server, set_server_discovery_enabled, start_recording,
// stop_recording, begin_batched_property_update, end_batched_property_update,
// save_instance_configuration_to_string and load_instance_configuration_from_string.
//
// Same shape as sweeps 2 and 3, and the same first question: did the handshake
// claim this operation's capability? A claimed capability is driven for real and
// anything wrong is failure class (b); a gapped one goes through
// driveGappedOperation and a refusal is class (a), which passes. Every assertion
// cites the line of contract.yaml it tests, because a conformance assertion
// nobody can trace to the contract is an opinion.
//
// It runs AFTER the subscription sweep and BEFORE the disconnect sweep. That
// position is load-bearing: two of these eleven rows change state that the
// streaming assertions read - a batched update HOLDS every property write
// against a subtree, and a configuration load replaces the configuration of
// every device under the instance - so neither may run while sweep 4 is waiting
// for sample frames. Disconnect still runs last, because it tears the device
// down.
//
// WHY THESE ELEVEN NEED A FILE. Four reasons, and the first two are the reason
// this file exists rather than eleven more paragraphs in sweep 2.
//
// A SERVER IS ADDED AND THEN TAKEN DOWN AGAIN, AND THAT IS NEW. This sweep used
// to refuse to drive add_server's success path, and its reason was correct at the
// time: adding a server BINDS A REAL LISTENING SOCKET inside the host process, on
// a port number that comes out of the server type's own configuration and that
// this project does not own - driving it against the SDK hosts was observed to
// bind 0.0.0.0:7420 (OpenDAQNativeStreaming) on cpp and both 7414 and 7420 on
// rust - AND THERE WAS NO remove_server ROW IN contract.yaml, so nothing in the
// closed operation table could take that socket down again.
//
// THE ROW NOW EXISTS, and the refusal expires with the reason for it.
// contract.yaml operations[remove_server] is IDevice::removeServer(IServer*) -
// "device.h:300-304 ... which device_impl.h:1014-1026 wraps to onRemoveServer
// (:1479-1487), the exact mirror of onAddServer (:1465-1476)" - and the contract
// states, in its own words, that the socket really closes: "THE SOCKET ACTUALLY
// CLOSES, which is what makes this a real undo rather than a delisting.
// folder_impl.h:598-605 removes the item, which calls IComponent::removed, and
// ServerImpl::removed (server_impl.h:199-202) is `checkErrorInfo(stop());
// Super::removed();` - IServer::stop, whose own doc (server.h:55) is 'Stops the
// server. This is called when we remove the server from the Instance or Instance
// is closing.'"
//
// So the lifecycle is driven whole: list_server_types, then add_server on a type
// that list actually returned, then - because a server row is the only thing
// set_server_discovery_enabled can act on and most hosts publish none at startup -
// the discovery pair against the row that was just created, then remove_server,
// and then a read-back that proves the row is gone and a second remove_server
// that must answer not_found. The removal is not conditional on anything above it
// succeeding: if this sweep created a server it takes it down, and if the removal
// is refused it says so in the loudest terms it has, because the thing left
// behind is a listening socket and not a row in a report.
//
// WHY IT IS SAFE TO BIND ONE AT ALL. add_server takes only type_id - the contract
// carries no config parameter, because AddServerDialog "calls
// self.context.instance.add_server(server_type_id, config) on the INSTANCE,
// always" and this contract does not model the config - so the port is whatever
// the server type defaults to, and it can already be held. contract.yaml names
// `internal` for exactly that ("a port already bound, a permission refused by the
// operating system"), so a refusal on those grounds is inside the row and is
// recorded as what it is rather than failed. What is NOT tolerated is a server
// this sweep created and could not remove.
//
// A CONFIGURATION LOAD THIS SWEEP CAN AFFORD. The same question is asked of
// load_instance_configuration_from_string, which "REPLACES the configuration of
// every device under the instance in one call", and it gets a different answer,
// because this pair has what add_server does not: an undo that is the operation
// beside it. The only load this sweep makes on the success path is the IDENTITY
// LOAD - the string save_instance_configuration_to_string returned moments
// earlier, from this same host - so what is applied is the configuration the
// instance already has. A foreign configuration, or an invented one, would be a
// permanent replacement with nothing to restore from, and is never sent: the
// invalid_value path is driven with a string that is deliberately not a
// configuration at all, which openDAQ cannot apply.
//
// AN ABANDONED BATCH, WHICH TAKES TWO SOCKETS. contract.yaml says beginUpdate is
// recursive over child property objects, so one begin puts a subtree into batch
// mode FOR EVERY SESSION, and "a session that begins and drops leaves it there".
// It then states, in as many words, that it does NOT rule who may end a batch
// somebody else began, and that Node.updating exists so the next session can see
// the state. That is drivable and it is driven here: a second socket begins a
// batch and is closed without ending it, this session reads Node.updating off
// the tree, and what it finds is recorded as UNCONSTRAINED rather than judged,
// because the contract declined to answer. The sweep then ends that batch from
// this session and prints what the host said, so the run leaves no component in
// batch mode whatever the host's unruled policy turns out to be.
//
// WHAT THIS SWEEP LEAVES BEHIND, stated because two of these rows have no
// read-back to restore from:
//   set_server_discovery_enabled  has NO GETTER and contract.yaml says there
//       cannot be one, so the state a server row was found in is unknowable and
//       nothing can be restored. The sweep drives false and then true and leaves
//       discovery ENABLED, which is the state contract.yaml says a server row is
//       created in (the reference calls enable_discovery straight after
//       add_server), and it prints that it did. When the row it drove is the one
//       add_server created, remove_server takes that row away afterwards and the
//       question of what was left disappears with it.
//   start_recording / stop_recording  are restored from Node.recording, which
//       IS readable, so the recorder is left in the state it was found in.
// Everything else - the attributes, the batched property write, the instance
// configuration - is read before it is written and written back afterwards.

import { findRecordViolations } from "../wire/validate-record-against-contract-type.mjs";
import { openWireSession } from "../wire/open-wire-session.mjs";
import { judgeResponseEnvelope } from "./judge-response-envelope.mjs";
import {
  CONFORMANCE_TEXT_THAT_IS_NOT_AN_INSTANCE_CONFIGURATION,
  CONFORMANCE_UNKNOWN_ATTRIBUTE_ID,
  CONFORMANCE_UNKNOWN_NODE_ID,
  CONFORMANCE_UNKNOWN_SERVER_TYPE_ID,
  driveGappedOperation,
} from "./sweep-every-contract-operation.mjs";
import { describeAnswer, refuseWithOneOf } from "./sweep-device-operation-mode-device-lock-and-modules.mjs";

/** The suffix a string attribute is written with on the changing round trip. */
const ATTRIBUTE_TEXT_THE_SWEEP_APPENDS = " (written by the quackoscope conformance sweep)";
/** The tag a string_list attribute is written with on the changing round trip. */
const ATTRIBUTE_TAG_THE_SWEEP_APPENDS = "quackoscope-conformance-sweep";

/**
 * The attribute this sweep will not change the value of, only write back
 * unchanged. IComponent.active false takes a component out of acquisition, and
 * sweep 4 has already subscribed to signals under it; a sweep that switched it
 * off, even for one round trip, would be changing what the run measures rather
 * than measuring it.
 */
const ATTRIBUTE_THE_SWEEP_NEVER_CHANGES_THE_VALUE_OF = "active";

export async function sweepComponentAttributesServersRecorderBatchedUpdatesAndInstanceConfiguration(
  ledger,
  contract,
  session,
  handshakeResult,
  discovered,
  options,
) {
  const claimed = (capability) => ledger.capabilityIsClaimed(capability);
  const gapsByCapability = handshakeResult.gapsByCapability ?? new Map();
  const operationOf = (wireMethod) => contract.operationsByWireMethod.get(wireMethod);
  const sessionsOpenedByThisSweep = [];

  const deviceNodeId = discovered.deviceNodeId;
  const treeNodes = discovered.treeNodes ?? [];
  const aServerNode = treeNodes.find((node) => node.kind === "server") ?? null;
  const aRecorderNode = treeNodes.find((node) => node.recording === true || node.recording === false) ?? null;
  const aNodeThatIsNotAServer = treeNodes.find((node) => node.kind !== "server") ?? null;
  const aNodeThatReportsNoRecordingState = treeNodes.find((node) => node.recording === null || node.recording === undefined) ?? null;

  const capabilitiesThisSweepOwns = [
    "attribute.read",
    "attribute.write",
    "server.add",
    "server.discovery",
    "recorder.control",
    "property.batched_update",
    "configuration.save",
    "configuration.load",
  ];
  console.log(
    `capabilities this sweep drives: ${capabilitiesThisSweepOwns
      .map((capability) => `${capability} (${claimed(capability) ? "claimed" : "declared a gap"})`)
      .join(", ")}`,
  );
  console.log(
    `the rows this sweep found in the tree it was handed (${treeNodes.length} node(s)): ` +
      `device ${deviceNodeId ?? "(none)"}; ` +
      `a node of kind server, for set_server_discovery_enabled: ${aServerNode?.id ?? "(none)"}; ` +
      `a node reporting a non-null Node.recording, which is the only kind of row that IS a recorder: ${aRecorderNode?.id ?? "(none)"}; ` +
      `a node that is not a server, for the unsupported corner: ${aNodeThatIsNotAServer?.id ?? "(none)"}; ` +
      `a node reporting Node.recording null, for the recorder's unsupported corner: ${aNodeThatReportsNoRecordingState?.id ?? "(none)"}`,
  );

  // -------------------------------------------------------------------------
  // A second session. It serves three purposes, all of which need a socket that
  // is not this run's first one:
  //   1. the not_connected corners of list_server_types, add_server,
  //      save_instance_configuration_to_string, load_instance_configuration_from_string,
  //      begin_batched_property_update and end_batched_property_update, which
  //      can only be asked of a session that has connected no device;
  //   2. the abandoned batch: a session that begins an update and drops;
  //   3. reading Node.updating from somewhere other than the batch's opener.
  // -------------------------------------------------------------------------
  let secondSession = null;
  let whyThereIsNoSecondSession = null;
  try {
    const opened = await openWireSession(options.url, contract, { requestTimeoutMs: options.requestTimeoutMs });
    secondSession = opened.session;
    sessionsOpenedByThisSweep.push(secondSession);
    console.log(
      `opened a second WebSocket to ${options.url}; its handshake was ${opened.firstMessage.text.length} bytes. ` +
        "It has connected no device, which is the only session the not_connected corner of these rows can be asked of, " +
        "and it is the session that will begin a batched update and then drop without ending it.",
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
  // attribute.read: get_component_attributes
  // =========================================================================
  console.log("\nattribute.read: get_component_attributes");
  let attributes = [];
  if (!claimed("attribute.read")) {
    await driveGappedOperation(ledger, contract, session, operationOf("get_component_attributes"), discovered, gapsByCapability);
  } else if (!deviceNodeId) {
    ledger.recordNotProvokable({
      capability: "attribute.read",
      wireMethod: "get_component_attributes",
      title: "get_component_attributes could not be driven against a real component",
      contractCitation: "contract.yaml operations[get_component_attributes].params node_id, references Node.id",
      reason: "connect_device produced no device node id in this session, so there is no component to open the attributes panel on",
    });
  } else {
    const response = await session.request("get_component_attributes", { node_id: deviceNodeId });
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod: "get_component_attributes",
      capability: "attribute.read",
      capabilityIsClaimed: true,
      describedAs: deviceNodeId,
    });
    attributes = Array.isArray(judged.result) ? judged.result : [];

    const violations = [];
    if (!judged.isError && !Array.isArray(judged.result)) {
      violations.push(`expected an array of ComponentAttribute; got ${JSON.stringify(judged.result)?.slice(0, 160)}`);
    }
    attributes.forEach((attribute, index) =>
      violations.push(...findRecordViolations(attribute, "ComponentAttribute", contract, `get_component_attributes[${index}]`)),
    );
    ledger.recordClaimedCapabilityAssertion({
      capability: "attribute.read",
      wireMethod: "get_component_attributes",
      title: `get_component_attributes ${deviceNodeId} returns an array of contract-shaped ComponentAttribute records`,
      contractCitation:
        "contract.yaml operations[get_component_attributes].returns = array of ComponentAttribute; types.ComponentAttribute id/name/value_type/read_only required and value nullable, value_type an enum over [bool, int, float, string, string_list]",
      expected: `every element a ComponentAttribute carrying all ${Object.keys(contract.types.ComponentAttribute.fields).length} contract keys`,
      actual: judged.isError
        ? `error ${judged.code}: ${judged.detail}`
        : violations.length === 0
          ? `${attributes.length} attribute(s): ${attributes.map((attribute) => `${attribute.id}=${JSON.stringify(attribute.value)} (${attribute.value_type}${attribute.read_only ? ", read_only" : ""})`).join(", ").slice(0, 400)}`
          : violations.slice(0, 8).join(" | "),
      held: !judged.isError && violations.length === 0,
    });

    // contract.yaml operations[get_component_attributes].returns says it in one
    // sentence: "A host that cannot perform a cast returns fewer rows; it does
    // not return a row with a null value, which would claim the attribute exists
    // and has no value." types.ComponentAttribute.value is nullable as a wire
    // shape, so only this sentence forbids it, and only this assertion tests it.
    const rowsWithANullValue = attributes.filter((attribute) => attribute.value === null || attribute.value === undefined);
    ledger.recordClaimedCapabilityAssertion({
      capability: "attribute.read",
      wireMethod: "get_component_attributes",
      title: `no attribute row of ${deviceNodeId} carries a null value`,
      contractCitation:
        'contract.yaml operations[get_component_attributes].returns: "A host that cannot perform a cast returns fewer rows; it does not return a row with a null value, which would claim the attribute exists and has no value."',
      expected: "every row a real value; an attribute a host cannot reach is absent, not null",
      actual: rowsWithANullValue.length === 0
        ? `all ${attributes.length} row(s) carry a value`
        : `${rowsWithANullValue.length} row(s) carry null: ${rowsWithANullValue.map((attribute) => `${attribute.id} (${attribute.value_type})`).join(", ")}`,
      held: rowsWithANullValue.length === 0,
    });

    // ATTRIBUTES ARE NOT PROPERTIES. types.ComponentAttribute opens with that
    // sentence and spends a paragraph on it: an attribute is a fixed member of
    // the openDAQ interface, a property is an entry in the property bag reached
    // by get/setPropertyValue. A host that answered the property bag here would
    // pass every shape check above and still be reporting the wrong thing.
    const nodeInTree = treeNodes.find((node) => node.id === deviceNodeId) ?? null;
    const propertyIds = new Set(nodeInTree?.property_ids ?? []);
    const attributeIdsThatAreAlsoProperties = attributes.map((attribute) => attribute.id).filter((id) => propertyIds.has(id));
    ledger.recordClaimedCapabilityAssertion({
      capability: "attribute.read",
      wireMethod: "get_component_attributes",
      title: `no attribute id of ${deviceNodeId} is also one of the property ids that node advertises`,
      contractCitation:
        'contract.yaml types.ComponentAttribute: "ATTRIBUTES ARE NOT PROPERTIES, and this record exists because of that. A property is a PropertyDescriptor the object carries in a property bag and answers get/setPropertyValue for. An attribute is a fixed member of the openDAQ interface itself"; types.Node.property_ids.references = PropertyDescriptor.id',
      expected: "the two id spaces do not overlap on this node",
      actual: attributeIdsThatAreAlsoProperties.length === 0
        ? `${attributes.length} attribute id(s) and ${propertyIds.size} property id(s) on ${deviceNodeId}, no id in both`
        : `also property ids: ${attributeIdsThatAreAlsoProperties.join(", ")}`,
      held: attributeIdsThatAreAlsoProperties.length === 0,
    });

    // The one rule ComponentAttribute.read_only states in capitals, tested at
    // exactly the moment it can be: a host that reads attributes and declares
    // attribute.write a GAP must let the client disable the editors from the
    // gap, not report read_only true on every row.
    if (!claimed("attribute.write")) {
      const writableRows = attributes.filter((attribute) => attribute.read_only === false);
      ledger.recordClaimedCapabilityAssertion({
        capability: "attribute.read",
        wireMethod: "get_component_attributes",
        title: "a host that declared attribute.write a gap does not report read_only true on every attribute row instead",
        contractCitation:
          'contract.yaml types.ComponentAttribute.read_only, "WHAT read_only MUST NOT BE USED FOR": "It is openDAQ\'s answer about the component, never the host\'s answer about itself. A host that has not implemented attribute writing declares no attribute.write capability and the client disables the editors from the gap; it must not instead report read_only true on every row, because that says openDAQ locked the attribute, which is a cause the host has not established."',
        expected: "at least one row with read_only false, since the gap and not read_only is what disables the editors",
        actual: writableRows.length > 0
          ? `${writableRows.length} of ${attributes.length} row(s) report read_only false: ${writableRows.map((attribute) => attribute.id).join(", ")}`
          : `all ${attributes.length} row(s) report read_only true, on a host whose handshake calls attribute.write a gap`,
        held: attributes.length === 0 || writableRows.length > 0,
      });
    }

    await refuseWithOneOf(ledger, contract, session, {
      wireMethod: "get_component_attributes",
      params: { node_id: CONFORMANCE_UNKNOWN_NODE_ID },
      title: `get_component_attributes on the unknown node "${CONFORMANCE_UNKNOWN_NODE_ID}" is refused with not_found`,
      contractCitation: `contract.yaml operations[get_component_attributes].errors = [${operationOf("get_component_attributes").errors.join(", ")}]; "The same subset get_property_descriptors declares, and for the same two reasons: node_id may name nothing, and there may be no instance to read."`,
      acceptableCodes: ["not_found"],
    });

    await askTheUnconnectedSession(
      "get_component_attributes",
      { node_id: deviceNodeId },
      `get_component_attributes for ${deviceNodeId}, asked from a session that has connected no device, is refused`,
      `contract.yaml operations[get_component_attributes].errors = [${operationOf("get_component_attributes").errors.join(", ")}]. The contract lists both and never says which a node id that is real on another session must get, so both are accepted here - the same reading sweep 3 makes of get_device_operation_modes`,
      "one of [not_connected, not_found]",
      (judged) => judged.isError && ["not_connected", "not_found"].includes(judged.code),
    );
  }

  // =========================================================================
  // attribute.write: set_component_attribute
  // =========================================================================
  console.log("\nattribute.write: set_component_attribute");
  const writableAttributes = attributes.filter((attribute) => attribute.read_only === false);
  const readOnlyAttributes = attributes.filter((attribute) => attribute.read_only === true);
  discovered.aWritableAttributeId = writableAttributes[0]?.id ?? null;

  if (!claimed("attribute.write")) {
    await driveGappedOperation(ledger, contract, session, operationOf("set_component_attribute"), discovered, gapsByCapability);
  } else if (!deviceNodeId || attributes.length === 0) {
    ledger.recordNotProvokable({
      capability: "attribute.write",
      wireMethod: "set_component_attribute",
      title: "set_component_attribute could not be driven",
      contractCitation: "contract.yaml operations[set_component_attribute].params attribute_id: \"One of the ComponentAttribute.id values get_component_attributes returned for this node\"",
      reason: deviceNodeId
        ? "get_component_attributes returned no row for this node, so there is no attribute id this contract permits to be written"
        : "connect_device produced no device node id in this session, so there is no component whose attributes could be written",
    });
  } else {
    // --- every row the host itself calls writable must accept a write -------
    //
    // THIS IS THE ASSERTION THAT CATCHES AN ADVERTISED EDITOR THAT CANNOT WORK.
    // read_only false is openDAQ's statement that the component did not lock
    // this attribute, and set_component_attribute's own error comment says
    // read_only is "never 'this host has no writer', which is a capability
    // gap". So a row the host published as writable, written back with the
    // value the host itself just reported, must be accepted: the value cannot
    // be wrong, because it is the value in force. A refusal here is the host
    // drawing an editor over a write it cannot perform.
    const identityWriteRefusals = [];
    for (const attribute of writableAttributes) {
      const response = await session.request("set_component_attribute", {
        node_id: deviceNodeId,
        attribute_id: attribute.id,
        value: attribute.value,
      });
      const judged = judgeResponseEnvelope(ledger, contract, {
        response,
        wireMethod: "set_component_attribute",
        capability: "attribute.write",
        capabilityIsClaimed: true,
        describedAs: `${attribute.id} written back unchanged`,
      });
      if (judged.isError) {
        identityWriteRefusals.push(
          `${attribute.id} (${attribute.value_type}, read_only false, value ${JSON.stringify(attribute.value)}) -> ${judged.code}: ${String(judged.detail).slice(0, 200)}`,
        );
      }
    }
    ledger.recordClaimedCapabilityAssertion({
      capability: "attribute.write",
      wireMethod: "set_component_attribute",
      title: `every attribute of ${deviceNodeId} this host reports read_only false accepts the value this host itself reports for it (${writableAttributes.length} row(s))`,
      contractCitation:
        'contract.yaml types.ComponentAttribute.read_only: "true means this attribute cannot be written", and "It is openDAQ\'s answer about the component, never the host\'s answer about itself"; operations[set_component_attribute].errors: "read_only: the attribute\'s ComponentAttribute.read_only is true ... never \'this host has no writer\', which is a capability gap. invalid_value: the value is of the wrong type for the attribute, or openDAQ rejected it." A row published read_only false, written back with the value in force, can be refused for neither reason.',
      expected: `all ${writableAttributes.length} row(s) accepted`,
      actual: identityWriteRefusals.length === 0
        ? `${writableAttributes.length} row(s) accepted: ${writableAttributes.map((attribute) => attribute.id).join(", ") || "(this node reports none)"}`
        : `${identityWriteRefusals.length} of ${writableAttributes.length} refused: ${identityWriteRefusals.join(" | ")}`,
      held: identityWriteRefusals.length === 0,
    });

    // --- one changing round trip, read back and restored -------------------
    const roundTripRow = pickTheAttributeToChangeAndRestore(writableAttributes);
    if (!roundTripRow) {
      ledger.recordNotProvokable({
        capability: "attribute.write",
        wireMethod: "set_component_attribute",
        title: "set_component_attribute could not be driven with a changing round trip",
        contractCitation: "contract.yaml operations[set_component_attribute].params value, type any, presence required",
        reason:
          `no row of ${deviceNodeId} was both read_only false and of a value_type this sweep can construct a different value for ` +
          `without changing what the run measures; the one it refuses to move is "${ATTRIBUTE_THE_SWEEP_NEVER_CHANGES_THE_VALUE_OF}", ` +
          "because IComponent.active false takes a component out of acquisition and sweep 4 has already subscribed under it",
      });
    } else {
      const submitted = aDifferentValueOfTheSameType(roundTripRow);
      const writeResponse = await session.request("set_component_attribute", {
        node_id: deviceNodeId,
        attribute_id: roundTripRow.id,
        value: submitted,
      });
      const judgedWrite = judgeResponseEnvelope(ledger, contract, {
        response: writeResponse,
        wireMethod: "set_component_attribute",
        capability: "attribute.write",
        capabilityIsClaimed: true,
        describedAs: `${roundTripRow.id} = ${JSON.stringify(submitted)}`,
      });
      ledger.recordClaimedCapabilityAssertion({
        capability: "attribute.write",
        wireMethod: "set_component_attribute",
        title: `set_component_attribute ${deviceNodeId}.${roundTripRow.id} = ${JSON.stringify(submitted)} is accepted and returns void`,
        contractCitation: "contract.yaml operations[set_component_attribute].returns = void; envelopes.result.result presence nullable",
        expected: "a result envelope carrying null",
        actual: judgedWrite.isError ? `error ${judgedWrite.code}: ${judgedWrite.detail}` : `result ${JSON.stringify(judgedWrite.result)}`,
        held: !judgedWrite.isError && (judgedWrite.result === null || judgedWrite.result === undefined),
      });

      if (!judgedWrite.isError) {
        const readBack = await readOneAttribute(session, deviceNodeId, roundTripRow.id);
        ledger.recordClaimedCapabilityAssertion({
          capability: "attribute.write",
          wireMethod: "set_component_attribute",
          title: `the write to ${deviceNodeId}.${roundTripRow.id} is visible to a later get_component_attributes`,
          contractCitation:
            'contract.yaml operations[set_component_attribute] writes the attribute get_component_attributes reads: "One of the ComponentAttribute.id values get_component_attributes returned for this node". A write the read side does not show would make the panel and the setter disagree.',
          expected: `get_component_attributes reports ${JSON.stringify(submitted)} for ${roundTripRow.id}`,
          actual: readBack === undefined
            ? `${roundTripRow.id} is no longer among the rows ${deviceNodeId} reports`
            : `${JSON.stringify(readBack.value)} (it was ${JSON.stringify(roundTripRow.value)} before the write)`,
          held: readBack !== undefined && JSON.stringify(readBack.value) === JSON.stringify(submitted),
        });

        const restored = await session.request("set_component_attribute", {
          node_id: deviceNodeId,
          attribute_id: roundTripRow.id,
          value: roundTripRow.value,
        });
        console.log(
          `restored ${deviceNodeId}.${roundTripRow.id} to the value it was found with, ${JSON.stringify(roundTripRow.value)}: ` +
            `the host ${describeAnswer(restored)}`,
        );
      }
    }

    // --- read_only, from the host's own rows -------------------------------
    if (readOnlyAttributes.length === 0) {
      ledger.recordNotProvokable({
        capability: "attribute.write",
        wireMethod: "set_component_attribute",
        title: 'the "read_only" error code of set_component_attribute could not be provoked',
        contractCitation: `contract.yaml operations[set_component_attribute].errors = [${operationOf("set_component_attribute").errors.join(", ")}]`,
        reason: `no row of ${deviceNodeId} reports read_only true, so there is no attribute this component has locked to write to`,
      });
    } else {
      const lockedRow = readOnlyAttributes[0];
      await refuseWithOneOf(ledger, contract, session, {
        wireMethod: "set_component_attribute",
        params: { node_id: deviceNodeId, attribute_id: lockedRow.id, value: lockedRow.value },
        title: `writing the host's own read_only=true attribute ${deviceNodeId}.${lockedRow.id} is refused with read_only`,
        contractCitation:
          `contract.yaml operations[set_component_attribute].errors = [${operationOf("set_component_attribute").errors.join(", ")}]; ` +
          '"read_only: the attribute\'s ComponentAttribute.read_only is true, i.e. openDAQ\'s locked_attributes or the reference\'s own hardcoded Locked flag refused the write"',
        acceptableCodes: ["read_only"],
      });
    }

    // --- invalid_value, by submitting the wrong type ------------------------
    const rowWithACheckableType = writableAttributes.find((attribute) => attribute.value_type !== "string");
    if (!rowWithACheckableType) {
      ledger.recordNotProvokable({
        capability: "attribute.write",
        wireMethod: "set_component_attribute",
        title: 'the "invalid_value" error code of set_component_attribute could not be provoked',
        contractCitation: `contract.yaml operations[set_component_attribute].errors = [${operationOf("set_component_attribute").errors.join(", ")}]`,
        reason:
          `every writable row of ${deviceNodeId} is value_type string, and the sweep will not decide on the contract's behalf ` +
          "which strings openDAQ rejects; a wrong TYPE is the only thing types.ComponentAttribute.value_type makes wrong on its own",
      });
    } else {
      await refuseWithOneOf(ledger, contract, session, {
        wireMethod: "set_component_attribute",
        params: {
          node_id: deviceNodeId,
          attribute_id: rowWithACheckableType.id,
          value: "this is not a value of that attribute's type, it was sent by the quackoscope conformance sweep",
        },
        title: `writing a string into the ${rowWithACheckableType.value_type} attribute ${deviceNodeId}.${rowWithACheckableType.id} is refused with invalid_value`,
        contractCitation:
          `contract.yaml operations[set_component_attribute].errors = [${operationOf("set_component_attribute").errors.join(", ")}]; ` +
          '"invalid_value: the value is of the wrong type for the attribute, or openDAQ rejected it"; types.ComponentAttribute.value_type is an enum over [bool, int, float, string, string_list]',
        acceptableCodes: ["invalid_value"],
      });
    }

    // --- not_found, on an attribute id this component does not report -------
    await refuseWithOneOf(ledger, contract, session, {
      wireMethod: "set_component_attribute",
      params: { node_id: deviceNodeId, attribute_id: CONFORMANCE_UNKNOWN_ATTRIBUTE_ID, value: true },
      title: `set_component_attribute with the attribute id "${CONFORMANCE_UNKNOWN_ATTRIBUTE_ID}", which ${deviceNodeId} does not report, is refused with not_found`,
      contractCitation:
        `contract.yaml operations[set_component_attribute].errors = [${operationOf("set_component_attribute").errors.join(", ")}]; ` +
        '"not_found: node_id names no component, or attribute_id is not one this component reports"',
      acceptableCodes: ["not_found"],
    });
  }

  // =========================================================================
  // server.add: list_server_types, add_server and remove_server
  // =========================================================================
  console.log("\nserver.add: list_server_types, add_server, remove_server - the whole lifecycle, see this file's header");
  // The server this sweep creates, held across the discovery section below and
  // taken down after it. null means nothing was created and there is nothing to
  // take down.
  let theServerThisSweepAdded = null;
  if (!claimed("server.add")) {
    await driveGappedOperation(ledger, contract, session, operationOf("list_server_types"), discovered, gapsByCapability);
    await driveGappedOperation(ledger, contract, session, operationOf("add_server"), discovered, gapsByCapability, {
      type_id: CONFORMANCE_UNKNOWN_SERVER_TYPE_ID,
    });
    // The unknown node id, never a real server row: a host that declared this
    // capability a gap and serves the call anyway must not be handed the id of a
    // server this sweep did not create and cannot put back.
    await driveGappedOperation(ledger, contract, session, operationOf("remove_server"), discovered, gapsByCapability, {
      node_id: CONFORMANCE_UNKNOWN_NODE_ID,
    });
  } else {
    const response = await session.request("list_server_types", {});
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod: "list_server_types",
      capability: "server.add",
      capabilityIsClaimed: true,
    });
    const serverTypes = Array.isArray(judged.result) ? judged.result : [];
    const violations = [];
    if (!judged.isError && !Array.isArray(judged.result)) {
      violations.push(`expected an array of ComponentTypeInfo; got ${JSON.stringify(judged.result)?.slice(0, 160)}`);
    }
    serverTypes.forEach((type, index) =>
      violations.push(...findRecordViolations(type, "ComponentTypeInfo", contract, `list_server_types[${index}]`)),
    );
    ledger.recordClaimedCapabilityAssertion({
      capability: "server.add",
      wireMethod: "list_server_types",
      title: "list_server_types returns an array of contract-shaped ComponentTypeInfo records",
      contractCitation:
        "contract.yaml operations[list_server_types].returns = array of ComponentTypeInfo; types.ComponentTypeInfo id/name/kind required, description and connection_string_prefix nullable, kind an enum over [device, function_block, server, streaming]",
      expected: "every element a ComponentTypeInfo",
      actual: judged.isError
        ? `error ${judged.code}: ${judged.detail}`
        : violations.length === 0
          ? `${serverTypes.length} server type(s): ${serverTypes.map((type) => `${type.id} (${type.kind})`).join(", ").slice(0, 300)}`
          : violations.slice(0, 8).join(" | "),
      held: !judged.isError && violations.length === 0,
    });

    const kindsOtherThanServer = serverTypes.filter((type) => type.kind !== "server");
    ledger.recordClaimedCapabilityAssertion({
      capability: "server.add",
      wireMethod: "list_server_types",
      title: "every row list_server_types returns carries kind \"server\"",
      contractCitation:
        'contract.yaml operations[list_server_types].returns: "kind is `server` on every element of this response, which is one redundant field per row and the price of not adding a fifth record"',
      expected: `kind "server" on all ${serverTypes.length} row(s)`,
      actual: kindsOtherThanServer.length === 0
        ? `${serverTypes.length} row(s), kind "server" on every one`
        : `rows with another kind: ${kindsOtherThanServer.map((type) => `${type.id} kind=${JSON.stringify(type.kind)}`).join(", ")}`,
      held: kindsOtherThanServer.length === 0,
    });

    await askTheUnconnectedSession(
      "list_server_types",
      {},
      "list_server_types, asked from a session that has connected no device, either answers the list or refuses not_connected",
      `contract.yaml operations[list_server_types].errors = [${operationOf("list_server_types").errors.join(", ")}]; "Same as list_function_block_types: the only way to have no server types is to have no instance." ` +
        "THE CONTRACT'S CONDITION IS AN INSTANCE, NOT A CONNECTED DEVICE, and those are not the same state: a host builds its openDAQ Instance at " +
        "startup and connect_device adds a device TO it, so a session that has connected nothing still has an instance to ask. The contract's own " +
        "add_server comment settles the scope - AddServerDialog \"calls self.context.instance.add_server(server_type_id, config) on the INSTANCE, " +
        "always\" - so server types are an instance-wide fact the way loaded modules are a process-wide one, which is the row list_loaded_modules is " +
        "read the same way for. The \"Same as list_function_block_types\" is the misleading half: function block types come off the DEVICE " +
        "(IDevice::getAvailableFunctionBlockTypes) and this run's cpp host demonstrates the split by refusing not_connected to that row and " +
        "answering the list to this one. All four independently written SDK hosts answer the list here, which is evidence about the contract's " +
        "wording and not about four bindings, so both answers conform and which one a host gives is recorded rather than judged",
      "an array of ComponentTypeInfo, or error not_connected",
      (judged) => (judged.isError ? judged.code === "not_connected" : Array.isArray(judged.result)),
    );

    // --- add_server, unsupported: the one path that creates nothing --------
    await refuseWithOneOf(ledger, contract, session, {
      wireMethod: "add_server",
      params: { type_id: CONFORMANCE_UNKNOWN_SERVER_TYPE_ID },
      title: `add_server with the type id "${CONFORMANCE_UNKNOWN_SERVER_TYPE_ID}", which list_server_types did not return, is refused with unsupported`,
      contractCitation:
        `contract.yaml operations[add_server].errors = [${operationOf("add_server").errors.join(", ")}]; ` +
        '"unsupported: type_id is not among list_server_types, which is exactly what add_function_block answers to an unknown type id"',
      acceptableCodes: ["unsupported"],
    });

    await askTheUnconnectedSession(
      "add_server",
      { type_id: CONFORMANCE_UNKNOWN_SERVER_TYPE_ID },
      `add_server "${CONFORMANCE_UNKNOWN_SERVER_TYPE_ID}", asked from a session that has connected no device, is refused with a code from its own subset`,
      `contract.yaml operations[add_server].errors = [${operationOf("add_server").errors.join(", ")}]; "not_connected: no instance, so nothing to add a server to" and "unsupported: type_id is not among list_server_types". Both are true of this request and the contract does not order them, so either conforms and which one a host picks is recorded rather than judged`,
      "one of [not_connected, unsupported]",
      (judged) => judged.isError && ["not_connected", "unsupported"].includes(judged.code),
    );

    // --- remove_server, the two refusals that create and destroy nothing ----
    await refuseWithOneOf(ledger, contract, session, {
      wireMethod: "remove_server",
      params: { node_id: CONFORMANCE_UNKNOWN_NODE_ID },
      title: `remove_server on the unknown node "${CONFORMANCE_UNKNOWN_NODE_ID}" is refused with not_found`,
      contractCitation:
        `contract.yaml operations[remove_server].errors = [${operationOf("remove_server").errors.join(", ")}]; "not_found: node_id names no component"`,
      acceptableCodes: ["not_found"],
    });
    if (aNodeThatIsNotAServer === null) {
      ledger.recordNotProvokable({
        capability: "server.add",
        wireMethod: "remove_server",
        title: 'the "unsupported" error code of remove_server could not be provoked',
        contractCitation: `contract.yaml operations[remove_server].errors = [${operationOf("remove_server").errors.join(", ")}]`,
        reason: "every node in the tree this host returned is of kind server, so there is no existing non-server row to aim a removal at",
      });
    } else {
      await refuseWithOneOf(ledger, contract, session, {
        wireMethod: "remove_server",
        params: { node_id: aNodeThatIsNotAServer.id },
        title: `remove_server on ${aNodeThatIsNotAServer.id}, a node of kind ${aNodeThatIsNotAServer.kind} and not a server, is refused with unsupported`,
        contractCitation:
          `contract.yaml operations[remove_server].errors = [${operationOf("remove_server").errors.join(", ")}]; ` +
          '"unsupported: the component exists and is not a server ... It is unsupported rather than not_found because the node was found; what is ' +
          'missing is the ability"',
        acceptableCodes: ["unsupported"],
      });
    }

    // --- add_server's SUCCESS path, which is drivable now that a server can be
    //     taken down again ---------------------------------------------------
    //
    // Every type list_server_types returned is tried in turn, newest refusal
    // printed each time, until one server is created. That is not thoroughness
    // for its own sake: add_server carries no config parameter, so each type
    // binds whatever port it defaults to, and contract.yaml names `internal` for
    // "a port already bound". One type being unavailable on this machine at this
    // moment must not silently turn the success path back into an undriven one.
    const addAttempts = [];
    for (const serverType of serverTypes) {
      if (typeof serverType?.id !== "string") continue;
      const addResponse = await session.request("add_server", { type_id: serverType.id });
      const judgedAdd = judgeResponseEnvelope(ledger, contract, {
        response: addResponse,
        wireMethod: "add_server",
        capability: "server.add",
        capabilityIsClaimed: true,
        describedAs: `type_id "${serverType.id}"`,
      });
      addAttempts.push({ typeId: serverType.id, judged: judgedAdd });
      console.log(
        `add_server "${serverType.id}" -> ${judgedAdd.isError ? `${judgedAdd.code}: ${String(judgedAdd.detail).slice(0, 200)}` : `created ${JSON.stringify(judgedAdd.result?.id)} (kind ${JSON.stringify(judgedAdd.result?.kind)})`}`,
      );
      if (!judgedAdd.isError) {
        theServerThisSweepAdded = { typeId: serverType.id, node: judgedAdd.result };
        break;
      }
    }

    if (serverTypes.length === 0) {
      ledger.recordNotProvokable({
        capability: "server.add",
        wireMethod: "add_server",
        title: "the success path of add_server was not driven",
        contractCitation:
          'contract.yaml operations[add_server].params type_id: "One of the ComponentTypeInfo.id values list_server_types returned"',
        reason:
          "list_server_types answered with no server type at all, so there is no type id this host has said it will accept, and the only " +
          "add_server this sweep could send would be one it already knows must be refused",
      });
    } else if (theServerThisSweepAdded === null) {
      ledger.recordNotProvokable({
        capability: "server.add",
        wireMethod: "add_server",
        title: "the success path of add_server was not driven: every type this host offered refused the addition",
        contractCitation:
          `contract.yaml operations[add_server].errors = [${operationOf("add_server").errors.join(", ")}]; ` +
          '"internal: adding a server opens a listening socket in the host process, and that fails for reasons that are not about type_id at all - ' +
          'a port already bound, a permission refused by the operating system"',
        reason:
          `all ${addAttempts.length} type(s) list_server_types returned were tried and each was refused: ` +
          `${addAttempts.map((attempt) => `${attempt.typeId} -> ${attempt.judged.code}: ${String(attempt.judged.detail).slice(0, 120)}`).join(" | ")}. ` +
          "Each refusal was judged against the row's own error subset above, so this is a fact about this machine's free ports and this host's " +
          "server types rather than an unasked row",
      });
    } else {
      const createdNode = theServerThisSweepAdded.node;
      const violations = findRecordViolations(createdNode, "Node", contract, "add_server result");
      ledger.recordClaimedCapabilityAssertion({
        capability: "server.add",
        wireMethod: "add_server",
        title: `add_server "${theServerThisSweepAdded.typeId}" returns a contract-shaped Node of kind "server"`,
        contractCitation:
          'contract.yaml operations[add_server].returns = Node - "The record of the thing it created, which is the shape connect_device, ' +
          'add_function_block and load_module_from_host_path already set. Its kind is `server`, which is the value NodeKind grew for this row."; ' +
          "types.Node id/name/kind/child_ids/property_ids required, kind an enum over [device, channel, function_block, signal, folder, server]",
        expected: 'a Node record whose kind is "server"',
        actual:
          violations.length === 0
            ? `Node ${JSON.stringify(createdNode.id)}, name ${JSON.stringify(createdNode.name)}, kind ${JSON.stringify(createdNode.kind)}, parent ${JSON.stringify(createdNode.parent_id ?? null)}`
            : violations.slice(0, 8).join(" | "),
        held: violations.length === 0 && createdNode?.kind === "server",
      });

      if (claimed("tree.read")) {
        const treeAfterTheAdd = await session.request("get_component_tree", {});
        const rowAfterTheAdd = Array.isArray(treeAfterTheAdd.result)
          ? treeAfterTheAdd.result.find((node) => node.id === createdNode.id)
          : null;
        ledger.recordClaimedCapabilityAssertion({
          capability: "server.add",
          wireMethod: "add_server",
          title: `the server add_server created, ${createdNode.id}, is in the component tree afterwards`,
          contractCitation:
            'contract.yaml types.Node.kind carries `server` because without it "the client cannot tell a server row from a folder row"; add_server ' +
            "returns the Node it created, so a row the tree does not carry is a card the add-server grid could draw and the tree could not",
          expected: `get_component_tree carries ${createdNode.id} with kind "server"`,
          actual:
            rowAfterTheAdd === null || rowAfterTheAdd === undefined
              ? `${createdNode.id} is not in the tree that came back: ${JSON.stringify(treeAfterTheAdd.error ?? (Array.isArray(treeAfterTheAdd.result) ? `${treeAfterTheAdd.result.length} row(s)` : treeAfterTheAdd.result))?.slice(0, 200)}`
              : `${rowAfterTheAdd.id}, kind ${JSON.stringify(rowAfterTheAdd.kind)}`,
          held: rowAfterTheAdd !== null && rowAfterTheAdd !== undefined && rowAfterTheAdd.kind === "server",
        });
      }

      console.log(
        `add_server "${theServerThisSweepAdded.typeId}" created ${createdNode.id}, and on a host holding a real openDAQ Instance that server is now ` +
          "HOLDING A LISTENING SOCKET on whatever port its type defaults to - nothing on this wire reports the port, so this sweep cannot print it. " +
          `${createdNode.id} is removed with remove_server after the discovery section below, and contract.yaml operations[remove_server] is why that ` +
          "closes the socket rather than only delisting the row: ServerImpl::removed (server_impl.h:199-202) is `checkErrorInfo(stop()); Super::removed();`.",
      );
    }

    ledger.recordNotProvokable({
      capability: "server.add",
      wireMethod: "add_server",
      title: 'the "invalid_value" error code of add_server was not provoked',
      contractCitation:
        `contract.yaml operations[add_server].errors = [${operationOf("add_server").errors.join(", ")}]; ` +
        '"invalid_value: the type exists and the instance refused this addition"',
      reason:
        "add_server takes one parameter and it is a type id, so the only well-formed requests a wire client can send are a type the host listed " +
        "and a type it did not; the first is the success path driven above and the second is the unsupported path driven above it. An instance " +
        "that accepts the type and then refuses the addition is a state inside the host that no input on this row can shape",
    });
  }

  // =========================================================================
  // server.discovery: set_server_discovery_enabled
  // =========================================================================
  console.log("\nserver.discovery: set_server_discovery_enabled");
  // The row this section acts on: one the host published at startup if it has
  // one, and otherwise the row add_server created above. Most hosts publish
  // none, which is why this section used to have nothing to drive at all.
  const theServerRowDiscoveryIsDrivenOn = aServerNode ?? theServerThisSweepAdded?.node ?? null;
  if (!claimed("server.discovery")) {
    await driveGappedOperation(ledger, contract, session, operationOf("set_server_discovery_enabled"), discovered, gapsByCapability);
  } else {
    if (theServerRowDiscoveryIsDrivenOn === null) {
      ledger.recordNotProvokable({
        capability: "server.discovery",
        wireMethod: "set_server_discovery_enabled",
        title: "set_server_discovery_enabled could not be driven against a server row",
        contractCitation:
          'contract.yaml operations[set_server_discovery_enabled].params node_id, references Node.id; types.Node.kind carries `server` because "the client cannot tell a server row from a folder row" without it',
        reason:
          "this host's component tree carried no node of kind server, and add_server created none either - every server type this host listed " +
          "refused the addition, which the server.add section above records type by type",
      });
    } else {
      console.log(
        `the server row this section drives is ${theServerRowDiscoveryIsDrivenOn.id}, ` +
          `${theServerRowDiscoveryIsDrivenOn === theServerThisSweepAdded?.node ? `created moments ago by add_server "${theServerThisSweepAdded.typeId}" and removed again below` : "published by this host at startup and left in place"}`,
      );
      for (const enabled of [false, true]) {
        const response = await session.request("set_server_discovery_enabled", { node_id: theServerRowDiscoveryIsDrivenOn.id, enabled });
        const judged = judgeResponseEnvelope(ledger, contract, {
          response,
          wireMethod: "set_server_discovery_enabled",
          capability: "server.discovery",
          capabilityIsClaimed: true,
          describedAs: `${theServerRowDiscoveryIsDrivenOn.id} enabled=${enabled}`,
        });
        ledger.recordClaimedCapabilityAssertion({
          capability: "server.discovery",
          wireMethod: "set_server_discovery_enabled",
          title: `set_server_discovery_enabled ${theServerRowDiscoveryIsDrivenOn.id} enabled=${enabled} is accepted and returns void`,
          contractCitation:
            'contract.yaml operations[set_server_discovery_enabled]: "ONE ROW WITH A BOOLEAN, NOT TWO ROWS ... the row menu still draws two items, each sending this method with a different `enabled`"; returns = void',
          expected: "a result envelope carrying null",
          actual: judged.isError ? `error ${judged.code}: ${judged.detail}` : `result ${JSON.stringify(judged.result)}`,
          held: !judged.isError && (judged.result === null || judged.result === undefined),
        });
      }
      console.log(
        `set_server_discovery_enabled was driven on ${theServerRowDiscoveryIsDrivenOn.id} with false and then true, and this sweep LEAVES DISCOVERY ENABLED there. ` +
          "It cannot restore what it cannot read: contract.yaml says of this row \"THERE IS NO GETTER AND THERE CANNOT BE ONE\", having " +
          "enumerated the Python binding's IServer surface and openDAQ's own server.h and found no discovery-state member in either. " +
          "true is the value left because contract.yaml records that the reference calls enable_discovery immediately after add_server, so it " +
          "is the state a server row is created in, and because silencing a server that other clients scan for is a larger change than advertising one.",
      );
      ledger.recordUnconstrained({
        title: `what discovery state ${theServerRowDiscoveryIsDrivenOn.id} was in before this sweep touched it, and what it is left in`,
        contractCitation:
          'contract.yaml operations[set_server_discovery_enabled]: "THERE IS NO GETTER AND THERE CANNOT BE ONE ... So this state cannot be a Node field the way `active` and `locked` are: no host can fill it."',
        reason: "the contract fixes the setter and states that the state behind it is unreadable, so a sweep cannot restore what it found and cannot assert what it left",
        observation: `this sweep sent enabled=false and then enabled=true to ${theServerRowDiscoveryIsDrivenOn.id}; it is left with discovery enabled, and no operation of this contract can confirm that`,
      });

      // unsupported: a node that exists and is not a server.
      if (aNodeThatIsNotAServer === null) {
        ledger.recordNotProvokable({
          capability: "server.discovery",
          wireMethod: "set_server_discovery_enabled",
          title: 'the "unsupported" error code of set_server_discovery_enabled could not be provoked',
          contractCitation: `contract.yaml operations[set_server_discovery_enabled].errors = [${operationOf("set_server_discovery_enabled").errors.join(", ")}]`,
          reason: "every node in the tree this host returned is of kind server, so there is no existing non-server row to address",
        });
      } else {
        await refuseWithOneOf(ledger, contract, session, {
          wireMethod: "set_server_discovery_enabled",
          params: { node_id: aNodeThatIsNotAServer.id, enabled: true },
          title: `set_server_discovery_enabled on ${aNodeThatIsNotAServer.id}, a node of kind ${aNodeThatIsNotAServer.kind} and not a server, is refused with unsupported`,
          contractCitation:
            `contract.yaml operations[set_server_discovery_enabled].errors = [${operationOf("set_server_discovery_enabled").errors.join(", ")}]; ` +
            '"unsupported: the component exists but is not a server - the same use get_device_operation_modes makes of this code for a node that is not a device"',
          acceptableCodes: ["unsupported"],
        });
      }
    }

    await refuseWithOneOf(ledger, contract, session, {
      wireMethod: "set_server_discovery_enabled",
      params: { node_id: CONFORMANCE_UNKNOWN_NODE_ID, enabled: true },
      title: `set_server_discovery_enabled on the unknown node "${CONFORMANCE_UNKNOWN_NODE_ID}" is refused with not_found`,
      contractCitation: `contract.yaml operations[set_server_discovery_enabled].errors = [${operationOf("set_server_discovery_enabled").errors.join(", ")}]; "not_found: node_id names no component"`,
      acceptableCodes: ["not_found"],
    });

    ledger.recordNotProvokable({
      capability: "server.discovery",
      wireMethod: "set_server_discovery_enabled",
      title: 'the "internal" error code of set_server_discovery_enabled was not provoked',
      contractCitation: `contract.yaml operations[set_server_discovery_enabled].errors = [${operationOf("set_server_discovery_enabled").errors.join(", ")}]; "internal: mDNS advertising failed"`,
      reason: "a failed mDNS advertisement is a fact about the host's network stack; no well-formed request can shape one, and nothing on the wire can take mDNS away from a healthy host",
    });
  }

  // =========================================================================
  // server.add, the other half: the server this sweep added is taken down
  // =========================================================================
  //
  // THIS RUNS WHATEVER HAPPENED ABOVE. Everything before it can be recorded and
  // moved past; a listening socket cannot. If add_server created a server, it is
  // removed here, and a removal that is refused is said out loud in the log as
  // well as in the ledger, because what is then left behind is a bound port
  // inside a host process and not a cell in a table.
  if (theServerThisSweepAdded !== null) {
    const createdNode = theServerThisSweepAdded.node;
    console.log(
      `\nserver.add: taking down ${createdNode.id}, the server add_server created from type "${theServerThisSweepAdded.typeId}" earlier in this sweep`,
    );
    const removeResponse = await session.request("remove_server", { node_id: createdNode.id });
    const judgedRemove = judgeResponseEnvelope(ledger, contract, {
      response: removeResponse,
      wireMethod: "remove_server",
      capability: "server.add",
      capabilityIsClaimed: true,
      describedAs: `${createdNode.id}, created by this sweep`,
    });
    ledger.recordClaimedCapabilityAssertion({
      capability: "server.add",
      wireMethod: "remove_server",
      title: `remove_server ${createdNode.id}, the server this sweep added, is accepted and returns void`,
      contractCitation:
        'contract.yaml operations[remove_server].returns = void; the row is IDevice::removeServer(IServer*) - "device.h:300-304, Removes the server ' +
        'provided as argument - which device_impl.h:1014-1026 wraps to onRemoveServer (:1479-1487), the exact mirror of onAddServer (:1465-1476)". ' +
        '"THE SOCKET ACTUALLY CLOSES ... ServerImpl::removed (server_impl.h:199-202) is `checkErrorInfo(stop()); Super::removed();` - IServer::stop, ' +
        "whose own doc (server.h:55) is \"Stops the server. This is called when we remove the server from the Instance or Instance is closing.\"\"",
      expected: "a result envelope carrying null, and with it the listening socket add_server opened",
      actual: judgedRemove.isError
        ? `error ${judgedRemove.code}: ${judgedRemove.detail} - THE SERVER THIS SWEEP CREATED IS STILL IN THE HOST, and so is its listening socket`
        : `result ${JSON.stringify(judgedRemove.result)}`,
      held: !judgedRemove.isError && (judgedRemove.result === null || judgedRemove.result === undefined),
    });
    if (judgedRemove.isError) {
      console.log(
        `THE SERVER THIS SWEEP ADDED COULD NOT BE REMOVED. remove_server ${createdNode.id} was refused with ` +
          `${judgedRemove.code}: ${judgedRemove.detail}. The host still holds the server add_server created from type ` +
          `"${theServerThisSweepAdded.typeId}", and with it whatever port that server type binds. Stop this host process to release it.`,
      );
    } else {
      console.log(`remove_server ${createdNode.id} was accepted; the socket add_server opened is closed with it.`);
    }

    if (claimed("tree.read")) {
      const treeAfterTheRemoval = await session.request("get_component_tree", {});
      const rowsAfterTheRemoval = Array.isArray(treeAfterTheRemoval.result) ? treeAfterTheRemoval.result : [];
      const rowStillThere = rowsAfterTheRemoval.find((node) => node.id === createdNode.id) ?? null;
      ledger.recordClaimedCapabilityAssertion({
        capability: "server.add",
        wireMethod: "remove_server",
        title: `${createdNode.id} is gone from the component tree after remove_server`,
        contractCitation:
          'contract.yaml operations[remove_server]: "`this->servers.removeItem(server)`" via folder_impl.h:598-605, which "removes the item, which ' +
          'calls IComponent::removed". A row that survives its own removal is a card the client would keep drawing for a server that is not there.',
        expected: `get_component_tree carries no node with id ${createdNode.id}`,
        actual:
          rowStillThere === null
            ? `${rowsAfterTheRemoval.length} row(s) came back and none of them is ${createdNode.id}`
            : `${createdNode.id} is STILL IN THE TREE, kind ${JSON.stringify(rowStillThere.kind)}`,
        held: rowStillThere === null,
      });
    }

    // The same removal again: the node is gone, so the row's own not_found is
    // the answer, and this is the one place the suite can ask it of an id that
    // WAS real rather than one that never was.
    await refuseWithOneOf(ledger, contract, session, {
      wireMethod: "remove_server",
      params: { node_id: createdNode.id },
      title: `remove_server ${createdNode.id} a second time, after it has been removed, is refused with not_found`,
      contractCitation:
        `contract.yaml operations[remove_server].errors = [${operationOf("remove_server").errors.join(", ")}]; "not_found: node_id names no component". ` +
        "This id named a component one request ago, so a host that still answers a result here has not removed anything.",
      acceptableCodes: ["not_found"],
    });

    ledger.recordNotProvokable({
      capability: "server.add",
      wireMethod: "remove_server",
      title: 'the "internal" error code of remove_server was not provoked',
      contractCitation:
        `contract.yaml operations[remove_server].errors = [${operationOf("remove_server").errors.join(", ")}]; ` +
        '"internal: stop() threw while closing the listening socket, which is native text for error.detail"',
      reason:
        "IServer::stop throwing on the way down is a fault inside the host's own socket teardown; no parameter of this row reaches it, and a " +
        "wire client cannot make a healthy server fail to close",
    });
  }

  // =========================================================================
  // recorder.control: start_recording, stop_recording
  // =========================================================================
  console.log("\nrecorder.control: start_recording, stop_recording");
  if (!claimed("recorder.control")) {
    await driveGappedOperation(ledger, contract, session, operationOf("start_recording"), discovered, gapsByCapability);
    await driveGappedOperation(ledger, contract, session, operationOf("stop_recording"), discovered, gapsByCapability);
  } else {
    if (aRecorderNode === null) {
      for (const wireMethod of ["start_recording", "stop_recording"]) {
        ledger.recordNotProvokable({
          capability: "recorder.control",
          wireMethod,
          title: `the success path of ${wireMethod} was not driven`,
          contractCitation:
            'contract.yaml types.Node.recording: "IRecorder::getIsRecording(Bool*), recorder.h:62. Recorder function-block rows only; null on every other kind." It is what decides whether the Start/Stop control exists at all.',
          reason:
            `no node in this host's component tree reports a non-null Node.recording, so by the contract's own test no row here is a recorder ` +
            `(${treeNodes.length} node(s) were read, every one reporting recording null). The failure paths below are still driven.`,
        });
      }
    } else {
      const wasRecording = aRecorderNode.recording === true;
      console.log(
        `the recorder row this sweep acts on is ${aRecorderNode.id} (kind ${aRecorderNode.kind}), found with Node.recording ${JSON.stringify(aRecorderNode.recording)}; ` +
          "it will be left in that state",
      );

      const startResponse = await session.request("start_recording", { node_id: aRecorderNode.id });
      const judgedStart = judgeResponseEnvelope(ledger, contract, {
        response: startResponse,
        wireMethod: "start_recording",
        capability: "recorder.control",
        capabilityIsClaimed: true,
        describedAs: aRecorderNode.id,
      });
      ledger.recordClaimedCapabilityAssertion({
        capability: "recorder.control",
        wireMethod: "start_recording",
        title: `start_recording ${aRecorderNode.id} is accepted and returns void`,
        contractCitation:
          'contract.yaml operations[start_recording].returns = void; the row is one half of "the reference\'s single Start/Stop button (recorder_view.py:90-106)"',
        expected: "a result envelope carrying null",
        actual: judgedStart.isError ? `error ${judgedStart.code}: ${judgedStart.detail}` : `result ${JSON.stringify(judgedStart.result)}`,
        held: !judgedStart.isError && (judgedStart.result === null || judgedStart.result === undefined),
      });

      if (!judgedStart.isError) {
        await assertTheTreeReportsRecording(ledger, contract, session, {
          nodeId: aRecorderNode.id,
          shouldBeRecording: true,
          wireMethod: "start_recording",
          whenItWasRead: "after this session's own start_recording",
          claimed,
        });
      }

      const stopResponse = await session.request("stop_recording", { node_id: aRecorderNode.id });
      const judgedStop = judgeResponseEnvelope(ledger, contract, {
        response: stopResponse,
        wireMethod: "stop_recording",
        capability: "recorder.control",
        capabilityIsClaimed: true,
        describedAs: aRecorderNode.id,
      });
      ledger.recordClaimedCapabilityAssertion({
        capability: "recorder.control",
        wireMethod: "stop_recording",
        title: `stop_recording ${aRecorderNode.id} is accepted and returns void`,
        contractCitation: "contract.yaml operations[stop_recording].returns = void",
        expected: "a result envelope carrying null",
        actual: judgedStop.isError ? `error ${judgedStop.code}: ${judgedStop.detail}` : `result ${JSON.stringify(judgedStop.result)}`,
        held: !judgedStop.isError && (judgedStop.result === null || judgedStop.result === undefined),
      });

      if (!judgedStop.isError) {
        await assertTheTreeReportsRecording(ledger, contract, session, {
          nodeId: aRecorderNode.id,
          shouldBeRecording: false,
          wireMethod: "stop_recording",
          whenItWasRead: "after this session's own stop_recording",
          claimed,
        });
      }

      if (wasRecording) {
        const restarted = await session.request("start_recording", { node_id: aRecorderNode.id });
        console.log(
          `${aRecorderNode.id} was found already recording, so recording was started again to leave it as it was found: the host ${describeAnswer(restarted)}`,
        );
      }
    }

    // --- unsupported: a node that exists and is not a recorder --------------
    for (const wireMethod of ["start_recording", "stop_recording"]) {
      if (aNodeThatReportsNoRecordingState === null) {
        ledger.recordNotProvokable({
          capability: "recorder.control",
          wireMethod,
          title: `the "unsupported" error code of ${wireMethod} could not be provoked`,
          contractCitation: `contract.yaml operations[${wireMethod}].errors = [${operationOf(wireMethod).errors.join(", ")}]`,
          reason: "every node in this host's tree reports a non-null Node.recording, so every one of them is a recorder and there is no non-recorder row to address",
        });
      } else {
        await refuseWithOneOf(ledger, contract, session, {
          wireMethod,
          params: { node_id: aNodeThatReportsNoRecordingState.id },
          title: `${wireMethod} on ${aNodeThatReportsNoRecordingState.id}, a node of kind ${aNodeThatReportsNoRecordingState.kind} reporting Node.recording null, is refused with unsupported`,
          contractCitation:
            `contract.yaml operations[${wireMethod}].errors = [${operationOf(wireMethod).errors.join(", ")}]; ` +
            '"unsupported: the component exists and is not a recorder, i.e. the cast block_view.py:169 performs would fail." not_found would be a lie about a node that is in the tree.',
          acceptableCodes: ["unsupported"],
        });
      }

      await refuseWithOneOf(ledger, contract, session, {
        wireMethod,
        params: { node_id: CONFORMANCE_UNKNOWN_NODE_ID },
        title: `${wireMethod} on the unknown node "${CONFORMANCE_UNKNOWN_NODE_ID}" is refused with not_found`,
        contractCitation: `contract.yaml operations[${wireMethod}].errors = [${operationOf(wireMethod).errors.join(", ")}]; "not_found: node_id names nothing"`,
        acceptableCodes: ["not_found"],
      });

      ledger.recordNotProvokable({
        capability: "recorder.control",
        wireMethod,
        title: `the "internal" error code of ${wireMethod} was not provoked`,
        contractCitation: `contract.yaml operations[${wireMethod}].errors = [${operationOf(wireMethod).errors.join(", ")}]`,
        reason:
          'internal here is "IRecorder::startRecording threw - no writable path, a file already open, a device error", which are facts about the host\'s filesystem and its device; a wire client can shape none of them from a well-formed request',
      });
    }
  }

  // =========================================================================
  // property.batched_update: begin_batched_property_update, end_batched_property_update
  // =========================================================================
  console.log("\nproperty.batched_update: begin_batched_property_update, end_batched_property_update");
  if (!claimed("property.batched_update")) {
    await driveGappedOperation(ledger, contract, session, operationOf("begin_batched_property_update"), discovered, gapsByCapability);
    await driveGappedOperation(ledger, contract, session, operationOf("end_batched_property_update"), discovered, gapsByCapability);
  } else if (!deviceNodeId) {
    for (const wireMethod of ["begin_batched_property_update", "end_batched_property_update"]) {
      ledger.recordNotProvokable({
        capability: "property.batched_update",
        wireMethod,
        title: `${wireMethod} could not be driven`,
        contractCitation: `contract.yaml operations[${wireMethod}].params node_id, references Node.id`,
        reason: "connect_device produced no device node id in this session, so there is no component to bracket writes on",
      });
    }
  } else {
    const beginResponse = await session.request("begin_batched_property_update", { node_id: deviceNodeId });
    const judgedBegin = judgeResponseEnvelope(ledger, contract, {
      response: beginResponse,
      wireMethod: "begin_batched_property_update",
      capability: "property.batched_update",
      capabilityIsClaimed: true,
      describedAs: deviceNodeId,
    });
    ledger.recordClaimedCapabilityAssertion({
      capability: "property.batched_update",
      wireMethod: "begin_batched_property_update",
      title: `begin_batched_property_update ${deviceNodeId} is accepted and returns void`,
      contractCitation: "contract.yaml operations[begin_batched_property_update].returns = void; the row is IPropertyObject::beginUpdate",
      expected: "a result envelope carrying null",
      actual: judgedBegin.isError ? `error ${judgedBegin.code}: ${judgedBegin.detail}` : `result ${JSON.stringify(judgedBegin.result)}`,
      held: !judgedBegin.isError && (judgedBegin.result === null || judgedBegin.result === undefined),
    });

    const aBatchIsOpen = !judgedBegin.isError;
    if (aBatchIsOpen) {
      await assertTheTreeReportsUpdating(ledger, contract, session, {
        nodeId: deviceNodeId,
        shouldBeUpdating: true,
        wireMethod: "begin_batched_property_update",
        whenItWasRead: "while this session holds a batch open on it",
        claimed,
      });
    }

    // --- the write that must be HELD rather than applied -------------------
    const heldWriteRow = aBatchIsOpen ? pickAWritablePropertyUnder(discovered, deviceNodeId) : null;
    if (aBatchIsOpen && heldWriteRow === null) {
      ledger.recordNotProvokable({
        capability: "property.batched_update",
        wireMethod: "begin_batched_property_update",
        title: "whether a batched update actually HOLDS a property write could not be driven",
        contractCitation:
          'contract.yaml operations[begin_batched_property_update]: "Between the two, setPropertyValue does not apply the value; endUpdate applies everything set in between (property_object.h:330-349)"',
        reason: claimed("property.write")
          ? `no descriptor under ${deviceNodeId} was both read_only false and of value_type bool, int or float, so there is no write this sweep may make blind`
          : "this host declared property.write a gap, so there is no write for a batch to hold",
      });
    } else if (aBatchIsOpen) {
      const submitted = heldWriteRow.descriptor.value_type === "bool" ? !heldWriteRow.value : Number(heldWriteRow.value) + 1;
      const writeDuringBatch = await session.request("set_property_value", {
        node_id: heldWriteRow.nodeId,
        property_id: heldWriteRow.descriptor.id,
        value: submitted,
      });
      const judgedWriteDuringBatch = judgeResponseEnvelope(ledger, contract, {
        response: writeDuringBatch,
        wireMethod: "set_property_value",
        capability: "property.write",
        capabilityIsClaimed: claimed("property.write"),
        describedAs: "while a batch is open on the device",
      });
      const duringBatch = await readOneProperty(session, heldWriteRow.nodeId, heldWriteRow.descriptor.id);
      ledger.recordClaimedCapabilityAssertion({
        capability: "property.batched_update",
        wireMethod: "begin_batched_property_update",
        title: `a write of ${JSON.stringify(submitted)} to ${heldWriteRow.nodeId}.${heldWriteRow.descriptor.id} made while a batch is open on ${deviceNodeId} is HELD, not applied`,
        contractCitation:
          'contract.yaml operations[begin_batched_property_update]: "Between the two, setPropertyValue does not apply the value; endUpdate applies everything set in between (property_object.h:330-349)"; types.Node.updating: "While that holds, every set_property_value against the component is HELD rather than applied." beginUpdate is recursive over child property objects, so a batch on the device covers this node.',
        expected: `the read-back still reports the pre-batch value ${JSON.stringify(heldWriteRow.value)}`,
        actual: judgedWriteDuringBatch.isError
          ? `the write itself was refused: ${judgedWriteDuringBatch.code}: ${judgedWriteDuringBatch.detail}`
          : `the write was accepted and the read-back during the batch reports ${JSON.stringify(duringBatch)} (it was ${JSON.stringify(heldWriteRow.value)} before)`,
        held: !judgedWriteDuringBatch.isError && JSON.stringify(duringBatch) === JSON.stringify(heldWriteRow.value),
      });

      const endResponse = await session.request("end_batched_property_update", { node_id: deviceNodeId });
      const judgedEnd = judgeResponseEnvelope(ledger, contract, {
        response: endResponse,
        wireMethod: "end_batched_property_update",
        capability: "property.batched_update",
        capabilityIsClaimed: true,
        describedAs: deviceNodeId,
      });
      ledger.recordClaimedCapabilityAssertion({
        capability: "property.batched_update",
        wireMethod: "end_batched_property_update",
        title: `end_batched_property_update ${deviceNodeId} is accepted and returns void`,
        contractCitation: "contract.yaml operations[end_batched_property_update].returns = void; the row is IPropertyObject::endUpdate",
        expected: "a result envelope carrying null",
        actual: judgedEnd.isError ? `error ${judgedEnd.code}: ${judgedEnd.detail}` : `result ${JSON.stringify(judgedEnd.result)}`,
        held: !judgedEnd.isError && (judgedEnd.result === null || judgedEnd.result === undefined),
      });

      const afterEnd = await readOneProperty(session, heldWriteRow.nodeId, heldWriteRow.descriptor.id);
      // The same coercion rule sweep 2 applies to its own round trip:
      // types.PropertyDescriptor.coercer means a numeric write may not come back
      // as it was sent, so only a bool - which has no range to coerce into - is
      // held to exact equality. What is demanded of a number is that the value
      // MOVED, because a value that did not move is a batch that was discarded.
      const exactRoundTripDemanded = heldWriteRow.descriptor.value_type === "bool";
      ledger.recordClaimedCapabilityAssertion({
        capability: "property.batched_update",
        wireMethod: "end_batched_property_update",
        title: `end_batched_property_update applies the write that was held on ${heldWriteRow.nodeId}.${heldWriteRow.descriptor.id}`,
        contractCitation:
          'contract.yaml operations[begin_batched_property_update]: "endUpdate applies everything set in between (property_object.h:330-349)". A batch that ends without applying its writes would tell a user their batch landed when it did not. ' +
          (exactRoundTripDemanded
            ? "A bool has no coercer range, so the read-back must equal what was written."
            : "contract.yaml types.PropertyDescriptor.coercer means a numeric write may be coerced, so the read-back is only required to differ from the value the batch opened on."),
        expected: exactRoundTripDemanded
          ? `the read-back reports ${JSON.stringify(submitted)}`
          : `the read-back differs from the pre-batch value ${JSON.stringify(heldWriteRow.value)}`,
        actual: `${JSON.stringify(afterEnd)} (it was ${JSON.stringify(heldWriteRow.value)} before the batch, and ${JSON.stringify(submitted)} was written inside it)`,
        held: exactRoundTripDemanded
          ? JSON.stringify(afterEnd) === JSON.stringify(submitted)
          : JSON.stringify(afterEnd) !== JSON.stringify(heldWriteRow.value),
      });

      await assertTheTreeReportsUpdating(ledger, contract, session, {
        nodeId: deviceNodeId,
        shouldBeUpdating: false,
        wireMethod: "end_batched_property_update",
        whenItWasRead: "after this session's own end_batched_property_update",
        claimed,
      });

      const restored = await session.request("set_property_value", {
        node_id: heldWriteRow.nodeId,
        property_id: heldWriteRow.descriptor.id,
        value: heldWriteRow.value,
      });
      console.log(
        `restored ${heldWriteRow.nodeId}.${heldWriteRow.descriptor.id} to the value it was found with, ${JSON.stringify(heldWriteRow.value)}: ` +
          `the host ${describeAnswer(restored)}`,
      );
    } else {
      // begin was refused, so there is no batch to end; the out-of-order end
      // below still drives the row.
      console.log(
        `begin_batched_property_update ${deviceNodeId} was refused, so no batch was opened and the held-write assertion could not be made`,
      );
    }

    // --- invalid_value: an end with no begin open --------------------------
    await refuseWithOneOf(ledger, contract, session, {
      wireMethod: "end_batched_property_update",
      params: { node_id: deviceNodeId },
      title: `end_batched_property_update ${deviceNodeId} with no batch open is refused with invalid_value, never swallowed`,
      contractCitation:
        `contract.yaml operations[end_batched_property_update].errors = [${operationOf("end_batched_property_update").errors.join(", ")}]; ` +
        '"invalid_value is this row\'s and not begin\'s: endUpdate raises when no beginUpdate is open, and the reference swallows exactly that with a bare `except RuntimeError: pass` ... A host must not swallow it the way the reference does: silence here would tell a user their batch was applied."',
      acceptableCodes: ["invalid_value"],
    });

    // --- not_found, on both rows -------------------------------------------
    for (const wireMethod of ["begin_batched_property_update", "end_batched_property_update"]) {
      await refuseWithOneOf(ledger, contract, session, {
        wireMethod,
        params: { node_id: CONFORMANCE_UNKNOWN_NODE_ID },
        title: `${wireMethod} on the unknown node "${CONFORMANCE_UNKNOWN_NODE_ID}" is refused with not_found`,
        contractCitation:
          `contract.yaml operations[${wireMethod}].errors = [${operationOf(wireMethod).errors.join(", ")}]; "not_found: node_id names no component"`,
        acceptableCodes: ["not_found"],
      });
    }

    // --- the abandoned batch, which is what Node.updating exists for --------
    //
    // It gets a THIRD socket of its own rather than reusing the unconnected
    // one, and that is not tidiness: this session has to connect_device (a
    // batch is opened on a component, and a component is reached through a
    // device this session holds) and then be CLOSED while the batch is open.
    // Either of those would ruin the second session for what it is for - the
    // not_connected corner of six rows, which only a session that has connected
    // nothing can be asked, and which is asked after this.
    const abandonedBatchSession = await driveTheAbandonedBatch(ledger, contract, session, {
      deviceNodeId,
      connectionString: discovered.connectionString,
      contract,
      options,
      claimed,
    });
    if (abandonedBatchSession !== null) sessionsOpenedByThisSweep.push(abandonedBatchSession);
  }

  // =========================================================================
  // configuration.save and configuration.load
  // =========================================================================
  console.log("\nconfiguration.save, configuration.load: save_instance_configuration_to_string, load_instance_configuration_from_string");
  let savedConfiguration = null;
  if (!claimed("configuration.save")) {
    await driveGappedOperation(ledger, contract, session, operationOf("save_instance_configuration_to_string"), discovered, gapsByCapability);
  } else {
    const response = await session.request("save_instance_configuration_to_string", {});
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod: "save_instance_configuration_to_string",
      capability: "configuration.save",
      capabilityIsClaimed: true,
    });
    const isANonEmptyString = typeof judged.result === "string" && judged.result.length > 0;
    ledger.recordClaimedCapabilityAssertion({
      capability: "configuration.save",
      wireMethod: "save_instance_configuration_to_string",
      title: "save_instance_configuration_to_string returns a non-empty string",
      contractCitation:
        'contract.yaml operations[save_instance_configuration_to_string].returns = {type: string, semantic: opendaq_instance_configuration_json}: "The serialised configuration, whole, as openDAQ produced it. Opaque: no client parses it, no client edits it, and this contract declares nothing about its shape beyond it being the string saveConfiguration returned."',
      expected: "a string result",
      actual: judged.isError
        ? `error ${judged.code}: ${judged.detail}`
        : isANonEmptyString
          ? `${judged.result.length} characters, beginning ${JSON.stringify(judged.result.slice(0, 120))}`
          : `not a non-empty string: ${JSON.stringify(judged.result)?.slice(0, 200)}`,
      held: !judged.isError && isANonEmptyString,
    });
    if (isANonEmptyString) savedConfiguration = judged.result;

    await askTheUnconnectedSession(
      "save_instance_configuration_to_string",
      {},
      "save_instance_configuration_to_string, asked from a session that has connected no device, either answers a string or refuses not_connected",
      `contract.yaml operations[save_instance_configuration_to_string].errors = [${operationOf("save_instance_configuration_to_string").errors.join(", ")}] and params = []. "not_connected: no instance to serialise" - and whether a host has an instance before any device is connected is not something the contract settles, exactly as it does not for list_loaded_modules, so both answers conform`,
      "a string result, or error not_connected",
      (judged2) => (judged2.isError ? judged2.code === "not_connected" : typeof judged2.result === "string"),
    );

    ledger.recordNotProvokable({
      capability: "configuration.save",
      wireMethod: "save_instance_configuration_to_string",
      title: 'the "internal" error code of save_instance_configuration_to_string was not provoked',
      contractCitation:
        `contract.yaml operations[save_instance_configuration_to_string].errors = [${operationOf("save_instance_configuration_to_string").errors.join(", ")}]; ` +
        '"internal: saveConfiguration threw, or the result does not fit this host\'s declared max_frame_bytes - detail carries both byte counts"',
      reason:
        "this row takes no parameters at all, so there is no input a wire client can shape. The frame-limit path would need the instance's serialised " +
        "form to be pushed past handshake.limits.max_frame_bytes, and the only wire lever on that is set_property_value against whichever property of " +
        "whichever node happens to enlarge THIS host's serialisation - which is a fact about one host's device and not about the contract, and a sweep " +
        "that went looking for it would be testing a host it had identified rather than a contract it had read",
    });
  }

  if (!claimed("configuration.load")) {
    await driveGappedOperation(ledger, contract, session, operationOf("load_instance_configuration_from_string"), discovered, gapsByCapability);
  } else {
    // --- invalid_value: a string that is not a configuration ---------------
    //
    // Driven FIRST, and deliberately: it is the only load in this sweep that
    // cannot change anything, so it is made before the one that can.
    await refuseWithOneOf(ledger, contract, session, {
      wireMethod: "load_instance_configuration_from_string",
      params: { configuration: CONFORMANCE_TEXT_THAT_IS_NOT_AN_INSTANCE_CONFIGURATION },
      title: "load_instance_configuration_from_string with a string that is not a configuration at all is refused with invalid_value",
      contractCitation:
        `contract.yaml operations[load_instance_configuration_from_string].errors = [${operationOf("load_instance_configuration_from_string").errors.join(", ")}]; ` +
        '"invalid_value: the string is not a configuration openDAQ will load - not parseable, or describing devices this instance cannot reconcile. This is the likeliest answer a user will ever see from this row"',
      acceptableCodes: ["invalid_value"],
    });

    await askTheUnconnectedSession(
      "load_instance_configuration_from_string",
      { configuration: CONFORMANCE_TEXT_THAT_IS_NOT_AN_INSTANCE_CONFIGURATION },
      "load_instance_configuration_from_string with an unloadable string, asked from a session that has connected no device, is refused with a code from its own subset",
      `contract.yaml operations[load_instance_configuration_from_string].errors = [${operationOf("load_instance_configuration_from_string").errors.join(", ")}]; "not_connected: no instance to load into". Both not_connected and invalid_value are true of this request and the contract does not order them, so either conforms`,
      `one of [${operationOf("load_instance_configuration_from_string").errors.join(", ")}]`,
      (judged2) => judged2.isError && operationOf("load_instance_configuration_from_string").errors.includes(judged2.code),
    );

    // --- the success path: the IDENTITY load, and nothing else -------------
    if (savedConfiguration === null) {
      ledger.recordNotProvokable({
        capability: "configuration.load",
        wireMethod: "load_instance_configuration_from_string",
        title: "the success path of load_instance_configuration_from_string was not driven",
        contractCitation:
          'contract.yaml capabilities[configuration.load]: "loading REPLACES the configuration of every device under the instance in one call"; operations[load_instance_configuration_from_string].params configuration: "The text of a configuration previously produced by save_instance_configuration_to_string, on this host or another."',
        reason: claimed("configuration.save")
          ? "save_instance_configuration_to_string did not return a string on this host, so this run holds no configuration it can be sure describes this instance. The only load this sweep will make on the success path is the one that reloads what save just produced; a configuration from anywhere else would replace every device's configuration with nothing to restore from."
          : "this host declared configuration.save a gap, so this run has no configuration string of this instance to load back. A configuration from anywhere else would replace every device's configuration permanently, and this sweep will not make a change it cannot undo.",
      });
    } else {
      const loadResponse = await session.request("load_instance_configuration_from_string", { configuration: savedConfiguration });
      const judgedLoad = judgeResponseEnvelope(ledger, contract, {
        response: loadResponse,
        wireMethod: "load_instance_configuration_from_string",
        capability: "configuration.load",
        capabilityIsClaimed: true,
        describedAs: `the ${savedConfiguration.length}-character configuration this host saved moments ago`,
      });
      ledger.recordClaimedCapabilityAssertion({
        capability: "configuration.load",
        wireMethod: "load_instance_configuration_from_string",
        title: `load_instance_configuration_from_string accepts the ${savedConfiguration.length}-character configuration save_instance_configuration_to_string returned on this same host, and returns void`,
        contractCitation:
          'contract.yaml operations[load_instance_configuration_from_string].params configuration: "The text of a configuration previously produced by save_instance_configuration_to_string, on this host or another"; returns = void. This is the identity load, and it is the only load this sweep makes on the success path: what it applies is the configuration the instance already has, so it is the one load with nothing left behind.',
        expected: "a result envelope carrying null",
        actual: judgedLoad.isError ? `error ${judgedLoad.code}: ${judgedLoad.detail}` : `result ${JSON.stringify(judgedLoad.result)}`,
        held: !judgedLoad.isError && (judgedLoad.result === null || judgedLoad.result === undefined),
      });

      if (claimed("tree.read")) {
        const treeAfter = await session.request("get_component_tree", {});
        const nodesAfter = Array.isArray(treeAfter.result) ? treeAfter.result : [];
        const stillThere = nodesAfter.some((node) => node.id === deviceNodeId);
        ledger.recordUnconstrained({
          title: `what the identity load left of the component tree on ${options.url}`,
          contractCitation:
            'contract.yaml operations[load_instance_configuration_from_string] fixes the parameter, the return and the error subset, and says nothing at all about what a load must preserve; capabilities[configuration.load] says only that it "REPLACES the configuration of every device under the instance in one call"',
          reason: "the contract constrains the call, never what the instance looks like afterwards, so nothing here can be passed or failed",
          observation:
            `before the load the tree carried ${treeNodes.length} node(s) and the device this run connected was ${deviceNodeId}; ` +
            `after it the tree carries ${nodesAfter.length} node(s) and that device id is ${stillThere ? "still present" : "NO LONGER PRESENT"}`,
        });
      }
    }

    ledger.recordNotProvokable({
      capability: "configuration.load",
      wireMethod: "load_instance_configuration_from_string",
      title: 'the "internal" error code of load_instance_configuration_from_string was not provoked',
      contractCitation:
        `contract.yaml operations[load_instance_configuration_from_string].errors = [${operationOf("load_instance_configuration_from_string").errors.join(", ")}]; ` +
        '"internal: the string parsed and applying it threw partway"',
      reason:
        "a configuration that parses and then throws partway through being applied is a configuration crafted against one host's device tree, and " +
        "building one would mean half-applying a replacement of every device's configuration with no way back - which is the change this sweep exists " +
        "to avoid making",
    });
  }

  if (secondSession !== null) {
    secondSession.close();
    console.log(
      `\nclosed this sweep's second WebSocket to ${options.url}; it sent ` +
        `${[...secondSession.requestsSentByWireMethod.values()].reduce((a, b) => a + b, 0)} request(s)`,
    );
  }
  return { sessionsOpenedByThisSweep };
}

// ---------------------------------------------------------------------------
// the small shapes the sections above share
// ---------------------------------------------------------------------------

/**
 * The attribute this sweep changes the value of and then restores.
 *
 * Order of preference, and each step of it is a decision about what a sweep may
 * move on a device somebody else is also using: a string first, because it is
 * the type whose "a different value" is unambiguous; then a string list, whose
 * different value is one more element; then a bool. `active` is excluded at
 * every step - see ATTRIBUTE_THE_SWEEP_NEVER_CHANGES_THE_VALUE_OF.
 */
function pickTheAttributeToChangeAndRestore(writableAttributes) {
  const movable = writableAttributes.filter(
    (attribute) => attribute.id !== ATTRIBUTE_THE_SWEEP_NEVER_CHANGES_THE_VALUE_OF && attribute.value !== null && attribute.value !== undefined,
  );
  return (
    movable.find((attribute) => attribute.value_type === "string" && typeof attribute.value === "string") ??
    movable.find((attribute) => attribute.value_type === "string_list" && Array.isArray(attribute.value)) ??
    movable.find((attribute) => attribute.value_type === "bool" && typeof attribute.value === "boolean") ??
    movable.find((attribute) => (attribute.value_type === "int" || attribute.value_type === "float") && typeof attribute.value === "number") ??
    null
  );
}

/** A value of the attribute's own declared type that differs from the one in force. */
function aDifferentValueOfTheSameType(attribute) {
  switch (attribute.value_type) {
    case "string":
      return `${attribute.value}${ATTRIBUTE_TEXT_THE_SWEEP_APPENDS}`;
    case "string_list":
      return [...attribute.value, ATTRIBUTE_TAG_THE_SWEEP_APPENDS];
    case "bool":
      return !attribute.value;
    case "int":
      return Number(attribute.value) + 1;
    case "float":
      return Number(attribute.value) + 1;
    default:
      throw new Error(
        `conformance/ does not know how to construct a different value for the ComponentAttribute value_type "${attribute.value_type}" of "${attribute.id}"; contract.yaml types.ComponentAttribute.value_type grew a value this sweep has never seen`,
      );
  }
}

/** Reads one attribute row back off get_component_attributes. */
async function readOneAttribute(session, nodeId, attributeId) {
  const response = await session.request("get_component_attributes", { node_id: nodeId });
  if (!Array.isArray(response.result)) return undefined;
  return response.result.find((attribute) => attribute.id === attributeId);
}

/** Reads one property value, returning the raw result or the error envelope's text. */
async function readOneProperty(session, nodeId, propertyId) {
  const response = await session.request("get_property_value", { node_id: nodeId, property_id: propertyId });
  if ("error" in response) return `(unreadable: ${response.error?.code}: ${String(response.error?.detail ?? "").slice(0, 120)})`;
  return response.result;
}

/**
 * A property sweep 2 already read, under this device, that this sweep may write
 * blind: read_only false and of a value_type whose "a different value" needs no
 * guess. The same test sweep 3 applies before it writes from the non-holder
 * session, and for the same reason.
 */
function pickAWritablePropertyUnder(discovered, deviceNodeId) {
  return (
    (discovered.readableProperties ?? []).find(
      (row) =>
        row.descriptor.read_only === false &&
        (row.descriptor.value_type === "bool" || row.descriptor.value_type === "int" || row.descriptor.value_type === "float") &&
        (typeof row.value === "boolean" || typeof row.value === "number") &&
        (row.nodeId === deviceNodeId || row.nodeId.startsWith(`${deviceNodeId}/`)),
    ) ?? null
  );
}

/** Reads the tree on one session and judges the recorder row's Node.recording. */
async function assertTheTreeReportsRecording(ledger, contract, session, { nodeId, shouldBeRecording, wireMethod, whenItWasRead, claimed }) {
  if (!claimed("tree.read")) {
    ledger.recordNotProvokable({
      capability: "recorder.control",
      wireMethod,
      title: `whether Node.recording is ${shouldBeRecording} ${whenItWasRead} could not be read`,
      contractCitation: "contract.yaml types.Node.recording carries IRecorder::getIsRecording",
      reason: "this host declared tree.read a gap, so there is no tree to read the recording state out of",
    });
    return;
  }
  const response = await session.request("get_component_tree", {});
  const row = Array.isArray(response.result) ? response.result.find((node) => node.id === nodeId) : null;
  const reported = row === null || row === undefined ? undefined : row.recording;
  if (reported === null) {
    ledger.recordUnconstrained({
      title: `Node.recording on ${nodeId} ${whenItWasRead}`,
      contractCitation:
        'contract.yaml types.Node.recording: "null therefore means BOTH not a recorder and this host does not report it, and the client draws no recorder control in either case"',
      reason: "null is the contract's own way for a host to say it does not report the recording state, so it is neither a gap nor a breach",
      observation: `this host reports Node.recording null on ${nodeId}; the sweep expected ${shouldBeRecording} there`,
    });
    return;
  }
  ledger.recordClaimedCapabilityAssertion({
    capability: "recorder.control",
    wireMethod,
    title: `get_component_tree reports Node.recording ${shouldBeRecording} on ${nodeId} ${whenItWasRead}`,
    contractCitation:
      'contract.yaml types.Node.recording: "IRecorder::getIsRecording(Bool*), recorder.h:62 ... the control is drawn or not drawn with no request at all." start_recording and stop_recording are "the two halves of the reference\'s single Start/Stop button", so a recording the tree does not show leaves that button wrong.',
    expected: `Node.recording === ${shouldBeRecording}`,
    actual:
      row === null || row === undefined
        ? `${nodeId} is not in the tree that came back: ${JSON.stringify(response.error ?? response.result)?.slice(0, 200)}`
        : `Node.recording ${JSON.stringify(reported)}`,
    held: reported === shouldBeRecording,
  });
}

/** Reads the tree on one session and judges the component's Node.updating. */
async function assertTheTreeReportsUpdating(ledger, contract, session, { nodeId, shouldBeUpdating, wireMethod, whenItWasRead, claimed }) {
  if (!claimed("tree.read")) {
    ledger.recordNotProvokable({
      capability: "property.batched_update",
      wireMethod,
      title: `whether Node.updating is ${shouldBeUpdating} ${whenItWasRead} could not be read`,
      contractCitation: "contract.yaml types.Node.updating carries IPropertyObject::getUpdating",
      reason: "this host declared tree.read a gap, so there is no tree to read the batch state out of",
    });
    return;
  }
  const response = await session.request("get_component_tree", {});
  const row = Array.isArray(response.result) ? response.result.find((node) => node.id === nodeId) : null;
  const reported = row === null || row === undefined ? undefined : row.updating;
  if (reported === null) {
    ledger.recordUnconstrained({
      title: `Node.updating on ${nodeId} ${whenItWasRead}`,
      contractCitation:
        'contract.yaml types.Node: "Every state field is nullable, and null means this host does not report it ... A host that cannot determine a field writes null rather than guessing a value."',
      reason: "null is the contract's own way for a host to say it does not report the batch state, so it is neither a gap nor a breach",
      observation: `this host reports Node.updating null on ${nodeId}; the sweep expected ${shouldBeUpdating} there`,
    });
    return;
  }
  ledger.recordClaimedCapabilityAssertion({
    capability: "property.batched_update",
    wireMethod,
    title: `get_component_tree reports Node.updating ${shouldBeUpdating} on ${nodeId} ${whenItWasRead}`,
    contractCitation:
      'contract.yaml types.Node.updating: "IPropertyObject::getUpdating(Bool*), property_object.h:361, whose own doc says it returns True if beginUpdate method has been called on the object and endUpdate has not"; operations[begin_batched_property_update]: "THE STATE IS Node.updating, so a client knows before it calls which of the two items is the live one, with no request."',
    expected: `Node.updating === ${shouldBeUpdating}`,
    actual:
      row === null || row === undefined
        ? `${nodeId} is not in the tree that came back: ${JSON.stringify(response.error ?? response.result)?.slice(0, 200)}`
        : `Node.updating ${JSON.stringify(reported)}`,
    held: reported === shouldBeUpdating,
  });
}

/**
 * The batch a session begins and then drops, which is the case contract.yaml
 * raises, refuses to rule, and gives Node.updating to make visible:
 *
 *   "A batch is a property of the COMPONENT, not of the socket that opened it -
 *    beginUpdate is recursive over child property objects, so one begin on a
 *    device puts a subtree into batch mode for every session at once, and a
 *    session that begins and then drops leaves it there. Nothing here says
 *    whether a host must end an abandoned batch when its opener disconnects,
 *    whether a second session may end one it did not begin, or what either
 *    should answer."
 *
 * So neither half of this is judged. Both are DRIVEN and both answers are
 * recorded as unconstrained, which is the ledger's word for a question the
 * contract declined to answer - the same treatment event occurrence gets. What
 * the sweep does insist on is leaving nothing behind: whatever the host's policy
 * turns out to be, it ends the batch from this session and prints what happened.
 */
async function driveTheAbandonedBatch(ledger, contract, session, { deviceNodeId, connectionString, options, claimed }) {
  let abandoningSession = null;
  try {
    const opened = await openWireSession(options.url, contract, { requestTimeoutMs: options.requestTimeoutMs });
    abandoningSession = opened.session;
    console.log(
      `opened a third WebSocket to ${options.url} for the abandoned batch; its handshake was ${opened.firstMessage.text.length} bytes. ` +
        "It exists to be closed while it holds a batch open, which is the case contract.yaml raises and refuses to rule.",
    );
  } catch (failure) {
    ledger.recordNotProvokable({
      capability: "property.batched_update",
      wireMethod: "begin_batched_property_update",
      title: "the batch a session begins and then drops was not driven",
      contractCitation:
        'contract.yaml operations[begin_batched_property_update]: "a session that begins and then drops leaves it there. Nothing here says whether a host must end an abandoned batch when its opener disconnects"',
      reason: `this needs a session of its own that can be closed while it holds a batch open, and a WebSocket to ${options.url} could not be opened: ${failure.message}`,
    });
    return null;
  }

  const connected = await abandoningSession.request("connect_device", { connection_string: connectionString });
  const secondSessionDeviceNodeId = connected.result && typeof connected.result.id === "string" ? connected.result.id : null;
  console.log(
    `that third session connected "${connectionString}" and got device node ${JSON.stringify(secondSessionDeviceNodeId)}; ` +
      `it is about to begin a batch on it and then be closed without ending it`,
  );
  if (secondSessionDeviceNodeId !== deviceNodeId) {
    ledger.recordNotProvokable({
      capability: "property.batched_update",
      wireMethod: "begin_batched_property_update",
      title: "the batch a session begins and then drops was not driven",
      contractCitation:
        'contract.yaml operations[begin_batched_property_update]: "one begin on a device puts a subtree into batch mode for every session at once"',
      reason: `that session does not hold the same device row: connect_device "${connectionString}" on it produced ${JSON.stringify(secondSessionDeviceNodeId)} while this run's first session holds "${deviceNodeId}", so a batch it opened would be on a different component and Node.updating on ${deviceNodeId} would say nothing about it`,
    });
    abandoningSession.close();
    return abandoningSession;
  }

  const abandonedBegin = await abandoningSession.request("begin_batched_property_update", { node_id: deviceNodeId });
  if ("error" in abandonedBegin) {
    ledger.recordNotProvokable({
      capability: "property.batched_update",
      wireMethod: "begin_batched_property_update",
      title: "the batch a session begins and then drops was not driven",
      contractCitation:
        'contract.yaml operations[begin_batched_property_update]: "a session that begins and then drops leaves it there"',
      reason: `that session's own begin_batched_property_update ${deviceNodeId} was refused (${abandonedBegin.error?.code}: ${String(abandonedBegin.error?.detail ?? "").slice(0, 160)}), so it never held a batch to abandon`,
    });
    abandoningSession.close();
    return abandoningSession;
  }

  abandoningSession.close();
  await session.quietFor(300);
  console.log(
    `that session began a batch on ${deviceNodeId} and its WebSocket was then closed without an end_batched_property_update. ` +
      "contract.yaml states this case, states that it does NOT rule it, and gives Node.updating so the next session can see it - so what follows is recorded, not judged.",
  );

  let updatingAfterTheOpenerDropped = "(tree.read is a gap on this host, so it could not be read)";
  if (claimed("tree.read")) {
    const treeResponse = await session.request("get_component_tree", {});
    const row = Array.isArray(treeResponse.result) ? treeResponse.result.find((node) => node.id === deviceNodeId) : null;
    updatingAfterTheOpenerDropped =
      row === null || row === undefined ? `${deviceNodeId} is not in the tree that came back` : `Node.updating ${JSON.stringify(row.updating)}`;
  }
  ledger.recordUnconstrained({
    title: `what Node.updating on ${deviceNodeId} says after the session that opened a batch on it dropped without ending it`,
    contractCitation:
      'contract.yaml operations[begin_batched_property_update], "WHAT THIS CONTRACT DOES NOT RULE": "A batch is a property of the COMPONENT, not of the socket that opened it ... a session that begins and then drops leaves it there. Nothing here says whether a host must end an abandoned batch when its opener disconnects, whether a second session may end one it did not begin, or what either should answer. That is the SAME question already open and escalated for device.lock ... Node.updating is what makes the unruled state visible in the meantime."',
    reason: "the contract states this question and declines to answer it, so neither ending the batch nor leaving it open can be failed here",
    observation: `${updatingAfterTheOpenerDropped}, read from the session that did NOT open the batch, ~300 ms after the opener's socket closed`,
  });

  // Whatever the host's unruled policy is, this run does not leave a component
  // in batch mode: an end is sent from the session that did not begin it, and
  // the answer to THAT is the second half of the same unruled question.
  const endFromTheOtherSession = await session.request("end_batched_property_update", { node_id: deviceNodeId });
  ledger.recordUnconstrained({
    title: `what this host answers when a session ends a batch it did not begin, on ${deviceNodeId}`,
    contractCitation:
      'contract.yaml operations[begin_batched_property_update]: "Nothing here says ... whether a second session may end one it did not begin, or what either should answer ... a host must not quietly invent a policy and call it the contract."',
    reason: "the contract states this question and declines to answer it, so accepting the end and refusing it are both conforming answers",
    observation: `end_batched_property_update ${deviceNodeId} from the session that did not begin the batch: the host ${describeAnswer(endFromTheOtherSession)}`,
  });
  console.log(
    `end_batched_property_update ${deviceNodeId} was sent from the session that did not begin that batch, so this run leaves no component in batch mode: ` +
      `the host ${describeAnswer(endFromTheOtherSession)}`,
  );
  return abandoningSession;
}
