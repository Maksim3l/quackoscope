#include "service/session.hpp"

#include "service/decimator.hpp"
#include "transport/wire.hpp"

#include <iostream>
#include <stdexcept>

namespace qs::service
{
namespace
{

std::string requireString(const Json& params, const char* key)
{
    if (!params.contains(key) || !params[key].is_string())
        throw ServiceError(ErrorCode::InvalidValue, std::string("params.") + key + " must be a string");
    return params[key].get<std::string>();
}

// std::stoul stops at the first character it cannot use, so "12abc" would come
// back as 12 and "-1" as 4294967295. A subscription id has to be the whole
// string and nothing else.
bool parseWholeUint32(const std::string& text, std::uint32_t& out)
{
    if (text.empty() || text.size() > 10)
        return false;
    std::uint64_t value = 0;
    for (const char c : text)
    {
        if (c < '0' || c > '9')
            return false;
        value = value * 10 + static_cast<std::uint64_t>(c - '0');
    }
    if (value > 0xFFFFFFFFull)
        return false;
    out = static_cast<std::uint32_t>(value);
    return true;
}

std::uint32_t requireIntInRange(const Json& params, const char* key, std::int64_t low, std::int64_t high)
{
    if (!params.contains(key) || !params[key].is_number_integer())
        throw ServiceError(ErrorCode::InvalidValue, std::string("params.") + key + " must be an integer");
    const auto v = params[key].get<std::int64_t>();
    if (v < low || v > high)
        throw ServiceError(ErrorCode::InvalidValue,
                           std::string("params.") + key + " must be in [" + std::to_string(low) + ", " +
                               std::to_string(high) + "]; got " + std::to_string(v));
    return static_cast<std::uint32_t>(v);
}

}  // namespace

const std::map<std::string, SessionHub::Handler>& SessionHub::handlersByWireMethod()
{
    // The one place a wire method becomes an operation this host serves. Adding
    // a row here is what adds its capability to the handshake; removing one is
    // what turns the capability back into a gap.
    static const std::map<std::string, Handler> table = {
        {"scan_available_devices", &SessionHub::scanAvailableDevices},
        {"connect_device", &SessionHub::connectDevice},
        {"disconnect_device", &SessionHub::disconnectDevice},
        {"get_component_tree", &SessionHub::getComponentTree},
        {"get_property_descriptors", &SessionHub::getPropertyDescriptors},
        {"get_property_value", &SessionHub::getPropertyValue},
        {"set_property_value", &SessionHub::setPropertyValue},
        {"list_function_block_types", &SessionHub::listFunctionBlockTypes},
        {"add_function_block", &SessionHub::addFunctionBlock},
        {"remove_function_block", &SessionHub::removeFunctionBlock},
        {"subscribe_signal", &SessionHub::subscribeSignal},
        {"unsubscribe_signal", &SessionHub::unsubscribeSignal},
        {"get_device_operation_modes", &SessionHub::getDeviceOperationModes},
        {"set_device_operation_mode", &SessionHub::setDeviceOperationMode},
        {"lock_device", &SessionHub::lockDevice},
        {"unlock_device", &SessionHub::unlockDevice},
        {"list_loaded_modules", &SessionHub::listLoadedModules},
        {"load_module_from_host_path", &SessionHub::loadModuleFromHostPath},
    };
    return table;
}

SessionHub::SessionHub(IDaqBackend& backend,
                       const Manifest& manifest,
                       std::string implementationName,
                       std::string implementationVersion)
    : backend_(backend)
{
    std::set<std::string> served;
    for (const auto& [wireMethod, handler] : handlersByWireMethod())
        served.insert(wireMethod);

    const std::vector<std::string> capabilities = capabilitiesFullyServedBy(served);
    const std::vector<Gap> gaps = gapsAgainstBaseline(capabilities);

    handshake_ = buildHandshake(implementationName,
                                implementationVersion,
                                manifest,
                                capabilities,
                                gaps,
                                kMaxSubscriptionsPerSession,
                                kMaxFrameBytes);
    handshakeText_ = handshake_.dump();

    std::cout << "[service] dispatch table holds " << served.size() << " of the contract's "
              << contractOperationTable().size() << " wire methods, so " << capabilities.size() << " of the "
              << baselineCapabilityIds().size() << " baseline capabilities are declared and " << gaps.size()
              << " are gaps:\n";
    for (const auto& capability : capabilities)
        std::cout << "[service]   capability " << capability << "\n";
    for (const auto& gap : gaps)
        std::cout << "[service]   gap        " << gap.capability << " (kind " << toWire(gap.kind) << "): " << gap.reason
                  << "\n";
    std::cout << "[service] limits announced: max_subscriptions " << kMaxSubscriptionsPerSession
              << " per session, max_frame_bytes " << kMaxFrameBytes << ", which caps pixel_columns at "
              << kMaxPixelColumns << " (17 header bytes + 2 float64 per column)\n"
              << std::flush;
}

void SessionHub::onOpen(const transport::ConnectionPtr& connection)
{
    std::size_t live = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        sessions_[connection.get()] = std::make_shared<SessionState>();
        connections_[connection.get()] = connection;
        live = sessions_.size();
    }

