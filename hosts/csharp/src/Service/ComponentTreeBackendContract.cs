// Quackoscope host (C#) -- service layer.
//
// What the service layer is allowed to ask of the openDAQ layer. The service
// layer never sees an SDK type; the openDAQ layer never sees a socket.
using System.Text.Json.Nodes;

namespace Quackoscope.Host.CSharp.Service;

// How the openDAQ layer hands freshly read samples back to the service layer.
// `values` is the reader's own buffer and is only valid for the duration of the
// call; `count` says how many of its entries this chunk actually carries.
public delegate void SampleChunkSink(uint subscriptionId, ulong domainStart, double[] values, int count);

public interface IComponentTreeBackend
{
    string RootComponentId { get; }

    ComponentNode ConnectDevice(string connectionString);

    // Undoing a ConnectDevice: this is what the disconnect_device wire method
    // calls, and it is also what session teardown calls for a device no live
    // session holds any more.
    void DisconnectDevice(string nodeId);

    IReadOnlyList<ComponentNode> GetComponentTree(string rootId);

    // Every server the openDAQ Instance holds, each as its own subtree. A
    // get_component_tree with no root_id needs this on top of the session's
    // connected devices, because IDevice::onAddServer refuses every device but
    // the root (device_impl.h:1470-1472), so a server is never inside a
    // connected device's subtree and a device-scoped read could never carry the
    // node add_server had just returned.
    IReadOnlyList<ComponentNode> ListInstanceServerNodes();
    IReadOnlyList<PropertyDescriptor> GetPropertyDescriptors(string nodeId);
    JsonNode GetPropertyValue(string nodeId, string propertyId);
    void SetPropertyValue(string nodeId, string propertyId, JsonNode value);

    void SubscribeSignal(string signalId, uint subscriptionId, SampleChunkSink sink);
    void UnsubscribeSignal(uint subscriptionId);

    // The modes this device offers, as the wire spells them: the elements are
    // values of contract types.Node.operation_mode, which is where the
    // OperationModeType vocabulary is enumerated once for every target.
    IReadOnlyList<string> GetDeviceOperationModes(string nodeId);

    // One of the names GetDeviceOperationModes answered with, applied to the
    // device. The CURRENT mode is read back as ComponentNode.OperationMode.
    void SetDeviceOperationMode(string nodeId, string mode);

    // IDevice.lock() / IDevice.unlock(). The lock STATE is ComponentNode.Locked,
    // so nothing has to call these to draw a lock icon. `force` asks for the
    // forced unlock the reference falls back to when another user holds the
    // lock.
    void LockDevice(string nodeId);
    void UnlockDevice(string nodeId, bool force);

    // Every module the openDAQ ModuleManager loaded, with the component types
    // each of them offers, in one answer.
    IReadOnlyList<ModuleInfo> ListLoadedModules();

    // IModuleManager::loadModule, given a path on THIS host's filesystem.
    // openDAQ declares loadModule(IString* path, IModule** module) and no
    // bytes-in sibling, so the file the host process opens is the only thing
    // that can be loaded; a path taken off the client's machine is not what
    // this loads. The answer is the record of the module that was loaded, so
    // the caller needs no second ListLoadedModules to draw it.
    ModuleInfo LoadModuleFromHostPath(string hostPath);

    // The rows of the reference's ATTRIBUTES panel for one component: the seven
    // IComponent attributes, plus the five an ISignal adds or the three an
    // IInputPort adds. read_only on each row is openDAQ's answer about the
    // component, never this host's answer about itself.
    IReadOnlyList<ComponentAttribute> GetComponentAttributes(string nodeId);

    // THERE IS NO SetComponentAttribute. openDAQ makes `tags` writable through
    // ITagsPrivate, and openDAQ's own .NET binding project excludes every
    // *Private.cs from openDAQ.Net.dll, so this host cannot serve the whole
    // set_component_attribute row. contract types.ComponentAttribute.read_only
    // rules that case: declare no attribute.write capability and let the client
    // disable the editors from the gap, never report read_only true instead.
    // OpenDaqBackend.AttributeWritingIsUnreachableInThisBinding carries the
    // enumeration, and it is the gap's reason in the handshake.

    // The server types THIS INSTANCE will accept, which is
    // IInstance.availableServerTypes and not the union of what the loaded
    // modules offer -- the two are only accidentally equal.
    IReadOnlyList<ComponentTypeInfo> ListServerTypes();

    // IDevice::addServer on the instance. There is no parent_id: only the root
    // device accepts servers, so there is exactly one legal parent and the
    // contract carries no parameter for it. The answer is the Node of the
    // server that was created, whose kind is `server`.
    ComponentNode AddServer(string typeId);

    // IDevice::removeServer on the instance, the undo of AddServer: the wire
    // sends the node id of the server row and this resolves it to the IServer
    // the call takes. Removing it runs IServer::stop through
    // ServerImpl::removed, so the listening socket the addition opened is
    // closed, not merely delisted.
    void RemoveServer(string nodeId);

    // IServer::enableDiscovery / IServer::disableDiscovery over one boolean.
    // Nothing in openDAQ reports the resulting state back, which is why there
    // is no getter and no Node field for it.
    void SetServerDiscoveryEnabled(string nodeId, bool enabled);

    // IRecorder::startRecording / IRecorder::stopRecording. Whether a node IS a
    // recorder is ComponentNode.Recording, so neither of these is the question
    // "is this a recorder"; a node that is not one is refused as unsupported.
    void StartRecording(string nodeId);
    void StopRecording(string nodeId);

    // IPropertyObject::beginUpdate / endUpdate. Between them SetPropertyValue
    // does not apply the value; EndBatchedPropertyUpdate applies everything set
    // in between. The state is ComponentNode.Updating, so no call is needed to
    // know which of the two is the live one.
    void BeginBatchedPropertyUpdate(string nodeId);
    void EndBatchedPropertyUpdate(string nodeId);

    // IDevice::saveConfiguration / IDevice::loadConfiguration on the instance.
    // openDAQ's own API is a string in both directions and has no path
    // overload, and the file is produced for and consumed by the user at the
    // other end of the socket, so the string crosses the wire rather than a
    // host-side path -- the opposite answer to LoadModuleFromHostPath, from the
    // same question about who consumes the file.
    string SaveInstanceConfigurationToString();
    void LoadInstanceConfigurationFromString(string configuration);
}
