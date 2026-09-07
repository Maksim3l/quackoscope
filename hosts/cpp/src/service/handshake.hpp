// Quackoscope host (C++) -- service layer.
//
// Contract section 1.6: the first message the server sends on every new
// WebSocket session, before any request is answered.
//
// The capability list in that message is DERIVED, never typed out: the session
// layer hands over the wire method names it actually dispatches, and a
// capability is declared only when every operation the contract assigns to it
// has a handler. The gap list is then baseline-minus-declared, exactly as
// contract section 4 requires -- this host writes no gap list of its own, only
// a reason per capability it fails to serve.
//
// The baseline itself comes from generated/cpp/quackoscope-contract.hpp, which
// tools/contract-compiler emits from contract/contract.yaml. The operation ->
// capability table below is checked against that generated header at startup,
// so it cannot drift away from the contract without the host refusing to run.
#pragma once

#include "service/manifest.hpp"
#include "service/types.hpp"

#include <cstdint>
#include <set>
#include <string>
#include <vector>

namespace qs::service
{

// One row of the contract's closed operation table (contract section 5): the
// wire method name and the capability id that owns it.
struct ContractOperation
{
    std::string wire_method;
    std::string capability;
};

// Every row of contract section 5. Throws std::runtime_error naming the
// offending entry if this table and the generated contract header disagree
// about the wire method names or the capability ids; the counts are read from
// the generated header rather than written down here.
const std::vector<ContractOperation>& contractOperationTable();

// The baseline capability ids, in contract order, read from the generated
// contract header.
const std::vector<std::string>& baselineCapabilityIds();

// A capability is served when EVERY wire method the contract assigns to it is
// present in servedWireMethods. Result keeps contract order.
//
// All-of, not any-of, and the reason is in the contract rather than in taste.
// contract/contract.yaml section 4 defines a capability AS its operation list
// ({id: device.connect, operations: [[connect, device], [disconnect, device]]}),
// and lints.capability_operation_lists_agree calls capabilities[].operations and
// operations[].capability "two views of one mapping [that] must agree exactly in
// both directions" -- there is no partial reference to half a capability.
// gap_generation.computed_as is baseline_capabilities_minus_host_capabilities,
// so `capabilities` and `gaps` are exactly complementary over the baseline ids, and
// gap_kinds.host is "the handler has not been written yet". Declare a
// capability on a subset of its operations and the unwritten handler is stated
// NOWHERE in the handshake: not in `capabilities`, which claims it works, and
// not in `gaps`, which the id has been excluded from. All-of is the only rule
// under which the handshake can express the fact the contract gives it words
// for. hosts/python/service/handshake.py:capabilities_fully_served_by() and
// hosts/mock-ts/src/service/capabilities-from-served-wire-methods.ts:
// capabilitiesFullyServedBy() apply the same rule, so a frontend that enables a
// control on a capability id gets the same promise from every backend.
std::vector<std::string> capabilitiesFullyServedBy(const std::set<std::string>& servedWireMethods);

// Gap kinds are exactly two. A C++ host that does not serve an operation has a
// handler that was not written -- Host. Binding is for a host whose SDK binding
// lacks the feature outright.
enum class GapKind
{
    Binding,
    Host
};

const char* toWire(GapKind kind);

struct Gap
{
    std::string capability;
    GapKind kind = GapKind::Host;
    std::string reason;
};

// baseline minus servedCapabilities, each with the reason this host declares
// for it. Throws std::runtime_error naming the capability if a gap has no
// declared reason: an undeclared gap would reach the wire with an empty
// reason, which contract types.Gap forbids (min_length 1).
std::vector<Gap> gapsAgainstBaseline(const std::vector<std::string>& servedCapabilities);

// {"protocol_version": ..., "implementation": {...}, "sdk": {...},
//  "capabilities": [...], "gaps": [...], "limits": {...}}
//
// sdkVersion and sdkCommit come from the manifest and from nowhere else.
Json buildHandshake(const std::string& implementationName,
                    const std::string& implementationVersion,
                    const Manifest& manifest,
                    const std::vector<std::string>& capabilities,
                    const std::vector<Gap>& gaps,
                    std::int64_t maxSubscriptions,
                    std::int64_t maxFrameBytes);

}  // namespace qs::service