    // Contract 1.6: the handshake is message ordinal 1 on every session. It is
    // queued here, before the first read is even started, so nothing -- no
    // result, no event, no binary frame -- can get ahead of it.
    connection->sendText(handshakeText_);

    std::cout << "[service] session opened (" << live << " live); sent the handshake first, "
              << handshakeText_.size() << " bytes: " << handshakeText_ << "\n"
              << std::flush;
}

void SessionHub::onClose(const transport::ConnectionPtr& connection)
{
    SessionStatePtr state;
    // Devices whose last holder was this session: (connection string, node id).
    std::vector<std::pair<std::string, std::string>> devicesToRelease;
    std::size_t liveSessions = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        auto it = sessions_.find(connection.get());
        if (it == sessions_.end())
            return;
        state = it->second;
        sessions_.erase(it);
        connections_.erase(connection.get());
        liveSessions = sessions_.size();

        for (const auto& [connectionString, nodeId] : state->deviceNodeIdsByConnectionString)
        {
            auto holders = sessionsHoldingDevice_.find(connectionString);
            if (holders == sessionsHoldingDevice_.end())
                continue;
            if (--holders->second <= 0)
            {
                sessionsHoldingDevice_.erase(holders);
                devicesToRelease.emplace_back(connectionString, nodeId);
            }
        }
    }

    // Dropped socket = session invalidated: every subscription it held goes away.
    for (const auto& [id, sub] : state->subscriptions)
    {
        try
        {
            backend_.unsubscribeSignal(id);
        }
        catch (const std::exception& e)
        {
            std::cerr << "[service] teardown of subscription " << id << " on signal " << sub.signal_id
                      << " failed: " << e.what() << "\n";
        }
    }

    // ...and so does every device no other live session is still holding, so
    // the next session opens against an instance without it.
    for (const auto& [connectionString, nodeId] : devicesToRelease)
    {
        try
        {
            backend_.disconnectDevice(nodeId);
            std::cout << "[service] released device " << nodeId << " (" << connectionString
                      << "); no live session holds it any more\n";
        }
        catch (const std::exception& e)
        {
            std::cerr << "[service] releasing device " << nodeId << " (" << connectionString
                      << ") failed: " << e.what() << "\n";
        }
    }

    std::cout << "[service] session closed: " << state->subscriptions.size() << " subscription(s) and "
              << state->deviceNodeIdsByConnectionString.size() << " device(s) dropped, " << devicesToRelease.size()
              << " of those removed from the instance, " << liveSessions << " session(s) still live\n"
              << std::flush;
}

