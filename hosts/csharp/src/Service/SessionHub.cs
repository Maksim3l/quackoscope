// Quackoscope host (C#) -- service layer.
//
// Per-socket session state, the method dispatch table, and the handshake. This
// layer speaks the wire DTOs to the transport and the backend contract to the
// openDAQ layer; it touches neither a socket nor an SDK type.
using System.Text.Json.Nodes;
using Quackoscope.Host.CSharp.Transport;

namespace Quackoscope.Host.CSharp.Service;

public sealed class SessionHub : IWebSocketSessionSink
{
    // The limits this host announces in every handshake. max_frame_bytes is what
    // caps pixel_columns: one column costs two float64 in the widest encoding.
    private const int MaxSubscriptionsPerSession = 64;
    private const int MaxFrameBytes = 262144;
    private const int MaxPixelColumns = (MaxFrameBytes - WireEnvelope.DataFrameHeaderBytes) / (2 * sizeof(double));

    private sealed class SignalSubscriptionRecord
    {
        public uint Id;
        public string SignalId = "";
        public uint PixelColumns;
    }

    private sealed class SessionState
    {
        // connection_string -> node id of the device this session connected.
        public readonly Dictionary<string, string> DeviceNodeIdsByConnectionString = new();

        // subscription id -> what this session subscribed it to.
        public readonly Dictionary<uint, SignalSubscriptionRecord> SubscriptionsById = new();
    }

    // One entry per wire method this host answers. The handshake reads its keys
    // and the dispatcher reads its values, so a method cannot be advertised
    // without a handler or handled without being advertised.
    private delegate JsonNode WireMethodHandler(WebSocketConnection connection, SessionState state, JsonObject parameters);

    private readonly IComponentTreeBackend backend;
    private readonly ManifestFile manifest;
    private readonly CapabilityBaselineArtifact baseline;
    private readonly Dictionary<string, WireMethodHandler> handlerByWireMethod;
    private readonly List<string> declaredCapabilityIds = new();
    private readonly object gate = new();
    private readonly Dictionary<WebSocketConnection, SessionState> sessions = new();
    private readonly Dictionary<string, int> sessionsHoldingDevice = new();
    private uint nextSubscriptionId = 1;

    public SessionHub(IComponentTreeBackend backend, ManifestFile manifest, CapabilityBaselineArtifact baseline)
    {
        this.backend = backend;
        this.manifest = manifest;
        this.baseline = baseline;

        handlerByWireMethod = new Dictionary<string, WireMethodHandler>
        {
            ["connect_device"] = (_, state, parameters) => ConnectDevice(state, parameters),
            ["disconnect_device"] = (_, state, parameters) => DisconnectDevice(state, parameters),
            ["get_component_tree"] = (_, state, parameters) => GetComponentTree(state, parameters),
            ["get_property_descriptors"] = (_, state, parameters) => GetPropertyDescriptors(state, parameters),
            ["get_property_value"] = (_, state, parameters) => GetPropertyValue(state, parameters),
            ["set_property_value"] = (_, state, parameters) => SetPropertyValue(state, parameters),
            ["subscribe_signal"] = SubscribeSignal,
            ["unsubscribe_signal"] = (_, state, parameters) => UnsubscribeSignal(state, parameters),
            ["get_device_operation_modes"] = (_, state, parameters) => GetDeviceOperationModes(state, parameters),
            ["set_device_operation_mode"] = (_, state, parameters) => SetDeviceOperationMode(state, parameters),
            ["lock_device"] = (_, state, parameters) => LockDevice(state, parameters),
            ["unlock_device"] = (_, state, parameters) => UnlockDevice(state, parameters),
            ["list_loaded_modules"] = (_, _, _) => ListLoadedModules(),
            ["load_module_from_host_path"] = (_, _, parameters) => LoadModuleFromHostPath(parameters)
        };

        VerifyEveryServedMethodIsInTheBaseline();
        DeriveDeclaredCapabilitiesFromTheBaseline();
        VerifyEveryComputedGapHasAReason();
    }

