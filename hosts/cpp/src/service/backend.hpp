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

    // --- the twenty-nine operations this host serves -------------------------
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

    // The ATTRIBUTES of one component: the fixed members of the openDAQ
    // interfaces the component carries, which is a different surface from its
    // properties. The row set is not fixed -- a signal has five rows an input
    // port does not -- so a component whose cast does not succeed simply yields
    // fewer rows rather than rows with null values.
    virtual std::vector<ComponentAttribute> getComponentAttributes(const std::string& nodeId) = 0;
    // Writes one of them. Refusal because the attribute is read_only is the
    // caller's to report as read_only; this throws ServiceError already
    // classified, because openDAQ answers a locked attribute write with
    // OPENDAQ_IGNORED -- a SUCCESS code -- so the refusal has to be detected
    // before the write and never after it.
    virtual void setComponentAttribute(const std::string& nodeId,
                                       const std::string& attributeId,
                                       const Json& value) = 0;

    // The server types the INSTANCE will accept, which is not the same list as
    // the server types the loaded modules offer (listLoadedModules reports
    // those). Every element's kind is "server".
    virtual std::vector<ComponentTypeInfo> listServerTypes() = 0;
    // Adds one to the instance. There is no parent: openDAQ's
    // IDevice::onAddServer refuses every device but the root, so
    // IInstance::addServer is the only call there is.
    virtual Node addServer(const std::string& typeId) = 0;
    // IServer::enableDiscovery / IServer::disableDiscovery, chosen by `enabled`.
    // There is NO getter for this state anywhere on IServer, which is why no
    // Node field carries it.
    virtual void setServerDiscoveryEnabled(const std::string& nodeId, bool enabled) = 0;

    // IRecorder::startRecording / IRecorder::stopRecording. Whether a node is a
    // recorder at all is Node.recording being non-null.
    virtual void startRecording(const std::string& nodeId) = 0;
    virtual void stopRecording(const std::string& nodeId) = 0;

    // IPropertyObject::beginUpdate / endUpdate. Between the two, a
    // setPropertyValue is held rather than applied, and Node.updating is what
    // reports that state. beginUpdate is RECURSIVE over child property objects,
    // so one begin on a device puts a whole subtree into batch mode for every
    // session at once.
    virtual void beginBatchedPropertyUpdate(const std::string& nodeId) = 0;
    virtual void endBatchedPropertyUpdate(const std::string& nodeId) = 0;

    // IDevice::saveConfiguration / IDevice::loadConfiguration on the root
    // device. Both take a STRING and openDAQ offers no path overload, so the
    // configuration crosses the wire in both directions and this host writes no
    // file for either.
    virtual std::string saveInstanceConfigurationToString() = 0;
    virtual void loadInstanceConfigurationFromString(const std::string& configuration) = 0;
};

}  // namespace qs::service
