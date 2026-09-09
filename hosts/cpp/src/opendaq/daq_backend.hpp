// Quackoscope host (C++) -- openDAQ layer.
//
// The concrete IDaqBackend. Every openDAQ SDK call in this process lives in
// daq_backend.cpp; this header deliberately exposes none of it (pimpl), so
// that main.cpp and the transport layer stay free of SDK headers.
#pragma once

#include "service/backend.hpp"

#include <memory>
#include <string>
#include <vector>

namespace qs::opendaq
{

class DaqBackend : public service::IDaqBackend
{
public:
    // modulePath and logLevel come from manifest.json and from nowhere else.
    DaqBackend(const std::string& modulePath, int logLevel);
    ~DaqBackend() override;

    void setEventSink(service::EventSink sink) override;

    std::vector<service::DeviceInfo> scanAvailableDevices() override;
    service::Node connectDevice(const std::string& connectionString) override;
    void disconnectDevice(const std::string& nodeId) override;
    std::vector<service::Node> getComponentTree(const std::optional<std::string>& rootId) override;
    std::vector<service::PropertyDescriptor> getPropertyDescriptors(const std::string& nodeId) override;
    service::Json getPropertyValue(const std::string& nodeId, const std::string& propertyId) override;
    void setPropertyValue(const std::string& nodeId, const std::string& propertyId, const service::Json& value) override;
    std::vector<std::string> listFunctionBlockTypes() override;
    service::Node addFunctionBlock(const std::string& parentId, const std::string& typeId) override;
    void removeFunctionBlock(const std::string& nodeId) override;
    void subscribeSignal(const std::string& signalId, std::uint32_t subscriptionId, service::SampleSink sink) override;
    void unsubscribeSignal(std::uint32_t subscriptionId) override;
    std::vector<std::string> getDeviceOperationModes(const std::string& nodeId) override;
    void setDeviceOperationMode(const std::string& nodeId, const std::string& mode) override;
    void lockDevice(const std::string& nodeId) override;
    void unlockDevice(const std::string& nodeId, bool force) override;
    std::vector<service::ModuleInfo> listLoadedModules() override;
    service::ModuleInfo loadModuleFromHostPath(const std::string& hostPath) override;
    std::vector<service::ComponentAttribute> getComponentAttributes(const std::string& nodeId) override;
    void setComponentAttribute(const std::string& nodeId,
                               const std::string& attributeId,
                               const service::Json& value) override;
    std::vector<service::ComponentTypeInfo> listServerTypes() override;
    service::Node addServer(const std::string& typeId) override;
    void removeServer(const std::string& nodeId) override;
    std::vector<service::Node> listInstanceServerNodes() override;
    void setServerDiscoveryEnabled(const std::string& nodeId, bool enabled) override;
    void startRecording(const std::string& nodeId) override;
    void stopRecording(const std::string& nodeId) override;
    void beginBatchedPropertyUpdate(const std::string& nodeId) override;
    void endBatchedPropertyUpdate(const std::string& nodeId) override;
    std::string saveInstanceConfigurationToString() override;
    void loadInstanceConfigurationFromString(const std::string& configuration) override;

    // Reported display-only at startup.
    std::string rootId() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace qs::opendaq