    // --- handshake ---------------------------------------------------------
    //
    // The gap list is the baseline capability set minus the capabilities this
    // host serves; the baseline itself is read from
    // generated/wire/capability-baseline.json and never retyped here. This host
    // declares only the reason per gap, per contract/contract.yaml
    // gap_generation.declared_by_host: reason_only.
    //
    // A capability is declared only when EVERY wire method the contract assigns
    // to it has a handler -- all-of, not any-of. contract/contract.yaml section
    // 4 defines a capability AS its operation list, and gaps are exactly
    // baseline-minus-declared, so a capability declared on half its operations
    // would leave the unwritten handler stated nowhere in the handshake:
    // neither in `capabilities` nor in `gaps`. hosts/cpp
    // (capabilitiesFullyServedBy in hosts/cpp/src/service/handshake.cpp) and
    // hosts/python (capabilities_fully_served_by in
    // hosts/python/service/handshake.py) apply the same rule, so the field means
    // one thing on every backend.

    // The reason this host has for each capability it does not fully serve --
    // the reason and nothing else. Every kind here is "host": "binding" is a
    // claim that openDAQ's .NET binding cannot do the thing, and it is only
    // made where the binding's surface was actually enumerated and the API was
    // genuinely absent. Where the surface WAS enumerated and the members are
    // there, the reason says so and names the members and how they were found.
    private static readonly Dictionary<string, (string Kind, string Reason)> GapKindAndReasonByCapabilityId = new()
    {
        ["device.scan"] = ("host",
            "scan_available_devices has no handler in quackoscope-host-csharp; currently not available. This is " +
            "unwritten host code and not a binding limit, and the binding surface was enumerated to say so: " +
            "System.Reflection over openDAQ.Net, Version=3.41.0.0 (openDAQ.Net.dll from the install tree the " +
            "csproj references) lists, on Daq.Core.OpenDAQ.Device, the declared instance property " +
            "\"IListObject`1 AvailableDevices { get; }\" with its accessor get_AvailableDevices(), alongside " +
            "AvailableDeviceTypes and Info, which is everything scan_available_devices needs to fill the " +
            "contract's DeviceInfo record"),
        ["function_block.add"] = ("host",
            "list_function_block_types, add_function_block and remove_function_block have no handler in " +
            "quackoscope-host-csharp; currently not available. This is unwritten host code and not a binding " +
            "limit, and the binding surface was enumerated to say so: System.Reflection over openDAQ.Net, " +
            "Version=3.41.0.0 lists, declared on Daq.Core.OpenDAQ.Device, \"IDictObject`2 " +
            "AvailableFunctionBlockTypes { get; }\", \"FunctionBlock AddFunctionBlock(String typeId, " +
            "PropertyObject config)\" and \"Void RemoveFunctionBlock(FunctionBlock functionBlock)\" -- one member " +
            "per operation"),
        ["streaming.raw"] = ("host",
            "read_samples_raw has no handler in quackoscope-host-csharp; currently not available. " +
            "The StreamReader plumbing it needs is " +
            "now written and serving streaming.decimated; what is missing is the request-scoped read path, because " +
            "read_samples_raw returns one binary frame per request rather than a standing subscription")
    };

    private void VerifyEveryServedMethodIsInTheBaseline()
    {
        foreach (var method in handlerByWireMethod.Keys)
            if (!baseline.WireMethodNames.Contains(method))
                throw new InvalidOperationException(
                    $"quackoscope-host-csharp dispatches wire method \"{method}\", which is not one of the " +
                    $"{baseline.WireMethodNames.Count} in {baseline.ReadFromPath}: " +
                    string.Join(", ", baseline.WireMethodNames));
    }

    private void DeriveDeclaredCapabilitiesFromTheBaseline()
    {
        foreach (var capabilityId in baseline.CapabilityIds)
        {
            var owned = baseline.WireMethodsOwnedBy(capabilityId);
            if (owned.All(handlerByWireMethod.ContainsKey))
                declaredCapabilityIds.Add(capabilityId);
        }
    }