transport::Outcome SessionHub::onRequest(const transport::ConnectionPtr& connection,
                                         const std::string& method,
                                         const Json& params)
{
    transport::Outcome outcome;
    try
    {
        outcome.result = dispatch(connection, method, params);
        outcome.ok = true;
    }
    catch (const ServiceError& e)
    {
        outcome.ok = false;
        outcome.code = toWire(e.code());
        outcome.detail = e.detail();
    }
    catch (const std::exception& e)
    {
        outcome.ok = false;
        outcome.code = toWire(ErrorCode::Internal);
        outcome.detail = e.what();
    }
    return outcome;
}

Json SessionHub::dispatch(const transport::ConnectionPtr& connection, const std::string& method, const Json& params)
{
    const SessionStatePtr state = lookUpSession(connection);

    const auto& table = handlersByWireMethod();
    const auto handler = table.find(method);
    if (handler == table.end())
    {
        // A method the contract does declare but this host does not serve is a
        // declared gap, and the handshake already said so; anything else is not
        // a wire method at all. Both are unsupported, and the detail says which.
        const auto& operations = contractOperationTable();
        for (const auto& operation : operations)
            if (operation.wire_method == method)
                throw ServiceError(ErrorCode::Unsupported,
                                   "quackoscope-host-cpp does not serve \"" + method + "\"; capability \"" +
                                       operation.capability +
                                       "\" is a declared gap in this session's handshake, which lists the "
                                       "capabilities this host does serve");

        std::string known;
        for (const auto& [wireMethod, ignored] : table)
            known += (known.empty() ? "" : ", ") + wireMethod;
        throw ServiceError(ErrorCode::Unsupported,
                           "\"" + method + "\" is not a wire method of the M1 contract; this host serves " + known);
    }

    return (this->*(handler->second))(connection, state, params);
}

SessionHub::SessionStatePtr SessionHub::lookUpSession(const transport::ConnectionPtr& connection)
{
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = sessions_.find(connection.get());
    if (it == sessions_.end())
        throw ServiceError(ErrorCode::NotConnected, "this WebSocket session is already closed");
    return it->second;
}

void SessionHub::requireDeviceInSession(const SessionStatePtr& state) const
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (state->deviceNodeIdsByConnectionString.empty())
        throw ServiceError(ErrorCode::NotConnected,
                           "this session has connected no device; call connect_device first "
                           "(a device another session connected is not visible here)");
}

std::string SessionHub::requireNodeReachableFromSession(const SessionStatePtr& state,
                                                        const Json& params,
                                                        const char* key) const
{
    const std::string nodeId = requireString(params, key);

    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& [connectionString, deviceNodeId] : state->deviceNodeIdsByConnectionString)
    {
        if (nodeId == deviceNodeId || nodeId.rfind(deviceNodeId + "/", 0) == 0)
            return nodeId;
    }

    if (state->deviceNodeIdsByConnectionString.empty())
        throw ServiceError(ErrorCode::NotConnected,
                           "this session has connected no device, so \"" + nodeId +
                               "\" is not addressable; call connect_device first");

    std::string reachable;
    for (const auto& [connectionString, deviceNodeId] : state->deviceNodeIdsByConnectionString)
        reachable += (reachable.empty() ? "" : ", ") + deviceNodeId;
    throw ServiceError(ErrorCode::NotFound,
                       "no component with id \"" + nodeId + "\" in this session; it holds " + reachable);
}

std::string SessionHub::requireNodeReachableReportedAs(const SessionStatePtr& state,
                                                       const Json& params,
                                                       const char* key,
                                                       ErrorCode whenTheParameterIsMalformed,
                                                       ErrorCode whenNoSuchNodeIsReachable) const
{
    if (!params.contains(key) || !params[key].is_string())
        throw ServiceError(whenTheParameterIsMalformed,
                           std::string("params.") + key +
                               " is missing or is not a string, so this request names no component");

    const std::string nodeId = params[key].get<std::string>();

    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& [connectionString, deviceNodeId] : state->deviceNodeIdsByConnectionString)
        if (nodeId == deviceNodeId || nodeId.rfind(deviceNodeId + "/", 0) == 0)
            return nodeId;

    std::string reachable;
    for (const auto& [connectionString, deviceNodeId] : state->deviceNodeIdsByConnectionString)
        reachable += (reachable.empty() ? "" : ", ") + deviceNodeId;
    throw ServiceError(whenNoSuchNodeIsReachable,
                       "no component with id \"" + nodeId + "\" in this session; it holds " +
                           (reachable.empty() ? std::string("no device at all; call connect_device first")
                                              : reachable));
}

