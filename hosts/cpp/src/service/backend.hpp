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

    // --- the eighteen operations this host serves ---------------------------
    //
    // One method per wire method of contract section 5, minus read_samples_raw:
    // streaming.raw is a declared gap, see hosts/cpp/src/service/handshake.cpp.
    //
    // disconnectDevice is also what the session teardown calls: it drops the
    // device from the openDAQ Instance so that the next session starts against
    // a clean instance instead of inheriting the previous session's device and
    // its mutated properties.
    virtual std::vector<DeviceInfo> scanAvailableDevices() = 0;
    virtual Node connectDevice(const std::string& connectionString) = 0;
    virtual void disconnectDevice(const std::string& nodeId) = 0;
    virtual std::vector<Node> getComponentTree(const std::optional<std::string>& rootId) = 0;
    virtual std::vector<PropertyDescriptor> getPropertyDescriptors(const std::string& nodeId) = 0;
    virtual Json getPropertyValue(const std::string& nodeId, const std::string& propertyId) = 0;
    virtual void setPropertyValue(const std::string& nodeId, const std::string& propertyId, const Json& value) = 0;
    virtual std::vector<std::string> listFunctionBlockTypes() = 0;
    virtual Node addFunctionBlock(const std::string& parentId, const std::string& typeId) = 0;
    virtual void removeFunctionBlock(const std::string& nodeId) = 0;
    virtual void subscribeSignal(const std::string& signalId, std::uint32_t subscriptionId, SampleSink sink) = 0;
    virtual void unsubscribeSignal(std::uint32_t subscriptionId) = 0;

    // The AVAILABLE mode names for one device. The CURRENT one is not here: it
    // rides on every device Node as operation_mode, because the reference draws
    // it into the row name and a per-row fact must not cost a per-row call.
    virtual std::vector<std::string> getDeviceOperationModes(const std::string& nodeId) = 0;
    virtual void setDeviceOperationMode(const std::string& nodeId, const std::string& mode) = 0;

    // The lock STATE is Node.locked, effective and inheritance-applied by
    // buildNode; these two are only the acts. force reaches IDevicePrivate's
    // forceUnlock, which openDAQ permits when IDevice::unlock refuses.
    virtual void lockDevice(const std::string& nodeId) = 0;
    virtual void unlockDevice(const std::string& nodeId, bool force) = 0;

    // Every loaded module with everything it can instantiate, in one answer.
    virtual std::vector<ModuleInfo> listLoadedModules() = 0;

    // hostPath is a path on THIS machine's filesystem, resolved by this
    // process. openDAQ's IModuleManager has no bytes-in overload -- loadModule
    // takes an absolute path and nothing else -- so there is no upload here and
    // a client must not offer a file picker over its own disk for it.
    // The answer is the module that was loaded, in the same shape
    // listLoadedModules reports, so a caller needs no second request.
    virtual ModuleInfo loadModuleFromHostPath(const std::string& hostPath) = 0;
};

}  // namespace qs::service
