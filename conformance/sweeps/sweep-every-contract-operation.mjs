// Sweep 2: the thirteen operations of contract/contract.yaml that were in the
// table when this suite was written - device.scan, device.connect, tree.read,
// property.read, property.write, function_block.add and streaming - plus the
// closed error set.
//
// The four capabilities the contract grew afterwards - device.mode, device.lock,
// module.read and module.load - are driven by sweep-device-operation-mode-device-lock-and-modules.mjs,
// which follows the same idiom as this file and needs a second socket.
//
// Every operation name here is READ from the contract, never written down: the
// visit() helper below looks each one up in contract.operationsByWireMethod.
// WHETHER EVERY ROW OF THE TABLE WAS DRIVEN IS NOT DECIDED IN THIS FILE. It used
// to be, from a hand-kept set at the bottom, and that set is exactly what let six
// operations be added to contract.yaml and asked of no host at all. The question
// is now answered after every sweep has run, from request counts taken on the
// socket itself, by require-every-contract-operation-to-be-driven.mjs.
//
// For each operation the sweep asks one question first - did the handshake claim
// this operation's capability? - and everything downstream follows from the
// answer:
//   claimed -> drive it for real; anything wrong is failure class (b)
//   gapped  -> drive it anyway and require a refusal; a refusal is class (a),
//              which passes, and a result earns a warning, not a failure

import { findRecordViolations } from "../wire/validate-record-against-contract-type.mjs";
import { judgeResponseEnvelope } from "./judge-response-envelope.mjs";

export const CONFORMANCE_UNKNOWN_NODE_ID = "/quackoscope-conformance-sweep/no-such-node";
const CONFORMANCE_UNKNOWN_PROPERTY_ID = "QuackoscopeConformanceSweepNoSuchProperty";
const CONFORMANCE_UNKNOWN_FUNCTION_BLOCK_TYPE_ID = "quackoscope-conformance-sweep-no-such-function-block-type";

// A mode name outside contract.yaml types.Node.operation_mode, so
// set_device_operation_mode must answer invalid_value to it.
export const CONFORMANCE_UNKNOWN_OPERATION_MODE = "quackoscope-conformance-sweep-no-such-operation-mode";

// Two spellings of one absent module file, because load_module_from_host_path
// resolves its path on the HOST's filesystem and the suite, which addresses a
// host by URL alone, cannot know that filesystem's syntax. Exactly one of these
// is an absolute path on any given platform; the other is relative there, and a
// host is entitled to refuse a relative path invalid_value rather than looking
// for it. Both are sent, and the assertion is made on the pair. Neither can
// collide with a real module: no openDAQ install puts one under a directory
// named after this sweep.
export const CONFORMANCE_ABSENT_MODULE_HOST_PATHS = {
  posixAbsolute: "/quackoscope-conformance-sweep/no-such-directory/no-such-module.module.dll",
  windowsAbsolute: "C:/quackoscope-conformance-sweep/no-such-directory/no-such-module.module.dll",
};

// Which node carries a read_only property, and which carries a writable numeric
// one, differs between devices. Sampling only the first node with properties
// leaves whole error codes unprovoked - it did on the openDAQ reference device,
// where the read_only property sits on a channel and not on the device node. So
// several nodes are sampled, bounded so the sweep stays a couple of minutes long
// against a real acquisition device rather than open-ended.
const NODES_TO_SAMPLE_FOR_PROPERTIES = 8;
const PROPERTY_READS_AT_MOST = 60;

/** Builds params for a wire method from the contract's own param list. */
export function paramsFromContract(operation, discovered, contract) {
  const params = {};
  for (const parameter of operation.params) {
    if (parameter.presence === "optional") continue;
    switch (parameter.name) {
      case "connection_string":
        params.connection_string = discovered.connectionString;
        break;
      case "node_id":
      case "parent_id":
      case "root_id":
        params[parameter.name] = discovered.deviceNodeId ?? CONFORMANCE_UNKNOWN_NODE_ID;
        break;
      case "signal_id":
        params.signal_id = discovered.signalNodeId ?? discovered.deviceNodeId ?? CONFORMANCE_UNKNOWN_NODE_ID;
        break;
      case "property_id":
        params.property_id = discovered.readablePropertyId ?? CONFORMANCE_UNKNOWN_PROPERTY_ID;
        break;
      case "value":
        params.value = false;
        break;
      case "pixel_columns":
        params.pixel_columns = 64;
        break;
      case "count":
        params.count = 16;
        break;
      case "type_id":
        params.type_id = discovered.functionBlockTypeId ?? CONFORMANCE_UNKNOWN_FUNCTION_BLOCK_TYPE_ID;
        break;
      case "subscription_id":
        params.subscription_id = discovered.lastSubscriptionId ?? "1";
        break;
      case "mode":
        // The mode a declared-gap host is asked for is one the contract itself
        // enumerates, so its refusal is about the gap and not about the value.
        params.mode = discovered.anAvailableOperationMode ?? contract.types.Node.fields.operation_mode.values[0];
        break;
      case "host_path":
        params.host_path = CONFORMANCE_ABSENT_MODULE_HOST_PATHS.windowsAbsolute;
        break;
      default:
        throw new Error(
          `conformance/ does not know how to supply the contract parameter "${parameter.name}" of ${operation.wireMethod}; contract.yaml grew a parameter this sweep has never seen`,
        );
    }
  }
  return params;
}