// --- the eighteen served methods ---------------------------------------------

Json SessionHub::scanAvailableDevices(const transport::ConnectionPtr&, const SessionStatePtr&, const Json&)
{
    // Discovery asks the modules what is out there; it needs no connected
    // device and touches no session state at all.
    Json out = Json::array();
    for (const auto& info : backend_.scanAvailableDevices())
        out.push_back(toJson(info));
    return out;
}

Json SessionHub::connectDevice(const transport::ConnectionPtr& connection,
                               const SessionStatePtr& state,
                               const Json& params)
{
    const auto connectionString = requireString(params, "connection_string");
    if (connectionString.empty())
        throw ServiceError(ErrorCode::InvalidValue,
                           "params.connection_string is empty; it must name a device, e.g. \"daqref://device0\"");

    // Idempotent within the session: the backend hands back the already-added
    // device for a connection string this process has seen, and the holder
    // count only moves the first time THIS session asks for it.
    const Node node = backend_.connectDevice(connectionString);

    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (state->deviceNodeIdsByConnectionString.emplace(connectionString, node.id).second)
            ++sessionsHoldingDevice_[connectionString];
    }

    return toJson(node);
}

Json SessionHub::disconnectDevice(const transport::ConnectionPtr&, const SessionStatePtr& state, const Json& params)
{
    const auto nodeId = requireString(params, "node_id");

    std::string connectionString;
    bool thisSessionWasTheLastHolder = false;
    int holdersLeft = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);

        auto held = state->deviceNodeIdsByConnectionString.end();
        for (auto it = state->deviceNodeIdsByConnectionString.begin();
             it != state->deviceNodeIdsByConnectionString.end();
             ++it)
        {
            if (it->second == nodeId)
            {
                held = it;
                break;
            }
        }

        if (held == state->deviceNodeIdsByConnectionString.end())
        {
            std::string holdsInstead;
            for (const auto& [heldConnectionString, heldNodeId] : state->deviceNodeIdsByConnectionString)
                holdsInstead += (holdsInstead.empty() ? "" : ", ") + heldNodeId;
            throw ServiceError(ErrorCode::NotFound,
                               "this session did not connect a device with id \"" + nodeId + "\"; it holds " +
                                   (holdsInstead.empty() ? std::string("no device at all") : holdsInstead));
        }

        connectionString = held->first;
        state->deviceNodeIdsByConnectionString.erase(held);

        auto holders = sessionsHoldingDevice_.find(connectionString);
        if (holders != sessionsHoldingDevice_.end())
        {
            holdersLeft = --holders->second;
            if (holdersLeft <= 0)
            {
                sessionsHoldingDevice_.erase(holders);
                thisSessionWasTheLastHolder = true;
            }
        }
        else
        {
            thisSessionWasTheLastHolder = true;
        }
    }

    if (!thisSessionWasTheLastHolder)
    {
        // The device stays in the openDAQ Instance for the sessions that still
        // hold it; it simply stops being addressable from this one.
        std::cout << "[service] disconnect_device " << nodeId << " (" << connectionString << "): dropped from this "
                  << "session, kept in the openDAQ Instance because " << holdersLeft
                  << " other session(s) still hold it" << std::endl;
        return nullptr;
    }

    backend_.disconnectDevice(nodeId);
    return nullptr;
}

