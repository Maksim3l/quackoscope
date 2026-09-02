#include "service/session.hpp"

#include "service/decimator.hpp"
#include "transport/wire.hpp"

#include <iostream>

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

std::uint32_t requirePositiveInt(const Json& params, const char* key)
{
    if (!params.contains(key) || !params[key].is_number_integer())
        throw ServiceError(ErrorCode::InvalidValue, std::string("params.") + key + " must be an integer");
    const auto v = params[key].get<std::int64_t>();
    if (v <= 0 || v > 1000000)
        throw ServiceError(ErrorCode::InvalidValue, std::string("params.") + key + " must be in [1, 1000000]");
    return static_cast<std::uint32_t>(v);
}

}  // namespace

SessionHub::SessionHub(IDaqBackend& backend)
    : backend_(backend)
{
}

void SessionHub::onOpen(const transport::ConnectionPtr& connection)
{
    std::lock_guard<std::mutex> lock(mutex_);
    sessions_[connection.get()] = std::make_shared<SessionState>();
    connections_[connection.get()] = connection;
    std::cout << "[service] session opened (" << sessions_.size() << " live)\n" << std::flush;
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
            backend_.releaseDevice(nodeId);
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

    if (method == "connect_device")           return connectDevice(connection, state, params);
    if (method == "get_component_tree")       return getComponentTree(state, params);
    if (method == "get_property_descriptors") return getPropertyDescriptors(state, params);
    if (method == "get_property_value")       return getPropertyValue(state, params);
    if (method == "set_property_value")       return setPropertyValue(state, params);
    if (method == "subscribe_signal")         return subscribeSignal(connection, state, params);
    if (method == "unsubscribe_signal")       return unsubscribeSignal(state, params);

    throw ServiceError(ErrorCode::Unsupported, "unknown method \"" + method + "\"");
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

// --- the seven methods -----------------------------------------------------

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

Json SessionHub::getComponentTree(const SessionStatePtr& state, const Json& params)
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

Json SessionHub::getPropertyDescriptors(const SessionStatePtr& state, const Json& params)
{
    requireDeviceInSession(state);

    Json out = Json::array();
    for (const auto& d : backend_.getPropertyDescriptors(requireNodeReachableFromSession(state, params, "node_id")))
        out.push_back(toJson(d));
    return out;
}

Json SessionHub::getPropertyValue(const SessionStatePtr& state, const Json& params)
{
    requireDeviceInSession(state);
    return backend_.getPropertyValue(requireNodeReachableFromSession(state, params, "node_id"),
                                     requireString(params, "property_id"));
}

Json SessionHub::setPropertyValue(const SessionStatePtr& state, const Json& params)
{
    requireDeviceInSession(state);
    if (!params.contains("value"))
        throw ServiceError(ErrorCode::InvalidValue, "params.value is required");

    backend_.setPropertyValue(requireNodeReachableFromSession(state, params, "node_id"),
                              requireString(params, "property_id"),
                              params["value"]);
    return nullptr;
}

Json SessionHub::subscribeSignal(const transport::ConnectionPtr& connection,
                                 const SessionStatePtr& state,
                                 const Json& params)
{
    requireDeviceInSession(state);

    const auto signalId = requireNodeReachableFromSession(state, params, "signal_id");
    const auto pixelColumns = requirePositiveInt(params, "pixel_columns");

    std::uint32_t id = 0;
    {
        std::lock_guard<std::mutex> lock(mutex_);
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

Json SessionHub::unsubscribeSignal(const SessionStatePtr& state, const Json& params)
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
