#include "service/handshake.hpp"

// GENERATED, from contract/contract.yaml. The baseline capability ids and the
// closed wire method table are read from here rather than retyped, so this
// host cannot silently disagree with the contract about what the baseline is.
#include <quackoscope-contract.hpp>

#include <algorithm>
#include <map>
#include <stdexcept>

namespace qs::service
{
namespace
{

namespace contract = ::quackoscope::contract;

// Which capability owns which wire method, contract section 5. Every wire
// method name and every capability id here is cross-checked against the
// generated header in verifyAgainstGeneratedContract() below, so the row count
// of this table is never asserted in prose: it is asserted against
// generated/cpp/quackoscope-contract.hpp at startup.
const std::vector<ContractOperation> kOperationTable = {
    {"scan_available_devices", "device.scan"},
    {"connect_device", "device.connect"},
    {"disconnect_device", "device.connect"},
    {"get_component_tree", "tree.read"},
    {"get_property_value", "property.read"},
    {"get_property_descriptors", "property.read"},
    {"set_property_value", "property.write"},
    {"list_function_block_types", "function_block.add"},
    {"add_function_block", "function_block.add"},
    {"remove_function_block", "function_block.add"},
    {"subscribe_signal", "streaming.decimated"},
    {"unsubscribe_signal", "streaming.decimated"},
    {"read_samples_raw", "streaming.raw"},
    {"get_device_operation_modes", "device.mode"},
    {"set_device_operation_mode", "device.mode"},
    {"lock_device", "device.lock"},
    {"unlock_device", "device.lock"},
    {"list_loaded_modules", "module.read"},
    // module.load is its own capability, not part of module.read: enumerating
    // the loaded modules is a read, while loading one makes this process
    // dlopen a file off its own disk and run that file's initialisation. With
    // ALL-OF capability semantics they have to be separate for a host to be
    // able to serve the list without serving the loader.
    {"load_module_from_host_path", "module.load"},
    // attribute.read and attribute.write are two capabilities over one panel
    // for the same reason property.read and property.write are: reading and
    // writing are separately grantable, and a host that can read attributes but
    // not write them must be able to say so through the gap rather than by
    // reporting read_only on every row, which would claim openDAQ locked them.
    {"get_component_attributes", "attribute.read"},
    {"set_component_attribute", "attribute.write"},
    // server.discovery is separate from server.add because the discovery items
    // act on a server row this session may not have created: a host that
    // publishes servers from its own configuration can enable discovery on them
    // without ever letting a client create one.
    {"list_server_types", "server.add"},
    {"add_server", "server.add"},
    {"set_server_discovery_enabled", "server.discovery"},
    {"start_recording", "recorder.control"},
    {"stop_recording", "recorder.control"},
    // property.batched_update is separate from property.write, and the
    // direction of that split matters: folded together, a host that cannot
    // reach beginUpdate would have to withhold property.write, which disables
    // every property editor in the application.
    {"begin_batched_property_update", "property.batched_update"},
    {"end_batched_property_update", "property.batched_update"},
    // configuration.save is separate from configuration.load because saving
    // serialises and reads nothing else, while loading REPLACES the
    // configuration of every device under the instance in one call.
    {"save_instance_configuration_to_string", "configuration.save"},
    {"load_instance_configuration_from_string", "configuration.load"},
};

// The reason this host declares for a capability it does not serve. A gap is
// only ever COMPUTED (baseline minus served); this table supplies nothing but
// the reason text the contract asks the host for.
const std::map<std::string, Gap> kDeclaredGapReasons = {
    {"streaming.raw",
     {"streaming.raw",
      GapKind::Host,
      "read_samples_raw has no handler in quackoscope-host-cpp: contract/contract.yaml declares "
      "returns: {type: binary_frame} for it, but envelopes.result carries a JSON result and the "
      "17-byte binary_frame header has no correlation id, so a binary answer cannot be matched to "
      "its request id. The two generated clients already disagree about the JSON stand-in -- "
      "generated/typescript/contract-client.ts casts a flat result object to BinarySampleFrame, "
      "generated/python/contract_types.py expects {header, values} -- and this host will not pick "
      "one of them on the contract's behalf."}},
};

std::vector<std::string> readBaselineFromGeneratedContract()
{
    std::vector<std::string> out;
    for (const auto id : contract::BASELINE_CAPABILITY_IDS)
        out.emplace_back(id);
    return out;
}

// The operation table above is hand-written; the generated header is not. If
// they ever disagree the host refuses to start rather than announce a
// capability set computed against the wrong baseline.
void verifyAgainstGeneratedContract(const std::vector<ContractOperation>& table,
                                    const std::vector<std::string>& baseline)
{
    std::set<std::string> generatedMethods;
    for (const auto method : contract::WIRE_METHOD_NAMES)
        generatedMethods.emplace(method);

    std::set<std::string> tableMethods;
    for (const auto& row : table)
    {
        if (!tableMethods.insert(row.wire_method).second)
            throw std::runtime_error("wire method \"" + row.wire_method +
                                     "\" appears twice in the operation table of "
                                     "hosts/cpp/src/service/handshake.cpp");
        if (std::find(baseline.begin(), baseline.end(), row.capability) == baseline.end())
            throw std::runtime_error("wire method \"" + row.wire_method + "\" is mapped to capability \"" +
                                     row.capability + "\", which is not one of the " +
                                     std::to_string(baseline.size()) +
                                     " baseline capability ids in generated/cpp/quackoscope-contract.hpp");
    }

    for (const auto& method : generatedMethods)
        if (tableMethods.find(method) == tableMethods.end())
            throw std::runtime_error("wire method \"" + method +
                                     "\" is in generated/cpp/quackoscope-contract.hpp but missing from the "
                                     "operation table of hosts/cpp/src/service/handshake.cpp");

    for (const auto& method : tableMethods)
        if (generatedMethods.find(method) == generatedMethods.end())
            throw std::runtime_error("wire method \"" + method +
                                     "\" is in the operation table of hosts/cpp/src/service/handshake.cpp but "
                                     "not in generated/cpp/quackoscope-contract.hpp");

    for (const auto& capability : baseline)
    {
        const bool owned = std::any_of(table.begin(),
                                       table.end(),
                                       [&capability](const ContractOperation& row)
                                       { return row.capability == capability; });
        if (!owned)
            throw std::runtime_error("baseline capability \"" + capability +
                                     "\" owns no wire method in the operation table of "
                                     "hosts/cpp/src/service/handshake.cpp");
    }
}

}  // namespace

const std::vector<std::string>& baselineCapabilityIds()
{
    static const std::vector<std::string> baseline = readBaselineFromGeneratedContract();
    return baseline;
}

const std::vector<ContractOperation>& contractOperationTable()
{
    static const std::vector<ContractOperation>& table = []() -> const std::vector<ContractOperation>&
    {
        verifyAgainstGeneratedContract(kOperationTable, baselineCapabilityIds());
        return kOperationTable;
    }();
    return table;
}

std::vector<std::string> capabilitiesFullyServedBy(const std::set<std::string>& servedWireMethods)
{
    const auto& table = contractOperationTable();

    std::vector<std::string> served;
    for (const auto& capability : baselineCapabilityIds())
    {
        bool everyOperationHasAHandler = true;
        for (const auto& row : table)
            if (row.capability == capability && servedWireMethods.find(row.wire_method) == servedWireMethods.end())
                everyOperationHasAHandler = false;

        if (everyOperationHasAHandler)
            served.push_back(capability);
    }
    return served;
}

const char* toWire(GapKind kind)
{
    switch (kind)
    {
        case GapKind::Binding: return "binding";
        case GapKind::Host:    return "host";
    }
    return "host";
}

std::vector<Gap> gapsAgainstBaseline(const std::vector<std::string>& servedCapabilities)
{
    std::vector<Gap> gaps;
    for (const auto& capability : baselineCapabilityIds())
    {
        if (std::find(servedCapabilities.begin(), servedCapabilities.end(), capability) != servedCapabilities.end())
            continue;

        const auto declared = kDeclaredGapReasons.find(capability);
        if (declared == kDeclaredGapReasons.end() || declared->second.reason.empty())
            throw std::runtime_error(
                "capability \"" + capability +
                "\" is a gap (this host dispatches none or only some of its wire methods) but "
                "hosts/cpp/src/service/handshake.cpp declares no reason for it; contract types.Gap.reason "
                "has min_length 1, so the handshake cannot be built");

        gaps.push_back(declared->second);
    }
    return gaps;
}

Json buildHandshake(const std::string& implementationName,
                    const std::string& implementationVersion,
                    const Manifest& manifest,
                    const std::vector<std::string>& capabilities,
                    const std::vector<Gap>& gaps,
                    std::int64_t maxSubscriptions,
                    std::int64_t maxFrameBytes)
{
    Json gapArray = Json::array();
    for (const auto& gap : gaps)
        gapArray.push_back(Json{{"capability", gap.capability}, {"kind", toWire(gap.kind)}, {"reason", gap.reason}});

    return Json{{"protocol_version", std::string(contract::PROTOCOL_VERSION)},
                {"implementation", {{"name", implementationName}, {"version", implementationVersion}}},
                {"sdk", {{"version", manifest.sdk_version}, {"commit", manifest.commit}}},
                {"capabilities", capabilities},
                {"gaps", gapArray},
                {"limits", {{"max_subscriptions", maxSubscriptions}, {"max_frame_bytes", maxFrameBytes}}}};
}

}  // namespace qs::service