Json SessionHub::getComponentTree(const transport::ConnectionPtr&, const SessionStatePtr& state, const Json& params)
{
    requireDeviceInSession(state);

    std::vector<std::string> roots;
    if (params.contains("root_id") && params["root_id"].is_string())
    {
        roots.push_back(requireNodeReachableFromSession(state, params, "root_id"));
    }
    else
    {
        // No root_id means "everything this session can see", which is exactly
        // the devices it connected itself -- never another session's.
        std::lock_guard<std::mutex> lock(mutex_);
        for (const auto& [connectionString, deviceNodeId] : state->deviceNodeIdsByConnectionString)
            roots.push_back(deviceNodeId);
    }

    Json out = Json::array();
    for (const auto& root : roots)
        for (const auto& node : backend_.getComponentTree(std::optional<std::string>(root)))
            out.push_back(toJson(node));
    return out;
}

Json SessionHub::getPropertyDescriptors(const transport::ConnectionPtr&,
                                        const SessionStatePtr& state,
                                        const Json& params)
{
    requireDeviceInSession(state);

    Json out = Json::array();
    for (const auto& d : backend_.getPropertyDescriptors(requireNodeReachableFromSession(state, params, "node_id")))
        out.push_back(toJson(d));
    return out;
}

Json SessionHub::getPropertyValue(const transport::ConnectionPtr&, const SessionStatePtr& state, const Json& params)
{
    requireDeviceInSession(state);
    return backend_.getPropertyValue(requireNodeReachableFromSession(state, params, "node_id"),
                                     requireString(params, "property_id"));
}

Json SessionHub::setPropertyValue(const transport::ConnectionPtr&, const SessionStatePtr& state, const Json& params)
{
    requireDeviceInSession(state);
    if (!params.contains("value"))
        throw ServiceError(ErrorCode::InvalidValue, "params.value is required");

    backend_.setPropertyValue(requireNodeReachableFromSession(state, params, "node_id"),
                              requireString(params, "property_id"),
                              params["value"]);
    return nullptr;
}

Json SessionHub::listFunctionBlockTypes(const transport::ConnectionPtr&,
                                        const SessionStatePtr& state,
                                        const Json&)
{
    // The types come from the loaded modules, but they are only useful to a
    // session that has a device to hang a block off, and not_connected is the
    // one error contract section 5 declares for this operation.
    requireDeviceInSession(state);

    Json out = Json::array();
    for (const auto& typeId : backend_.listFunctionBlockTypes())
        out.push_back(typeId);
    return out;
}

Json SessionHub::addFunctionBlock(const transport::ConnectionPtr&, const SessionStatePtr& state, const Json& params)
{
    requireDeviceInSession(state);

    const auto parentId = requireNodeReachableFromSession(state, params, "parent_id");
    const auto typeId = requireString(params, "type_id");
    if (typeId.empty())
        throw ServiceError(ErrorCode::InvalidValue,
                           "params.type_id is empty; list_function_block_types names the ids this host can add");

    // component_added is not raised here: adding the block makes openDAQ raise
    // its own ComponentAdded core event, and the openDAQ layer turns that into
    // the contract event. Raising one here as well would double it.
    return toJson(backend_.addFunctionBlock(parentId, typeId));
}

Json SessionHub::removeFunctionBlock(const transport::ConnectionPtr&, const SessionStatePtr& state, const Json& params)
{
    requireDeviceInSession(state);

    // Likewise component_removed: openDAQ raises ComponentRemoved for the
    // block, and the openDAQ layer publishes the contract event from there.
    backend_.removeFunctionBlock(requireNodeReachableFromSession(state, params, "node_id"));
    return nullptr;
}

