// Quackoscope host (C#) -- service layer.
//
// The wire DTOs of the M1 contract and their JSON marshalling. Snake_case on
// the wire, always. Nothing here knows about the SDK or about sockets.
using System.Text.Json.Nodes;

namespace Quackoscope.Host.CSharp.Service;

public sealed class ComponentNode
{
    public string Id = "";
    public string Name = "";
    public string Kind = "folder";          // device | channel | function_block | signal | folder
    public string ParentId;                 // null at the root
    public List<string> ChildIds = new();
    public List<string> PropertyIds = new();

    // The six component-state fields of contract types.Node. Every one is
    // nullable and null means "this host did not determine it", never a guessed
    // value: null draws no label and no colour on a row.
    public bool? Active;                    // IComponent.Active
    public bool? Locked;                    // EFFECTIVE lock, inheritance applied host-side
    public string ComponentStatus;          // ok | warning | error
    public string ComponentStatusMessage;
    public string ConnectionStatus;         // device rows only: connected | reconnecting | unrecoverable | removed
    public string OperationMode;            // device rows only: unknown | idle | operation | safe_operation

    // IPropertyObject::getUpdating -- true while a beginUpdate is open and no
    // endUpdate has closed it, during which every set_property_value against
    // this component is HELD rather than applied.
    public bool? Updating;

    // IRecorder::getIsRecording. null means BOTH "this component is not a
    // recorder" and "this host did not determine it", which is the conflation
    // contract types.Node.recording names in as many words; the client draws no
    // recorder control in either case.
    public bool? Recording;

    public JsonNode ToWireJson()
    {
        var children = new JsonArray();
        foreach (var c in ChildIds) children.Add(c);
        var properties = new JsonArray();
        foreach (var p in PropertyIds) properties.Add(p);

        return new JsonObject
        {
            ["id"] = Id,
            ["name"] = Name,
            ["kind"] = Kind,
            ["parent_id"] = ParentId is null ? null : JsonValue.Create(ParentId),
            ["child_ids"] = children,
            ["property_ids"] = properties,
            ["active"] = Active is null ? null : JsonValue.Create(Active.Value),
            ["locked"] = Locked is null ? null : JsonValue.Create(Locked.Value),
            ["component_status"] = ComponentStatus is null ? null : JsonValue.Create(ComponentStatus),
            ["component_status_message"] = ComponentStatusMessage is null ? null : JsonValue.Create(ComponentStatusMessage),
            ["connection_status"] = ConnectionStatus is null ? null : JsonValue.Create(ConnectionStatus),
            ["operation_mode"] = OperationMode is null ? null : JsonValue.Create(OperationMode),
            ["updating"] = Updating is null ? null : JsonValue.Create(Updating.Value),
            ["recording"] = Recording is null ? null : JsonValue.Create(Recording.Value)
        };
    }
}

// One row of the reference's ATTRIBUTES treeview, as contract
// types.ComponentAttribute declares it. The set is not fixed: seven come off
// IComponent, five more if the component casts to ISignal, three more if it
// casts to IInputPort. A host that cannot perform a cast contributes fewer
// rows; it never contributes a row whose value is null, which would claim the
// attribute exists and has no value.
public sealed class ComponentAttribute
{
    public string Id = "";                  // the frozen snake_case wire id, e.g. domain_signal_id
    public string Name = "";                // the label the reference prints, e.g. "Domain Signal ID"
    public JsonNode Value;
    public string ValueType = "";           // bool | int | float | string | string_list
    public bool ReadOnly;

    public JsonNode ToWireJson() => new JsonObject
    {
        ["id"] = Id,
        ["name"] = Name,
        ["value"] = Value?.DeepClone(),
        ["value_type"] = ValueType,
        ["read_only"] = ReadOnly
    };
}

// One component type a module offers, as contract types.ComponentTypeInfo
// declares it. connection_string_prefix is null on the two kinds that carry no
// prefix: openDAQ puts ConnectionStringPrefix on IDeviceType and IStreamingType
// only, never on IFunctionBlockType or IServerType.
public sealed class ComponentTypeInfo
{
    public string Id = "";
    public string Name = "";
    public string Kind = "";                // device | function_block | server | streaming
    public string Description;
    public string ConnectionStringPrefix;

    public JsonNode ToWireJson() => new JsonObject
    {
        ["id"] = Id,
        ["name"] = Name,
        ["kind"] = Kind,
        ["description"] = Description is null ? null : JsonValue.Create(Description),
        ["connection_string_prefix"] = ConnectionStringPrefix is null ? null : JsonValue.Create(ConnectionStringPrefix)
    };
}