/** Drives a gapped operation and records class (a) or the under-claim warning. */
export async function driveGappedOperation(ledger, contract, session, operation, discovered, gapsByCapability) {
  const params = paramsFromContract(operation, discovered, contract);
  let response;
  try {
    response = await session.request(operation.wireMethod, params);
  } catch (failure) {
    ledger.recordWireProtocolAssertion({
      title: `${operation.wireMethod}: a declared-gap request is still answered on the wire`,
      wireMethod: operation.wireMethod,
      contractCitation: "contract.yaml envelopes.request/result: every request envelope is answered with the same correlation id",
      expected: "a result or an error envelope",
      actual: failure.message,
      held: false,
    });
    return;
  }
  const gap = gapsByCapability.get(operation.capability);
  const isError = "error" in response;
  const code = isError && response.error && typeof response.error === "object" ? response.error.code : null;
  const outcome = { isError, code, result: isError ? undefined : response.result };

  if (isError) {
    ledger.recordWireProtocolAssertion({
      title: `${operation.wireMethod}: the declared-gap refusal uses a code from the closed set`,
      wireMethod: operation.wireMethod,
      contractCitation: `contract.yaml error_codes.closed = true, values [${contract.errorCodes.join(", ")}]`,
      expected: `one of [${contract.errorCodes.join(", ")}]`,
      actual: JSON.stringify(response.error),
      held: contract.errorCodes.includes(code),
    });
  }

  ledger.recordGapConsistency({
    capability: operation.capability,
    wireMethod: operation.wireMethod,
    gapReason: gap ? gap.reason : "(the host declared no Gap record for this capability)",
    refused: isError,
    errorCode: code,
    actual: isError
      ? String(response.error?.detail ?? "").slice(0, 240)
      : JSON.stringify(response.result).slice(0, 240),
  });
  return outcome;
}

