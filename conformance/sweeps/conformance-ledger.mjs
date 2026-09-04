// The ledger that keeps the two failure classes apart.
//
// This distinction is the whole reason the harness exists:
//
//   (a) DECLARED GAP, CONSISTENT
//       The handshake did not list capability C, and the operations belonging
//       to C are indeed refused. The host told the truth. NOT a failure. A host
//       that declares every baseline capability as a gap therefore passes.
//
//   (b) CLAIMS A CAPABILITY AND FAILS IT
//       The handshake listed capability C in `capabilities`, and an operation
//       belonging to C then broke: wrong shape, wrong error code, no response,
//       a result where the contract requires a refusal. The host lied. A REAL
//       FAILURE.
//
// Three further verdicts exist because they are genuinely neither (a) nor (b),
// and folding them into either one would make the report dishonest:
//
//   WIRE PROTOCOL BROKEN         a rule that binds every host regardless of what
//                                it claims (handshake ordinal, envelope shape,
//                                the closed error set). A failure.
//   HANDSHAKE NONCONFORMANT      the handshake itself does not match contract
//                                1.6, so its capability list cannot be trusted
//                                to classify anything else. A failure.
//   GAP DECLARED BUT SERVED      the host called C a gap and then served it.
//                                Under-claiming, not a broken promise: reported
//                                as a warning so that "declares everything as a
//                                gap" still passes.
//   SUITE COVERAGE INCOMPLETE    an operation in contract.yaml that this run put
//                                on no socket and wrote no assertion about. It
//                                is a FAILURE, and it is the only verdict here
//                                that blames the SUITE rather than the host: a
//                                host cannot be judged on a row nobody asked it.
//                                It is kept apart from wire_protocol_broken for
//                                exactly that reason - a report saying "this
//                                host broke the wire protocol" when the truth is
//                                "conformance/ never drove this row" names the
//                                wrong culprit. See
//                                sweeps/require-every-contract-operation-to-be-driven.mjs.
//
// And two non-verdicts, recorded so the report says what it could not reach
// rather than silently omitting it:
//
//   NOT PROVOKABLE BY A WIRE CLIENT   e.g. the `internal` and `timeout` error
//                                     codes, which no well-formed request can
//                                     force out of a healthy host.
//   UNCONSTRAINED BY THE CONTRACT     e.g. event delivery, which contract.yaml
//                                     ties to no capability id, so a host that
//                                     pushes no events is neither in gap nor in
//                                     breach.

export const VERDICT_HELD = "held";
export const VERDICT_GAP_DECLARED_AND_CONSISTENT = "gap_declared_and_consistent";
export const VERDICT_CAPABILITY_CLAIMED_AND_BROKEN = "capability_claimed_and_broken";
export const VERDICT_WIRE_PROTOCOL_BROKEN = "wire_protocol_broken";
export const VERDICT_HANDSHAKE_NONCONFORMANT = "handshake_nonconformant";
export const VERDICT_GAP_DECLARED_BUT_SERVED = "gap_declared_but_served";
export const VERDICT_SUITE_COVERAGE_INCOMPLETE = "suite_coverage_incomplete";
export const VERDICT_NOT_PROVOKABLE_BY_A_WIRE_CLIENT = "not_provokable_by_a_wire_client";
export const VERDICT_UNCONSTRAINED_BY_THE_CONTRACT = "unconstrained_by_the_contract";

const FAILING_VERDICTS = new Set([
  VERDICT_CAPABILITY_CLAIMED_AND_BROKEN,
  VERDICT_WIRE_PROTOCOL_BROKEN,
  VERDICT_HANDSHAKE_NONCONFORMANT,
  VERDICT_SUITE_COVERAGE_INCOMPLETE,
]);

const WARNING_VERDICTS = new Set([VERDICT_GAP_DECLARED_BUT_SERVED]);

export class ConformanceLedger {
  constructor({ targetUrl, contract }) {
    this.targetUrl = targetUrl;
    this.contract = contract;
    this.entries = [];
    this.declaredCapabilities = null;
    this.gapCapabilities = null;
  }

  /**
   * Called once the handshake sweep has decided which capabilities the host
   * claims. Every later capability-scoped entry is classified against this.
   */
  setDeclaredCapabilities(declaredCapabilities) {
    this.declaredCapabilities = new Set(declaredCapabilities);
    this.gapCapabilities = new Set(
      this.contract.capabilityBaselineIds.filter((id) => !this.declaredCapabilities.has(id)),
    );
  }

  capabilityIsClaimed(capability) {
    if (this.declaredCapabilities === null) {
      throw new Error("the ledger was asked to classify a capability before the handshake sweep set the declared list");
    }
    return this.declaredCapabilities.has(capability);
  }