Json SessionHub::subscribeSignal(const transport::ConnectionPtr& connection,
                                 const SessionStatePtr& state,
                                 const Json& params)
{
    requireDeviceInSession(state);

    const auto signalId = requireNodeReachableFromSession(state, params, "signal_id");
    // pixel_columns is capped by the max_frame_bytes this session's handshake
    // announced, so no frame this host emits can exceed it.
    const auto pixelColumns = requireIntInRange(params, "pixel_columns", 1, kMaxPixelColumns);

    std::uint32_t id = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (static_cast<std::int64_t>(state->subscriptions.size()) >= kMaxSubscriptionsPerSession)
            throw ServiceError(ErrorCode::InvalidValue,
                               "this session already holds " + std::to_string(state->subscriptions.size()) +
                                   " subscriptions, which is the max_subscriptions this session's handshake "
                                   "announced (" + std::to_string(kMaxSubscriptionsPerSession) +
                                   "); unsubscribe_signal one before subscribing to \"" + signalId + "\"");
        id = nextSubscriptionId_++;
    }

    backend_.subscribeSignal(signalId,
                             id,
                             [this, connection, id, pixelColumns](std::uint32_t subscriptionId,
                                                                  std::uint64_t domainStart,
                                                                  const double* values,
                                                                  std::size_t count)
                             { emitFrame(connection, subscriptionId, pixelColumns, domainStart, values, count); });

    {
        std::lock_guard<std::mutex> lock(mutex_);
        state->subscriptions[id] = Subscription{id, signalId, pixelColumns};
    }

    // The subscription_id on the wire is the decimal text of the uint32 that
    // rides in the binary frame header.
    return std::to_string(id);
}

Json SessionHub::unsubscribeSignal(const transport::ConnectionPtr&, const SessionStatePtr& state, const Json& params)
{
    const auto text = requireString(params, "subscription_id");

    std::uint32_t id = 0;
    if (!parseWholeUint32(text, id))
        throw ServiceError(ErrorCode::InvalidValue,
                           "params.subscription_id must be the decimal text of a uint32, whole and with nothing "
                           "else in it; got \"" + text + "\"");

    {
        std::lock_guard<std::mutex> lock(mutex_);
        auto& subs = state->subscriptions;
        auto sub = subs.find(id);
        if (sub == subs.end())
            throw ServiceError(ErrorCode::NotFound, "no subscription \"" + text + "\" on this session");
        subs.erase(sub);
    }

    backend_.unsubscribeSignal(id);
    return nullptr;
}

// --- device.mode -----------------------------------------------------------

Json SessionHub::getDeviceOperationModes(const transport::ConnectionPtr&,
                                         const SessionStatePtr& state,
                                         const Json& params)
{
    // contract operations[get_device_operation_modes].errors =
    // [not_found, not_connected, unsupported], so a session with no device is
    // reported as not_connected -- the one of the three that is true.
    requireDeviceInSession(state);

    Json out = Json::array();
    for (const auto& mode : backend_.getDeviceOperationModes(
             requireNodeReachableReportedAs(state, params, "node_id", ErrorCode::NotFound, ErrorCode::NotFound)))
        out.push_back(mode);
    return out;
}

Json SessionHub::setDeviceOperationMode(const transport::ConnectionPtr&,
                                        const SessionStatePtr& state,
                                        const Json& params)
{
    // contract operations[set_device_operation_mode].errors =
    // [not_found, invalid_value, read_only, unsupported]. not_connected is NOT
    // in that subset, so a session holding no device answers not_found for the
    // node it was asked about rather than reaching for a code this row forbids.
    const auto nodeId =
        requireNodeReachableReportedAs(state, params, "node_id", ErrorCode::InvalidValue, ErrorCode::NotFound);
    const auto mode = requireString(params, "mode");

    backend_.setDeviceOperationMode(nodeId, mode);
    std::cout << "[service] set_device_operation_mode " << nodeId << " -> " << mode << std::endl;
    return nullptr;
}

// --- device.lock -----------------------------------------------------------

Json SessionHub::lockDevice(const transport::ConnectionPtr&, const SessionStatePtr& state, const Json& params)
{
    // contract operations[lock_device].errors = [not_found, read_only,
    // unsupported]: neither not_connected nor invalid_value is in the subset,
    // so both a malformed node_id and a session with no device are not_found.
    const auto nodeId =
        requireNodeReachableReportedAs(state, params, "node_id", ErrorCode::NotFound, ErrorCode::NotFound);

    backend_.lockDevice(nodeId);
    std::cout << "[service] lock_device " << nodeId << ": openDAQ now reports this device as locked" << std::endl;
    return nullptr;
}