export async function sweepEveryContractOperation(ledger, contract, session, handshakeResult, options) {
  const claimed = (capability) => ledger.capabilityIsClaimed(capability);
  const gapsByCapability = handshakeResult.gapsByCapability ?? new Map();
  const visitedWireMethods = new Set();
  const discovered = {
    connectionString: options.connectionString,
    deviceNodeId: null,
    signalNodeId: null,
    readablePropertyId: null,
    functionBlockTypeId: null,
    lastSubscriptionId: null,
    treeNodes: [],
    descriptors: [],
    descriptorNodeId: null,
  };

  // A gapped operation is still driven, and if the host serves it anyway (which
  // earns the gap_declared_but_served warning) the answer is salvaged so the
  // rest of the sweep can keep going. That happens for real: a capability can
  // own two operations, and a host that serves one of them and not the other
  // must declare the whole capability a gap - contract.yaml gap_generation is
  // computed over capabilities, not over operations.
  const visit = async (wireMethod, driver, salvageFromAGapThatWasServedAnyway = null) => {
    visitedWireMethods.add(wireMethod);
    const operation = contract.operationsByWireMethod.get(wireMethod);
    if (!claimed(operation.capability)) {
      const outcome = await driveGappedOperation(ledger, contract, session, operation, discovered, gapsByCapability);
      if (outcome && !outcome.isError && salvageFromAGapThatWasServedAnyway) {
        salvageFromAGapThatWasServedAnyway(outcome.result);
      }
      return null;
    }
    return await driver(operation);
  };

  // ------------------------------------------------------------------------
  // Before any device is connected: the not_connected corner of the closed set.
  // ------------------------------------------------------------------------
  if (claimed("tree.read")) {
    const beforeConnect = await session.request("get_component_tree", {});
    const judged = judgeResponseEnvelope(ledger, contract, {
      response: beforeConnect,
      wireMethod: "get_component_tree",
      capability: "tree.read",
      capabilityIsClaimed: true,
    });
    ledger.recordClaimedCapabilityAssertion({
      capability: "tree.read",
      wireMethod: "get_component_tree",
      title: "get_component_tree on a session that has connected no device answers not_connected, or an array",
      contractCitation:
        "contract.yaml operations[get_component_tree].errors = [not_connected]; the contract does not say WHEN the code must be used, so an array result is accepted here too - see the contract-vagueness notes",
      expected: 'error code "not_connected", or a result that is an array',
      actual: judged.isError ? `error ${judged.code}: ${judged.detail}` : `result ${JSON.stringify(judged.result).slice(0, 160)}`,
      held: judged.isError ? judged.code === "not_connected" : Array.isArray(judged.result),
    });
  }

  // ------------------------------------------------------------------------
  // device.scan
  // ------------------------------------------------------------------------
  await visit("scan_available_devices", async (operation) => {
    const response = await session.request(operation.wireMethod, paramsFromContract(operation, discovered, contract));
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod: operation.wireMethod,
      capability: operation.capability,
      capabilityIsClaimed: true,
    });
    if (judged.isError) return null;

    const violations = [];
    if (!Array.isArray(judged.result)) violations.push(`expected an array of DeviceInfo; got ${JSON.stringify(judged.result)?.slice(0, 160)}`);
    else judged.result.forEach((item, index) => violations.push(...findRecordViolations(item, "DeviceInfo", contract, `scan_available_devices[${index}]`)));

    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: "scan_available_devices returns an array of contract-shaped DeviceInfo records",
      contractCitation: "contract.yaml operations[scan_available_devices].returns = array of DeviceInfo; types.DeviceInfo connection_string/name required, serial nullable",
      expected: "array of {connection_string, name, serial}",
      actual: violations.length === 0 ? `${judged.result.length} DeviceInfo records, all conforming` : violations.join(" | "),
      held: violations.length === 0,
    });

    if (Array.isArray(judged.result) && judged.result.length > 0 && !options.connectionStringWasGivenExplicitly) {
      const preferred = judged.result.find((item) => item.connection_string === options.connectionString);
      discovered.connectionString = preferred ? preferred.connection_string : judged.result[0].connection_string;
    }
    return judged.result;
  }, (servedAnyway) => {
    if (Array.isArray(servedAnyway) && servedAnyway.length > 0 && typeof servedAnyway[0]?.connection_string === "string" && !options.connectionStringWasGivenExplicitly) {
      discovered.connectionString = servedAnyway[0].connection_string;
    }
  });

  // ------------------------------------------------------------------------
  // device.connect: connect_device
  // ------------------------------------------------------------------------
  await visit("connect_device", async (operation) => {
    const response = await session.request(operation.wireMethod, { connection_string: discovered.connectionString });
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod: operation.wireMethod,
      capability: operation.capability,
      capabilityIsClaimed: true,
    });
    if (judged.isError) {
      ledger.recordClaimedCapabilityAssertion({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: `connect_device "${discovered.connectionString}" succeeds`,
        contractCitation: "contract.yaml operations[connect_device].returns = Node",
        expected: "a Node record for the connected device",
        actual: `error ${judged.code}: ${judged.detail}`,
        held: false,
      });
      return null;
    }
    const violations = findRecordViolations(judged.result, "Node", contract, "connect_device result");
    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: `connect_device "${discovered.connectionString}" returns a contract-shaped Node`,
      contractCitation: "contract.yaml operations[connect_device].returns = Node; types.Node id/name/kind/child_ids/property_ids required, parent_id nullable",
      expected: "a Node record",
      actual: violations.length === 0 ? `Node ${judged.result.id} kind=${judged.result.kind}, ${judged.result.child_ids.length} children, ${judged.result.property_ids.length} properties` : violations.join(" | "),
      held: violations.length === 0,
    });
    if (violations.length === 0) discovered.deviceNodeId = judged.result.id;
    return judged.result;
  }, (servedAnyway) => {
    if (servedAnyway && typeof servedAnyway === "object" && typeof servedAnyway.id === "string") {
      discovered.deviceNodeId = servedAnyway.id;
    }
  });

  // ------------------------------------------------------------------------
  // tree.read: get_component_tree
  // ------------------------------------------------------------------------
  await visit("get_component_tree", async (operation) => {
    const response = await session.request(operation.wireMethod, {});
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod: operation.wireMethod,
      capability: operation.capability,
      capabilityIsClaimed: true,
    });
    if (judged.isError) {
      ledger.recordClaimedCapabilityAssertion({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: "get_component_tree after connect_device returns the tree",
        contractCitation: "contract.yaml operations[get_component_tree].returns = array of Node",
        expected: "an array of Node records",
        actual: `error ${judged.code}: ${judged.detail}`,
        held: false,
      });
      return null;
    }

    const nodes = Array.isArray(judged.result) ? judged.result : [];
    const violations = [];
    if (!Array.isArray(judged.result)) violations.push(`expected an array of Node; got ${JSON.stringify(judged.result)?.slice(0, 160)}`);
    nodes.forEach((node, index) => violations.push(...findRecordViolations(node, "Node", contract, `get_component_tree[${index}]`)));

    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: "get_component_tree returns an array of contract-shaped Node records",
      contractCitation: "contract.yaml operations[get_component_tree].returns = array of Node; types.Node.kind enum [device, channel, function_block, signal, folder]",
      expected: "every element a Node record",
      actual: violations.length === 0 ? `${nodes.length} Node records, all conforming; kinds present: ${[...new Set(nodes.map((node) => node.kind))].join(", ")}` : violations.slice(0, 8).join(" | "),
      held: violations.length === 0,
    });

    // Referential integrity: types.Node.parent_id and child_ids both carry
    // "references: Node.id", so every id they name must resolve inside the tree.
    const idsInTree = new Set(nodes.map((node) => node.id));
    const danglingReferences = [];
    for (const node of nodes) {
      if (node.parent_id !== null && node.parent_id !== undefined && !idsInTree.has(node.parent_id)) {
        // A tree root's parent legitimately sits above the returned slice.
        if (nodes.some((other) => other.child_ids?.includes(node.id))) {
          danglingReferences.push(`${node.id}.parent_id -> ${node.parent_id} is not in the returned tree`);
        }
      }
      for (const childId of node.child_ids ?? []) {
        if (!idsInTree.has(childId)) danglingReferences.push(`${node.id}.child_ids -> ${childId} is not in the returned tree`);
      }
    }
    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: "every child_ids entry, and every parent_id of a claimed child, resolves inside the returned tree",
      contractCitation: "contract.yaml types.Node.child_ids.references = Node.id and types.Node.parent_id.references = Node.id",
      expected: "no dangling Node.id reference",
      actual: danglingReferences.length === 0 ? `${nodes.length} nodes, every child_ids and parent_id reference resolves` : danglingReferences.slice(0, 6).join(" | "),
      held: danglingReferences.length === 0,
    });

    discovered.treeNodes = nodes;
    const signalNode = nodes.find((node) => node.kind === "signal");
    if (signalNode) discovered.signalNodeId = signalNode.id;
    // Several nodes are sampled, not just the first: which node carries a
    // read_only property, or a writable numeric one, differs between devices,
    // and a sweep that looks at one node only leaves error codes unprovoked.
    const nodesWithProperties = nodes.filter((node) => Array.isArray(node.property_ids) && node.property_ids.length > 0);
    discovered.descriptorNodeIds = nodesWithProperties.slice(0, NODES_TO_SAMPLE_FOR_PROPERTIES).map((node) => node.id);
    if (discovered.descriptorNodeIds.length > 0) {
      discovered.descriptorNodeId = discovered.descriptorNodeIds[0];
      discovered.readablePropertyId = nodesWithProperties[0].property_ids[0];
    }

    // The optional root_id parameter, exercised separately.
    if (discovered.deviceNodeId) {
      const rooted = await session.request(operation.wireMethod, { root_id: discovered.deviceNodeId });
      const judgedRooted = judgeResponseEnvelope(ledger, contract, {
        response: rooted,
        wireMethod: operation.wireMethod,
        capability: operation.capability,
        capabilityIsClaimed: true,
      });
      ledger.recordClaimedCapabilityAssertion({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: "get_component_tree honours its optional root_id parameter",
        contractCitation: "contract.yaml operations[get_component_tree].params root_id, presence optional, references Node.id",
        expected: `an array of Node rooted at ${discovered.deviceNodeId}`,
        actual: judgedRooted.isError
          ? `error ${judgedRooted.code}: ${judgedRooted.detail}`
          : `${Array.isArray(judgedRooted.result) ? judgedRooted.result.length : "not an array:"} node(s)`,
        held: !judgedRooted.isError && Array.isArray(judgedRooted.result) && judgedRooted.result.length > 0,
      });
    }
    return nodes;
  });

  // ------------------------------------------------------------------------
  // property.read: get_property_descriptors, get_property_value
  // ------------------------------------------------------------------------
  await visit("get_property_descriptors", async (operation) => {
    const nodeIds = discovered.descriptorNodeIds ?? [];
    if (nodeIds.length === 0) {
      ledger.recordNotProvokable({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: "get_property_descriptors could not be driven",
        contractCitation: "contract.yaml operations[get_property_descriptors].params node_id, references Node.id",
        reason: "no node in the returned component tree carried a non-empty property_ids, so there is no node_id to ask about",
      });
      return null;
    }

    const descriptorsByNodeId = new Map();
    const shapeViolations = [];
    const idMismatches = [];
    const refusedNodes = [];

    for (const nodeId of nodeIds) {
      const response = await session.request(operation.wireMethod, { node_id: nodeId });
      const judged = judgeResponseEnvelope(ledger, contract, {
        response,
        wireMethod: operation.wireMethod,
        capability: operation.capability,
        capabilityIsClaimed: true,
        describedAs: nodeId,
      });
      if (judged.isError) {
        refusedNodes.push(`${nodeId} -> ${judged.code}: ${judged.detail}`);
        continue;
      }
      if (!Array.isArray(judged.result)) {
        shapeViolations.push(`${nodeId}: expected an array of PropertyDescriptor; got ${JSON.stringify(judged.result)?.slice(0, 120)}`);
        continue;
      }
      const descriptors = judged.result;
      descriptors.forEach((descriptor, index) =>
        shapeViolations.push(...findRecordViolations(descriptor, "PropertyDescriptor", contract, `${nodeId} descriptors[${index}]`)),
      );
      descriptorsByNodeId.set(nodeId, descriptors);

      const nodeInTree = discovered.treeNodes.find((node) => node.id === nodeId);
      const declaredIds = nodeInTree ? [...nodeInTree.property_ids].sort() : [];
      const descriptorIds = descriptors.map((descriptor) => descriptor.id).sort();
      if (JSON.stringify(declaredIds) !== JSON.stringify(descriptorIds)) {
        idMismatches.push(
          `${nodeId}: the tree advertised [${declaredIds.join(", ")}], get_property_descriptors answered [${descriptorIds.join(", ")}]`,
        );
      }
    }

    const allDescriptors = [...descriptorsByNodeId.values()].flat();
    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: `get_property_descriptors answers for every sampled node (${nodeIds.length} of them) with contract-shaped PropertyDescriptor records`,
      contractCitation:
        "contract.yaml types.PropertyDescriptor: id/name/value_type/read_only/visible required, unit/description/default/selection_values/suggested_values/min/max/validator/coercer nullable; section 3 says a host emits every key of a type record, writing null where a value is absent",
      expected: `${nodeIds.length} nodes answered, every descriptor carrying all ${Object.keys(contract.types.PropertyDescriptor.fields).length} contract keys`,
      actual:
        refusedNodes.length === 0 && shapeViolations.length === 0
          ? `${allDescriptors.length} descriptors across ${descriptorsByNodeId.size} nodes; value_types present: ${[...new Set(allDescriptors.map((descriptor) => descriptor.value_type))].join(", ")}; read_only=true on ${allDescriptors.filter((descriptor) => descriptor.read_only === true).length} of them`
          : [...refusedNodes, ...shapeViolations].slice(0, 8).join(" | "),
      held: refusedNodes.length === 0 && shapeViolations.length === 0,
    });

    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: "on every sampled node, the descriptor ids match the property_ids that node advertised in the tree",
      contractCitation: "contract.yaml types.Node.property_ids.references = PropertyDescriptor.id",
      expected: `no disagreement on any of the ${descriptorsByNodeId.size} nodes that answered`,
      actual: idMismatches.length === 0 ? `${descriptorsByNodeId.size} nodes agree with their own tree entry` : idMismatches.slice(0, 4).join(" | "),
      held: idMismatches.length === 0,
    });

    discovered.descriptorsByNodeId = descriptorsByNodeId;
    discovered.descriptors = descriptorsByNodeId.get(discovered.descriptorNodeId) ?? [];
    return descriptorsByNodeId;
  });

  await visit("get_property_value", async (operation) => {
    const descriptorsByNodeId = discovered.descriptorsByNodeId ?? new Map();
    if (descriptorsByNodeId.size === 0) {
      ledger.recordNotProvokable({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: "get_property_value could not be driven",
        contractCitation: "contract.yaml operations[get_property_value].params node_id + property_id",
        reason: "no PropertyDescriptor was obtained, so there is no property_id to read",
      });
      return null;
    }
    const readable = [];
    const failedReads = [];
    let attempted = 0;
    for (const [nodeId, descriptors] of descriptorsByNodeId) {
      for (const descriptor of descriptors) {
        if (attempted >= PROPERTY_READS_AT_MOST) break;
        attempted++;
        const response = await session.request(operation.wireMethod, { node_id: nodeId, property_id: descriptor.id });
        const judged = judgeResponseEnvelope(ledger, contract, {
          response,
          wireMethod: operation.wireMethod,
          capability: operation.capability,
          capabilityIsClaimed: true,
          describedAs: `${nodeId}.${descriptor.id}`,
        });
        if (judged.isError) failedReads.push(`${nodeId}.${descriptor.id} (${descriptor.value_type}) -> ${judged.code}: ${judged.detail}`);
        else readable.push({ nodeId, descriptor, value: judged.result });
      }
    }
    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: `get_property_value reads every property the host's own descriptors advertise (${attempted} attempted across ${descriptorsByNodeId.size} nodes)`,
      contractCitation: "contract.yaml operations[get_property_value].returns = any; the property_ids come from the host's own get_property_descriptors answer",
      expected: `all ${attempted} advertised properties readable`,
      actual:
        failedReads.length === 0
          ? `${readable.length} read, for example ${readable.slice(0, 4).map((row) => `${row.nodeId}.${row.descriptor.id}=${JSON.stringify(row.value)}`).join(", ")}${readable.length > 4 ? ", ..." : ""}`
          : `${failedReads.length} of ${attempted} failed: ${failedReads.slice(0, 4).join(" | ")}`,
      held: failedReads.length === 0,
    });
    discovered.readableProperties = readable;
    if (readable.length > 0) {
      discovered.readablePropertyId = readable[0].descriptor.id;
      discovered.descriptorNodeId = readable[0].nodeId;
    }
    return readable;
  });


  // ------------------------------------------------------------------------
  // property.write: set_property_value, and the read_only / invalid_value codes
  // ------------------------------------------------------------------------
  await visit("set_property_value", async (operation) => {
    const readable = discovered.readableProperties ?? [];
    const writableBool = readable.find((row) => row.descriptor.read_only === false && row.descriptor.value_type === "bool");
    const writableNumber = readable.find(
      (row) =>
        row.descriptor.read_only === false &&
        (row.descriptor.value_type === "int" || row.descriptor.value_type === "float") &&
        typeof row.value === "number",
    );
    const chosen = writableBool ?? writableNumber;

    if (!chosen) {
      ledger.recordNotProvokable({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: "set_property_value could not be driven with a round trip",
        contractCitation: "contract.yaml operations[set_property_value].params node_id/property_id/value",
        reason: `no descriptor on any of the ${(discovered.descriptorNodeIds ?? []).length} sampled node(s) was both read_only=false and of value_type bool, int or float; the sweep will not write a string or struct property blind`,
      });
    } else {
      const submitted = chosen.descriptor.value_type === "bool"
        ? !chosen.value
        : pickANumberInsideTheDescriptorRange(chosen);
      const eventsBefore = session.eventsInArrivalOrder.length;

      const writeResponse = await session.request(operation.wireMethod, {
        node_id: chosen.nodeId,
        property_id: chosen.descriptor.id,
        value: submitted,
      });
      const judgedWrite = judgeResponseEnvelope(ledger, contract, {
        response: writeResponse,
        wireMethod: operation.wireMethod,
        capability: operation.capability,
        capabilityIsClaimed: true,
      });
      ledger.recordClaimedCapabilityAssertion({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: `set_property_value ${chosen.nodeId}.${chosen.descriptor.id} = ${JSON.stringify(submitted)} is accepted and returns void`,
        contractCitation: "contract.yaml operations[set_property_value].returns = void; envelopes.result.result presence nullable",
        expected: "a result envelope carrying null",
        actual: judgedWrite.isError ? `error ${judgedWrite.code}: ${judgedWrite.detail}` : `result ${JSON.stringify(judgedWrite.result)}`,
        held: !judgedWrite.isError && (judgedWrite.result === null || judgedWrite.result === undefined),
      });

      if (!judgedWrite.isError && claimed("property.read")) {
        const readBack = await session.request("get_property_value", {
          node_id: chosen.nodeId,
          property_id: chosen.descriptor.id,
        });
        const judgedRead = judgeResponseEnvelope(ledger, contract, {
          response: readBack,
          wireMethod: "get_property_value",
          capability: "property.read",
          capabilityIsClaimed: true,
        });
        // A host is allowed to coerce (contract.yaml PropertyDescriptor.coercer),
        // so an exact round trip is only demanded for a bool toggle, which has
        // nothing to coerce to.
        const exactRoundTripDemanded = chosen.descriptor.value_type === "bool";
        const held = exactRoundTripDemanded
          ? !judgedRead.isError && judgedRead.result === submitted
          : !judgedRead.isError && judgedRead.result !== chosen.value;
        ledger.recordClaimedCapabilityAssertion({
          capability: operation.capability,
          wireMethod: operation.wireMethod,
          title: `the write to ${chosen.nodeId}.${chosen.descriptor.id} is visible to a read-back`,
          contractCitation: exactRoundTripDemanded
            ? "a bool has no coercer range, so the read-back must equal what was written"
            : "contract.yaml types.PropertyDescriptor.coercer means a numeric write may be coerced, so the read-back is only required to differ from the value before the write",
          expected: exactRoundTripDemanded ? `read-back === ${JSON.stringify(submitted)}` : `read-back differs from the pre-write value ${JSON.stringify(chosen.value)}`,
          actual: judgedRead.isError ? `error ${judgedRead.code}: ${judgedRead.detail}` : `read-back ${JSON.stringify(judgedRead.result)} (was ${JSON.stringify(chosen.value)}, submitted ${JSON.stringify(submitted)})`,
          held,
        });

        const propertyChangedEvents = session
          .eventsSince(eventsBefore)
          .filter((event) => event.event === "property_changed" && event.payload?.property_id === chosen.descriptor.id);
        ledger.recordUnconstrained({
          title: `property_changed after writing ${chosen.descriptor.id}`,
          contractCitation:
            "contract.yaml events declares the property_changed shape but ties no event to any capability id, and gap_generation only computes gaps over capabilities - so a host that pushes no events is neither in gap nor in breach",
          reason: "the contract constrains the event's shape, never its occurrence",
          observation: propertyChangedEvents.length === 0
            ? "no property_changed event arrived for this write"
            : `${propertyChangedEvents.length} property_changed event(s): ${JSON.stringify(propertyChangedEvents[0]).slice(0, 200)}`,
        });
      }

      // Put the device back the way it was found.
      await session.request(operation.wireMethod, {
        node_id: chosen.nodeId,
        property_id: chosen.descriptor.id,
        value: chosen.value,
      });
    }

    // read_only, from the host's own descriptors.
    const readOnlyRow = readable.find((row) => row.descriptor.read_only === true);
    if (!readOnlyRow) {
      ledger.recordNotProvokable({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: 'the "read_only" error code could not be provoked',
        contractCitation: "contract.yaml operations[set_property_value].errors includes read_only",
        reason: `no descriptor on any of the ${(discovered.descriptorNodeIds ?? []).length} sampled node(s) carries read_only = true, so there is nothing to write to that must refuse`,
      });
    } else {
      const response = await session.request(operation.wireMethod, {
        node_id: readOnlyRow.nodeId,
        property_id: readOnlyRow.descriptor.id,
        value: readOnlyRow.descriptor.value_type === "bool" ? !readOnlyRow.value : readOnlyRow.value,
      });
      const judged = judgeResponseEnvelope(ledger, contract, {
        response,
        wireMethod: operation.wireMethod,
        capability: operation.capability,
        capabilityIsClaimed: true,
      });
      ledger.recordClaimedCapabilityAssertion({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: `writing the host's own read_only=true property ${readOnlyRow.nodeId}.${readOnlyRow.descriptor.id} is refused with read_only`,
        contractCitation: "contract.yaml operations[set_property_value].errors = [not_found, read_only, invalid_value]; types.PropertyDescriptor.read_only",
        expected: 'error code "read_only"',
        actual: judged.isError ? `error ${judged.code}: ${judged.detail}` : `accepted the write, result ${JSON.stringify(judged.result)}`,
        held: judged.isError && judged.code === "read_only",
      });
    }

    // invalid_value, by writing text into a numeric property.
    const numericRow = readable.find(
      (row) => row.descriptor.read_only === false && (row.descriptor.value_type === "int" || row.descriptor.value_type === "float"),
    );
    if (!numericRow) {
      ledger.recordNotProvokable({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: 'the "invalid_value" error code could not be provoked through set_property_value',
        contractCitation: "contract.yaml operations[set_property_value].errors includes invalid_value",
        reason: `no writable int or float descriptor exists on any of the ${(discovered.descriptorNodeIds ?? []).length} sampled node(s) to submit a wrong-typed value to`,
      });
    } else {
      const response = await session.request(operation.wireMethod, {
        node_id: numericRow.nodeId,
        property_id: numericRow.descriptor.id,
        value: "this is not a number, it was sent by the quackoscope conformance sweep",
      });
      const judged = judgeResponseEnvelope(ledger, contract, {
        response,
        wireMethod: operation.wireMethod,
        capability: operation.capability,
        capabilityIsClaimed: true,
      });
      ledger.recordClaimedCapabilityAssertion({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: `writing a string into the ${numericRow.descriptor.value_type} property ${numericRow.nodeId}.${numericRow.descriptor.id} is refused with invalid_value`,
        contractCitation: "contract.yaml operations[set_property_value].errors = [not_found, read_only, invalid_value]",
        expected: 'error code "invalid_value"',
        actual: judged.isError ? `error ${judged.code}: ${judged.detail}` : `accepted the write, result ${JSON.stringify(judged.result)}`,
        held: judged.isError && judged.code === "invalid_value",
      });
    }

    // not_found on the write path.
    const notFoundResponse = await session.request(operation.wireMethod, {
      node_id: discovered.descriptorNodeId ?? CONFORMANCE_UNKNOWN_NODE_ID,
      property_id: CONFORMANCE_UNKNOWN_PROPERTY_ID,
      value: 1,
    });
    const judgedNotFound = judgeResponseEnvelope(ledger, contract, {
      response: notFoundResponse,
      wireMethod: operation.wireMethod,
      capability: operation.capability,
      capabilityIsClaimed: true,
    });
    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: `set_property_value on the unknown property "${CONFORMANCE_UNKNOWN_PROPERTY_ID}" is refused with not_found`,
      contractCitation: "contract.yaml operations[set_property_value].errors includes not_found",
      expected: 'error code "not_found"',
      actual: judgedNotFound.isError ? `error ${judgedNotFound.code}: ${judgedNotFound.detail}` : `accepted, result ${JSON.stringify(judgedNotFound.result)}`,
      held: judgedNotFound.isError && judgedNotFound.code === "not_found",
    });
    return null;
  });

  // not_found on the read path, only when the host claims property.read.
  if (claimed("property.read") && discovered.descriptorNodeId) {
    for (const [wireMethod, params, title] of [
      [
        "get_property_value",
        { node_id: discovered.descriptorNodeId, property_id: CONFORMANCE_UNKNOWN_PROPERTY_ID },
        `get_property_value for the unknown property "${CONFORMANCE_UNKNOWN_PROPERTY_ID}" is refused with not_found`,
      ],
      [
        "get_property_descriptors",
        { node_id: CONFORMANCE_UNKNOWN_NODE_ID },
        `get_property_descriptors for the unknown node "${CONFORMANCE_UNKNOWN_NODE_ID}" is refused with not_found or not_connected`,
      ],
    ]) {
      const response = await session.request(wireMethod, params);
      const judged = judgeResponseEnvelope(ledger, contract, {
        response,
        wireMethod,
        capability: "property.read",
        capabilityIsClaimed: true,
      });
      const acceptable = wireMethod === "get_property_value" ? ["not_found"] : ["not_found", "not_connected"];
      ledger.recordClaimedCapabilityAssertion({
        capability: "property.read",
        wireMethod,
        title,
        contractCitation: `contract.yaml operations[${wireMethod}].errors = [${contract.operationsByWireMethod.get(wireMethod).errors.join(", ")}]`,
        expected: `one of [${acceptable.join(", ")}]`,
        actual: judged.isError ? `error ${judged.code}: ${judged.detail}` : `answered with a result: ${JSON.stringify(judged.result)?.slice(0, 160)}`,
        held: judged.isError && acceptable.includes(judged.code),
      });
    }
  }

  // ------------------------------------------------------------------------
  // function_block.add: list_function_block_types, add_function_block,
  // remove_function_block
  // ------------------------------------------------------------------------
  await visit("list_function_block_types", async (operation) => {
    const response = await session.request(operation.wireMethod, {});
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod: operation.wireMethod,
      capability: operation.capability,
      capabilityIsClaimed: true,
    });
    const isArrayOfStrings = Array.isArray(judged.result) && judged.result.every((entry) => typeof entry === "string");
    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: "list_function_block_types returns an array of strings",
      contractCitation: "contract.yaml operations[list_function_block_types].returns = array of string",
      expected: "an array whose every element is a string",
      actual: judged.isError ? `error ${judged.code}: ${judged.detail}` : JSON.stringify(judged.result)?.slice(0, 240),
      held: !judged.isError && isArrayOfStrings,
    });
    if (isArrayOfStrings && judged.result.length > 0) discovered.functionBlockTypeId = judged.result[0];
    return judged.result;
  }, (servedAnyway) => {
    if (Array.isArray(servedAnyway) && typeof servedAnyway[0] === "string") discovered.functionBlockTypeId = servedAnyway[0];
  });

  await visit("add_function_block", async (operation) => {
    if (!discovered.functionBlockTypeId || !discovered.deviceNodeId) {
      ledger.recordNotProvokable({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: "add_function_block could not be driven",
        contractCitation: "contract.yaml operations[add_function_block].params parent_id + type_id",
        reason: "list_function_block_types produced no type id, or no device node id is known, so there is nothing to add",
      });
      return null;
    }
    const response = await session.request(operation.wireMethod, {
      parent_id: discovered.deviceNodeId,
      type_id: discovered.functionBlockTypeId,
    });
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod: operation.wireMethod,
      capability: operation.capability,
      capabilityIsClaimed: true,
    });
    const violations = judged.isError ? [] : findRecordViolations(judged.result, "Node", contract, "add_function_block result");
    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: `add_function_block "${discovered.functionBlockTypeId}" under ${discovered.deviceNodeId} returns a contract-shaped Node`,
      contractCitation: "contract.yaml operations[add_function_block].returns = Node, errors [not_found, unsupported]",
      expected: "a Node record for the created function block",
      actual: judged.isError ? `error ${judged.code}: ${judged.detail}` : violations.length === 0 ? `Node ${judged.result.id} kind=${judged.result.kind}` : violations.join(" | "),
      held: !judged.isError && violations.length === 0,
    });
    if (!judged.isError && violations.length === 0) discovered.addedFunctionBlockNodeId = judged.result.id;

    const unknownTypeResponse = await session.request(operation.wireMethod, {
      parent_id: discovered.deviceNodeId,
      type_id: CONFORMANCE_UNKNOWN_FUNCTION_BLOCK_TYPE_ID,
    });
    const judgedUnknownType = judgeResponseEnvelope(ledger, contract, {
      response: unknownTypeResponse,
      wireMethod: operation.wireMethod,
      capability: operation.capability,
      capabilityIsClaimed: true,
    });
    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: `add_function_block with the unknown type id "${CONFORMANCE_UNKNOWN_FUNCTION_BLOCK_TYPE_ID}" is refused`,
      contractCitation: "contract.yaml operations[add_function_block].errors = [not_found, unsupported]",
      expected: "one of [not_found, unsupported]",
      actual: judgedUnknownType.isError ? `error ${judgedUnknownType.code}: ${judgedUnknownType.detail}` : `created something anyway: ${JSON.stringify(judgedUnknownType.result)?.slice(0, 160)}`,
      held: judgedUnknownType.isError && ["not_found", "unsupported"].includes(judgedUnknownType.code),
    });
    return judged.result;
  });

  await visit("remove_function_block", async (operation) => {
    if (!discovered.addedFunctionBlockNodeId) {
      ledger.recordNotProvokable({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: "remove_function_block could not be driven against a block this sweep created",
        contractCitation: "contract.yaml operations[remove_function_block].params node_id",
        reason: "add_function_block created nothing, so removing its result is not possible; the unknown-node refusal below is still asserted",
      });
    } else {
      const response = await session.request(operation.wireMethod, { node_id: discovered.addedFunctionBlockNodeId });
      const judged = judgeResponseEnvelope(ledger, contract, {
        response,
        wireMethod: operation.wireMethod,
        capability: operation.capability,
        capabilityIsClaimed: true,
      });
      ledger.recordClaimedCapabilityAssertion({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: `remove_function_block removes the block this sweep added (${discovered.addedFunctionBlockNodeId}) and returns void`,
        contractCitation: "contract.yaml operations[remove_function_block].returns = void",
        expected: "a result envelope carrying null",
        actual: judged.isError ? `error ${judged.code}: ${judged.detail}` : `result ${JSON.stringify(judged.result)}`,
        held: !judged.isError && (judged.result === null || judged.result === undefined),
      });
    }
    const response = await session.request(operation.wireMethod, { node_id: CONFORMANCE_UNKNOWN_NODE_ID });
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod: operation.wireMethod,
      capability: operation.capability,
      capabilityIsClaimed: true,
    });
    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: `remove_function_block on the unknown node "${CONFORMANCE_UNKNOWN_NODE_ID}" is refused with not_found`,
      contractCitation: "contract.yaml operations[remove_function_block].errors = [not_found]",
      expected: 'error code "not_found"',
      actual: judged.isError ? `error ${judged.code}: ${judged.detail}` : `accepted, result ${JSON.stringify(judged.result)}`,
      held: judged.isError && judged.code === "not_found",
    });
    return null;
  });

  // ------------------------------------------------------------------------
  // streaming.raw: read_samples_raw
  // ------------------------------------------------------------------------
  await visit("read_samples_raw", async (operation) => {
    if (!discovered.signalNodeId) {
      ledger.recordNotProvokable({
        capability: operation.capability,
        wireMethod: operation.wireMethod,
        title: "read_samples_raw could not be driven",
        contractCitation: "contract.yaml operations[read_samples_raw].params signal_id + count",
        reason: "the component tree carried no node of kind signal, so there is no signal_id to read from",
      });
      return null;
    }
    const framesBefore = session.binaryFramesInArrivalOrder.length;
    const response = await session.request(operation.wireMethod, { signal_id: discovered.signalNodeId, count: 16 });
    const judged = judgeResponseEnvelope(ledger, contract, {
      response,
      wireMethod: operation.wireMethod,
      capability: operation.capability,
      capabilityIsClaimed: true,
    });
    await session.waitForFrames(1, 500);
    const framesAfter = session.framesSince(framesBefore);
    ledger.recordClaimedCapabilityAssertion({
      capability: operation.capability,
      wireMethod: operation.wireMethod,
      title: "read_samples_raw answers the request",
      contractCitation: "contract.yaml operations[read_samples_raw].returns = binary_frame, while envelopes.result carries JSON and the binary frame header has no correlation id - see the contract-vagueness notes",
      expected: "a JSON result and/or a binary frame; the contract does not settle which",
      actual: `${judged.isError ? `error ${judged.code}: ${judged.detail}` : `result ${JSON.stringify(judged.result)?.slice(0, 200)}`}; ${framesAfter.length} binary frame(s) arrived within 500 ms`,
      held: !judged.isError || framesAfter.length > 0,
    });
    return null;
  });

  // Whether every operation of the contract was driven is NOT decided here any
  // more. It used to be, from the visitedWireMethods set above plus three names
  // added by hand for the operations other sweeps drive - and that hand-kept
  // list is precisely what let six operations be added to contract.yaml and
  // never asked of a single host. The question is now answered after every sweep
  // has run, from request counts taken on the socket itself and from the ledger,
  // by sweeps/require-every-contract-operation-to-be-driven.mjs. The set below
  // stays because it is what tells THIS sweep which rows it has already handled.
  discovered.wireMethodsVisitedByThisSweep = [...visitedWireMethods];
  return discovered;
}

function pickANumberInsideTheDescriptorRange(row) {
  const { descriptor, value } = row;
  const minimum = typeof descriptor.min === "number" ? descriptor.min : null;
  const maximum = typeof descriptor.max === "number" ? descriptor.max : null;
  if (Array.isArray(descriptor.suggested_values) && descriptor.suggested_values.length > 0) {
    const different = descriptor.suggested_values.find((candidate) => typeof candidate === "number" && candidate !== value);
    if (different !== undefined) return different;
  }
  if (minimum !== null && maximum !== null) {
    const middle = descriptor.value_type === "int" ? Math.round((minimum + maximum) / 2) : (minimum + maximum) / 2;
    if (middle !== value) return middle;
    return descriptor.value_type === "int" ? Math.min(maximum, middle + 1) : Math.min(maximum, middle + 1);
  }
  return descriptor.value_type === "int" ? Number(value) + 1 : Number(value) + 1;
}