    private void VerifyEveryComputedGapHasAReason()
    {
        foreach (var capabilityId in baseline.CapabilityIds)
        {
            if (declaredCapabilityIds.Contains(capabilityId))
                continue;
            if (!GapKindAndReasonByCapabilityId.TryGetValue(capabilityId, out var gap) || gap.Reason.Length == 0)
                throw new InvalidOperationException(
                    $"capability \"{capabilityId}\" of {baseline.ReadFromPath} is not fully served by " +
                    $"quackoscope-host-csharp (it owns {string.Join(", ", baseline.WireMethodsOwnedBy(capabilityId))}, " +
                    $"and this host serves {string.Join(", ", handlerByWireMethod.Keys.Order())}), and it has no " +
                    "reason in GapKindAndReasonByCapabilityId of hosts/csharp/src/Service/SessionHub.cs; contract " +
                    "types.Gap.reason has min_length 1, so a gap without a reason cannot be declared");
            if (!baseline.GapKindMeanings.ContainsKey(gap.Kind))
                throw new InvalidOperationException(
                    $"capability \"{capabilityId}\" declares gap kind \"{gap.Kind}\" in " +
                    $"hosts/csharp/src/Service/SessionHub.cs; {baseline.ReadFromPath} declares the kinds " +
                    $"[{string.Join(", ", baseline.GapKindMeanings.Keys)}] and nothing else");
        }

        foreach (var capabilityId in GapKindAndReasonByCapabilityId.Keys)
            if (!baseline.CapabilityIds.Contains(capabilityId))
                throw new InvalidOperationException(
                    $"hosts/csharp/src/Service/SessionHub.cs holds a gap reason for capability \"{capabilityId}\", " +
                    $"which is not one of the {baseline.CapabilityIds.Count} in {baseline.ReadFromPath}: " +
                    string.Join(", ", baseline.CapabilityIds));
    }

    /// Says, at startup, exactly which capabilities this host will declare and
    /// which wire methods each of them was derived from.
    public void PrintTheCapabilitySetItDerived()
    {
        Console.WriteLine($"[service] wire methods with a handler in quackoscope-host-csharp " +
                          $"({handlerByWireMethod.Count} of the {baseline.WireMethodNames.Count} in " +
                          $"{baseline.ReadFromPath}): {string.Join(", ", handlerByWireMethod.Keys.Order())}");
        foreach (var capabilityId in baseline.CapabilityIds)
        {
            var owned = baseline.WireMethodsOwnedBy(capabilityId);
            var missing = owned.Where(method => !handlerByWireMethod.ContainsKey(method)).ToArray();
            Console.WriteLine(missing.Length == 0
                ? $"[service] capability {capabilityId}: DECLARED, every wire method it owns has a handler ({string.Join(", ", owned)})"
                : $"[service] capability {capabilityId}: GAP, it owns {string.Join(", ", owned)} and " +
                  $"{string.Join(", ", missing)} {(missing.Length == 1 ? "has" : "have")} no handler; kind " +
                  $"{GapKindAndReasonByCapabilityId[capabilityId].Kind}: {GapKindAndReasonByCapabilityId[capabilityId].Reason}");
        }
    }

    public JsonNode BuildHandshakeFor(WebSocketConnection connection)
    {
        var capabilities = new JsonArray();
        foreach (var id in declaredCapabilityIds)
            capabilities.Add(id);

        var gaps = new JsonArray();
        foreach (var id in baseline.CapabilityIds)
        {
            if (declaredCapabilityIds.Contains(id))
                continue;
            var (kind, reason) = GapKindAndReasonByCapabilityId[id];
            gaps.Add(new JsonObject { ["capability"] = id, ["kind"] = kind, ["reason"] = reason });
        }

        Console.WriteLine($"[service] handshake to {connection.RemoteEndpointText}: protocol_version 1.0, " +
                          $"implementation quackoscope-host-csharp 0.1.0, sdk {manifest.SdkVersion} @ {manifest.Commit}, " +
                          $"capabilities [{string.Join(", ", declaredCapabilityIds)}], " +
                          $"{gaps.Count} gap(s), max_subscriptions {MaxSubscriptionsPerSession}, " +
                          $"max_frame_bytes {MaxFrameBytes}, which caps pixel_columns at {MaxPixelColumns} " +
                          "(17 header bytes + 2 float64 per column)");

        return new JsonObject
        {
            ["protocol_version"] = "1.0",
            ["implementation"] = new JsonObject
            {
                ["name"] = "quackoscope-host-csharp",
                ["version"] = "0.1.0"
            },
            ["sdk"] = new JsonObject
            {
                ["version"] = manifest.SdkVersion,
                ["commit"] = manifest.Commit
            },
            ["capabilities"] = capabilities,
            ["gaps"] = gaps,
            ["limits"] = new JsonObject
            {
                ["max_subscriptions"] = MaxSubscriptionsPerSession,
                ["max_frame_bytes"] = MaxFrameBytes
            }
        };
    }