Json SessionHub::unlockDevice(const transport::ConnectionPtr&, const SessionStatePtr& state, const Json& params)
{
    const auto nodeId =
        requireNodeReachableReportedAs(state, params, "node_id", ErrorCode::NotFound, ErrorCode::NotFound);

    // force is optional. A present force that is not a boolean is a malformed
    // parameter, and lock_device/unlock_device declare no invalid_value, so it
    // is refused as not_found the same way a malformed node_id is.
    bool force = false;
    if (params.contains("force") && !params["force"].is_null())
    {
        if (!params["force"].is_boolean())
            throw ServiceError(ErrorCode::NotFound,
                               "params.force is " + params["force"].dump() +
                                   ", which is not a boolean; unlock_device takes force: true or false");
        force = params["force"].get<bool>();
    }

    backend_.unlockDevice(nodeId, force);
    std::cout << "[service] unlock_device " << nodeId << " (force " << (force ? "true" : "false")
              << "): openDAQ now reports this device as unlocked" << std::endl;
    return nullptr;
}

// --- module.read -----------------------------------------------------------

Json SessionHub::listLoadedModules(const transport::ConnectionPtr&, const SessionStatePtr&, const Json&)
{
    // No device is required. The loaded modules are a fact about this process,
    // settled when the openDAQ Instance was built from the manifest's
    // module_path, exactly like scan_available_devices -- which is also why
    // not_connected, though declared, is never the answer this host gives.
    Json out = Json::array();
    for (const auto& module : backend_.listLoadedModules())
        out.push_back(toJson(module));
    return out;
}

// --- module.load -----------------------------------------------------------

Json SessionHub::loadModuleFromHostPath(const transport::ConnectionPtr&, const SessionStatePtr&, const Json& params)
{
    // host_path is a path on the filesystem of the machine THIS process runs
    // on, not on the caller's. openDAQ's IModuleManager::loadModule takes a
    // path and there is no bytes-in sibling on the interface, so the parameter
    // is what it says it is and there is nothing here that accepts a file.
    //
    // No device is required, for the same reason list_loaded_modules requires
    // none: the module manager hangs off the Instance. not_connected is in this
    // operation's declared error subset and is never the answer this host
    // gives.
    if (!params.contains("host_path") || !params["host_path"].is_string())
        throw ServiceError(ErrorCode::InvalidValue,
                           "params.host_path must be a string naming a module file on this host's filesystem; "
                           "load_module_from_host_path received " +
                               (params.contains("host_path") ? params["host_path"].dump() : std::string("no such key")));

    const auto hostPath = params["host_path"].get<std::string>();
    const ModuleInfo module = backend_.loadModuleFromHostPath(hostPath);

    std::cout << "[service] load_module_from_host_path \"" << hostPath << "\" answered with module " << module.id
              << " (name " << module.name << ", version " << (module.version ? *module.version : std::string("none"))
              << ", " << module.component_types.size() << " component type(s))" << std::endl;
    return toJson(module);
}

// --- data plane ------------------------------------------------------------

void SessionHub::emitFrame(const transport::ConnectionPtr& connection,
                           std::uint32_t subscriptionId,
                           std::uint32_t pixelColumns,
                           std::uint64_t domainStart,
                           const double* values,
                           std::size_t count)
{
    const Envelope envelope = decimate(values, count, pixelColumns);
    if (envelope.sample_count == 0)
        return;

    connection->sendBinary(transport::encodeDataFrame(subscriptionId,
                                                      domainStart,
                                                      envelope.sample_count,
                                                      envelope.encoding,
                                                      envelope.payload.data(),
                                                      envelope.payload.size()));
}

// --- server push -----------------------------------------------------------

void SessionHub::publish(const Event& event)
{
    const std::string text = toEnvelope(event).dump();

    std::vector<transport::ConnectionPtr> targets;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        targets.reserve(connections_.size());
        for (const auto& [key, connection] : connections_)
            targets.push_back(connection);
    }

    for (const auto& connection : targets)
        connection->sendText(text);
}

}  // namespace qs::service
