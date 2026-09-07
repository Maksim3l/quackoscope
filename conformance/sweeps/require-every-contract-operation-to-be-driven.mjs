// The guard that stops operation twenty from slipping through the way
// operations fourteen to nineteen did.
//
// WHAT WENT WRONG BEFORE. contract.yaml grew six operations - the device.mode
// pair, the device.lock pair, list_loaded_modules and load_module_from_host_path
// - after the sweeps were written, and nothing in conformance/ noticed. The only
// coverage statement the suite had was a hand-kept set inside
// sweep-every-contract-operation.mjs: each sweep added the names it drove, three
// more names were added to it by hand because they are driven in other files,
// and the difference against contract.operations was reported. That set is a
// LIST, and a list is exactly the wrong instrument: the six new rows were never
// added to it because nobody was writing them down, and the same edit that would
// have added a name is the edit that would have written the coverage. A guard
// that can be satisfied by typing a name is a guard that measures typing.
//
// WHAT THIS MEASURES INSTEAD. Two facts, neither of them a list anyone maintains:
//
//   1. requests actually sent. WireSession counts every request envelope by its
//      method name at the point it puts the frame on the socket
//      (wire/open-wire-session.mjs). An operation is "put to the host" when that
//      count is above zero, on any session this run opened. Nothing but sending
//      the request can produce that number.
//   2. assertions actually recorded. Every ledger entry carries wire_method. An
//      operation is "judged" when at least one entry names it. Sending a request
//      and never judging the answer is not coverage either.
//
// An operation passes when BOTH hold, or when the suite recorded an explicit
// not_provokable_by_a_wire_client entry naming it - which is a sweep saying, in
// the report, why this host's own data left the row undrivable (no signal in the
// tree, no writable property). That is the one honest way to be uncovered, and
// it costs a printed reason.
//
// WHY IT IS ITS OWN VERDICT. The old assertion was recorded as
// wire_protocol_broken, which reads as "the host broke the wire protocol". The
// host did nothing; conformance/ did. suite_coverage_incomplete is a failure -
// exit 1, and the cross-host report refuses to call a run clean while one stands
// - and it says whose fault it is.

/**
 * @param {import("./conformance-ledger.mjs").ConformanceLedger} ledger
 * @param {object} contract        the parsed contract.yaml view
 * @param {Array}  sessions        every WireSession this run opened, in the order
 *                                 it opened them
 * @returns {{driven: string[], undriven: string[], perOperation: object[]}}
 */
export function requireEveryContractOperationToBeDriven(ledger, contract, sessions) {
  const requestsSentByWireMethod = new Map();
  for (const session of sessions) {
    for (const [wireMethod, count] of session.requestsSentByWireMethod ?? new Map()) {
      requestsSentByWireMethod.set(wireMethod, (requestsSentByWireMethod.get(wireMethod) ?? 0) + count);
    }
  }

  const entriesByWireMethod = new Map();
  for (const entry of ledger.entries) {
    if (!entry.wire_method) continue;
    if (!entriesByWireMethod.has(entry.wire_method)) entriesByWireMethod.set(entry.wire_method, []);
    entriesByWireMethod.get(entry.wire_method).push(entry);
  }

  const perOperation = contract.operations.map((operation) => {
    const requestsSent = requestsSentByWireMethod.get(operation.wireMethod) ?? 0;
    const entries = entriesByWireMethod.get(operation.wireMethod) ?? [];
    const saidWhyItCouldNotBeDriven = entries.some((entry) => entry.verdict === "not_provokable_by_a_wire_client");
    return {
      wire_method: operation.wireMethod,
      capability: operation.capability,
      requests_sent: requestsSent,
      ledger_entries: entries.length,
      declared_undrivable_with_a_reason: saidWhyItCouldNotBeDriven,
      driven: (requestsSent > 0 && entries.length > 0) || saidWhyItCouldNotBeDriven,
    };
  });

  const driven = perOperation.filter((row) => row.driven).map((row) => row.wire_method);
  const undriven = perOperation.filter((row) => !row.driven);

  const describeOneUndrivenRow = (row) =>
    `${row.wire_method} (capability ${row.capability}): ${row.requests_sent} request(s) sent, ${row.ledger_entries} ledger entry/entries`;

  ledger.recordSuiteCoverageAssertion({
    title: `every one of the ${contract.operations.length} operations in contract.yaml was put on the socket and judged`,
    contractCitation:
      `contract.yaml operations: ${contract.operations.length} rows - ${contract.operations.map((operation) => operation.wireMethod).join(", ")}. ` +
      "Section 5 calls that table closed and says host coverage of it is 100%; a suite that reports a clean sweep while never asking one of its rows is reporting on a smaller contract than the one it read.",
    expected:
      `all ${contract.operations.length} wire methods with at least one request sent on a session of this run AND at least one ledger entry naming them, ` +
      "or an explicit not_provokable_by_a_wire_client entry saying why this host's own data left the row undrivable",
    actual:
      undriven.length === 0
        ? `${driven.length} of ${contract.operations.length} driven; requests sent per wire method: ${perOperation.map((row) => `${row.wire_method}=${row.requests_sent}`).join(", ")}`
        : `${driven.length} of ${contract.operations.length} driven. NEVER DRIVEN: ${undriven.map(describeOneUndrivenRow).join(" | ")}. ` +
          "conformance/sweeps has no case for these rows; write one, or record why a wire client cannot reach them. This is a hole in the suite, not a fault of the host at the other end.",
    held: undriven.length === 0,
  });

  return {
    driven,
    undriven: undriven.map((row) => row.wire_method),
    perOperation,
  };
}
