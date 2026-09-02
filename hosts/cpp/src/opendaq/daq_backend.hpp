// Quackoscope host (C++) -- openDAQ layer.
//
// The concrete IDaqBackend. Every openDAQ SDK call in this process lives in
// daq_backend.cpp; this header deliberately exposes none of it (pimpl), so
// that main.cpp and the transport layer stay free of SDK headers.
#pragma once

#include "service/backend.hpp"

#include <memory>
#include <string>

namespace qs::opendaq
{

class DaqBackend : public service::IDaqBackend
{
public:
    // modulePath and logLevel come from manifest.json and from nowhere else.
    DaqBackend(const std::string& modulePath, int logLevel);
    ~DaqBackend() override;

    void setEventSink(service::EventSink sink) override;
    void releaseDevice(const std::string& nodeId) override;

    service::Node connectDevice(const std::string& connectionString) override;
    std::vector<service::Node> getComponentTree(const std::optional<std::string>& rootId) override;
    std::vector<service::PropertyDescriptor> getPropertyDescriptors(const std::string& nodeId) override;
    service::Json getPropertyValue(const std::string& nodeId, const std::string& propertyId) override;
    void setPropertyValue(const std::string& nodeId, const std::string& propertyId, const service::Json& value) override;
    void subscribeSignal(const std::string& signalId, std::uint32_t subscriptionId, service::SampleSink sink) override;
    void unsubscribeSignal(std::uint32_t subscriptionId) override;

    // Reported display-only at startup.
    std::string rootId() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace qs::opendaq
