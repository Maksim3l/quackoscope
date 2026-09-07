// Sweep 3: the subscription lifecycle and the binary sample plane.
//
// The one bridge between the two planes is contract.yaml
// subscription_id_encoding: the control-plane subscription id is a string that
// is the decimal text of the uint32 in the binary frame header, "whole, with
// nothing else in it", and on_unparseable is invalid_value. That relation is
// asserted directly: the id the host returned is parsed and compared with the
// subscription_id field decoded out of the frames it then sends.

import { judgeResponseEnvelope } from "./judge-response-envelope.mjs";
import { driveGappedOperation } from "./sweep-every-contract-operation.mjs";

const PIXEL_COLUMNS_ASKED_FOR = 64;
const FRAMES_WANTED = 3;
const MILLISECONDS_TO_WAIT_FOR_FRAMES = 4000;
const MILLISECONDS_OF_GRACE_AFTER_UNSUBSCRIBE = 500;
const MILLISECONDS_OF_REQUIRED_QUIET = 1000;

export async function sweepSubscriptionLifecycleAndBinaryFrames(ledger, contract, session, handshakeResult, discovered) {
  const capability = contract.operationsByWireMethod.get("subscribe_signal").capability;
  const subscribeOperation = contract.operationsByWireMethod.get("subscribe_signal");
  const unsubscribeOperation = contract.operationsByWireMethod.get("unsubscribe_signal");
  const gapsByCapability = handshakeResult.gapsByCapability ?? new Map();

  if (!ledger.capabilityIsClaimed(capability)) {
    await driveGappedOperation(ledger, contract, session, subscribeOperation, discovered, gapsByCapability);
    await driveGappedOperation(ledger, contract, session, unsubscribeOperation, discovered, gapsByCapability);
    return;
  }

  if (!discovered.signalNodeId) {
    ledger.recordNotProvokable({
      capability,
      wireMethod: "subscribe_signal",
      title: "the subscription lifecycle could not be driven",
      contractCitation: "contract.yaml operations[subscribe_signal].params signal_id, references Node.id",
      reason: "the component tree carried no node of kind signal, so there is no signal_id to subscribe to",
    });
    return;
  }

  // --- subscribe ------------------------------------------------------------
  const framesBefore = session.binaryFramesInArrivalOrder.length;
  const subscribeResponse = await session.request("subscribe_signal", {
    signal_id: discovered.signalNodeId,
    pixel_columns: PIXEL_COLUMNS_ASKED_FOR,
  });
  const judgedSubscribe = judgeResponseEnvelope(ledger, contract, {
    response: subscribeResponse,
    wireMethod: "subscribe_signal",
    capability,
    capabilityIsClaimed: true,
  });
  if (judgedSubscribe.isError) {
    ledger.recordClaimedCapabilityAssertion({
      capability,
      wireMethod: "subscribe_signal",
      title: `subscribe_signal ${discovered.signalNodeId} with pixel_columns ${PIXEL_COLUMNS_ASKED_FOR} succeeds`,
      contractCitation: "contract.yaml operations[subscribe_signal].returns = string with semantic subscription_id",
      expected: "a subscription id string",
      actual: `error ${judgedSubscribe.code}: ${judgedSubscribe.detail}`,
      held: false,
    });
    return;
  }

  const subscriptionIdText = judgedSubscribe.result;
  const encodingSpec = contract.subscriptionIdEncoding;
  const isDecimalTextOfUint32 =
    typeof subscriptionIdText === "string" &&
    /^[0-9]+$/.test(subscriptionIdText) &&
    Number(subscriptionIdText) <= 0xffffffff;
  ledger.recordClaimedCapabilityAssertion({
    capability,
    wireMethod: "subscribe_signal",
    title: "the subscription id is a string that is the decimal text of a uint32, whole, with nothing else in it",
    contractCitation: `contract.yaml subscription_id_encoding: control_plane_type ${encodingSpec.control_plane_type}, sample_plane_type ${encodingSpec.sample_plane_type}, relation ${encodingSpec.relation}, strict ${encodingSpec.strict}`,
    expected: "a string matching ^[0-9]+$ whose value fits a uint32",
    actual: JSON.stringify(subscriptionIdText),
    held: isDecimalTextOfUint32,
  });
  discovered.lastSubscriptionId = String(subscriptionIdText);

  // --- the binary sample plane ---------------------------------------------
  const framesArrived = await session.waitForFrames(FRAMES_WANTED, MILLISECONDS_TO_WAIT_FOR_FRAMES);
  const frames = session.framesSince(framesBefore);
  ledger.recordClaimedCapabilityAssertion({
    capability,
    wireMethod: "subscribe_signal",
    title: `binary sample frames arrive after subscribing (waited up to ${MILLISECONDS_TO_WAIT_FOR_FRAMES} ms for ${FRAMES_WANTED})`,
    contractCitation: "contract.yaml binary_frame: binary frames share the one socket with the JSON envelopes",
    expected: `at least one binary frame within ${MILLISECONDS_TO_WAIT_FOR_FRAMES} ms`,
    actual: `${framesArrived} frame(s) arrived`,
    held: frames.length > 0,
  });

  if (frames.length > 0) {
    const malformed = frames.filter((frame) => !frame.wellFormed);
    ledger.recordClaimedCapabilityAssertion({
      capability,
      wireMethod: "subscribe_signal",
      title: `every binary frame carries the ${contract.binaryFrame.header_bytes}-byte little-endian header and a payload of the length its encoding implies`,
      contractCitation: `contract.yaml binary_frame: header_bytes ${contract.binaryFrame.header_bytes}, byte_order ${contract.binaryFrame.byte_order}, fields ${contract.binaryFrame.header.map((field) => `${field.name}@${field.offset}:${field.type}`).join(" ")}; encodings ${contract.binaryFrame.encodings.map((row) => `${row.value}=${row.name} (${row.payload_value_count} float64)`).join(", ")}`,
      expected: `all ${frames.length} frames well formed`,
      actual: malformed.length === 0
        ? `${frames.length} frames, all well formed; ` +
          `encodings seen: ${[...new Set(frames.map((frame) => `${frame.encoding} (${frame.encodingName})`))].join(", ")}; ` +
          `sample_count ${Math.min(...frames.map((f) => f.sampleCount))}..${Math.max(...frames.map((f) => f.sampleCount))}; ` +
          `bytes ${Math.min(...frames.map((f) => f.byteLength))}..${Math.max(...frames.map((f) => f.byteLength))}`
        : malformed.slice(0, 4).map((frame) => frame.reason).join(" | "),
      held: malformed.length === 0,
    });

    const expectedSubscriptionId = Number(subscriptionIdText);
    const wrongId = frames.filter((frame) => frame.subscriptionId !== expectedSubscriptionId);
    ledger.recordClaimedCapabilityAssertion({
      capability,
      wireMethod: "subscribe_signal",
      title: "the uint32 subscription_id in every frame header equals the decimal text the control plane returned",
      contractCitation: `contract.yaml subscription_id_encoding.relation = ${encodingSpec.relation}; "This is the only bridge between the two planes."`,
      expected: `every frame header carries subscription_id ${expectedSubscriptionId}`,
      actual: wrongId.length === 0
        ? `all ${frames.length} frames carry subscription_id ${expectedSubscriptionId}`
        : `${wrongId.length} frame(s) carry a different id: ${[...new Set(wrongId.map((frame) => frame.subscriptionId))].join(", ")}`,
      held: wrongId.length === 0,
    });

    const advertisedMaxFrameBytes = handshakeResult.limits.max_frame_bytes;
    const oversized = frames.filter((frame) => frame.byteLength > advertisedMaxFrameBytes);
    ledger.recordClaimedCapabilityAssertion({
      capability,
      wireMethod: "subscribe_signal",
      title: "no frame exceeds the max_frame_bytes this host advertised in its own handshake",
      contractCitation: `contract.yaml handshake.fields.limits.fields.max_frame_bytes; this host advertised ${advertisedMaxFrameBytes}`,
      expected: `every frame <= ${advertisedMaxFrameBytes} bytes`,
      actual: oversized.length === 0
        ? `largest frame ${Math.max(...frames.map((frame) => frame.byteLength))} bytes`
        : `${oversized.length} frame(s) over the limit, largest ${Math.max(...oversized.map((frame) => frame.byteLength))} bytes`,
      held: oversized.length === 0,
    });

    const monotonic = frames.every((frame, index) => index === 0 || frame.domainStart >= frames[index - 1].domainStart);
    ledger.recordUnconstrained({
      title: "domain_start ordering across the frames of one subscription",
      contractCitation: "contract.yaml binary_frame.header declares domain_start a uint64 and says nothing about ordering between frames",
      reason: "the contract fixes the field's width and offset but never says successive frames must not go backwards, so this is observed, not asserted",
      observation: `${frames.length} frames, domain_start ${frames[0].domainStart} .. ${frames[frames.length - 1].domainStart}, non-decreasing: ${monotonic}`,
    });

    const overPixelColumns = frames.filter((frame) => frame.sampleCount > PIXEL_COLUMNS_ASKED_FOR);
    ledger.recordUnconstrained({
      title: `sample_count against the pixel_columns ${PIXEL_COLUMNS_ASKED_FOR} that was asked for`,
      contractCitation: "contract.yaml operations[subscribe_signal].params pixel_columns is declared, but binary_frame states no relation between pixel_columns and sample_count",
      reason: "nothing in the contract bounds sample_count by pixel_columns, so exceeding it cannot be a failure",
      observation: `${overPixelColumns.length} of ${frames.length} frames carry sample_count > ${PIXEL_COLUMNS_ASKED_FOR}; sample_count range ${Math.min(...frames.map((f) => f.sampleCount))}..${Math.max(...frames.map((f) => f.sampleCount))}`,
    });
  }

  // --- invalid_value on an unparseable subscription id ----------------------
  const unparseableResponse = await session.request("unsubscribe_signal", {
    subscription_id: "not-the-decimal-text-of-a-uint32",
  });
  const judgedUnparseable = judgeResponseEnvelope(ledger, contract, {
    response: unparseableResponse,
    wireMethod: "unsubscribe_signal",
    capability,
    capabilityIsClaimed: true,
    // subscription_id_encoding.on_unparseable mandates invalid_value, which
    // operations[unsubscribe_signal].errors does not list. The contract
    // contradicts itself here; see the contract-vagueness notes.
    errorCodesAlsoAllowed: [contract.subscriptionIdEncoding.on_unparseable],
  });
  ledger.recordClaimedCapabilityAssertion({
    capability,
    wireMethod: "unsubscribe_signal",
    title: 'an unparseable subscription_id is refused with the code subscription_id_encoding.on_unparseable names',
    contractCitation: `contract.yaml subscription_id_encoding.on_unparseable = ${contract.subscriptionIdEncoding.on_unparseable} (note: operations[unsubscribe_signal].errors lists only [${unsubscribeOperation.errors.join(", ")}])`,
    expected: `error code "${contract.subscriptionIdEncoding.on_unparseable}"`,
    actual: judgedUnparseable.isError ? `error ${judgedUnparseable.code}: ${judgedUnparseable.detail}` : `accepted, result ${JSON.stringify(judgedUnparseable.result)}`,
    held: judgedUnparseable.isError && judgedUnparseable.code === contract.subscriptionIdEncoding.on_unparseable,
  });

  // --- unsubscribe, and the frames stopping --------------------------------
  const unsubscribeResponse = await session.request("unsubscribe_signal", { subscription_id: String(subscriptionIdText) });
  const judgedUnsubscribe = judgeResponseEnvelope(ledger, contract, {
    response: unsubscribeResponse,
    wireMethod: "unsubscribe_signal",
    capability,
    capabilityIsClaimed: true,
  });
  ledger.recordClaimedCapabilityAssertion({
    capability,
    wireMethod: "unsubscribe_signal",
    title: `unsubscribe_signal "${subscriptionIdText}" is accepted and returns void`,
    contractCitation: "contract.yaml operations[unsubscribe_signal].returns = void",
    expected: "a result envelope carrying null",
    actual: judgedUnsubscribe.isError ? `error ${judgedUnsubscribe.code}: ${judgedUnsubscribe.detail}` : `result ${JSON.stringify(judgedUnsubscribe.result)}`,
    held: !judgedUnsubscribe.isError && (judgedUnsubscribe.result === null || judgedUnsubscribe.result === undefined),
  });

  await session.quietFor(MILLISECONDS_OF_GRACE_AFTER_UNSUBSCRIBE);
  const markAfterGrace = session.binaryFramesInArrivalOrder.length;
  await session.quietFor(MILLISECONDS_OF_REQUIRED_QUIET);
  const framesInTheQuietWindow = session
    .framesSince(markAfterGrace)
    .filter((frame) => frame.subscriptionId === Number(subscriptionIdText));
  ledger.recordClaimedCapabilityAssertion({
    capability,
    wireMethod: "unsubscribe_signal",
    title: `frames for subscription ${subscriptionIdText} stop after unsubscribe_signal`,
    contractCitation: "contract.yaml capabilities[streaming.decimated].operations pairs subscribe_signal with unsubscribe_signal; an unsubscribe that does not stop delivery makes the pair meaningless",
    expected: `no frame carrying subscription_id ${subscriptionIdText} during a ${MILLISECONDS_OF_REQUIRED_QUIET} ms window, after ${MILLISECONDS_OF_GRACE_AFTER_UNSUBSCRIBE} ms of grace`,
    actual: framesInTheQuietWindow.length === 0
      ? `silence: 0 frames for that subscription in the ${MILLISECONDS_OF_REQUIRED_QUIET} ms window`
      : `${framesInTheQuietWindow.length} frame(s) still arriving for subscription ${subscriptionIdText}`,
    held: framesInTheQuietWindow.length === 0,
  });

  // --- unsubscribing the same id twice --------------------------------------
  const secondUnsubscribe = await session.request("unsubscribe_signal", { subscription_id: String(subscriptionIdText) });
  const judgedSecond = judgeResponseEnvelope(ledger, contract, {
    response: secondUnsubscribe,
    wireMethod: "unsubscribe_signal",
    capability,
    capabilityIsClaimed: true,
  });
  ledger.recordClaimedCapabilityAssertion({
    capability,
    wireMethod: "unsubscribe_signal",
    title: `unsubscribing "${subscriptionIdText}" a second time is refused with not_found`,
    contractCitation: `contract.yaml operations[unsubscribe_signal].errors = [${unsubscribeOperation.errors.join(", ")}]`,
    expected: 'error code "not_found"',
    actual: judgedSecond.isError ? `error ${judgedSecond.code}: ${judgedSecond.detail}` : `accepted again, result ${JSON.stringify(judgedSecond.result)}`,
    held: judgedSecond.isError && judgedSecond.code === "not_found",
  });

  // --- not_found on subscribing to something that is not there --------------
  const unknownSignalResponse = await session.request("subscribe_signal", {
    signal_id: "/quackoscope-conformance-sweep/no-such-signal",
    pixel_columns: PIXEL_COLUMNS_ASKED_FOR,
  });
  const judgedUnknownSignal = judgeResponseEnvelope(ledger, contract, {
    response: unknownSignalResponse,
    wireMethod: "subscribe_signal",
    capability,
    capabilityIsClaimed: true,
  });
  ledger.recordClaimedCapabilityAssertion({
    capability,
    wireMethod: "subscribe_signal",
    title: "subscribe_signal on an unknown signal id is refused",
    contractCitation: `contract.yaml operations[subscribe_signal].errors = [${subscribeOperation.errors.join(", ")}]`,
    expected: `one of [${subscribeOperation.errors.join(", ")}]`,
    actual: judgedUnknownSignal.isError
      ? `error ${judgedUnknownSignal.code}: ${judgedUnknownSignal.detail}`
      : `subscribed anyway, result ${JSON.stringify(judgedUnknownSignal.result)}`,
    held: judgedUnknownSignal.isError && subscribeOperation.errors.includes(judgedUnknownSignal.code),
  });
  if (!judgedUnknownSignal.isError && typeof judgedUnknownSignal.result === "string") {
    await session.request("unsubscribe_signal", { subscription_id: judgedUnknownSignal.result });
  }

  ledger.recordNotProvokable({
    capability,
    wireMethod: "subscribe_signal",
    title: `the advertised max_subscriptions limit (${handshakeResult.limits.max_subscriptions}) was not driven to exhaustion`,
    contractCitation: "contract.yaml handshake.fields.limits.fields.max_subscriptions",
    reason: `opening ${handshakeResult.limits.max_subscriptions} simultaneous subscriptions against a real acquisition device would change how that device behaves for anyone else using it; the sweep declines to do it and says so rather than skipping silently`,
  });
}
