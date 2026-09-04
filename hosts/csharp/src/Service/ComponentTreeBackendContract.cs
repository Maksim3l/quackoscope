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
}
