// Quackoscope host (C++) -- service layer.
//
// The seam. The service layer talks to openDAQ only through this interface;
// the concrete implementation (hosts/cpp/src/opendaq/) is the only translation
// unit allowed to include an SDK header. Nothing declared here mentions
// openDAQ types, and nothing here mentions sockets.
#pragma once

#include "service/types.hpp"

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace qs::service
{

// Raw samples straight out of the SDK reader. Decimation into the pixel
// envelope is the service layer's job, not the backend's.
using SampleSink = std::function<
    void(std::uint32_t subscriptionId, std::uint64_t domainStart, const double* values, std::size_t count)>;

using EventSink = std::function<void(const Event&)>;

class IDaqBackend
{
public:
    virtual ~IDaqBackend() = default;

    // Server push. Installed once, before the transport starts accepting.
    virtual void setEventSink(EventSink sink) = 0;

    // Drops a device from the openDAQ Instance again. Called when the last
    // WebSocket session holding that device goes away, so that the next
    // session starts against a clean instance instead of inheriting the
    // previous session's device and its mutated properties.
    virtual void releaseDevice(const std::string& nodeId) = 0;

    // --- the seven methods -------------------------------------------------
    virtual Node connectDevice(const std::string& connectionString) = 0;
    virtual std::vector<Node> getComponentTree(const std::optional<std::string>& rootId) = 0;
    virtual std::vector<PropertyDescriptor> getPropertyDescriptors(const std::string& nodeId) = 0;
    virtual Json getPropertyValue(const std::string& nodeId, const std::string& propertyId) = 0;
    virtual void setPropertyValue(const std::string& nodeId, const std::string& propertyId, const Json& value) = 0;
    virtual void subscribeSignal(const std::string& signalId, std::uint32_t subscriptionId, SampleSink sink) = 0;
    virtual void unsubscribeSignal(std::uint32_t subscriptionId) = 0;
};

}  // namespace qs::service
