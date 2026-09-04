// Quackoscope host (C#) -- openDAQ layer.
//
// THE ONLY file in this host that references an openDAQ type. Nothing here
// knows about sockets or about the JSON envelope; it speaks the service DTOs.
//
// Every SDK-touching line of every operation sits inside quack-snippet markers,
// the same syntax hosts/cpp/src/opendaq/daq_backend.cpp uses, so that
// tools/snippet-extractor can build generated/snippets.json:
//
//     // quack-snippet capability=<id>[,<id>...] [uses=<name>,...] [step=<n>]
//     // quack-snippet end
//
//     // quack-snippet shared=<name> [uses=<name>,...] [step=<n>]
//     // quack-snippet end
//
// Session bookkeeping, dictionaries, locks and error translation stay OUTSIDE
// every region: they are this host's plumbing, not openDAQ.
using System.Text.Json.Nodes;

using Daq.Core.Objects;
using Daq.Core.OpenDAQ;
using Daq.Core.Types;

using Quackoscope.Host.CSharp.Service;

namespace Quackoscope.Host.CSharp.OpenDaq;

public sealed class OpenDaqBackend : IComponentTreeBackend, IDisposable
{
    // One read asks for at most this many samples and waits at most this long
    // for them, so a stopped subscription's pump thread exits within one
    // timeout rather than blocking on a silent signal.
    private const int PumpBufferSamples = 65536;
    private const int PumpTimeoutMilliseconds = 50;

    // A live subscription: the openDAQ reader over one signal, the thread that
    // drains it, and the sink that the drained samples go to.
    private sealed class SignalSubscription
    {
        public uint Id;
        public string SignalId = "";
        public Signal Signal;
        public Daq.Core.OpenDAQ.StreamReader<double, long> Reader;
        public SampleChunkSink Sink;
        public volatile bool StopRequested;
        public Thread PumpThread;
    }

    private readonly Instance instance;
    private readonly object gate = new();
    private readonly Dictionary<string, Device> devicesByConnectionString = new();
    private readonly object subscriptionGate = new();
    private readonly Dictionary<uint, SignalSubscription> subscriptionsById = new();

    // list_loaded_modules reads IModuleManager::getModules while
    // load_module_from_host_path appends to the very list it walks, so the two
    // are serialised against each other. Plumbing, not openDAQ.
    private readonly object moduleManagerGate = new();

    public string RootComponentId { get; }

    /// The directory the manifest named and openDAQ's loadModules() swept when
    /// this Instance was constructed. load_module_from_host_path names it in a
    /// not_found refusal, because it is the one host-side directory a client
    /// can already be sure this host looks in.
    public string ModuleDirectorySweptAtStartup { get; }

    public OpenDaqBackend(string modulePath, int logLevel)
    {
        ModuleDirectorySweptAtStartup = modulePath;
        Console.WriteLine($"[opendaq] constructing openDAQ Instance with module path {modulePath} and log level {logLevel}");

        // quack-snippet shared=instance-with-module-path
        // The Instance is built with the module path the manifest named, which
        // is the directory openDAQ's loadModules() sweeps: every module
        // list_loaded_modules answers with comes from here, and every module
        // load_module_from_host_path adds comes from somewhere this sweep did
        // not reach.
        instance = OpenDAQFactory.Instance(modulePath, "quackoscope-host-csharp");
        // quack-snippet end

        // quack-snippet capability=tree.read uses=instance-with-module-path step=1
        var rootDevice = instance.RootDevice;
        RootComponentId = rootDevice.GlobalId;
        // quack-snippet end

        Console.WriteLine($"[opendaq] Instance constructed; root component global id is {RootComponentId}");
    }

    public void Dispose()
    {
        uint[] stillSubscribed;
        lock (subscriptionGate)
            stillSubscribed = subscriptionsById.Keys.ToArray();

        foreach (var subscriptionId in stillSubscribed)
            UnsubscribeSignal(subscriptionId);

        if (stillSubscribed.Length > 0)
            Console.WriteLine($"[opendaq] stopped {stillSubscribed.Length} still-open subscription(s) " +
                              $"({string.Join(", ", stillSubscribed)}) before disposing the Instance");

        instance?.Dispose();
    }

    // --- kind, value and descriptor mechanisms ------------------------------

    // openDAQ has no "kind" attribute: a component's kind is whichever of these
    // interfaces it can be cast to. Order matters, because a Channel is also a
    // FunctionBlock and a Device is also a Folder.
    private static string KindOf(Component component)
    {
        // quack-snippet shared=component-kind
        if (component.CanCastTo<Channel>())
            return "channel";
        if (component.CanCastTo<Device>())
            return "device";
        if (component.CanCastTo<FunctionBlock>())
            return "function_block";
        if (component.CanCastTo<Signal>())
            return "signal";
        // Everything else -- folders and plain components such as Synchronization
        // -- is reported as a folder; the contract's kind set has no other
        // container.
        return "folder";
        // quack-snippet end
    }

    // --- component state: the six nullable Node fields ----------------------
    //
    // Every reader below answers null rather than a guess when openDAQ will not
    // say, which is what contract types.Node means by presence: nullable -- the
    // same shape gui_demo.py's _build_component_state_labels gets from wrapping
    // each read in try/except and appending no label when it raises.

    // A PascalCase openDAQ enumeration name as the frozen wire join spells it:
    // "Ok" -> "ok", "SafeOperation" -> "safe_operation". Bookkeeping, not an SDK
    // call, so it sits outside every region.
    private static string WireJoinOf(string openDaqEnumerationName)
    {
        if (string.IsNullOrEmpty(openDaqEnumerationName))
            return null;
        var text = new System.Text.StringBuilder();
        for (var i = 0; i < openDaqEnumerationName.Length; i++)
        {
            var character = openDaqEnumerationName[i];
            if (char.IsUpper(character) && i > 0)
                text.Append('_');
            text.Append(char.ToLowerInvariant(character));
        }
        return text.ToString();
    }

    // contract types.Node.component_status, .connection_status and
    // .operation_mode are closed enums. A value openDAQ reports that is not one
    // of them is dropped to null rather than put on the wire.
    private static readonly string[] ComponentStatusWireValues = { "ok", "warning", "error" };
    private static readonly string[] ConnectionStatusWireValues = { "connected", "reconnecting", "unrecoverable", "removed" };
    private static readonly string[] OperationModeWireValues = { "unknown", "idle", "operation", "safe_operation" };

    private static string InsideTheContractEnum(string candidate, string[] wireValues) =>
        candidate is not null && Array.IndexOf(wireValues, candidate) >= 0 ? candidate : null;

    // The name the wire uses for one OperationModeType member.
    private static string WireNameOfOperationMode(OperationModeType mode)
    {
        // quack-snippet shared=operation-mode-wire-names
        switch (mode)
        {
            case OperationModeType.Unknown:       return "unknown";
            case OperationModeType.Idle:          return "idle";
            case OperationModeType.Operation:     return "operation";
            case OperationModeType.SafeOperation: return "safe_operation";
            default:                              return null;
        }
        // quack-snippet end
    }

    private static bool TryOperationModeNamed(string wireName, out OperationModeType mode)
    {
        foreach (var candidate in new[] { OperationModeType.Unknown, OperationModeType.Idle,
                                          OperationModeType.Operation, OperationModeType.SafeOperation })
            if (WireNameOfOperationMode(candidate) == wireName)
            {
                mode = candidate;
                return true;
            }
        mode = OperationModeType.Unknown;
        return false;
    }

    // IComponent.active. In the .NET binding a C++ getter/setter pair collapses
    // into a property, so there is no GetActive() to find: it is Component.Active.
    private static bool? ActiveStateOf(Component component)
    {
        try
        {
            // quack-snippet shared=component-active
            return component.Active;
            // quack-snippet end
        }
        catch (Exception)
        {
            return null;
        }
    }

