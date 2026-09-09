// Quackoscope host (C++) -- service layer.
//
// Session state and method dispatch. Owns the subscription registry, performs
// the decimation, maps every failure into the closed error-code set and fans
// server-pushed events out to the live sockets.
//
// A dropped socket invalidates that session: its subscriptions are torn down,
// its devices are released from the openDAQ Instance once no other live session
// still holds them, and the node ids it was allowed to name go with it. Nothing
// a session did is visible to the next one.
#pragma once

#include "service/backend.hpp"
#include "service/error.hpp"
#include "service/handshake.hpp"
#include "service/manifest.hpp"
#include "service/types.hpp"
#include "transport/server.hpp"

#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace qs::service
{

// Contract 1.6 limits, announced in the handshake and enforced here so that the
// announcement is true. max_frame_bytes bounds pixel_columns rather than the
// frame: a decimated frame is 17 header bytes plus at most two float64 per
// requested column, so the column count is where the byte cap has to bite.
constexpr std::int64_t kMaxSubscriptionsPerSession = 64;
constexpr std::int64_t kMaxFrameBytes = 262144;
constexpr std::uint32_t kMaxPixelColumns =
    static_cast<std::uint32_t>((kMaxFrameBytes - 17) / (2 * static_cast<std::int64_t>(sizeof(double))));

class SessionHub : public transport::IConnectionHandler
{
public:
    // implementationName and implementationVersion are DISPLAY ONLY: they go
    // into the handshake and no behavioural branch in this host reads them.
    // The sdk version and commit come from the manifest and from nowhere else.
    SessionHub(IDaqBackend& backend,
               const Manifest& manifest,
               std::string implementationName,
               std::string implementationVersion);

    // The exact JSON this host sends as the first message of every session.
    const Json& handshake() const { return handshake_; }

    void onOpen(const transport::ConnectionPtr& connection) override;
    void onClose(const transport::ConnectionPtr& connection) override;
    transport::Outcome onRequest(const transport::ConnectionPtr& connection,
                                 const std::string& method,
                                 const Json& params) override;

    // Installed as the backend's event sink; broadcasts to every live session.
    void publish(const Event& event);

private:
    struct Subscription
    {
        std::uint32_t id = 0;
        std::string signal_id;
        std::uint32_t pixel_columns = 0;
    };

    // Everything one WebSocket may see. A node id this session never reached
    // through a connect_device of its own is not addressable from it.
    struct SessionState
    {
        std::map<std::uint32_t, Subscription> subscriptions;
        // connection string -> the device node id connect_device answered with
        std::map<std::string, std::string> deviceNodeIdsByConnectionString;
        // The node ids add_server answered with on THIS session. Servers hang
        // under the openDAQ Instance's own root device, which no session
        // connected, so they are not reachable through the device registry
        // above and this set is a record of what this session created rather
        // than a permission check -- a server outlives the socket that made it.
        std::set<std::string> serverNodeIds;
    };

    using SessionStatePtr = std::shared_ptr<SessionState>;

    // Every handler has the same signature so that they can live in one table
    // keyed by wire method name. That table is the single place a wire method
    // becomes a served operation, and the handshake's capability list is
    // computed from its keys rather than written out by hand.
    using Handler = Json (SessionHub::*)(const transport::ConnectionPtr& connection,
                                         const SessionStatePtr& state,
                                         const Json& params);

    static const std::map<std::string, Handler>& handlersByWireMethod();

    Json dispatch(const transport::ConnectionPtr& connection, const std::string& method, const Json& params);

    Json scanAvailableDevices(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json connectDevice(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json disconnectDevice(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json getComponentTree(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json getPropertyDescriptors(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json getPropertyValue(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json setPropertyValue(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json listFunctionBlockTypes(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json addFunctionBlock(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json removeFunctionBlock(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json subscribeSignal(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json unsubscribeSignal(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json getDeviceOperationModes(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json setDeviceOperationMode(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json lockDevice(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json unlockDevice(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json listLoadedModules(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json loadModuleFromHostPath(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json getComponentAttributes(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json setComponentAttribute(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json listServerTypes(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json addServer(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json removeServer(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json setServerDiscoveryEnabled(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json startRecording(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json stopRecording(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json beginBatchedPropertyUpdate(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json endBatchedPropertyUpdate(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json saveInstanceConfigurationToString(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json loadInstanceConfigurationFromString(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);

    SessionStatePtr lookUpSession(const transport::ConnectionPtr& connection);
    void requireDeviceInSession(const SessionStatePtr& state) const;
    // Throws not_found unless nodeId is one of this session's device nodes or
    // sits underneath one; this is the session-scoped node id registry.
    std::string requireNodeReachableFromSession(const SessionStatePtr& state, const Json& params, const char* key) const;
    // The same registry lookup, but every refusal is reported with a code the
    // CALLER names. contract section 5 gives each operation a subset of the
    // closed error set, and three of the new rows do not declare not_connected
    // (set_device_operation_mode, lock_device, unlock_device) while two of them
    // do not declare invalid_value either (lock_device, unlock_device). A host
    // that claims a capability and then answers outside that operation's subset
    // is exactly the class (b) failure the conformance harness exists to catch,
    // so the codes are passed in per call site instead of being fixed here.
    std::string requireNodeReachableReportedAs(const SessionStatePtr& state,
                                               const Json& params,
                                               const char* key,
                                               ErrorCode whenTheParameterIsMalformed,
                                               ErrorCode whenNoSuchNodeIsReachable) const;
    void emitFrame(const transport::ConnectionPtr& connection,
                   std::uint32_t subscriptionId,
                   std::uint32_t pixelColumns,
                   std::uint64_t domainStart,
                   const double* values,
                   std::size_t count);

    IDaqBackend& backend_;
    Json handshake_;
    std::string handshakeText_;
    mutable std::mutex mutex_;
    std::map<transport::Connection*, SessionStatePtr> sessions_;
    std::map<transport::Connection*, transport::ConnectionPtr> connections_;
    // How many live sessions hold each connection string. The device stays in
    // the openDAQ Instance while this is above zero and is released at zero.
    std::map<std::string, int> sessionsHoldingDevice_;
    std::uint32_t nextSubscriptionId_ = 1;
};

}  // namespace qs::service