    // --- session bookkeeping ------------------------------------------------

    public void OnSessionOpened(WebSocketConnection connection)
    {
        int live;
        lock (gate)
        {
            sessions[connection] = new SessionState();
            live = sessions.Count;
        }
        Console.WriteLine($"[service] session opened from {connection.RemoteEndpointText} ({live} live)");
    }

    public void OnSessionClosed(WebSocketConnection connection)
    {
        var devicesToRelease = new List<(string ConnectionString, string NodeId)>();
        SignalSubscriptionRecord[] subscriptionsToStop;
        int live;
        int heldByThisSession;

        lock (gate)
        {
            if (!sessions.TryGetValue(connection, out var state))
                return;
            sessions.Remove(connection);
            live = sessions.Count;
            heldByThisSession = state.DeviceNodeIdsByConnectionString.Count;
            subscriptionsToStop = state.SubscriptionsById.Values.ToArray();
            state.SubscriptionsById.Clear();

            foreach (var (connectionString, nodeId) in state.DeviceNodeIdsByConnectionString)
            {
                if (!sessionsHoldingDevice.TryGetValue(connectionString, out var holders))
                    continue;
                if (--holders <= 0)
                {
                    sessionsHoldingDevice.Remove(connectionString);
                    devicesToRelease.Add((connectionString, nodeId));
                }
                else
                {
                    sessionsHoldingDevice[connectionString] = holders;
                }
            }
        }

        // Subscriptions go first: a StreamReader still attached to a signal of a
        // device that is about to be removed would outlive its own signal.
        foreach (var subscription in subscriptionsToStop)
        {
            try
            {
                backend.UnsubscribeSignal(subscription.Id);
                Console.WriteLine($"[service] stopped subscription {subscription.Id} on signal {subscription.SignalId} " +
                                  $"({subscription.PixelColumns} pixel columns) because its session closed");
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"[service] stopping subscription {subscription.Id} on signal " +
                                        $"{subscription.SignalId} failed: {e.GetType().Name}: {e.Message}");
            }
        }

