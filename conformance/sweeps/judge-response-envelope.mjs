// Judges one response envelope: the rules that hold for every operation of the
// contract, whichever host answered and whatever it claims.
//
// Two error-code rules, deliberately kept apart because they carry different
// weight:
//
//   CLOSED SET (binds every host, always)
//     contract.yaml error_codes.closed is true. A code outside
//     [not_found, not_connected, invalid_value, read_only, unsupported,
//     timeout, internal] breaks the wire protocol no matter what the host
//     claims, so it is recorded as wire_protocol_broken.
//
//   PER-OPERATION SUBSET (binds a host that CLAIMED the capability)
//     operations[].errors names the codes that operation may answer with. A
//     host that claims the capability and then answers outside that subset is
//     failure class (b). A host that declared the capability a gap is not
//     judged here at all - see recordGapConsistency.

import { findErrorShapeViolations } from "../wire/validate-record-against-contract-type.mjs";

/**
 * @returns {{isError: boolean, code: string|null, detail: string|null, result: any}}
 */
export function judgeResponseEnvelope(ledger, contract, { response, wireMethod, capability, capabilityIsClaimed, errorCodesAlsoAllowed = [], describedAs = null }) {
  const operation = contract.operationsByWireMethod.get(wireMethod);
  const hasResult = "result" in response;
  const hasError = "error" in response;
  const subject = describedAs ? `${wireMethod} ${describedAs}` : wireMethod;

  ledger.recordWireProtocolAssertion({
    title: `${subject}: the response carries exactly one of result or error`,
    wireMethod,
    contractCitation: "contract.yaml envelopes.result (discriminator has_key_result) and envelopes.error (discriminator has_key_error)",
    expected: "exactly one of the keys result / error, alongside the request's correlation id",
    actual: `keys: ${Object.keys(response).join(", ")}`,
    held: hasResult !== hasError,
  });

  if (!hasError) {
    return { isError: false, code: null, detail: null, result: response.result };
  }

  const shapeViolations = findErrorShapeViolations(response.error, contract, `${wireMethod} error`);
  ledger.recordWireProtocolAssertion({
    title: `${subject}: the error object matches contract error_shape and the closed error set`,
    wireMethod,
    contractCitation: `contract.yaml error_shape (code, detail) and error_codes.closed = ${contract.errorCodesClosed}, values [${contract.errorCodes.join(", ")}]`,
    expected: "{code: one of the closed set, detail: string}",
    actual: shapeViolations.length === 0 ? JSON.stringify(response.error) : shapeViolations.join(" | "),
    held: shapeViolations.length === 0,
  });

  const code = response.error && typeof response.error === "object" ? response.error.code : null;
  const detail = response.error && typeof response.error === "object" ? response.error.detail : null;

  if (capabilityIsClaimed && operation) {
    const permitted = [...operation.errors, ...errorCodesAlsoAllowed];
    ledger.recordClaimedCapabilityAssertion({
      capability,
      wireMethod,
      title: `${subject}: the refusal code is inside the subset this operation declares`,
      contractCitation: `contract.yaml operations[${wireMethod}].errors = [${operation.errors.join(", ")}]${errorCodesAlsoAllowed.length ? `; also allowed here by ${errorCodesAlsoAllowed.join(", ")}` : ""}`,
      expected: `one of [${permitted.join(", ")}]`,
      actual: `${JSON.stringify(code)} - ${JSON.stringify(detail)}`,
      held: permitted.includes(code),
    });
  }

  return { isError: true, code, detail, result: undefined };
}