  push(entry) {
    this.entries.push(entry);
    return entry;
  }

  /** A rule that binds every host, claimed capabilities or not. */
  recordWireProtocolAssertion({ title, expected, actual, held, wireMethod = null, contractCitation }) {
    return this.push({
      title,
      scope: "wire_protocol",
      capability: null,
      wire_method: wireMethod,
      contract_citation: contractCitation,
      expected,
      actual,
      verdict: held ? VERDICT_HELD : VERDICT_WIRE_PROTOCOL_BROKEN,
    });
  }

  /** A rule about the handshake's own shape. */
  recordHandshakeAssertion({ title, expected, actual, held, contractCitation }) {
    return this.push({
      title,
      scope: "handshake",
      capability: null,
      wire_method: null,
      contract_citation: contractCitation,
      expected,
      actual,
      verdict: held ? VERDICT_HELD : VERDICT_HANDSHAKE_NONCONFORMANT,
    });
  }

  /**
   * An assertion about an operation whose capability the host CLAIMED. If it
   * does not hold, that is failure class (b).
   */
  recordClaimedCapabilityAssertion({ capability, wireMethod, title, expected, actual, held, contractCitation }) {
    if (!this.capabilityIsClaimed(capability)) {
      throw new Error(
        `recordClaimedCapabilityAssertion was called for "${capability}", which this host did not claim; a gap must go through recordGapConsistency`,
      );
    }
    return this.push({
      title,
      scope: "capability_claimed",
      capability,
      wire_method: wireMethod,
      contract_citation: contractCitation,
      expected,
      actual,
      verdict: held ? VERDICT_HELD : VERDICT_CAPABILITY_CLAIMED_AND_BROKEN,
    });
  }

  /**
   * An operation whose capability the host declared a GAP. The host passes by
   * refusing it; it earns a warning, not a failure, by serving it anyway.
   */
  recordGapConsistency({ capability, wireMethod, gapReason, refused, errorCode, actual }) {
    const verdict = refused ? VERDICT_GAP_DECLARED_AND_CONSISTENT : VERDICT_GAP_DECLARED_BUT_SERVED;
    return this.push({
      title: `${wireMethod} belongs to declared gap "${capability}"`,
      scope: "gap_declared",
      capability,
      wire_method: wireMethod,
      contract_citation: "contract.yaml gap_generation (gaps = baseline minus declared capabilities)",
      expected: `a refusal, because "${capability}" is absent from this host's handshake capabilities`,
      actual: refused
        ? `refused with error code "${errorCode}": ${actual}`
        : `answered with a result instead of refusing: ${actual}`,
      gap_reason_declared_by_host: gapReason,
      refusal_error_code: errorCode,
      verdict,
    });
  }

  /**
   * An operation of contract.yaml that this run did not drive and did not write
   * a single assertion about. The subject is conformance/, not the host, so it
   * carries no capability and never consults the declared list: a row nobody
   * asked cannot be a gap the host declared, nor a promise the host broke.
   */
  recordSuiteCoverageAssertion({ title, expected, actual, held, wireMethod = null, contractCitation }) {
    return this.push({
      title,
      scope: "suite_coverage",
      capability: null,
      wire_method: wireMethod,
      contract_citation: contractCitation,
      expected,
      actual,
      verdict: held ? VERDICT_HELD : VERDICT_SUITE_COVERAGE_INCOMPLETE,
    });
  }

  recordNotProvokable({ title, reason, wireMethod = null, capability = null, contractCitation }) {
    return this.push({
      title,
      scope: "not_provokable",
      capability,
      wire_method: wireMethod,
      contract_citation: contractCitation,
      expected: "no assertion: a well-formed wire client cannot force this without breaking the host from the outside",
      actual: reason,
      verdict: VERDICT_NOT_PROVOKABLE_BY_A_WIRE_CLIENT,
    });
  }

  recordUnconstrained({ title, reason, observation, contractCitation }) {
    return this.push({
      title,
      scope: "unconstrained",
      capability: null,
      wire_method: null,
      contract_citation: contractCitation,
      expected: "no pass/fail is possible: the contract constrains the shape but not the occurrence",
      actual: `${reason}  observed: ${observation}`,
      verdict: VERDICT_UNCONSTRAINED_BY_THE_CONTRACT,
    });
  }

  tally() {
    const counts = {};
    for (const entry of this.entries) counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1;
    return counts;
  }

  failures() {
    return this.entries.filter((entry) => FAILING_VERDICTS.has(entry.verdict));
  }

  warnings() {
    return this.entries.filter((entry) => WARNING_VERDICTS.has(entry.verdict));
  }
}