        foreach (var (connectionString, nodeId) in devicesToRelease)
        {
            try
            {
                backend.DisconnectDevice(nodeId);
                Console.WriteLine($"[service] released device {nodeId} ({connectionString}); no live session holds it any more");
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"[service] releasing device {nodeId} ({connectionString}) failed: {e.Message}");
            }
        }

        Console.WriteLine($"[service] session from {connection.RemoteEndpointText} closed: {subscriptionsToStop.Length} subscription(s) " +
                          $"stopped, {heldByThisSession} device(s) dropped, " +
                          $"{devicesToRelease.Count} of those removed from the instance, {live} session(s) still live");
    }

    // --- dispatch -----------------------------------------------------------

    public RequestOutcome OnRequest(WebSocketConnection connection, string method, JsonObject parameters)
    {
        try
        {
            return new RequestOutcome { Ok = true, Result = Dispatch(connection, method, parameters) };
        }
        catch (WireError e)
        {
            Console.WriteLine($"[service] {method} -> {WireErrorCodeText.OnTheWire(e.Code)}: {e.Message}");
            return new RequestOutcome { Ok = false, Code = WireErrorCodeText.OnTheWire(e.Code), Detail = e.Message };
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"[service] {method} -> internal: {e.GetType().Name}: {e.Message}");
            return new RequestOutcome { Ok = false, Code = "internal", Detail = $"{e.GetType().Name}: {e.Message}" };
        }
    }

    private JsonNode Dispatch(WebSocketConnection connection, string method, JsonObject parameters)
    {
        var state = LookUpSession(connection);
        if (handlerByWireMethod.TryGetValue(method, out var handler))
            return handler(connection, state, parameters);
        throw new WireError(WireErrorCode.Unsupported,
            $"unknown method \"{method}\"; quackoscope-host-csharp serves " +
            string.Join(", ", handlerByWireMethod.Keys.Order()));
    }

    private SessionState LookUpSession(WebSocketConnection connection)
    {
        lock (gate)
        {
            if (sessions.TryGetValue(connection, out var state))
                return state;
        }
        throw new WireError(WireErrorCode.NotConnected, "this WebSocket session is already closed");
    }

    private static string RequireString(JsonObject parameters, string key)
    {
        if (!parameters.TryGetPropertyValue(key, out var node) ||
            node is not JsonValue value ||
            !value.TryGetValue(out string text))
            throw new WireError(WireErrorCode.InvalidValue, $"params.{key} must be a string");
        return text;
    }

    private void RequireDeviceInSession(SessionState state)
    {
        lock (gate)
        {
            if (state.DeviceNodeIdsByConnectionString.Count == 0)
                throw new WireError(WireErrorCode.NotConnected,
                    "this session has connected no device; call connect_device first " +
                    "(a device another session connected is not visible here)");
        }
    }

    private string RequireNodeReachableFromSession(SessionState state, JsonObject parameters, string key)
    {
        var nodeId = RequireString(parameters, key);
        lock (gate)
        {
            foreach (var deviceNodeId in state.DeviceNodeIdsByConnectionString.Values)
                if (nodeId == deviceNodeId || nodeId.StartsWith(deviceNodeId + "/", StringComparison.Ordinal))
                    return nodeId;

            if (state.DeviceNodeIdsByConnectionString.Count == 0)
                throw new WireError(WireErrorCode.NotConnected,
                    $"this session has connected no device, so \"{nodeId}\" is not addressable; call connect_device first");

            var reachable = string.Join(", ", state.DeviceNodeIdsByConnectionString.Values);
            throw new WireError(WireErrorCode.NotFound,
                $"no component with id \"{nodeId}\" in this session; it holds {reachable}");
        }
    }

    private static uint RequireIntInRange(JsonObject parameters, string key, uint lowest, uint highest)
    {
        if (!parameters.TryGetPropertyValue(key, out var node) ||
            node is not JsonValue value ||
            !value.TryGetValue(out long given))
            throw new WireError(WireErrorCode.InvalidValue, $"params.{key} must be an integer");

        if (given < lowest || given > highest)
            throw new WireError(WireErrorCode.InvalidValue,
                $"params.{key} is {given}, outside the {lowest}..{highest} this host accepts");

        return (uint)given;
    }

    // --- the eight operations of the original contract table ----------------

    private JsonNode ConnectDevice(SessionState state, JsonObject parameters)
    {
        var connectionString = RequireString(parameters, "connection_string");
        if (connectionString.Length == 0)
            throw new WireError(WireErrorCode.InvalidValue,
                "params.connection_string is empty; it must name a device, e.g. \"daqref://device0\"");

        var node = backend.ConnectDevice(connectionString);

        lock (gate)
        {
            if (state.DeviceNodeIdsByConnectionString.TryAdd(connectionString, node.Id))
                sessionsHoldingDevice[connectionString] =
                    sessionsHoldingDevice.TryGetValue(connectionString, out var holders) ? holders + 1 : 1;
        }

        return node.ToWireJson();
    }

    private JsonNode DisconnectDevice(SessionState state, JsonObject parameters)
    {
        var nodeId = RequireString(parameters, "node_id");

        string connectionString = null;
        var thisSessionWasTheLastHolder = false;
        var holdersLeft = 0;

        lock (gate)
        {
            foreach (var (heldConnectionString, heldNodeId) in state.DeviceNodeIdsByConnectionString)
                if (heldNodeId == nodeId)
                {
                    connectionString = heldConnectionString;
                    break;
                }

            if (connectionString is null)
            {
                var holdsInstead = state.DeviceNodeIdsByConnectionString.Count == 0
                    ? "no device at all"
                    : string.Join(", ", state.DeviceNodeIdsByConnectionString.Values);
                throw new WireError(WireErrorCode.NotFound,
                    $"this session did not connect a device with id \"{nodeId}\"; it holds {holdsInstead}");
            }

            state.DeviceNodeIdsByConnectionString.Remove(connectionString);

            if (sessionsHoldingDevice.TryGetValue(connectionString, out var holders))
            {
                holdersLeft = holders - 1;
                if (holdersLeft <= 0)
                {
                    sessionsHoldingDevice.Remove(connectionString);
                    thisSessionWasTheLastHolder = true;
                }
                else
                {
                    sessionsHoldingDevice[connectionString] = holdersLeft;
                }
            }
            else
            {
                thisSessionWasTheLastHolder = true;
            }
        }

        if (!thisSessionWasTheLastHolder)
        {
            // The device stays in the openDAQ Instance for the sessions that
            // still hold it; it simply stops being addressable from this one.
            Console.WriteLine($"[service] disconnect_device {nodeId} ({connectionString}): dropped from this session, " +
                              $"kept in the openDAQ Instance because {holdersLeft} other session(s) still hold it");
            return null;
        }

        backend.DisconnectDevice(nodeId);
        Console.WriteLine($"[service] disconnect_device {nodeId} ({connectionString}): dropped from this session, " +
                          "which was the last holder, so it was removed from the openDAQ Instance too");
        return null;
    }

    private JsonNode GetComponentTree(SessionState state, JsonObject parameters)
    {
        RequireDeviceInSession(state);

        var roots = new List<string>();
        if (parameters.TryGetPropertyValue("root_id", out var rootNode) &&
            rootNode is JsonValue rootValue && rootValue.TryGetValue(out string _))
        {
            roots.Add(RequireNodeReachableFromSession(state, parameters, "root_id"));
        }
        else
        {
            lock (gate)
                roots.AddRange(state.DeviceNodeIdsByConnectionString.Values);
        }

        var out_ = new JsonArray();
        foreach (var root in roots)
            foreach (var node in backend.GetComponentTree(root))
                out_.Add(node.ToWireJson());
        return out_;
    }

    private JsonNode GetPropertyDescriptors(SessionState state, JsonObject parameters)
    {
        RequireDeviceInSession(state);
        var out_ = new JsonArray();
        foreach (var descriptor in backend.GetPropertyDescriptors(RequireNodeReachableFromSession(state, parameters, "node_id")))
            out_.Add(descriptor.ToWireJson());
        return out_;
    }

    private JsonNode GetPropertyValue(SessionState state, JsonObject parameters)
    {
        RequireDeviceInSession(state);
        return backend.GetPropertyValue(RequireNodeReachableFromSession(state, parameters, "node_id"),
                                        RequireString(parameters, "property_id"));
    }

    private JsonNode SetPropertyValue(SessionState state, JsonObject parameters)
    {
        RequireDeviceInSession(state);
        if (!parameters.TryGetPropertyValue("value", out var value))
            throw new WireError(WireErrorCode.InvalidValue, "params.value is required");

        backend.SetPropertyValue(RequireNodeReachableFromSession(state, parameters, "node_id"),
                                 RequireString(parameters, "property_id"),
                                 value);
        return null;
    }

    private JsonNode SubscribeSignal(WebSocketConnection connection, SessionState state, JsonObject parameters)
    {
        RequireDeviceInSession(state);

        var signalId = RequireNodeReachableFromSession(state, parameters, "signal_id");
        // pixel_columns is capped by the max_frame_bytes this session's handshake
        // announced, so no frame this host emits can exceed it.
        var pixelColumns = RequireIntInRange(parameters, "pixel_columns", 1, MaxPixelColumns);

        uint subscriptionId;
        lock (gate)
        {
            if (state.SubscriptionsById.Count >= MaxSubscriptionsPerSession)
                throw new WireError(WireErrorCode.InvalidValue,
                    $"this session already holds {state.SubscriptionsById.Count} subscriptions, which is the " +
                    $"max_subscriptions this session's handshake announced ({MaxSubscriptionsPerSession}); " +
                    $"unsubscribe_signal one before subscribing to \"{signalId}\"");
            subscriptionId = nextSubscriptionId++;
        }

        backend.SubscribeSignal(signalId, subscriptionId,
            (id, domainStart, values, count) => EmitDataFrame(connection, id, pixelColumns, domainStart, values, count));

        lock (gate)
            state.SubscriptionsById[subscriptionId] =
                new SignalSubscriptionRecord { Id = subscriptionId, SignalId = signalId, PixelColumns = pixelColumns };

        Console.WriteLine($"[service] subscribe_signal {signalId} at {pixelColumns} pixel columns -> subscription {subscriptionId}");

        // The subscription_id on the wire is the decimal text of the uint32 that
        // rides in the binary frame header.
        return JsonValue.Create(subscriptionId.ToString());
    }

    private JsonNode UnsubscribeSignal(SessionState state, JsonObject parameters)
    {
        var text = RequireString(parameters, "subscription_id");

        if (!uint.TryParse(text, System.Globalization.NumberStyles.None,
                           System.Globalization.CultureInfo.InvariantCulture, out var subscriptionId))
            throw new WireError(WireErrorCode.InvalidValue,
                "params.subscription_id must be the decimal text of a uint32, whole and with nothing else in it; " +
                $"got \"{text}\"");

        string signalId;
        lock (gate)
        {
            if (!state.SubscriptionsById.TryGetValue(subscriptionId, out var record))
                throw new WireError(WireErrorCode.NotFound, $"no subscription \"{text}\" on this session");
            signalId = record.SignalId;
            state.SubscriptionsById.Remove(subscriptionId);
        }

        backend.UnsubscribeSignal(subscriptionId);
        Console.WriteLine($"[service] unsubscribe_signal {subscriptionId} on signal {signalId}: stopped");
        return null;
    }

    // --- the four device rows and the two module rows ------------------------

    // The node_id reader the four device rows use.
    //
    // contract operations[set_device_operation_mode|lock_device|unlock_device]
    // .errors carry NEITHER not_connected NOR invalid_value, and
    // operations[get_device_operation_modes].errors carries no invalid_value, so
    // an unaddressable node_id may not be reported with either of those codes on
    // these rows. not_found is inside all four subsets and it is also the true
    // statement: the component named is not one this session can reach. The
    // detail says which ids it can.
    private string RequireDeviceNodeIdAddressableOrNotFound(SessionState state, JsonObject parameters)
    {
        string nodeId = null;
        if (parameters.TryGetPropertyValue("node_id", out var node) &&
            node is JsonValue value && value.TryGetValue(out string text))
            nodeId = text;

        if (string.IsNullOrEmpty(nodeId))
            throw new WireError(WireErrorCode.NotFound,
                "params.node_id is absent, empty or not a string, so no component was named; these operations take " +
                "the node id of a device exactly as connect_device answered it");

        lock (gate)
        {
            foreach (var deviceNodeId in state.DeviceNodeIdsByConnectionString.Values)
                if (nodeId == deviceNodeId || nodeId.StartsWith(deviceNodeId + "/", StringComparison.Ordinal))
                    return nodeId;

            var reachable = state.DeviceNodeIdsByConnectionString.Count == 0
                ? "no device at all, because this session has connected none; call connect_device first"
                : string.Join(", ", state.DeviceNodeIdsByConnectionString.Values);
            throw new WireError(WireErrorCode.NotFound,
                $"no component with id \"{nodeId}\" in this session; it holds {reachable}");
        }
    }

    private JsonNode GetDeviceOperationModes(SessionState state, JsonObject parameters)
    {
        var nodeId = RequireDeviceNodeIdAddressableOrNotFound(state, parameters);
        var modes = new JsonArray();
        foreach (var mode in backend.GetDeviceOperationModes(nodeId))
            modes.Add(mode);
        return modes;
    }

    private JsonNode SetDeviceOperationMode(SessionState state, JsonObject parameters)
    {
        var nodeId = RequireDeviceNodeIdAddressableOrNotFound(state, parameters);

        if (!parameters.TryGetPropertyValue("mode", out var modeNode) ||
            modeNode is not JsonValue modeValue ||
            !modeValue.TryGetValue(out string mode))
            throw new WireError(WireErrorCode.InvalidValue,
                "params.mode must be a string naming one of the operation modes " +
                "get_device_operation_modes answered with for this node");

        backend.SetDeviceOperationMode(nodeId, mode);
        return null;
    }

    private JsonNode LockDevice(SessionState state, JsonObject parameters)
    {
        backend.LockDevice(RequireDeviceNodeIdAddressableOrNotFound(state, parameters));
        return null;
    }

    private JsonNode UnlockDevice(SessionState state, JsonObject parameters)
    {
        var nodeId = RequireDeviceNodeIdAddressableOrNotFound(state, parameters);

        // force is presence: optional. Absent means false; anything present that
        // is not a JSON boolean is a malformed request, and unlock_device's error
        // subset has no invalid_value, so it is refused as unsupported -- the
        // code the same row already reserves for a force this host cannot do.
        var force = false;
        if (parameters.TryGetPropertyValue("force", out var forceNode) && forceNode is not null)
        {
            if (forceNode is not JsonValue forceValue || !forceValue.TryGetValue(out force))
                throw new WireError(WireErrorCode.Unsupported,
                    $"params.force is {forceNode.ToJsonString()}; contract operations[unlock_device].params.force " +
                    "is an optional bool, so it must be true, false or absent");
        }

        backend.UnlockDevice(nodeId, force);
        return null;
    }

    // list_loaded_modules is not scoped to a connected device: the modules are
    // the ones the openDAQ Instance loaded from the manifest's module_path at
    // startup, and they are the same whether or not this session has connected
    // anything. contract operations[list_loaded_modules].errors carries
    // not_connected, which this host uses for the one case that is true -- the
    // WebSocket session is already gone, which Dispatch checks before any
    // handler runs.
    private JsonNode ListLoadedModules()
    {
        var modules = new JsonArray();
        foreach (var module in backend.ListLoadedModules())
            modules.Add(module.ToWireJson());
        return modules;
    }

    // load_module_from_host_path is not scoped to a connected device either: it
    // acts on the same openDAQ ModuleManager list_loaded_modules reads, and it
    // reads a path on THIS host's filesystem -- the contract's design (a), the
    // one openDAQ's own API allows, since IModuleManager declares
    // loadModule(IString* path, IModule** module) and no bytes-in sibling.
    //
    // contract operations[load_module_from_host_path].errors is
    // [not_found, not_connected, invalid_value, internal]: no unsupported, no
    // read_only, no timeout. So a params.host_path that is absent, not a string
    // or empty is invalid_value and nothing else. not_connected is the one case
    // Dispatch already covers before any handler runs -- the WebSocket session
    // is gone -- plus openDAQ's own "ModuleManager in not initialized".
    private JsonNode LoadModuleFromHostPath(JsonObject parameters)
    {
        if (!parameters.TryGetPropertyValue("host_path", out var node) ||
            node is not JsonValue value ||
            !value.TryGetValue(out string hostPath))
            throw new WireError(WireErrorCode.InvalidValue,
                "params.host_path must be a string holding an absolute path on the HOST's filesystem, the machine " +
                "quackoscope-host-csharp runs on. openDAQ's IModuleManager::loadModule takes a path and no byte " +
                "buffer, so this row loads a file this host process opens itself; a path picked on the machine " +
                $"running the client is not one it can open. Got {(node is null ? "no host_path at all" : node.ToJsonString())}");

        if (hostPath.Length == 0)
            throw new WireError(WireErrorCode.InvalidValue,
                "params.host_path is the empty string; it must name a module file on the host's filesystem, " +
                "for example an absolute path ending in the module extension this host's platform uses");

        return backend.LoadModuleFromHostPath(hostPath).ToWireJson();
    }

    // --- data plane ---------------------------------------------------------

    private static void EmitDataFrame(WebSocketConnection connection,
                                      uint subscriptionId,
                                      uint pixelColumns,
                                      ulong domainStart,
                                      double[] values,
                                      int count)
    {
        var chunk = SignalDecimator.DecimateToPixelColumns(values, count, pixelColumns);
        if (chunk.SampleCount == 0)
            return;

        connection.SendBinary(WireEnvelope.EncodeDataFrame(subscriptionId,
                                                           domainStart,
                                                           chunk.SampleCount,
                                                           chunk.Encoding,
                                                           chunk.Payload));
    }
}