// One loaded openDAQ module, as contract types.ModuleInfo declares it. The
// component types ride inside the record so the Modules view is one request and
// not 1 + 4N.
public sealed class ModuleInfo
{
    public string Id = "";
    public string Name = "";
    public string Version;                  // "major.minor.patch", or null when the module carries no version info
    public List<ComponentTypeInfo> ComponentTypes = new();

    public JsonNode ToWireJson()
    {
        var types = new JsonArray();
        foreach (var componentType in ComponentTypes)
            types.Add(componentType.ToWireJson());

        return new JsonObject
        {
            ["id"] = Id,
            ["name"] = Name,
            ["version"] = Version is null ? null : JsonValue.Create(Version),
            ["component_types"] = types
        };
    }
}

public sealed class PropertyDescriptor
{
    public string Id = "";
    public string Name = "";
    public string ValueType = "";           // bool | int | float | string | selection | struct
    public string Unit;
    public string Description;
    public bool ReadOnly;
    public bool Visible = true;
    public JsonNode DefaultValue;
    public List<string> SelectionValues;
    public List<JsonNode> SuggestedValues;
    public double? Minimum;
    public double? Maximum;
    public string ValidatorEvalSource;
    public string CoercerEvalSource;

    public JsonNode ToWireJson()
    {
        JsonNode selection = null;
        if (SelectionValues is not null)
        {
            var array = new JsonArray();
            foreach (var v in SelectionValues) array.Add(v);
            selection = array;
        }

        JsonNode suggested = null;
        if (SuggestedValues is not null)
        {
            var array = new JsonArray();
            foreach (var v in SuggestedValues) array.Add(v?.DeepClone());
            suggested = array;
        }

        return new JsonObject
        {
            ["id"] = Id,
            ["name"] = Name,
            ["value_type"] = ValueType,
            ["unit"] = Unit is null ? null : JsonValue.Create(Unit),
            ["description"] = Description is null ? null : JsonValue.Create(Description),
            ["read_only"] = ReadOnly,
            ["visible"] = Visible,
            ["default"] = DefaultValue?.DeepClone(),
            ["selection_values"] = selection,
            ["suggested_values"] = suggested,
            ["min"] = Minimum is null ? null : JsonValue.Create(Minimum.Value),
            ["max"] = Maximum is null ? null : JsonValue.Create(Maximum.Value),
            ["validator"] = ValidatorEvalSource is null ? null : JsonValue.Create(ValidatorEvalSource),
            ["coercer"] = CoercerEvalSource is null ? null : JsonValue.Create(CoercerEvalSource)
        };
    }
}

public enum ServerPushKind
{
    ComponentAdded,
    ComponentRemoved,
    PropertyChanged,
    PropertyDescriptorChanged,
    DeviceDisconnected
}

public sealed class ServerPush
{
    public ServerPushKind Kind;
    public ComponentNode Node;              // ComponentAdded
    public string NodeId = "";              // all but ComponentAdded
    public string PropertyId = "";          // PropertyChanged
    public JsonNode Value;                  // PropertyChanged
    public PropertyDescriptor Descriptor;   // PropertyDescriptorChanged
    public string Reason = "";              // DeviceDisconnected

    public JsonNode ToWireEnvelope() => Kind switch
    {
        ServerPushKind.ComponentAdded => new JsonObject
        {
            ["event"] = "component_added",
            ["payload"] = new JsonObject { ["node"] = Node?.ToWireJson() }
        },
        ServerPushKind.ComponentRemoved => new JsonObject
        {
            ["event"] = "component_removed",
            ["payload"] = new JsonObject { ["node_id"] = NodeId }
        },
        ServerPushKind.PropertyChanged => new JsonObject
        {
            ["event"] = "property_changed",
            ["payload"] = new JsonObject
            {
                ["node_id"] = NodeId,
                ["property_id"] = PropertyId,
                ["value"] = Value?.DeepClone()
            }
        },
        ServerPushKind.PropertyDescriptorChanged => new JsonObject
        {
            ["event"] = "property_descriptor_changed",
            ["payload"] = new JsonObject
            {
                ["node_id"] = NodeId,
                ["descriptor"] = Descriptor?.ToWireJson()
            }
        },
        _ => new JsonObject
        {
            ["event"] = "device_disconnected",
            ["payload"] = new JsonObject { ["node_id"] = NodeId, ["reason"] = Reason }
        }
    };
}
