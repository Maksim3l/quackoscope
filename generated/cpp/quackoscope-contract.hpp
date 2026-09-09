// GENERATED FILE. Do not edit by hand.
//
// Produced by tools/contract-compiler from contract/contract.yaml, which is
// the single source of truth for the Quackoscope wire contract. Regenerate
// with:
//
//   python tools/contract-compiler/compile_contract_to_generated_targets.py
//

#pragma once

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace quackoscope::contract
{

/// The contract's `any`: an arbitrary JSON value.
using AnyValue = ::nlohmann::json;

inline constexpr std::string_view PROTOCOL_VERSION = "1.0";

/// The closed error code set of contract 1.2. A native exception maps
/// into one of these; the native message rides along in WireError::detail.
enum class WireErrorCode
{
    notFound,  // wire: "not_found"
    notConnected,  // wire: "not_connected"
    invalidValue,  // wire: "invalid_value"
    readOnly,  // wire: "read_only"
    unsupported,  // wire: "unsupported"
    timeout,  // wire: "timeout"
    internal,  // wire: "internal"
};

inline constexpr std::string_view wireName(WireErrorCode code)
{
    switch (code)
    {
        case WireErrorCode::notFound: return "not_found";
        case WireErrorCode::notConnected: return "not_connected";
        case WireErrorCode::invalidValue: return "invalid_value";
        case WireErrorCode::readOnly: return "read_only";
        case WireErrorCode::unsupported: return "unsupported";
        case WireErrorCode::timeout: return "timeout";
        case WireErrorCode::internal: return "internal";
    }
    return "internal";
}

struct WireError
{
    WireErrorCode code;
    /// Display and logs only. Never parsed by any client.
    std::string detail;
};

/// Thrown by a handler method to produce an error envelope. Any other
/// exception escaping a handler becomes WireErrorCode::internal.
class WireCallFailed : public std::runtime_error
{
public:
    WireCallFailed(WireErrorCode code, std::string detail)
        : std::runtime_error(detail)
        , error{code, std::move(detail)}
    {
    }

    WireError error;
};

/// contract 1.3 types.Node.kind
enum class NodeKind
{
    device,  // wire: "device"
    channel,  // wire: "channel"
    functionBlock,  // wire: "function_block"
    signal,  // wire: "signal"
    folder,  // wire: "folder"
    server,  // wire: "server"
};

inline constexpr std::string_view wireName(NodeKind value)
{
    switch (value)
    {
        case NodeKind::device: return "device";
        case NodeKind::channel: return "channel";
        case NodeKind::functionBlock: return "function_block";
        case NodeKind::signal: return "signal";
        case NodeKind::folder: return "folder";
        case NodeKind::server: return "server";
    }
    return "";
}

/// contract 1.3 types.Node.component_status
enum class NodeComponentStatus
{
    ok,  // wire: "ok"
    warning,  // wire: "warning"
    error,  // wire: "error"
};

inline constexpr std::string_view wireName(NodeComponentStatus value)
{
    switch (value)
    {
        case NodeComponentStatus::ok: return "ok";
        case NodeComponentStatus::warning: return "warning";
        case NodeComponentStatus::error: return "error";
    }
    return "";
}

/// contract 1.3 types.Node.connection_status
enum class NodeConnectionStatus
{
    connected,  // wire: "connected"
    reconnecting,  // wire: "reconnecting"
    unrecoverable,  // wire: "unrecoverable"
    removed,  // wire: "removed"
};

inline constexpr std::string_view wireName(NodeConnectionStatus value)
{
    switch (value)
    {
        case NodeConnectionStatus::connected: return "connected";
        case NodeConnectionStatus::reconnecting: return "reconnecting";
        case NodeConnectionStatus::unrecoverable: return "unrecoverable";
        case NodeConnectionStatus::removed: return "removed";
    }
    return "";
}

/// contract 1.3 types.Node.operation_mode
enum class NodeOperationMode
{
    unknown,  // wire: "unknown"
    idle,  // wire: "idle"
    operation,  // wire: "operation"
    safeOperation,  // wire: "safe_operation"
};

inline constexpr std::string_view wireName(NodeOperationMode value)
{
    switch (value)
    {
        case NodeOperationMode::unknown: return "unknown";
        case NodeOperationMode::idle: return "idle";
        case NodeOperationMode::operation: return "operation";
        case NodeOperationMode::safeOperation: return "safe_operation";
    }
    return "";
}

/// contract 1.3 types.PropertyDescriptor.value_type
enum class PropertyDescriptorValueType
{
    bool_,  // wire: "bool"
    int_,  // wire: "int"
    float_,  // wire: "float"
    string,  // wire: "string"
    selection,  // wire: "selection"
    struct_,  // wire: "struct"
};

inline constexpr std::string_view wireName(PropertyDescriptorValueType value)
{
    switch (value)
    {
        case PropertyDescriptorValueType::bool_: return "bool";
        case PropertyDescriptorValueType::int_: return "int";
        case PropertyDescriptorValueType::float_: return "float";
        case PropertyDescriptorValueType::string: return "string";
        case PropertyDescriptorValueType::selection: return "selection";
        case PropertyDescriptorValueType::struct_: return "struct";
    }
    return "";
}

/// contract 1.3 types.ComponentAttribute.value_type
enum class ComponentAttributeValueType
{
    bool_,  // wire: "bool"
    int_,  // wire: "int"
    float_,  // wire: "float"
    string,  // wire: "string"
    stringList,  // wire: "string_list"
};

inline constexpr std::string_view wireName(ComponentAttributeValueType value)
{
    switch (value)
    {
        case ComponentAttributeValueType::bool_: return "bool";
        case ComponentAttributeValueType::int_: return "int";
        case ComponentAttributeValueType::float_: return "float";
        case ComponentAttributeValueType::string: return "string";
        case ComponentAttributeValueType::stringList: return "string_list";
    }
    return "";
}

/// contract 1.3 types.SignalDescriptor.sample_type
enum class SignalDescriptorSampleType
{
    float32,  // wire: "float32"
    float64,  // wire: "float64"
    int32,  // wire: "int32"
    int64,  // wire: "int64"
};

inline constexpr std::string_view wireName(SignalDescriptorSampleType value)
{
    switch (value)
    {
        case SignalDescriptorSampleType::float32: return "float32";
        case SignalDescriptorSampleType::float64: return "float64";
        case SignalDescriptorSampleType::int32: return "int32";
        case SignalDescriptorSampleType::int64: return "int64";
    }
    return "";
}

/// contract 1.3 types.Gap.kind
enum class GapKind
{
    binding,  // wire: "binding"
    host,  // wire: "host"
};

inline constexpr std::string_view wireName(GapKind value)
{
    switch (value)
    {
        case GapKind::binding: return "binding";
        case GapKind::host: return "host";
    }
    return "";
}

/// contract 1.3 types.ComponentTypeInfo.kind
enum class ComponentTypeInfoKind
{
    device,  // wire: "device"
    functionBlock,  // wire: "function_block"
    server,  // wire: "server"
    streaming,  // wire: "streaming"
};

inline constexpr std::string_view wireName(ComponentTypeInfoKind value)
{
    switch (value)
    {
        case ComponentTypeInfoKind::device: return "device";
        case ComponentTypeInfoKind::functionBlock: return "function_block";
        case ComponentTypeInfoKind::server: return "server";
        case ComponentTypeInfoKind::streaming: return "streaming";
    }
    return "";
}

/// contract 1.3 types.DeviceInfo
struct DeviceInfo
{
    std::string connectionString;  // wire key "connection_string", presence required
    std::string name;  // wire key "name", presence required
    std::optional<std::string> serial;  // wire key "serial", presence nullable
};

/// contract 1.3 types.Node
struct Node
{
    std::string id_;  // wire key "id", presence required
    std::string name;  // wire key "name", presence required
    NodeKind kind;  // wire key "kind", presence required
    std::optional<std::string> parentId;  // wire key "parent_id", presence nullable
    std::vector<std::string> childIds;  // wire key "child_ids", presence required
    std::vector<std::string> propertyIds;  // wire key "property_ids", presence required
    std::optional<bool> active;  // wire key "active", presence nullable
    std::optional<bool> locked;  // wire key "locked", presence nullable
    std::optional<NodeComponentStatus> componentStatus;  // wire key "component_status", presence nullable
    std::optional<std::string> componentStatusMessage;  // wire key "component_status_message", presence nullable
    std::optional<NodeConnectionStatus> connectionStatus;  // wire key "connection_status", presence nullable
    std::optional<NodeOperationMode> operationMode;  // wire key "operation_mode", presence nullable
    std::optional<bool> updating;  // wire key "updating", presence nullable
    std::optional<bool> recording;  // wire key "recording", presence nullable
};

/// contract 1.3 types.PropertyDescriptor
struct PropertyDescriptor
{
    std::string id_;  // wire key "id", presence required
    std::string name;  // wire key "name", presence required
    PropertyDescriptorValueType valueType;  // wire key "value_type", presence required
    std::optional<std::string> unit;  // wire key "unit", presence nullable
    std::optional<std::string> description;  // wire key "description", presence nullable
    bool readOnly;  // wire key "read_only", presence required
    bool visible;  // wire key "visible", presence required
    std::optional<AnyValue> default_;  // wire key "default", presence nullable
    std::optional<std::vector<std::string>> selectionValues;  // wire key "selection_values", presence nullable
    std::optional<std::vector<AnyValue>> suggestedValues;  // wire key "suggested_values", presence nullable
    std::optional<double> min;  // wire key "min", presence nullable
    std::optional<double> max;  // wire key "max", presence nullable
    std::optional<std::string> validator;  // wire key "validator", presence nullable; openDAQ EvalValue source, display only, never interpreted
    std::optional<std::string> coercer;  // wire key "coercer", presence nullable; openDAQ EvalValue source, display only, never interpreted
};

/// contract 1.3 types.ComponentAttribute
struct ComponentAttribute
{
    std::string id_;  // wire key "id", presence required
    std::string name;  // wire key "name", presence required
    std::optional<AnyValue> value;  // wire key "value", presence nullable
    ComponentAttributeValueType valueType;  // wire key "value_type", presence required
    bool readOnly;  // wire key "read_only", presence required
};

/// contract 1.3 types.SignalDescriptor
struct SignalDescriptor
{
    std::string id_;  // wire key "id", presence required
    std::string name;  // wire key "name", presence required
    SignalDescriptorSampleType sampleType;  // wire key "sample_type", presence required
    std::optional<std::string> unit;  // wire key "unit", presence nullable
    std::optional<std::string> domainId;  // wire key "domain_id", presence nullable
};

/// contract 1.3 types.Gap
struct Gap
{
    std::string capability;  // wire key "capability", presence required
    GapKind kind;  // wire key "kind", presence required
    std::string reason;  // wire key "reason", presence required
};

/// contract 1.3 types.ComponentTypeInfo
struct ComponentTypeInfo
{
    std::string id_;  // wire key "id", presence required
    std::string name;  // wire key "name", presence required
    ComponentTypeInfoKind kind;  // wire key "kind", presence required
    std::optional<std::string> description;  // wire key "description", presence nullable
    std::optional<std::string> connectionStringPrefix;  // wire key "connection_string_prefix", presence nullable
};

/// contract 1.3 types.ModuleInfo
struct ModuleInfo
{
    std::string id_;  // wire key "id", presence required
    std::string name;  // wire key "name", presence required
    std::optional<std::string> version;  // wire key "version", presence nullable
    std::vector<ComponentTypeInfo> componentTypes;  // wire key "component_types", presence required
};

/// Baseline capability ids of contract 4. A host declares the subset it
/// implements; the gap list is this baseline minus that subset.
inline constexpr std::string_view BASELINE_CAPABILITY_IDS[20] =
{
    "device.scan",
    "device.connect",
    "tree.read",
    "property.read",
    "property.write",
    "function_block.add",
    "streaming.decimated",
    "streaming.raw",
    "device.mode",
    "device.lock",
    "module.read",
    "module.load",
    "attribute.read",
    "attribute.write",
    "server.add",
    "server.discovery",
    "recorder.control",
    "property.batched_update",
    "configuration.save",
    "configuration.load",
};

/// The closed operation table of contract 1.4. lints.host_covers_every_operation
/// and lints.no_undeclared_public_method are both checked against this
/// array.
inline constexpr std::string_view WIRE_METHOD_NAMES[31] =
{
    "scan_available_devices",
    "connect_device",
    "disconnect_device",
    "get_component_tree",
    "get_property_value",
    "get_property_descriptors",
    "set_property_value",
    "list_function_block_types",
    "add_function_block",
    "remove_function_block",
    "subscribe_signal",
    "unsubscribe_signal",
    "read_samples_raw",
    "get_device_operation_modes",
    "set_device_operation_mode",
    "lock_device",
    "unlock_device",
    "list_loaded_modules",
    "load_module_from_host_path",
    "get_component_attributes",
    "set_component_attribute",
    "list_server_types",
    "add_server",
    "remove_server",
    "set_server_discovery_enabled",
    "start_recording",
    "stop_recording",
    "begin_batched_property_update",
    "end_batched_property_update",
    "save_instance_configuration_to_string",
    "load_instance_configuration_from_string",
};

/// Server-push events of contract 1.5. Events carry no id field.
inline constexpr std::string_view WIRE_EVENT_NAMES[5] =
{
    "component_added",
    "component_removed",
    "property_changed",
    "property_descriptor_changed",
    "device_disconnected",
};

/// Binary sample frames of contract 1.9. little_endian, 17-byte header.
enum class BinaryFrameEncoding : std::uint8_t
{
    raw = 0,  // wire: "raw", sample_count float64 values
    minMaxEnvelope = 1,  // wire: "min_max_envelope", sample_count * 2 float64 values
};

inline constexpr std::size_t BINARY_FRAME_HEADER_BYTES = 17;
inline constexpr std::size_t BINARY_FRAME_PAYLOAD_OFFSET = 17;

/// Header field offsets, little-endian, as written on the wire. The
/// payload offset is 17, which is not 8-byte aligned, so a reader
/// must copy the payload out rather than view it in place.
struct BinaryFrameHeader
{
    std::uint32_t subscriptionId;  // offset 0, 4 bytes, uint32
    std::uint64_t domainStart;  // offset 4, 8 bytes, uint64
    std::uint32_t sampleCount;  // offset 12, 4 bytes, uint32
    BinaryFrameEncoding encoding;  // offset 16, 1 bytes, uint8
};

struct BinarySampleFrame
{
    BinaryFrameHeader header;
    std::vector<double> values;
};

/// contract 1.6, the first message the server sends.
struct WireHandshake
{
    std::string protocolVersion;  // wire key "protocol_version", const "1.0"
    /// DISPLAY ONLY. No behavioural branch may read implementationName.
    std::string implementationName;  // wire key "implementation.name"
    std::string implementationVersion;  // wire key "implementation.version"
    std::string sdkVersion;  // wire key "sdk.version"
    std::string sdkCommit;  // wire key "sdk.commit"
    std::vector<std::string> capabilities;  // wire key "capabilities"
    std::vector<Gap> gaps;  // wire key "gaps"
    std::int64_t maxSubscriptions = 64;  // wire key "limits.max_subscriptions"
    std::int64_t maxFrameBytes = 262144;  // wire key "limits.max_frame_bytes"
};

/// The handler interface. A C++ host implements every method of this
/// class; lints.host_covers_every_operation is what a missing override
/// costs, and because every method here is pure virtual, a missing
/// handler is a compile error rather than a runtime surprise.
///
/// Methods are synchronous: casing.async_style_applies_to scopes the
/// async convention to generated CLIENT call symbols, and this is the
/// server side of the same operations.
class WireOperationHandler
{
public:
    virtual ~WireOperationHandler() = default;

    /// wire method "scan_available_devices", capability device.scan, kind action.
    /// Declared errors: internal. Signal one by throwing WireCallFailed.
    virtual std::vector<DeviceInfo> scanAvailableDevices() = 0;

    /// wire method "connect_device", capability device.connect, kind action.
    /// Declared errors: not_found, invalid_value, timeout. Signal one by throwing WireCallFailed.
    virtual Node connectDevice(const std::string& connectionString) = 0;

    /// wire method "disconnect_device", capability device.connect, kind action.
    /// Declared errors: not_found. Signal one by throwing WireCallFailed.
    virtual void disconnectDevice(const std::string& nodeId) = 0;

    /// wire method "get_component_tree", capability tree.read, kind getter.
    /// Declared errors: not_connected, not_found. Signal one by throwing WireCallFailed.
    virtual std::vector<Node> getComponentTree(const std::optional<std::string>& rootId) = 0;

    /// wire method "get_property_value", capability property.read, kind getter.
    /// Declared errors: not_found, not_connected. Signal one by throwing WireCallFailed.
    virtual AnyValue getPropertyValue(const std::string& nodeId, const std::string& propertyId) = 0;

    /// wire method "get_property_descriptors", capability property.read, kind getter.
    /// Declared errors: not_found, not_connected. Signal one by throwing WireCallFailed.
    virtual std::vector<PropertyDescriptor> getPropertyDescriptors(const std::string& nodeId) = 0;

    /// wire method "set_property_value", capability property.write, kind setter.
    /// Declared errors: not_found, read_only, invalid_value. Signal one by throwing WireCallFailed.
    virtual void setPropertyValue(const std::string& nodeId, const std::string& propertyId, const AnyValue& value) = 0;

    /// wire method "list_function_block_types", capability function_block.add, kind getter.
    /// Declared errors: not_connected. Signal one by throwing WireCallFailed.
    virtual std::vector<std::string> listFunctionBlockTypes() = 0;

    /// wire method "add_function_block", capability function_block.add, kind action.
    /// Declared errors: not_found, unsupported. Signal one by throwing WireCallFailed.
    virtual Node addFunctionBlock(const std::string& parentId, const std::string& typeId) = 0;

    /// wire method "remove_function_block", capability function_block.add, kind action.
    /// Declared errors: not_found. Signal one by throwing WireCallFailed.
    virtual void removeFunctionBlock(const std::string& nodeId) = 0;

    /// wire method "subscribe_signal", capability streaming.decimated, kind action.
    /// Declared errors: not_found, not_connected, invalid_value. Signal one by throwing WireCallFailed.
    virtual std::string subscribeSignal(const std::string& signalId, std::int64_t pixelColumns) = 0;

    /// wire method "unsubscribe_signal", capability streaming.decimated, kind action.
    /// Declared errors: not_found, invalid_value. Signal one by throwing WireCallFailed.
    virtual void unsubscribeSignal(const std::string& subscriptionId) = 0;

    /// wire method "read_samples_raw", capability streaming.raw, kind action.
    /// Declared errors: not_found, not_connected. Signal one by throwing WireCallFailed.
    ///
    /// UNSPECIFIED IN contract.yaml: this operation returns a binary
    /// frame, but envelopes.result carries a JSON result and
    /// binary_frame.header has no correlation id, so a binary
    /// response cannot be matched to its request id. See the
    /// contract-compiler report.
    virtual BinarySampleFrame readSamplesRaw(const std::string& signalId, std::int64_t count) = 0;

    /// wire method "get_device_operation_modes", capability device.mode, kind getter.
    /// Declared errors: not_found, not_connected, unsupported. Signal one by throwing WireCallFailed.
    virtual std::vector<std::string> getDeviceOperationModes(const std::string& nodeId) = 0;

    /// wire method "set_device_operation_mode", capability device.mode, kind setter.
    /// Declared errors: not_found, invalid_value, unsupported. Signal one by throwing WireCallFailed.
    virtual void setDeviceOperationMode(const std::string& nodeId, const std::string& mode) = 0;

    /// wire method "lock_device", capability device.lock, kind action.
    /// Declared errors: not_found, read_only, unsupported. Signal one by throwing WireCallFailed.
    virtual void lockDevice(const std::string& nodeId) = 0;

    /// wire method "unlock_device", capability device.lock, kind action.
    /// Declared errors: not_found, read_only, unsupported. Signal one by throwing WireCallFailed.
    virtual void unlockDevice(const std::string& nodeId, const std::optional<bool>& force) = 0;

    /// wire method "list_loaded_modules", capability module.read, kind getter.
    /// Declared errors: not_connected, internal. Signal one by throwing WireCallFailed.
    virtual std::vector<ModuleInfo> listLoadedModules() = 0;

    /// wire method "load_module_from_host_path", capability module.load, kind action.
    /// Declared errors: not_found, not_connected, invalid_value, internal. Signal one by throwing WireCallFailed.
    virtual ModuleInfo loadModuleFromHostPath(const std::string& hostPath) = 0;

    /// wire method "get_component_attributes", capability attribute.read, kind getter.
    /// Declared errors: not_found, not_connected, invalid_value. Signal one by throwing WireCallFailed.
    virtual std::vector<ComponentAttribute> getComponentAttributes(const std::string& nodeId) = 0;

    /// wire method "set_component_attribute", capability attribute.write, kind setter.
    /// Declared errors: not_found, read_only, invalid_value. Signal one by throwing WireCallFailed.
    virtual void setComponentAttribute(const std::string& nodeId, const std::string& attributeId, const AnyValue& value) = 0;

    /// wire method "list_server_types", capability server.add, kind getter.
    /// Declared errors: not_connected. Signal one by throwing WireCallFailed.
    virtual std::vector<ComponentTypeInfo> listServerTypes() = 0;

    /// wire method "add_server", capability server.add, kind action.
    /// Declared errors: not_connected, unsupported, invalid_value, internal. Signal one by throwing WireCallFailed.
    virtual Node addServer(const std::string& typeId) = 0;

    /// wire method "remove_server", capability server.add, kind action.
    /// Declared errors: not_found, unsupported, internal. Signal one by throwing WireCallFailed.
    virtual void removeServer(const std::string& nodeId) = 0;

    /// wire method "set_server_discovery_enabled", capability server.discovery, kind setter.
    /// Declared errors: not_found, unsupported, internal, invalid_value. Signal one by throwing WireCallFailed.
    virtual void setServerDiscoveryEnabled(const std::string& nodeId, bool enabled) = 0;

    /// wire method "start_recording", capability recorder.control, kind action.
    /// Declared errors: not_found, unsupported, internal, invalid_value. Signal one by throwing WireCallFailed.
    virtual void startRecording(const std::string& nodeId) = 0;

    /// wire method "stop_recording", capability recorder.control, kind action.
    /// Declared errors: not_found, unsupported, internal. Signal one by throwing WireCallFailed.
    virtual void stopRecording(const std::string& nodeId) = 0;

    /// wire method "begin_batched_property_update", capability property.batched_update, kind action.
    /// Declared errors: not_found, not_connected, invalid_value. Signal one by throwing WireCallFailed.
    virtual void beginBatchedPropertyUpdate(const std::string& nodeId) = 0;

    /// wire method "end_batched_property_update", capability property.batched_update, kind action.
    /// Declared errors: not_found, not_connected, invalid_value. Signal one by throwing WireCallFailed.
    virtual void endBatchedPropertyUpdate(const std::string& nodeId) = 0;

    /// wire method "save_instance_configuration_to_string", capability configuration.save, kind getter.
    /// Declared errors: not_connected, internal. Signal one by throwing WireCallFailed.
    virtual std::string saveInstanceConfigurationToString() = 0;

    /// wire method "load_instance_configuration_from_string", capability configuration.load, kind action.
    /// Declared errors: not_connected, invalid_value, internal. Signal one by throwing WireCallFailed.
    virtual void loadInstanceConfigurationFromString(const std::string& configuration) = 0;
};

/// Server push. A host calls these to emit the events of contract 1.5.
class WireEventSink
{
public:
    virtual ~WireEventSink() = default;

    /// wire event "component_added"
    virtual void componentAdded(const Node& node) = 0;

    /// wire event "component_removed"
    virtual void componentRemoved(const std::string& nodeId) = 0;

    /// wire event "property_changed"
    virtual void propertyChanged(const std::string& nodeId, const std::string& propertyId, const AnyValue& value) = 0;

    /// wire event "property_descriptor_changed"
    virtual void propertyDescriptorChanged(const std::string& nodeId, const PropertyDescriptor& descriptor) = 0;

    /// wire event "device_disconnected"
    virtual void deviceDisconnected(const std::string& nodeId, const std::string& reason) = 0;
};

}  // namespace quackoscope::contract

