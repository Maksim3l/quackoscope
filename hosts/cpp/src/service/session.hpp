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
#include "service/types.hpp"
#include "transport/server.hpp"

#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace qs::service
{

class SessionHub : public transport::IConnectionHandler
{
public:
    explicit SessionHub(IDaqBackend& backend);

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
    };

    using SessionStatePtr = std::shared_ptr<SessionState>;

    Json dispatch(const transport::ConnectionPtr& connection, const std::string& method, const Json& params);

    Json connectDevice(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json getComponentTree(const SessionStatePtr& state, const Json& params);
    Json getPropertyDescriptors(const SessionStatePtr& state, const Json& params);
    Json getPropertyValue(const SessionStatePtr& state, const Json& params);
    Json setPropertyValue(const SessionStatePtr& state, const Json& params);
    Json subscribeSignal(const transport::ConnectionPtr& connection, const SessionStatePtr& state, const Json& params);
    Json unsubscribeSignal(const SessionStatePtr& state, const Json& params);

    SessionStatePtr lookUpSession(const transport::ConnectionPtr& connection);
    void requireDeviceInSession(const SessionStatePtr& state) const;
    // Throws not_found unless nodeId is one of this session's device nodes or
    // sits underneath one; this is the session-scoped node id registry.
    std::string requireNodeReachableFromSession(const SessionStatePtr& state, const Json& params, const char* key) const;
    void emitFrame(const transport::ConnectionPtr& connection,
                   std::uint32_t subscriptionId,
                   std::uint32_t pixelColumns,
                   std::uint64_t domainStart,
                   const double* values,
                   std::size_t count);

    IDaqBackend& backend_;
    mutable std::mutex mutex_;
    std::map<transport::Connection*, SessionStatePtr> sessions_;
    std::map<transport::Connection*, transport::ConnectionPtr> connections_;
    // How many live sessions hold each connection string. The device stays in
    // the openDAQ Instance while this is above zero and is released at zero.
    std::map<std::string, int> sessionsHoldingDevice_;
    std::uint32_t nextSubscriptionId_ = 1;
};

}  // namespace qs::service
