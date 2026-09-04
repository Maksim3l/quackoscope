// Sweep 4: disconnect behaviour, event delivery, and the wire-protocol rules
// that bind every host regardless of what it claims.
//
// Events are the honest awkward corner of this harness. contract.yaml section 6
// closes the event set and fixes each payload's shape, but it attaches no event
// to any capability id, and gap_generation computes gaps only over capabilities.
// So there is no way for a host to declare "I push no events" as a gap, and no
// way for this harness to call a silent host wrong. Every event observed is
// SHAPE-CHECKED against the contract as a hard assertion; the absence of an
// event is recorded as unconstrained, never as a failure.
//
// Disconnect runs last: it tears the device down, so nothing can follow it.

import { findRecordViolations } from "../wire/validate-record-against-contract-type.mjs";
import { judgeResponseEnvelope } from "./judge-response-envelope.mjs";
import { driveGappedOperation } from "./sweep-every-contract-operation.mjs";

const CONFORMANCE_UNKNOWN_NODE_ID = "/quackoscope-conformance-sweep/no-such-node";
const CONFORMANCE_UNKNOWN_WIRE_METHOD = "quackoscope_conformance_sweep_method_that_is_not_in_the_contract";

/** Shape-checks every event that arrived, against contract.yaml events.items. */
export function sweepEventDelivery(ledger, contract, session) {
  const eventsByName = new Map(contract.events.map((event) => [event.eventName, event]));
  const observed = session.eventsInArrivalOrder;

  const unknownEventNames = observed.map((event) => event.event).filter((name) => !eventsByName.has(name));
  ledger.recordWireProtocolAssertion({
    title: "every event pushed by the host is one of the contract's closed event set",
    contractCitation: `contract.yaml events.closed = true, items [${contract.events.map((event) => event.eventName).join(", ")}]`,
    expected: "no event name outside the closed set",
    actual: unknownEventNames.length === 0
      ? `${observed.length} event(s) received, names seen: ${[...new Set(observed.map((event) => event.event))].join(", ") || "(none)"}`
      : `event names outside the set: ${[...new Set(unknownEventNames)].join(", ")}`,
    held: unknownEventNames.length === 0,
  });

  const carriesId = observed.filter((event) => "id" in event);
  ledger.recordWireProtocolAssertion({
    title: "no event carries an id field",
    contractCitation: `contract.yaml events.carries_id_field = ${contract.eventsCarryIdField}; "They are not responses and are never correlated."`,
    expected: "no event envelope has an id key",
    actual: carriesId.length === 0 ? `${observed.length} event(s), none carrying an id` : `${carriesId.length} event(s) carry an id: ${JSON.stringify(carriesId[0]).slice(0, 200)}`,
    held: carriesId.length === 0,
  });

  const payloadViolations = [];
  for (const event of observed) {
    const spec = eventsByName.get(event.event);
    if (!spec) continue;
    const payload = event.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      payloadViolations.push(`${event.event}.payload: contract.yaml envelopes.event.fields.payload is a required object; got ${JSON.stringify(payload)}`);
      continue;
    }
    for (const field of spec.payload) {
      if (!(field.name in payload)) {
        payloadViolations.push(`${event.event}.payload.${field.name}: contract.yaml events declares it presence ${field.presence}; the key is absent`);
        continue;
      }
      if (contract.types[field.type]) {
        payloadViolations.push(...findRecordViolations(payload[field.name], field.type, contract, `${event.event}.payload.${field.name}`));
      } else if (field.type === "string" && typeof payload[field.name] !== "string") {
        payloadViolations.push(`${event.event}.payload.${field.name}: contract.yaml declares it a string; got ${JSON.stringify(payload[field.name])}`);
      }
    }
  }
  ledger.recordWireProtocolAssertion({
    title: "every event that did arrive carries the payload shape the contract declares for it",
    contractCitation: "contract.yaml events.items[].payload",
    expected: `${observed.length} conforming event payloads`,
    actual: payloadViolations.length === 0 ? `${observed.length} event(s), every declared payload key present and correctly typed` : payloadViolations.slice(0, 6).join(" | "),
    held: payloadViolations.length === 0,
  });

  const seen = new Set(observed.map((event) => event.event));
  const neverSeen = contract.events.map((event) => event.eventName).filter((name) => !seen.has(name));
  ledger.recordUnconstrained({
    title: "which of the contract's five events this host pushed during the sweep",
    contractCitation:
      "contract.yaml events fixes the closed set and each payload shape, but attaches no event to a capability id; gap_generation computes gaps over capabilities only, so a host that pushes no events can neither declare that as a gap nor be failed for it",
    reason: "event occurrence is unconstrained by the contract, so silence is not a verdict",
    observation: `pushed during this sweep: [${[...seen].join(", ") || "(none)"}]; not pushed: [${neverSeen.join(", ")}]`,
  });
}