    // The EFFECTIVE lock state of any component: a device reports its own
    // IDevice.locked, and every other component reports the nearest ancestor
    // device's. gui_demo.py pushes that inheritance down the tree client-side in
    // _set_node_lock_status_recursive; contract types.Node.locked says the host
    // does it once instead, so every client gets the same answer.
    private static bool? EffectiveLockStateOf(Component component)
    {
        try
        {
            // quack-snippet shared=component-locked-effective
            var walker = component;
            while (walker is not null)
            {
                if (walker.CanCastTo<Device>())
                    return walker.Cast<Device>().Locked;
                walker = walker.Parent;
            }
            return null;
            // quack-snippet end
        }
        catch (Exception)
        {
            return null;
        }
    }

    // IComponent.statusContainer, read under the two keys openDAQ's own
    // Context registers the enumeration types under: "ComponentStatus" of
    // ComponentStatusType (Ok, Warning, Error), and "ConnectionStatus" of
    // ConnectionStatusType (Connected, Reconnecting, Unrecoverable, Removed).
    private static string StatusValueOf(Component component, string statusName)
    {
        try
        {
            // quack-snippet shared=component-status-container
            var container = component.StatusContainer;
            if (container is null || !container.Statuses.ContainsKey(statusName))
                return null;
            return container.GetStatus(statusName).Value;
            // quack-snippet end
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string StatusMessageOf(Component component, string statusName)
    {
        try
        {
            // quack-snippet shared=component-status-message uses=component-status-container
            var container = component.StatusContainer;
            if (container is null || !container.Statuses.ContainsKey(statusName))
                return null;
            var message = container.GetStatusMessage(statusName);
            return string.IsNullOrEmpty(message) ? null : message;
            // quack-snippet end
        }
        catch (Exception)
        {
            return null;
        }
    }

    // IComponent.operationMode -- the CURRENT mode, not the available list.
    // Contract types.Node.operation_mode is device rows only, so this is only
    // ever asked of a component that cast to IDevice.
    private static string CurrentOperationModeOf(Component component)
    {
        try
        {
            // quack-snippet shared=device-operation-mode-current
            return WireNameOfOperationMode(component.OperationMode);
            // quack-snippet end
        }
        catch (Exception)
        {
            return null;
        }
    }

    // The closed value_type set. A property whose openDAQ core type has no
    // member of that set (ctObject, ctProc, ctFunc, ...) is not representable on
    // the M1 wire and is omitted rather than misreported.
    private static bool TryWireValueType(Property property, out string wireValueType)
    {
        // quack-snippet shared=property-wire-value-type
        // A property with selection values is a selection whatever its storage
        // type says; otherwise the core type of the property decides.
        if (property.SelectionValues is not null)
        {
            wireValueType = "selection";
            return true;
        }

        switch (property.ValueType)
        {
            case CoreType.ctBool:   wireValueType = "bool";   return true;
            case CoreType.ctInt:    wireValueType = "int";    return true;
            case CoreType.ctFloat:  wireValueType = "float";  return true;
            case CoreType.ctString: wireValueType = "string"; return true;
            case CoreType.ctStruct: wireValueType = "struct"; return true;
            default:                wireValueType = null;     return false;
        }
        // quack-snippet end
    }

    private static bool IsRepresentableOnTheWire(Property property)
    {
        try
        {
            return TryWireValueType(property, out _);
        }
        catch (Exception)
        {
            return false;
        }
    }

    // An openDAQ value as it appears on the wire, shaped by the core type it
    // reports.
    private static JsonNode ValueAsWireJson(BaseObject value, CoreType coreType)
    {
        if (value is null)
            return null;

        // quack-snippet shared=opendaq-value-to-json
        switch (coreType)
        {
            case CoreType.ctBool:
                return JsonValue.Create((bool)value);
            case CoreType.ctInt:
                return JsonValue.Create((long)value);
            case CoreType.ctFloat:
                return JsonValue.Create((double)value);
            case CoreType.ctString:
                return JsonValue.Create((string)value);
            case CoreType.ctStruct:
            {
                var structure = value.Cast<Daq.Core.Types.Struct>();
                var fields = new JsonObject();
                foreach (var fieldName in structure.FieldNames)
                {
                    var field = structure.Get(fieldName);
                    fields[fieldName] = field is null ? null : JsonValue.Create(field.ToString());
                }
                return fields;
            }
            default:
                return JsonValue.Create(value.ToString());
        }
        // quack-snippet end
    }

    // The whole descriptor mechanism: everything openDAQ can say about one
    // property.
    private static Service.PropertyDescriptor DescriptorOf(Property property)
    {
        var descriptor = new Service.PropertyDescriptor();

        // quack-snippet shared=property-descriptor uses=property-wire-value-type,opendaq-value-to-json
        descriptor.Name = property.Name;
        descriptor.Id = descriptor.Name;  // openDAQ property names are the identifiers
        TryWireValueType(property, out var wireValueType);  // shared region property-wire-value-type
        descriptor.ValueType = wireValueType;
        descriptor.ReadOnly = property.ReadOnly;
        descriptor.Visible = property.Visible;
        descriptor.DefaultValue = ValueAsWireJson(property.DefaultValue, property.ValueType);

        var unit = property.Unit;
        if (unit is not null)
            descriptor.Unit = unit.Symbol;

        var description = property.Description;
        if (!string.IsNullOrEmpty(description))
            descriptor.Description = description;

        var minimum = property.MinValue;
        if (minimum is not null)
            descriptor.Minimum = (double)minimum;

        var maximum = property.MaxValue;
        if (maximum is not null)
            descriptor.Maximum = (double)maximum;

        var validator = property.Validator;
        if (validator is not null)
            descriptor.ValidatorEvalSource = validator.Eval;

        var coercer = property.Coercer;
        if (coercer is not null)
            descriptor.CoercerEvalSource = coercer.Eval;

        var selectionValues = property.SelectionValues;
        if (selectionValues is not null)
        {
            var values = new List<string>();
            if (selectionValues.CanCastTo<ListObject<BaseObject>>())
                foreach (var item in selectionValues.CastList<BaseObject>())
                    values.Add(item?.ToString());
            else if (selectionValues.CanCastTo<DictObject<BaseObject, BaseObject>>())
                foreach (var pair in selectionValues.CastDict<BaseObject, BaseObject>())
                    values.Add(pair.Value?.ToString());
            descriptor.SelectionValues = values;
        }

        var suggestedValues = property.SuggestedValues;
        if (suggestedValues is not null)
        {
            var values = new List<JsonNode>();
            foreach (var item in suggestedValues)
                values.Add(item is null ? null : JsonValue.Create(item.ToString()));
            descriptor.SuggestedValues = values;
        }
        // quack-snippet end

        return descriptor;
    }

    // JSON -> openDAQ value, shaped by the property's declared type. Coercion
    // and validation stay openDAQ's business: this only builds a value of the
    // right kind and lets SetPropertyValue judge it.
    private static BaseObject WireJsonAsOpenDaqValue(Property property, JsonNode value)
    {
        // quack-snippet shared=json-to-opendaq-value
        var valueType = property.ValueType;
        switch (valueType)
        {
            case CoreType.ctBool:
                if (value is JsonValue boolNode && boolNode.TryGetValue(out bool boolean))
                    return (BaseObject)boolean;
                if (value is JsonValue boolAsNumber && boolAsNumber.TryGetValue(out double numericBoolean))
                    return (BaseObject)(numericBoolean != 0.0);
                break;
            case CoreType.ctInt:
                if (value is JsonValue intNode && intNode.TryGetValue(out long integer))
                    return (BaseObject)integer;
                if (value is JsonValue intAsDouble && intAsDouble.TryGetValue(out double numericInteger))
                    return (BaseObject)(long)numericInteger;
                break;
            case CoreType.ctFloat:
                if (value is JsonValue floatNode && floatNode.TryGetValue(out double floating))
                    return (BaseObject)floating;
                break;
            case CoreType.ctString:
                if (value is JsonValue stringNode && stringNode.TryGetValue(out string text))
                    return (BaseObject)text;
                break;
            default:
                throw new WireError(WireErrorCode.Unsupported,
                    $"property \"{property.Name}\" has openDAQ value type {valueType}; quackoscope-host-csharp builds " +
                    "only ctBool, ctInt, ctFloat and ctString values from wire JSON, because the M1 wire carries no " +
                    "field-typed encoding a ctStruct write could be reconstructed from");
        }
        // quack-snippet end

        throw new WireError(WireErrorCode.InvalidValue,
            $"value {value?.ToJsonString() ?? "null"} does not fit property \"{property.Name}\" of openDAQ value type {valueType}");
    }

    // --- resolution ---------------------------------------------------------

    private Component ResolveComponent(string nodeId)
    {
        // quack-snippet shared=component-by-global-id
        var rootDevice = instance.RootDevice;
        var rootId = rootDevice.GlobalId;

        if (nodeId == rootId)
            return rootDevice;

        if (nodeId.StartsWith(rootId + "/", StringComparison.Ordinal))
        {
            var relative = nodeId.Substring(rootId.Length + 1);
            Component found = null;
            try
            {
                found = rootDevice.FindComponent(relative);
            }
            catch (OpenDaqException)
            {
                found = null;
            }
            if (found is not null)
                return found;
        }
        // quack-snippet end

        throw new WireError(WireErrorCode.NotFound, $"no component with id \"{nodeId}\"");
    }

    private PropertyObject ResolvePropertyObject(string nodeId)
    {
        var component = ResolveComponent(nodeId);

        // quack-snippet shared=property-object-of-component
        if (!component.CanCastTo<PropertyObject>())
            throw new WireError(WireErrorCode.NotFound, $"component \"{nodeId}\" carries no properties");
        var propertyObject = component.Cast<PropertyObject>();
        // quack-snippet end

        return propertyObject;
    }

    private static Property ResolveProperty(PropertyObject propertyObject, string nodeId, string propertyId)
    {
        try
        {
            // quack-snippet shared=property-by-name
            return propertyObject.GetProperty(propertyId);
            // quack-snippet end
        }
        catch (OpenDaqException e)
        {
            throw new WireError(WireErrorCode.NotFound,
                $"property \"{propertyId}\" not found on \"{nodeId}\": {e.Message}");
        }
    }

    // --- the implemented operations -----------------------------------------

    public ComponentNode ConnectDevice(string connectionString)
    {
        lock (gate)
        {
            if (devicesByConnectionString.TryGetValue(connectionString, out var already))
            {
                Console.WriteLine($"[opendaq] connect_device {connectionString}: already added as {already.GlobalId}");
                return BuildNode(already);
            }
        }

        Device device;
        try
        {
            // quack-snippet capability=device.connect uses=component-node step=1
            device = instance.AddDevice(connectionString);
            // quack-snippet end
        }
        catch (OpenDaqException e)
        {
            throw new WireError(ClosedSetCodeFor(e),
                $"adding device \"{connectionString}\" failed: {e.Message}");
        }

        lock (gate)
            devicesByConnectionString[connectionString] = device;

        var node = BuildNode(device);
        Console.WriteLine($"[opendaq] connect_device {connectionString} -> node id {node.Id}, name \"{node.Name}\", " +
                          $"kind {node.Kind}, {node.ChildIds.Count} child component(s), {node.PropertyIds.Count} property/properties");
        return node;
    }

    public void DisconnectDevice(string nodeId)
    {
        Device device = null;
        string connectionString = null;

        lock (gate)
        {
            foreach (var (key, value) in devicesByConnectionString)
                if (value.GlobalId == nodeId)
                {
                    connectionString = key;
                    device = value;
                    break;
                }
            if (connectionString is not null)
                devicesByConnectionString.Remove(connectionString);
        }

        if (device is null)
        {
            string added;
            lock (gate)
                added = devicesByConnectionString.Count == 0
                    ? "no device at all"
                    : string.Join(", ", devicesByConnectionString.Select(pair => $"{pair.Value} ({pair.Key})"));
            throw new WireError(WireErrorCode.NotFound,
                $"connect_device never added a device with id \"{nodeId}\" to this openDAQ Instance; it holds {added}. " +
                "disconnect_device takes the node id connect_device answered with");
        }

        try
        {
            // quack-snippet capability=device.connect step=2
            // Undoing an addDevice. The Device handle connect_device kept is
            // handed straight back to the same Instance that added it, and
            // openDAQ raises its ComponentRemoved core event for the vanished
            // subtree.
            instance.RemoveDevice(device);
            // quack-snippet end
        }
        catch (OpenDaqException e)
        {
            throw new WireError(ClosedSetCodeFor(e),
                $"removing device \"{nodeId}\" ({connectionString}) from the openDAQ Instance failed: {e.Message}");
        }

        Console.WriteLine($"[opendaq] disconnect_device {nodeId} ({connectionString}): removed from the openDAQ Instance");
    }

    private ComponentNode BuildNode(Component component)
    {
        var node = new ComponentNode();

        // quack-snippet shared=component-node uses=component-kind,property-wire-value-type,component-active,component-locked-effective,component-status-container,component-status-message,device-operation-mode-current,operation-mode-wire-names
        node.Id = component.GlobalId;
        node.Name = component.Name;
        node.Kind = KindOf(component);  // shared region component-kind

        var parent = component.Parent;
        if (parent is not null)
            node.ParentId = parent.GlobalId;

        if (component.CanCastTo<Folder>())
            foreach (var child in component.Cast<Folder>().GetItems())
                node.ChildIds.Add(child.GlobalId);

        if (component.CanCastTo<PropertyObject>())
            foreach (var property in component.Cast<PropertyObject>().AllProperties)
                if (IsRepresentableOnTheWire(property))  // shared region property-wire-value-type
                    node.PropertyIds.Add(property.Name);

        node.Active = ActiveStateOf(component);                        // shared region component-active
        node.Locked = EffectiveLockStateOf(component);                 // shared region component-locked-effective
        node.ComponentStatus = InsideTheContractEnum(
            WireJoinOf(StatusValueOf(component, "ComponentStatus")), ComponentStatusWireValues);
        node.ComponentStatusMessage = StatusMessageOf(component, "ComponentStatus");

        // connection_status and operation_mode are device rows only; contract
        // types.Node says null on every other kind, so they are not even read
        // for a channel, a signal or a folder.
        if (component.CanCastTo<Device>())
        {
            node.ConnectionStatus = InsideTheContractEnum(
                WireJoinOf(StatusValueOf(component, "ConnectionStatus")), ConnectionStatusWireValues);
            node.OperationMode = InsideTheContractEnum(
                CurrentOperationModeOf(component), OperationModeWireValues);
        }
        // quack-snippet end

        return node;
    }

    public IReadOnlyList<ComponentNode> GetComponentTree(string rootId)
    {
        var nodes = new List<ComponentNode>();
        var root = ResolveComponent(rootId);
        AppendSubtree(root, nodes);
        Console.WriteLine($"[opendaq] get_component_tree from {rootId} -> {nodes.Count} node(s)");
        return nodes;
    }

    private void AppendSubtree(Component component, List<ComponentNode> nodes)
    {
        nodes.Add(BuildNode(component));

        // quack-snippet capability=tree.read uses=component-node step=2
        if (!component.CanCastTo<Folder>())
            return;
        foreach (var child in component.Cast<Folder>().GetItems())
            AppendSubtree(child, nodes);
        // quack-snippet end
    }

    public IReadOnlyList<Service.PropertyDescriptor> GetPropertyDescriptors(string nodeId)
    {
        var propertyObject = ResolvePropertyObject(nodeId);
        var descriptors = new List<Service.PropertyDescriptor>();

        // quack-snippet capability=property.read uses=property-object-of-component,property-descriptor step=1
        foreach (var property in propertyObject.AllProperties)
            if (IsRepresentableOnTheWire(property))
                descriptors.Add(DescriptorOf(property));  // shared region property-descriptor
        // quack-snippet end

        Console.WriteLine($"[opendaq] get_property_descriptors on {nodeId} -> {descriptors.Count} descriptor(s)");
        return descriptors;
    }

    public JsonNode GetPropertyValue(string nodeId, string propertyId)
    {
        var propertyObject = ResolvePropertyObject(nodeId);
        var property = ResolveProperty(propertyObject, nodeId, propertyId);

        JsonNode wireValue;
        try
        {
            // quack-snippet capability=property.read uses=property-by-name,opendaq-value-to-json step=2
            var value = propertyObject.GetPropertyValue(propertyId);
            wireValue = ValueAsWireJson(value, property.ValueType);  // shared region opendaq-value-to-json
            // quack-snippet end
        }
        catch (OpenDaqException e)
        {
            throw new WireError(ClosedSetCodeFor(e),
                $"reading property \"{propertyId}\" on \"{nodeId}\" failed: {e.Message}");
        }

        Console.WriteLine($"[opendaq] get_property_value {nodeId}.{propertyId} -> {wireValue?.ToJsonString() ?? "null"}");
        return wireValue;
    }

    public void SetPropertyValue(string nodeId, string propertyId, JsonNode value)
    {
        var propertyObject = ResolvePropertyObject(nodeId);
        var property = ResolveProperty(propertyObject, nodeId, propertyId);

        if (property.ReadOnly)
            throw new WireError(WireErrorCode.ReadOnly,
                $"property \"{propertyId}\" on \"{nodeId}\" is read-only in openDAQ; it cannot be written");

        try
        {
            // quack-snippet capability=property.write uses=property-by-name,json-to-opendaq-value step=1
            var opendaqValue = WireJsonAsOpenDaqValue(property, value);  // shared region json-to-opendaq-value
            propertyObject.SetPropertyValue(propertyId, opendaqValue);
            // quack-snippet end
        }
        catch (OpenDaqException e)
        {
            throw new WireError(ClosedSetCodeFor(e),
                $"writing {value?.ToJsonString() ?? "null"} to property \"{propertyId}\" on \"{nodeId}\" failed: {e.Message}");
        }

        Console.WriteLine($"[opendaq] set_property_value {nodeId}.{propertyId} = {value?.ToJsonString() ?? "null"} accepted");
    }

    // --- subscribe_signal ---------------------------------------------------

    public void SubscribeSignal(string signalId, uint subscriptionId, SampleChunkSink sink)
    {
        var component = ResolveComponent(signalId);

        // quack-snippet capability=streaming.decimated step=1
        // Only a component that carries ISignal can be read from, and a
        // StreamReader is what turns that signal into samples: it is asked for
        // Float64 values against an Int64 domain, and openDAQ converts whatever
        // the signal's own descriptor says into those two types.
        if (!component.CanCastTo<Signal>())
            throw new WireError(WireErrorCode.InvalidValue, $"component \"{signalId}\" is not a signal");
        var signal = component.Cast<Signal>();
        // quack-snippet end

        var subscription = new SignalSubscription
        {
            Id = subscriptionId,
            SignalId = signalId,
            Signal = signal,
            Sink = sink
        };

        try
        {
            // quack-snippet capability=streaming.decimated step=2
            subscription.Reader = OpenDAQFactory.CreateStreamReader<double, long>(signal);
            // quack-snippet end
        }
        catch (OpenDaqException e)
        {
            throw new WireError(ClosedSetCodeFor(e),
                $"creating a StreamReader<double, long> over signal \"{signalId}\" failed: {e.Message}");
        }

        lock (subscriptionGate)
            subscriptionsById[subscriptionId] = subscription;

        subscription.PumpThread = new Thread(() => DrainSubscriptionUntilStopped(subscription))
        {
            IsBackground = true,
            Name = $"quackoscope-signal-pump-{subscriptionId}"
        };
        subscription.PumpThread.Start();

        Console.WriteLine($"[opendaq] subscribe_signal {signalId} -> subscription {subscriptionId}; " +
                          $"StreamReader<double, long> open, pump thread \"{subscription.PumpThread.Name}\" started " +
                          $"(buffer {PumpBufferSamples} samples, read timeout {PumpTimeoutMilliseconds} ms)");
    }

    // --- unsubscribe_signal -------------------------------------------------

    public void UnsubscribeSignal(uint subscriptionId)
    {
        SignalSubscription subscription;
        lock (subscriptionGate)
        {
            if (!subscriptionsById.TryGetValue(subscriptionId, out subscription))
                return;  // the session registry already reported an unknown id
            subscriptionsById.Remove(subscriptionId);
        }

        subscription.StopRequested = true;
        subscription.PumpThread?.Join();

        // quack-snippet capability=streaming.decimated step=5
        subscription.Reader?.Dispose();  // releasing the reader disconnects it from the signal
        // quack-snippet end
        subscription.Reader = null;

        Console.WriteLine($"[opendaq] unsubscribe_signal {subscriptionId} ({subscription.SignalId}): " +
                          "pump thread joined and the StreamReader released from the signal");
    }

    private void DrainSubscriptionUntilStopped(SignalSubscription subscription)
    {
        var values = new double[PumpBufferSamples];
        var domain = new long[PumpBufferSamples];

        while (!subscription.StopRequested)
        {
            nuint count = PumpBufferSamples;
            var readerWentInvalid = false;

            try
            {
                // quack-snippet capability=streaming.decimated step=3
                using var status = subscription.Reader.ReadWithDomain(values, domain, ref count, PumpTimeoutMilliseconds);
                readerWentInvalid = status is not null && !status.Valid;
                // quack-snippet end
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"[opendaq] ReadWithDomain on subscription {subscription.Id} " +
                                        $"({subscription.SignalId}) failed: {e.GetType().Name}: {e.Message}");
                Thread.Sleep(100);
                continue;
            }

            if (count > 0)
                subscription.Sink?.Invoke(subscription.Id, (ulong)domain[0], values, (int)count);

            // quack-snippet capability=streaming.decimated step=4
            // A descriptor change invalidates the reader: ReadWithDomain reports
            // an invalid status once and every later read would keep returning
            // nothing, so the reader has to be built again over the same signal.
            // This is the same construction subscribe_signal does.
            if (readerWentInvalid)
            {
                try
                {
                    subscription.Reader?.Dispose();
                    subscription.Reader = OpenDAQFactory.CreateStreamReader<double, long>(subscription.Signal);
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine($"[opendaq] could not rebuild the StreamReader for subscription " +
                                            $"{subscription.Id} ({subscription.SignalId}): {e.GetType().Name}: {e.Message}");
                    Thread.Sleep(100);
                }
            }
            // quack-snippet end

            if (count == 0)
                Thread.Sleep(5);
        }
    }

    // --- get_device_operation_modes / set_device_operation_mode -------------

    // A node that must be a device. The node existing but not being a device is
    // `unsupported` and not `not_found`, because the node is genuinely there --
    // contract operations[get_device_operation_modes].errors says so in as many
    // words.
    private Device ResolveDeviceOnly(string nodeId, string wireMethod)
    {
        var component = ResolveComponent(nodeId);

        // quack-snippet shared=device-of-component uses=component-by-global-id,component-kind
        if (!component.CanCastTo<Device>())
            throw new WireError(WireErrorCode.Unsupported,
                $"component \"{nodeId}\" is a {KindOf(component)} and not a device, so {wireMethod} has nothing to " +
                "act on; openDAQ puts lock/unlock and the operation modes on IDevice");
        var device = component.Cast<Device>();
        // quack-snippet end

        return device;
    }

    public IReadOnlyList<string> GetDeviceOperationModes(string nodeId)
    {
        var device = ResolveDeviceOnly(nodeId, "get_device_operation_modes");
        var wireNames = new List<string>();
        var ordinalsOutsideTheContractEnum = new List<long>();

        try
        {
            // quack-snippet capability=device.mode uses=device-of-component,operation-mode-wire-names step=1
            // IDevice.availableOperationModes answers the ORDINALS of the
            // OperationModeType members the device offers, not their names: the
            // .NET binding types it IListObject<IntegerObject>, exactly as the
            // reference's block_view.py reads `list(node.available_operation_modes)`
            // and matches 0/1/2/3 by hand. Each ordinal is turned back into the
            // enum member and then spelled the way the wire spells it.
            foreach (var ordinal in device.AvailableOperationModes)
            {
                var name = WireNameOfOperationMode((OperationModeType)(int)(long)ordinal);
                if (name is null)
                    ordinalsOutsideTheContractEnum.Add(ordinal);
                else
                    wireNames.Add(name);
            }
            // quack-snippet end
        }
        catch (OpenDaqException e)
        {
            throw new WireError(ClosedSetCodeFor(e),
                $"reading IDevice.availableOperationModes on \"{nodeId}\" failed: {e.Message}");
        }

        Console.WriteLine($"[opendaq] get_device_operation_modes {nodeId} -> {wireNames.Count} mode(s): " +
                          $"{(wireNames.Count == 0 ? "(none)" : string.Join(", ", wireNames))}" +
                          (ordinalsOutsideTheContractEnum.Count == 0
                              ? ""
                              : $"; dropped {ordinalsOutsideTheContractEnum.Count} ordinal(s) " +
                                $"[{string.Join(", ", ordinalsOutsideTheContractEnum)}] that name no member of " +
                                $"OperationModeType (Unknown=0, Idle=1, Operation=2, SafeOperation=3)"));
        return wireNames;
    }

    public void SetDeviceOperationMode(string nodeId, string mode)
    {
        var device = ResolveDeviceOnly(nodeId, "set_device_operation_mode");

        if (!TryOperationModeNamed(mode, out var modeType))
            throw new WireError(WireErrorCode.InvalidValue,
                $"\"{mode}\" is not one of the operation mode names contract types.Node.operation_mode enumerates: " +
                $"{string.Join(", ", OperationModeWireValues)}");

        var available = GetDeviceOperationModes(nodeId);
        if (!available.Contains(mode))
            throw new WireError(WireErrorCode.InvalidValue,
                $"device \"{nodeId}\" does not offer operation mode \"{mode}\"; " +
                $"IDevice.availableOperationModes lists {(available.Count == 0 ? "(none)" : string.Join(", ", available))}");

        if (EffectiveLockStateOf(device) == true)
            throw new WireError(WireErrorCode.ReadOnly,
                $"device \"{nodeId}\" reports IDevice.locked = true, so openDAQ refuses the write; " +
                "unlock_device it first");

        try
        {
            // quack-snippet capability=device.mode uses=device-of-component,operation-mode-wire-names step=2
            // IDevice.setOperationMode takes the enum member, not its name. The
            // non-recursive form is used: it changes this device only, where
            // setOperationModeRecursive would also change every child device,
            // which is a different act than the one the wire asked for.
            device.SetOperationMode(modeType);
            // quack-snippet end
        }
        catch (OpenDaqException e)
        {
            // The likeliest native refusal here is the lock, which openDAQ
            // reports on the write and not on the precheck if it is taken in
            // between; LockRefusalCodeFor turns that into the read_only the
            // row's error subset names for it.
            throw new WireError(LockRefusalCodeFor(e),
                $"IDevice.setOperationMode({modeType}) on \"{nodeId}\" failed: {e.Message}");
        }

        Console.WriteLine($"[opendaq] set_device_operation_mode {nodeId} = \"{mode}\" " +
                          $"(OperationModeType.{modeType}, ordinal {(int)modeType}) accepted; " +
                          $"IComponent.operationMode now reads \"{CurrentOperationModeOf(device)}\"");
    }

    // --- lock_device / unlock_device ----------------------------------------

    // The refusal openDAQ gives when a lock is held by somebody else, mapped to
    // the code contract operations[lock_device].errors names for it. The closed
    // set has no "locked" member and read_only is the nearest true statement:
    // it is also the exact signal that turns the forced-unlock control on.
    // A native failure that is NOT a lock refusal is not dressed up as one --
    // it goes through the same classifier every other operation uses.
    private static WireErrorCode LockRefusalCodeFor(OpenDaqException e)
    {
        var text = e.Message ?? "";
        if (text.Contains("lock", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("access denied", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("ACCESSDENIED", StringComparison.OrdinalIgnoreCase))
            return WireErrorCode.ReadOnly;
        return ClosedSetCodeFor(e);
    }

    public void LockDevice(string nodeId)
    {
        var device = ResolveDeviceOnly(nodeId, "lock_device");
        var wasLocked = EffectiveLockStateOf(device);

        try
        {
            // quack-snippet capability=device.lock uses=device-of-component step=1
            // IDevice.lock() takes no arguments in the .NET binding: openDAQ
            // resolves the user from the instance's authentication provider, and
            // locks every child device of this one as well. IDevice.locked is
            // what reads the state back, and it is already on every Node.
            device.Lock();
            // quack-snippet end
        }
        catch (OpenDaqException e)
        {
            throw new WireError(LockRefusalCodeFor(e), $"IDevice.lock() on \"{nodeId}\" failed: {e.Message}");
        }

        Console.WriteLine($"[opendaq] lock_device {nodeId}: IDevice.lock() returned; IDevice.locked was " +
                          $"{(wasLocked is null ? "unreadable" : wasLocked.ToString().ToLowerInvariant())} " +
                          $"and now reads {EffectiveLockStateOf(device)?.ToString().ToLowerInvariant() ?? "unreadable"}");
    }

    public void UnlockDevice(string nodeId, bool force)
    {
        var device = ResolveDeviceOnly(nodeId, "unlock_device");

        // The forced path. openDAQ.Net, Version=3.41.0.0 carries no member that
        // hands out a device's IUserLock and no IDevicePrivate at all -- see
        // ForcedUnlockIsUnreachableInThisBinding for what was enumerated -- so
        // force: true is refused with the code contract
        // operations[unlock_device].errors reserves for exactly this case
        // ("unsupported covers ... force: true on a host that cannot reach
        // IDevicePrivate") rather than being silently downgraded to a plain
        // unlock.
        if (force)
            throw new WireError(WireErrorCode.Unsupported, ForcedUnlockIsUnreachableInThisBinding);

        var wasLocked = EffectiveLockStateOf(device);

        try
        {
            // quack-snippet capability=device.lock uses=device-of-component step=2
            // IDevice.unlock() takes no arguments in the .NET binding and
            // refuses with OPENDAQ_ERR_ACCESSDENIED when the lock belongs to
            // another user; that refusal is what read_only carries back.
            device.Unlock();
            // quack-snippet end
        }
        catch (OpenDaqException e)
        {
            throw new WireError(LockRefusalCodeFor(e), $"IDevice.unlock() on \"{nodeId}\" failed: {e.Message}");
        }

        Console.WriteLine($"[opendaq] unlock_device {nodeId} (force false): IDevice.unlock() returned; " +
                          $"IDevice.locked was {(wasLocked is null ? "unreadable" : wasLocked.ToString().ToLowerInvariant())} " +
                          $"and now reads {EffectiveLockStateOf(device)?.ToString().ToLowerInvariant() ?? "unreadable"}");
    }

    // Why unlock_device refuses force: true. Stated once, printed verbatim into
    // the refusal, so the client shows what was searched and not "not exposed".
    public const string ForcedUnlockIsUnreachableInThisBinding =
        "unlock_device force: true is currently not available in quackoscope-host-csharp. openDAQ's C++ " +
        "IDevicePrivate::forceUnlock is what the reference falls back to (gui_demo.py:1409-1412), and the .NET " +
        "binding's surface was enumerated to see whether it can be reached: System.Reflection over openDAQ.Net, " +
        "Version=3.41.0.0 lists 212 public types, none named DevicePrivate or IDevicePrivate; the only ForceUnlock " +
        "in the whole assembly is \"Void ForceUnlock()\" on Daq.Core.OpenDAQ.UserLock, and no public member of any " +
        "of the 212 types returns a UserLock, so a Device gives no route to one. Daq.Core.OpenDAQ.Device declares " +
        "\"Void Lock()\", \"Void Unlock()\" and \"Boolean Locked { get; }\" and nothing further about locking. " +
        "unlock_device without force is served.";

    // --- list_loaded_modules -------------------------------------------------

    public IReadOnlyList<Service.ModuleInfo> ListLoadedModules()
    {
        var modules = new List<Service.ModuleInfo>();

        try
        {
            lock (moduleManagerGate)
            {
                // quack-snippet capability=module.read uses=instance-with-module-path step=1
                // IInstance.moduleManager.modules is the whole loaded set. In
                // the .NET binding both are properties, not getters: a C++
                // getModuleManager()/getModules() pair collapses into
                // Instance.ModuleManager and ModuleManager.Modules.
                var moduleManager = instance.ModuleManager;
                foreach (var module in moduleManager.Modules)
                    modules.Add(DescribeModule(module));  // shared region module-info-record
                // quack-snippet end
            }
        }
        catch (OpenDaqException e)
        {
            // contract operations[list_loaded_modules].errors is
            // [not_connected, internal]. A native failure here is not a wrong
            // request and not a missing device, so internal is the only member
            // of that subset it can honestly be; the native text is carried
            // through whole rather than being flattened into "failed".
            throw new WireError(WireErrorCode.Internal,
                $"reading IInstance.moduleManager.modules failed: {e.GetType().Name}: {e.Message}");
        }

        // contract types.ModuleInfo.id and .name are presence: required, so
        // neither key may carry null on the wire. Two of the modules the
        // manifest's module_path loads -- MockModules -- answer IModuleInfo.id
        // as a null IString, which the .NET binding surfaces as a null string.
        // The empty string is what "openDAQ reported no id" renders as on a
        // required string field, and the line below names every module it
        // happened to, so the fact is stated rather than swallowed.
        var reportingNoId = modules.Where(module => module.Id is null).ToArray();
        var reportingNoName = modules.Where(module => module.Name is null).ToArray();
        foreach (var module in modules)
        {
            module.Id ??= "";
            module.Name ??= "";
        }
        if (reportingNoId.Length > 0)
            Console.WriteLine($"[opendaq] {reportingNoId.Length} of the {modules.Count} loaded modules answer " +
                              "IModuleInfo.id as a null string, and contract types.ModuleInfo.id is required, so they " +
                              "cross the wire with id \"\": " +
                              string.Join(", ", reportingNoId.Select(module => $"name \"{module.Name}\" v{module.Version ?? "(none)"}")));
        if (reportingNoName.Length > 0)
            Console.WriteLine($"[opendaq] {reportingNoName.Length} of the {modules.Count} loaded modules answer " +
                              "IModuleInfo.name as a null string, and they cross the wire with name \"\": " +
                              string.Join(", ", reportingNoName.Select(module => $"id \"{module.Id}\"")));

        Console.WriteLine($"[opendaq] list_loaded_modules -> {modules.Count} module(s): " +
                          string.Join("; ", modules.Select(module =>
                              $"\"{module.Id}\" \"{module.Name}\" v{module.Version ?? "(none)"} " +
                              $"offering {module.ComponentTypes.Count} component type(s)")));
        return modules;
    }

    // --- load_module_from_host_path -----------------------------------------

    public Service.ModuleInfo LoadModuleFromHostPath(string hostPath)
    {
        // Everything down to the SDK call is a statement about THIS machine's
        // filesystem, which is the whole substance of the row: openDAQ declares
        // loadModule(IString* path, IModule** module) and no bytes-in sibling,
        // so the file that gets loaded is one the host process opens itself.
        // These are not SDK calls and stay outside every quack-snippet region.
        if (!Path.IsPathFullyQualified(hostPath))
            throw new WireError(WireErrorCode.InvalidValue,
                $"params.host_path is \"{hostPath}\", which is not a fully qualified path on this host. " +
                $"A relative path would be resolved against the working directory quackoscope-host-csharp " +
                $"happens to be running in ({Directory.GetCurrentDirectory()}), which the caller cannot see; " +
                "load_module_from_host_path takes an absolute path on the host's own filesystem. The directory " +
                $"openDAQ's loadModules() already swept for this Instance is {ModuleDirectorySweptAtStartup}");

        var absolutePath = Path.GetFullPath(hostPath);

        if (Directory.Exists(absolutePath))
            throw new WireError(WireErrorCode.InvalidValue,
                $"host_path \"{absolutePath}\" is a directory on this host, not a file. " +
                "IModuleManager::loadModule loads one module file; the directory sweep is loadModules(), which " +
                $"already ran once over {ModuleDirectorySweptAtStartup} when this Instance was constructed");

        // File.Exists is asked BEFORE openDAQ so that the answer can name the
        // literal path and the host's own module directory. openDAQ's own
        // check would report the same absence, but as OPENDAQ_ERR_INVALIDPARAMETER
        // ("Specified module path ... does not exist"), and contract
        // operations[load_module_from_host_path].errors splits that case out as
        // not_found. LoadModuleRefusalCodeFor still recognises the native text,
        // so a file that vanishes between this check and the load is answered
        // with the same code.
        if (!File.Exists(absolutePath))
            throw new WireError(WireErrorCode.NotFound,
                $"this host has no file at \"{absolutePath}\". load_module_from_host_path resolves the path on " +
                "the HOST's filesystem, never on the client's, so a path copied off the machine running the UI " +
                $"will land here. The directory this host's openDAQ Instance already swept for modules is " +
                $"{ModuleDirectorySweptAtStartup}");

        var modulesLoadedBefore = CountLoadedModules();

        Module loaded;
        lock (moduleManagerGate)
        {
            try
            {
                // quack-snippet capability=module.load uses=instance-with-module-path step=1
                // IModuleManager::loadModule(IString* path, IModule** module)
                // collapses in the .NET binding into Module LoadModule(string
                // path) on Daq.Core.OpenDAQ.ModuleManager: the out-parameter
                // becomes the return value. It LOADS AND ADDS -- the module
                // joins the same list ModuleManager.Modules answers with, so
                // list_loaded_modules sees it on its very next call.
                var moduleManager = instance.ModuleManager;
                loaded = moduleManager.LoadModule(absolutePath);
                // quack-snippet end
            }
            catch (OpenDaqException e)
            {
                throw new WireError(LoadModuleRefusalCodeFor(e),
                    $"IModuleManager::loadModule(\"{absolutePath}\") refused with {NativeCodeTextOf(e)}: " +
                    OpenDaqOwnMessageOf(e));
            }
        }

        if (loaded is null)
            throw new WireError(WireErrorCode.Internal,
                $"IModuleManager::loadModule(\"{absolutePath}\") returned without an error and without a module, " +
                "so there is no IModule to build the contract's ModuleInfo record from");

        var entry = DescribeModule(loaded);  // shared region module-info-record

        // contract types.ModuleInfo.id and .name are presence: required. The
        // same null-IString modules list_loaded_modules already meets can be
        // loaded through this row, and "" is what a required string field
        // renders "openDAQ reported nothing" as.
        var reportedNoId = entry.Id is null;
        var reportedNoName = entry.Name is null;
        entry.Id ??= "";
        entry.Name ??= "";

        // openDAQ answers OPENDAQ_IGNORED -- a SUCCESS code, so the .NET
        // binding's Result.Failed() lets it through and hands back the module
        // that is already in the list -- when this exact path was loaded
        // before (module_manager_impl.cpp tryLoadAndAddModule). The count says
        // which of the two happened, and it is stated rather than dressed up
        // as a fresh load.
        var modulesLoadedAfter = CountLoadedModules();
        var wasAlreadyLoadedFromThisPath = modulesLoadedAfter == modulesLoadedBefore;

        Console.WriteLine($"[opendaq] load_module_from_host_path \"{absolutePath}\" -> module id \"{entry.Id}\" " +
                          $"name \"{entry.Name}\" v{entry.Version ?? "(none)"} offering {entry.ComponentTypes.Count} " +
                          $"component type(s); IModuleManager::getModules held {modulesLoadedBefore} module(s) before " +
                          $"and holds {modulesLoadedAfter} now" +
                          (wasAlreadyLoadedFromThisPath
                              ? ", so openDAQ answered OPENDAQ_IGNORED and handed back the module it had already " +
                                "loaded from this same path rather than loading a second copy"
                              : ", so this is a module the startup sweep of " +
                                $"{ModuleDirectorySweptAtStartup} had not loaded") +
                          (reportedNoId ? "; IModuleInfo.id came back null and crosses the wire as \"\"" : "") +
                          (reportedNoName ? "; IModuleInfo.name came back null and crosses the wire as \"\"" : ""));

        // What a successful load makes stale, said in full because nothing on
        // the wire can announce it: contract events is closed: true over
        // component_added, component_removed, property_changed,
        // property_descriptor_changed and device_disconnected, and none of the
        // five is about modules. So no event is pushed -- inventing a sixth
        // would put a record on the wire no client has a type for.
        //   - list_loaded_modules: reads ModuleManager.Modules live on every
        //     call and caches nothing, so its next answer already carries this
        //     module. The caller of THIS row does not even need it: the record
        //     it just received is the same one that list would build.
        //   - the component tree: unchanged. loadModule loads and adds a
        //     module; it instantiates no device, function block or server, so
        //     get_component_tree answers exactly what it answered before.
        //   - the device types connect_device accepts and the function block
        //     types add_function_block accepts: these DO widen, and this host
        //     caches neither -- connect_device calls Instance.AddDevice each
        //     time, and function_block.add is a declared gap here, so there is
        //     no stale list to invalidate. The new module's own device,
        //     function block, server and streaming types are already in the
        //     component_types of the record just returned.
        Console.WriteLine($"[opendaq] load_module_from_host_path \"{absolutePath}\": nothing cached in this host went " +
                          "stale -- list_loaded_modules reads IModuleManager::getModules on every call, and " +
                          "IModuleManager::loadModule instantiates no component, so the component tree is unchanged. " +
                          "contract events is a closed set of five and none of them is about modules, so no event " +
                          "was pushed to the other sessions");

        return entry;
    }

    // How many modules IModuleManager::getModules currently answers with.
    // Bookkeeping around the load, so the host can say whether a module was
    // actually added; the SDK reads it makes are the ones module.read step 1
    // already marks.
    private int CountLoadedModules()
    {
        try
        {
            lock (moduleManagerGate)
            {
                var count = 0;
                foreach (var _ in instance.ModuleManager.Modules)
                    count++;
                return count;
            }
        }
        catch (Exception)
        {
            return -1;
        }
    }

    // Native refusal of loadModule -> the four codes contract
    // operations[load_module_from_host_path].errors allows, and no others.
    // ClosedSetCodeFor is not reused here because it can answer unsupported,
    // read_only or timeout, none of which is in this row's subset; classifying
    // on OpenDaqException.ErrorCode rather than on message text is also exact
    // where that classifier can only guess.
    // The sentence openDAQ itself wrote for a failure, which OpenDaqException
    // does not put in Message.
    //
    // OpenDaqException(ErrorCode) chains to OpenDaqException(code, null, null),
    // and .NET fills base.Message for a null message with "Exception of type
    // 'Daq.Core.Types.OpenDaqException' was thrown."; the binding's ToString()
    // sees that non-empty base.Message and returns it instead of ever reaching
    // the ErrorInfo it read in that same constructor. So e.Message is
    // "OPENDAQ_ERR_INVALIDPARAMETER: Exception of type ... was thrown." and
    // carries nothing about the module. IErrorInfo::getMessage, surfaced as the
    // ErrorInfo.Message property, is where DAQ_MAKE_ERROR_INFO's text actually
    // is -- e.g. "Specified module path \"...\" does not exist" from
    // module_manager_impl.cpp tryLoadAndAddModule. It is read through the
    // exception rather than reconstructed, so the wire carries openDAQ's own
    // words and not this host's paraphrase of them.
    private static string OpenDaqOwnMessageOf(OpenDaqException e)
    {
        try
        {
            var fromErrorInfo = e.ErrorInfo?.Message;
            if (!string.IsNullOrWhiteSpace(fromErrorInfo))
                return fromErrorInfo;
        }
        catch (Exception)
        {
            // IErrorInfo was cleared or never set; e.Message is all there is.
        }
        return e.Message ?? "";
    }

    // The five module-manager error codes, which the .NET binding's ErrorCode
    // enumeration does not carry -- it stops at the coretypes codes, so
    // OpenDaqException.ErrorCode prints one of these as its bare number. They
    // are read off openDAQ's own header,
    // core/opendaq/modulemanager/include/opendaq/module_manager_errors.h, where
    // OPENDAQ_ERRTYPE_MODULE_MANAGER is 0x03 and
    // OPENDAQ_ERROR_CODE(TYPE_ID, CODE) is 0x80000000 | (TYPE_ID << 16) | CODE
    // (core/coretypes/include/coretypes/errors.h:25).
    private const uint ModuleManagerUnknown = 0x80030000u;          // OPENDAQ_ERR_MODULE_MANAGER_UNKNOWN
    private const uint ModuleLoadFailed = 0x80030001u;              // OPENDAQ_ERR_MODULE_LOAD_FAILED
    private const uint ModuleNoEntryPoint = 0x80030002u;            // OPENDAQ_ERR_MODULE_NO_ENTRY_POINT
    private const uint ModuleEntryPointFailed = 0x80030003u;        // OPENDAQ_ERR_MODULE_ENTRY_POINT_FAILED
    private const uint ModuleIncompatibleDependencies = 0x80030004u;// OPENDAQ_ERR_MODULE_INCOMPATIBLE_DEPENDENCIES

    private static WireErrorCode LoadModuleRefusalCodeFor(OpenDaqException e)
    {
        var text = OpenDaqOwnMessageOf(e);
        var nativeCode = (uint)e.ErrorCode;

        // "ModuleManager in not initialized. Call loadModules(IContext*)
        // first." -- there is no module manager to load into. That is the
        // condition the row's error subset calls not_connected, and it is the
        // same one list_loaded_modules reserves not_connected for.
        if (e.ErrorCode == Daq.Core.Types.ErrorCode.OPENDAQ_ERR_INVALIDSTATE)
            return WireErrorCode.NotConnected;

        // openDAQ reports a missing file as OPENDAQ_ERR_INVALIDPARAMETER with
        // "Specified module path \"...\" does not exist"; the contract splits
        // that case out of invalid_value and calls it not_found.
        if (text.Contains("does not exist", StringComparison.OrdinalIgnoreCase) ||
            e.ErrorCode == Daq.Core.Types.ErrorCode.OPENDAQ_ERR_NOTFOUND)
            return WireErrorCode.NotFound;

        // The module was opened and ITS OWN initialisation threw. contract
        // operations[load_module_from_host_path].errors spells that case
        // internal in as many words, and it is the one module-manager code that
        // is not a statement about host_path.
        if (nativeCode is ModuleEntryPointFailed or ModuleManagerUnknown)
            return WireErrorCode.Internal;

        // The remaining module-manager codes are the contract's invalid_value
        // list verbatim: "not a shared library" is MODULE_LOAD_FAILED, "no
        // module entry point" is MODULE_NO_ENTRY_POINT, and "wrong ABI" is
        // MODULE_INCOMPATIBLE_DEPENDENCIES.
        if (nativeCode is ModuleLoadFailed or ModuleNoEntryPoint or ModuleIncompatibleDependencies)
            return WireErrorCode.InvalidValue;

        // Everything else module_manager_impl.cpp refuses with is likewise a
        // refusal of THIS host_path rather than a fault of the host: the wrong
        // extension for the host's platform ("The openDAQ module file must have
        // an extention \"...\"" and an empty path, both INVALIDPARAMETER), a
        // path that is not a regular file (INVALIDPARAMETER), a module whose id
        // is already loaded from another path (ALREADYEXISTS), and a binary the
        // instance's ModuleAuthenticator rejects (ACCESSDENIED /
        // INVALID_OPERATION).
        if (e.ErrorCode is Daq.Core.Types.ErrorCode.OPENDAQ_ERR_INVALIDPARAMETER
                        or Daq.Core.Types.ErrorCode.OPENDAQ_ERR_ALREADYEXISTS
                        or Daq.Core.Types.ErrorCode.OPENDAQ_ERR_DUPLICATEITEM
                        or Daq.Core.Types.ErrorCode.OPENDAQ_ERR_ACCESSDENIED
                        or Daq.Core.Types.ErrorCode.OPENDAQ_ERR_INVALID_OPERATION)
            return WireErrorCode.InvalidValue;

        // A native failure module_manager_errors.h and module_manager_impl.cpp
        // between them do not name. The native code and text ride along in the
        // detail either way.
        return WireErrorCode.Internal;
    }

    // The native code as both openDAQ's own name for it (where the .NET
    // enumeration has one) and the hex the C++ headers spell it with, so a
    // refusal that falls outside Daq.Core.Types.ErrorCode is still legible.
    private static string NativeCodeTextOf(OpenDaqException e)
    {
        var nativeCode = (uint)e.ErrorCode;
        var name = Enum.IsDefined(typeof(Daq.Core.Types.ErrorCode), e.ErrorCode)
            ? e.ErrorCode.ToString()
            : nativeCode switch
            {
                ModuleManagerUnknown => "OPENDAQ_ERR_MODULE_MANAGER_UNKNOWN",
                ModuleLoadFailed => "OPENDAQ_ERR_MODULE_LOAD_FAILED",
                ModuleNoEntryPoint => "OPENDAQ_ERR_MODULE_NO_ENTRY_POINT",
                ModuleEntryPointFailed => "OPENDAQ_ERR_MODULE_ENTRY_POINT_FAILED",
                ModuleIncompatibleDependencies => "OPENDAQ_ERR_MODULE_INCOMPATIBLE_DEPENDENCIES",
                _ => "a code neither Daq.Core.Types.ErrorCode nor module_manager_errors.h names"
            };
        return $"{name} (0x{nativeCode:X8})";
    }

    // One IModule turned into the contract's ModuleInfo record: its identity,
    // its version and the four component-type dictionaries it offers. Both
    // module rows end here -- list_loaded_modules runs it over every module
    // IModuleManager::getModules answers with, and load_module_from_host_path
    // runs it over the single module IModuleManager::loadModule handed back --
    // so the record a client sees is built by the same reads either way.
    private static Service.ModuleInfo DescribeModule(Module module)
    {
        // quack-snippet capability=module.read,module.load uses=module-component-types,component-type-info step=2
        // IModule.moduleInfo is a property in the .NET binding, not a
        // getModuleInfo(): the C++ getter collapses into Module.ModuleInfo, and
        // IModuleInfo's id/name/versionInfo collapse the same way.
        var moduleInfo = module.ModuleInfo;
        var entry = new Service.ModuleInfo
        {
            Id = moduleInfo.Id,
            Name = moduleInfo.Name,
            Version = VersionTextOf(moduleInfo.VersionInfo)  // shared region below, step 3
        };
        // quack-snippet end

        AppendComponentTypesOf(module, entry.Id ?? "(a module that reports no id)", entry.ComponentTypes);
        return entry;
    }

    // "major.minor.patch", or null where the module carries no version info --
    // the reference prints "N/A" there and contract types.ModuleInfo.version is
    // nullable for the same reason.
    private static string VersionTextOf(Daq.Core.Types.VersionInfo versionInfo)
    {
        try
        {
            // quack-snippet capability=module.read,module.load step=3
            // IModuleInfo.versionInfo carries the three numbers as size_t, which
            // the .NET binding surfaces as UIntPtr properties Major/Minor/Patch.
            if (versionInfo is null)
                return null;
            return $"{(ulong)versionInfo.Major}.{(ulong)versionInfo.Minor}.{(ulong)versionInfo.Patch}";
            // quack-snippet end
        }
        catch (Exception)
        {
            return null;
        }
    }

    // The four type dictionaries a module offers, flattened into one array of
    // contract ComponentTypeInfo records. The reference reads exactly these four
    // in _draw_module_type_columns and casts each value to IComponentType for
    // id, name and description.
    private static void AppendComponentTypesOf(Module module, string moduleId, List<Service.ComponentTypeInfo> into)
    {
        var refusals = new List<string>();

        // quack-snippet shared=module-component-types uses=component-type-info
        // A module may answer OPENDAQ_ERR_NOTIMPLEMENTED for a dictionary it
        // does not offer -- the MockModule loaded from the manifest's
        // module_path does exactly that for availableStreamingTypes -- so the
        // four are read one at a time and a refusal costs only its own kind
        // instead of the whole module. gui_demo.py guards the same four reads
        // the same way, with _safe_get in _draw_module_type_columns.
        try
        {
            foreach (var pair in module.AvailableDeviceTypes)
                into.Add(DescribeComponentType(pair.Value, "device", pair.Value?.ConnectionStringPrefix));
        }
        catch (OpenDaqException e) { refusals.Add($"availableDeviceTypes -> {e.Message}"); }

        try
        {
            foreach (var pair in module.AvailableFunctionBlockTypes)
                into.Add(DescribeComponentType(pair.Value, "function_block", null));
        }
        catch (OpenDaqException e) { refusals.Add($"availableFunctionBlockTypes -> {e.Message}"); }

        try
        {
            foreach (var pair in module.AvailableServerTypes)
                into.Add(DescribeComponentType(pair.Value, "server", null));
        }
        catch (OpenDaqException e) { refusals.Add($"availableServerTypes -> {e.Message}"); }

        try
        {
            foreach (var pair in module.AvailableStreamingTypes)
                into.Add(DescribeComponentType(pair.Value, "streaming", pair.Value?.ConnectionStringPrefix));
        }
        catch (OpenDaqException e) { refusals.Add($"availableStreamingTypes -> {e.Message}"); }
        // quack-snippet end

        if (refusals.Count > 0)
            Console.WriteLine($"[opendaq] module {moduleId} refused {refusals.Count} of the 4 component type " +
                              $"dictionaries and contributes no ComponentTypeInfo for them: {string.Join("; ", refusals)}");
    }

    private static Service.ComponentTypeInfo DescribeComponentType(ComponentType componentType,
                                                                   string wireKind,
                                                                   string connectionStringPrefix)
    {
        var described = new Service.ComponentTypeInfo { Kind = wireKind };

        // quack-snippet shared=component-type-info
        // IDeviceType, IFunctionBlockType, IServerType and IStreamingType all
        // derive from IComponentType, which is where id, name and description
        // live. connectionStringPrefix is NOT on IComponentType: only IDeviceType
        // and IStreamingType declare it, which is why the caller passes it in and
        // why contract types.ComponentTypeInfo.connection_string_prefix is
        // nullable.
        described.Id = componentType.Id;
        described.Name = componentType.Name;
        var description = componentType.Description;
        // quack-snippet end

        described.Description = string.IsNullOrEmpty(description) ? null : description;
        described.ConnectionStringPrefix =
            string.IsNullOrEmpty(connectionStringPrefix) ? null : connectionStringPrefix;

        // contract types.ComponentTypeInfo.id and .name are presence: required,
        // so neither may be null on the wire. IModuleInfo.id already comes back
        // null from the MockModules loaded here, so a component type that says
        // as little is not hypothetical; "" is what a required string field
        // renders "openDAQ reported nothing" as.
        described.Id ??= "";
        described.Name ??= "";
        return described;
    }

    // Native openDAQ failure -> closed-set error. The .NET binding surfaces the
    // native error code only inside the message text, so this host classifies on
    // what the binding does expose and falls back to internal, never to a code
    // outside the closed set.
    private static WireErrorCode ClosedSetCodeFor(OpenDaqException e)
    {
        var text = e.Message ?? "";
        if (text.Contains("not found", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("NotFound", StringComparison.OrdinalIgnoreCase))
            return WireErrorCode.NotFound;
        if (text.Contains("read-only", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("readonly", StringComparison.OrdinalIgnoreCase))
            return WireErrorCode.ReadOnly;
        if (text.Contains("not supported", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("NotImplemented", StringComparison.OrdinalIgnoreCase))
            return WireErrorCode.Unsupported;
        if (text.Contains("timed out", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("timeout", StringComparison.OrdinalIgnoreCase))
            return WireErrorCode.Timeout;
        if (text.Contains("invalid", StringComparison.OrdinalIgnoreCase) ||
            text.Contains("out of range", StringComparison.OrdinalIgnoreCase))
            return WireErrorCode.InvalidValue;
        return WireErrorCode.Internal;
    }
}