/** Wire-protocol rules that bind every host, claimed capabilities or not. */
export async function sweepWireProtocolRules(ledger, contract, session) {
  const response = await session.request(CONFORMANCE_UNKNOWN_WIRE_METHOD, {});
  const isError = "error" in response;
  const code = isError && response.error && typeof response.error === "object" ? response.error.code : null;
  ledger.recordWireProtocolAssertion({
    title: "a method name that is not in the contract's operation table is refused with a closed-set error code",
    wireMethod: CONFORMANCE_UNKNOWN_WIRE_METHOD,
    contractCitation: `contract.yaml lints.no_undeclared_public_method and error_codes.closed = true, values [${contract.errorCodes.join(", ")}]. The contract does not name WHICH code an unknown method must get - see the contract-vagueness notes`,
    expected: `an error envelope whose code is one of [${contract.errorCodes.join(", ")}]`,
    actual: isError ? `error ${code}: ${response.error.detail}` : `answered with a result: ${JSON.stringify(response.result)?.slice(0, 160)}`,
    held: isError && contract.errorCodes.includes(code),
  });

  ledger.recordNotProvokable({
    title: 'the "internal" error code was not provoked',
    contractCitation: `contract.yaml error_policy.unmapped_native_error_becomes = ${contract.rawDocument.error_policy.unmapped_native_error_becomes}; operations[scan_available_devices].errors = [internal]`,
    reason: "internal is what an unmapped native exception becomes; a well-formed wire client cannot force one out of a healthy host without breaking the host or its device from outside the wire",
  });
  ledger.recordNotProvokable({
    title: 'the "timeout" error code was not provoked',
    contractCitation: "contract.yaml operations[connect_device].errors includes timeout",
    reason: "timeout requires a device or network that does not answer; nothing on the wire can produce one on demand, and inventing an unreachable connection string would test the string, not the host",
  });
}

/** Runs last: disconnect tears the device down. */
export async function sweepDisconnectBehaviour(ledger, contract, session, handshakeResult, discovered) {
  const operation = contract.operationsByWireMethod.get("disconnect_device");
  const capability = operation.capability;
  const gapsByCapability = handshakeResult.gapsByCapability ?? new Map();

  if (!ledger.capabilityIsClaimed(capability)) {
    await driveGappedOperation(ledger, contract, session, operation, discovered, gapsByCapability);
    return;
  }

  const unknownResponse = await session.request("disconnect_device", { node_id: CONFORMANCE_UNKNOWN_NODE_ID });
  const judgedUnknown = judgeResponseEnvelope(ledger, contract, {
    response: unknownResponse,
    wireMethod: "disconnect_device",
    capability,
    capabilityIsClaimed: true,
  });
  ledger.recordClaimedCapabilityAssertion({
    capability,
    wireMethod: "disconnect_device",
    title: `disconnect_device on the unknown node "${CONFORMANCE_UNKNOWN_NODE_ID}" is refused with not_found`,
    contractCitation: `contract.yaml operations[disconnect_device].errors = [${operation.errors.join(", ")}]`,
    expected: 'error code "not_found"',
    actual: judgedUnknown.isError ? `error ${judgedUnknown.code}: ${judgedUnknown.detail}` : `accepted, result ${JSON.stringify(judgedUnknown.result)}`,
    held: judgedUnknown.isError && judgedUnknown.code === "not_found",
  });

  if (!discovered.deviceNodeId) {
    ledger.recordNotProvokable({
      capability,
      wireMethod: "disconnect_device",
      title: "disconnect_device could not be driven against a connected device",
      contractCitation: "contract.yaml operations[disconnect_device].params node_id",
      reason: "connect_device never produced a device node id in this session, so there is nothing to disconnect",
    });
    return;
  }

  const eventsBefore = session.eventsInArrivalOrder.length;
  const response = await session.request("disconnect_device", { node_id: discovered.deviceNodeId });
  const judged = judgeResponseEnvelope(ledger, contract, {
    response,
    wireMethod: "disconnect_device",
    capability,
    capabilityIsClaimed: true,
  });
  ledger.recordClaimedCapabilityAssertion({
    capability,
    wireMethod: "disconnect_device",
    title: `disconnect_device ${discovered.deviceNodeId} is accepted and returns void`,
    contractCitation: "contract.yaml operations[disconnect_device].returns = void",
    expected: "a result envelope carrying null",
    actual: judged.isError ? `error ${judged.code}: ${judged.detail}` : `result ${JSON.stringify(judged.result)}`,
    held: !judged.isError && (judged.result === null || judged.result === undefined),
  });

  if (!judged.isError && ledger.capabilityIsClaimed("property.read") && discovered.descriptorNodeId) {
    const afterDisconnect = await session.request("get_property_value", {
      node_id: discovered.descriptorNodeId,
      property_id: discovered.readablePropertyId,
    });
    const judgedAfter = judgeResponseEnvelope(ledger, contract, {
      response: afterDisconnect,
      wireMethod: "get_property_value",
      capability: "property.read",
      capabilityIsClaimed: true,
    });
    const acceptable = contract.operationsByWireMethod.get("get_property_value").errors;
    ledger.recordClaimedCapabilityAssertion({
      capability,
      wireMethod: "disconnect_device",
      title: `after disconnect_device, reading ${discovered.descriptorNodeId}.${discovered.readablePropertyId} no longer succeeds`,
      contractCitation: `contract.yaml operations[get_property_value].errors = [${acceptable.join(", ")}]; a node reachable after its device was disconnected would mean disconnect_device did nothing`,
      expected: `one of [${acceptable.join(", ")}]`,
      actual: judgedAfter.isError
        ? `error ${judgedAfter.code}: ${judgedAfter.detail}`
        : `still readable, value ${JSON.stringify(judgedAfter.result)}`,
      held: judgedAfter.isError && acceptable.includes(judgedAfter.code),
    });
  }

  await session.quietFor(300);
  const disconnectedEvents = session.eventsSince(eventsBefore).filter((event) => event.event === "device_disconnected");
  ledger.recordUnconstrained({
    title: "device_disconnected after a client-initiated disconnect_device",
    contractCitation: "contract.yaml events.items[device_disconnected] fixes the payload {node_id, reason}, but nothing in the contract says a client-initiated disconnect must push it",
    reason: "the contract constrains the event's shape, never when it must be emitted",
    observation: disconnectedEvents.length === 0
      ? "no device_disconnected event followed the client's own disconnect_device"
      : `${disconnectedEvents.length}: ${JSON.stringify(disconnectedEvents[0]).slice(0, 200)}`,
  });
}
