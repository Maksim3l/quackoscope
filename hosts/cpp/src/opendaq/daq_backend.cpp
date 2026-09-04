// Quackoscope host (C++) -- openDAQ layer.
//
// THE ONLY translation unit that includes an openDAQ header. Nothing here
// knows about sockets, HTTP or the WebSocket envelope; it speaks the service
// layer's DTOs and throws service::ServiceError with codes drawn from the
// closed set by service::mapNativeErrorCode.
//
// Every operation marks the SDK calls a reader would need in order to write
// that same operation against openDAQ in another language, inside quack-snippet
// markers that tools/snippet-extractor reads to build generated/snippets.json:
//
//     // quack-snippet capability=<id>[,<id>...] [uses=<name>,...] [step=<n>]
//     ...the SDK calls...
//     // quack-snippet end
//
//     // quack-snippet shared=<name> [uses=<name>,...] [step=<n>]
//     ...the SDK calls...
//     // quack-snippet end
//
// capability= names one or more capability ids from the contract's closed set
// (device.scan, device.connect, tree.read, property.read, property.write,
// function_block.add, streaming.decimated, streaming.raw, device.mode,
// device.lock, module.read). shared= names a
// mechanism several operations lean on -- kindOf, buildNode, wireValueType,
// toDescriptor, fromJson, resolveProperty's getProperty, the component-state
// reads, the device facet cast, the component-type mapping, the core-event
// decoding -- so it is written down once; uses= pulls those in, and the
// extracted snippet is the used shared regions (depth first, de-duplicated)
// followed by the operation's own regions. Regions of one operation are
// ordered by step= and then by line number, so the snippet reads in the order
// the reader would write it even when this file defines them in another order.
// The syntax is a plain line comment, so the same markers carry over to the
// Python (#), C# (//) and Rust (//) hosts unchanged.
//
// Session bookkeeping, JSON marshalling into service::Json, node-id registry
// lookups (resolve/resolvePropertyObject) and the native-error-code mapping
// stay OUTSIDE every region: they are this host's plumbing, not openDAQ.

#include "opendaq/daq_backend.hpp"

#include "service/error.hpp"

#include <opendaq/opendaq.h>

// Not reached through <opendaq/opendaq.h>: the two component types that carry a
// connection string prefix, and IModuleInfo, which list_loaded_modules needs.
#include <opendaq/device_type_ptr.h>
#include <opendaq/module_info_ptr.h>
#include <opendaq/streaming_type_ptr.h>

#include <algorithm>
#include <cctype>
#include <atomic>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <filesystem>
#include <functional>
#include <iostream>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace qs::opendaq
{
namespace
{

using namespace daq;
using service::ErrorCode;
using service::MapContext;
using service::ServiceError;

constexpr std::size_t kPumpBufferSamples = 65536;
constexpr std::size_t kPumpTimeoutMs = 50;

std::string toStd(const StringPtr& s)
{
    return s.assigned() ? s.toStdString() : std::string{};
}

std::string toStd(const ObjectPtr<IString>& s)
{
    return s.assigned() ? StringPtr(s).toStdString() : std::string{};
}

std::string describe(const BaseObjectPtr& o)
{
    return o.assigned() ? toStd(o.toString()) : std::string{};
}

// Native openDAQ failure -> closed-set error. The classification table itself
// lives in the service layer; this only ferries the numbers across the seam.
ServiceError translate(const DaqException& e, MapContext context = MapContext::General)
{
    return ServiceError(service::mapNativeErrorCode(static_cast<std::uint32_t>(e.getErrCode()), context),
                        e.getErrorMessage());
}

// How a component's kind is decided. The shared region component-kind;
// component-node uses it, and so reach it connect_device, get_component_tree
// and the core-event decoding.
const char* kindOf(const ComponentPtr& component)
{
    // quack-snippet shared=component-kind
    // openDAQ has no "kind" attribute: a component's kind is whichever of these
    // interfaces it can be cast to, and the order matters because a Channel is
    // also a FunctionBlock and a Device is also a Folder.
    if (component.asPtrOrNull<IChannel>().assigned())
        return "channel";
    if (component.asPtrOrNull<IDevice>().assigned())
        return "device";
    if (component.asPtrOrNull<IFunctionBlock>().assigned())
        return "function_block";
    if (component.asPtrOrNull<ISignal>().assigned())
        return "signal";
    // Everything else -- folders and plain components such as Synchronization --
    // is reported as a folder; the contract's kind set has no other container.
    return "folder";
    // quack-snippet end
}

// openDAQ names its enumeration members in PascalCase ("Ok", "Reconnecting",
// "SafeOperation"); the contract spells the same members in the frozen wire
// join, which for every one of these is the same word in lower case. This is
// string bookkeeping, not an SDK call, so it sits outside every region.
std::string lowercased(const std::string& text)
{
    std::string out = text;
    for (auto& c : out)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return out;
}

// The four states of openDAQ's OperationModeType and the wire's spelling of
// each, in ONE table so the two directions cannot drift apart. The shared
// region operation-mode-names: Node.operation_mode,
// get_device_operation_modes and set_device_operation_mode all use it.
struct OperationModeWireName
{
    OperationModeType mode;
    const char* wire;
};

const OperationModeWireName kOperationModeWireNames[] = {
    // quack-snippet shared=operation-mode-names
    // OperationModeType is declared in <opendaq/component.h>. Its four members
    // are the contract's Node.operation_mode values, and the wire spells the
    // compound one in snake_case.
    {OperationModeType::Unknown, "unknown"},
    {OperationModeType::Idle, "idle"},
    {OperationModeType::Operation, "operation"},
    {OperationModeType::SafeOperation, "safe_operation"},
    // quack-snippet end
};

const char* operationModeWireName(OperationModeType mode)
{
    for (const auto& row : kOperationModeWireNames)
        if (row.mode == mode)
            return row.wire;
    return "unknown";
}

bool operationModeFromWireName(const std::string& wire, OperationModeType& mode)
{
    for (const auto& row : kOperationModeWireNames)
        if (wire == row.wire)
        {
            mode = row.mode;
            return true;
        }
    return false;
}

std::string everyOperationModeWireName()
{
    std::string all;
    for (const auto& row : kOperationModeWireNames)
        all += (all.empty() ? "" : ", ") + std::string(row.wire);
    return all;
}

// Where both ComponentStatus and ConnectionStatus are read from. The shared
// region component-status-container; component-state uses it.
DictPtr<IString, IEnumeration> componentStatuses(const ComponentPtr& component)
{
    // quack-snippet shared=component-status-container
    // Statuses live in a container keyed by name, and a component carries only
    // the statuses whoever built it added: a plain folder has none at all, and
    // "ConnectionStatus" exists only on a device that a streaming client module
    // built. Reading the whole dictionary once asks openDAQ what is actually
    // there instead of guessing a key and catching the miss. The values are
    // Enumerations of openDAQ's ComponentStatusType (Ok, Warning, Error) and
    // ConnectionStatusType (Connected, Reconnecting, Unrecoverable, Removed).
    const auto container = component.getStatusContainer();
    if (!container.assigned())
        return DictPtr<IString, IEnumeration>();
    return container.getStatuses();
    // quack-snippet end
}

// The EFFECTIVE lock state of one component, inheritance already applied. The
// shared region effective-device-lock-state; component-state uses it.
std::optional<bool> effectiveDeviceLockState(const ComponentPtr& component)
{
    // quack-snippet shared=effective-device-lock-state
    // The lock is a DEVICE fact: only IDevice carries isLocked(). openDAQ has
    // no "effective locked" for a component below a device, so the nearest
    // IDevice ancestor -- the component itself, when it is a device -- is
    // walked to and asked, and that answer is what the wire carries. The walk
    // is exactly what the reference does client-side, once per row, in
    // _set_node_lock_status_recursive; doing it host-side does it once.
    for (ComponentPtr walker = component; walker.assigned(); walker = walker.getParent())
        if (const auto owningDevice = walker.asPtrOrNull<IDevice>(); owningDevice.assigned())
            return static_cast<bool>(owningDevice.isLocked());
    return std::nullopt;
    // quack-snippet end
}

// Everything openDAQ can say about the STATE of one component: whether it is
// active, whether it is locked, its ComponentStatus and that status's message,
// and -- for a device -- its ConnectionStatus and its current operation mode.
//
// The shared region component-state. component-node uses it, so it reaches
// every Node this host emits: get_component_tree, connect_device,
// add_function_block and the component_added core event alike. A per-row fact
// travels with the row it annotates rather than costing a request of its own.
void readComponentState(const ComponentPtr& component, service::Node& node)
{
    // quack-snippet shared=component-state uses=operation-mode-names,component-status-container,effective-device-lock-state
    // getActive() is the EFFECTIVE active flag: false either because this
    // component was deactivated or because a parent was.
    node.active = static_cast<bool>(component.getActive());

    // shared region effective-device-lock-state
    node.locked = effectiveDeviceLockState(component);

    // shared region component-status-container
    const auto statuses = componentStatuses(component);

    if (statuses.assigned() && statuses.hasKey("ComponentStatus"))
    {
        node.component_status = lowercased(toStd(statuses.get("ComponentStatus").getValue()));
        const auto message = component.getStatusContainer().getStatusMessage("ComponentStatus");
        if (message.assigned() && !toStd(message).empty())
            node.component_status_message = toStd(message);
    }

    // connection_status and operation_mode are device facts. On anything else
    // they stay null, which is what the contract asks for.
    const auto device = component.asPtrOrNull<IDevice>();
    if (!device.assigned())
        return;

    if (statuses.assigned() && statuses.hasKey("ConnectionStatus"))
        node.connection_status = lowercased(toStd(statuses.get("ConnectionStatus").getValue()));

    // getOperationMode() is the CURRENT mode. The AVAILABLE list is a separate
    // call, get_device_operation_modes, because only an opened menu needs it.
    node.operation_mode = operationModeWireName(device.getOperationMode());
    // quack-snippet end
}

// The AVAILABLE operation modes of one device. The shared region
// device-available-operation-modes: get_device_operation_modes answers with it,
// and set_device_operation_mode checks a requested mode against it.
std::vector<OperationModeType> availableOperationModes(const DevicePtr& device)
{
    std::vector<OperationModeType> modes;
    // quack-snippet shared=device-available-operation-modes uses=operation-mode-names
    // openDAQ answers with a list of IInteger rather than a list of the enum:
    // each element is the integer value of one OperationModeType member. The
    // CURRENT mode is getOperationMode(), which every device Node already
    // carries as operation_mode, so this list is fetched only when a mode menu
    // is opened on one device.
    for (const auto& mode : device.getAvailableOperationModes())
        modes.push_back(static_cast<OperationModeType>(static_cast<Int>(mode)));
    // quack-snippet end
    return modes;
}

// One row of one of the four type dictionaries a module publishes. The shared
// region component-type-info; list_loaded_modules uses it four times over.
void appendComponentTypes(std::vector<service::ComponentTypeInfo>& out,
                          const char* wireKind,
                          const DictPtr<IString, IBaseObject>& types)
{
    if (!types.assigned())
        return;

    for (const auto& [typeId, type] : types)
    {
        (void) typeId;  // the id is read off the type object, not off the key
        service::ComponentTypeInfo entry;
        entry.kind = wireKind;

        std::string description;
        std::string prefix;
        // quack-snippet shared=component-type-info
        // Every value in all four dictionaries carries IComponentType, which is
        // where the id, the display name and the description live. The
        // connection string prefix is NOT on IComponentType: it is declared on
        // IDeviceType and on IStreamingType only, so it is reached by an
        // interface query that simply comes back unassigned for a function
        // block type or a server type.
        const auto componentType = type.asPtr<IComponentType>();
        entry.id = toStd(componentType.getId());
        entry.name = toStd(componentType.getName());
        description = toStd(componentType.getDescription());

        if (const auto asDeviceType = type.asPtrOrNull<IDeviceType>(); asDeviceType.assigned())
            prefix = toStd(asDeviceType.getConnectionStringPrefix());
        else if (const auto asStreamingType = type.asPtrOrNull<IStreamingType>(); asStreamingType.assigned())
            prefix = toStd(asStreamingType.getConnectionStringPrefix());
        // quack-snippet end

        if (!description.empty())
            entry.description = description;
        if (!prefix.empty())
            entry.connection_string_prefix = prefix;

        out.push_back(std::move(entry));
    }
}

// One of the four dictionaries, read and mapped, with a module that refuses
// this one kind kept out of the way of the three it does answer -- openDAQ's
// own module manager logs "Failed to enumerate module's supported SRV types:
// Not Implemented" for several of the modules on this machine.
void appendComponentTypesFrom(std::vector<service::ComponentTypeInfo>& out,
                              const char* wireKind,
                              const std::string& moduleId,
                              const std::function<DictPtr<IString, IBaseObject>()>& readDictionary)
{
    try
    {
        appendComponentTypes(out, wireKind, readDictionary());
    }
    catch (const DaqException& e)
    {
        std::cerr << "[opendaq] module \"" << moduleId << "\" refused its " << wireKind
                  << " type dictionary, so no component type of that kind is listed for it: " << e.getErrorMessage()
                  << "\n";
    }
}

// Everything one module can instantiate. The shared region
// module-component-types; list_loaded_modules uses it once per module.
std::vector<service::ComponentTypeInfo> moduleComponentTypes(const ModulePtr& module, const std::string& moduleId)
{
    std::vector<service::ComponentTypeInfo> types;
    // quack-snippet shared=module-component-types uses=component-type-info
    // What a module offers is FOUR separate dictionaries, one per kind of
    // component openDAQ knows how to build; there is no single "available
    // types" call, so the Modules view is these four together. Each row is
    // mapped by the shared region component-type-info.
    appendComponentTypesFrom(types, "device", moduleId, [&module] { return module.getAvailableDeviceTypes(); });
    appendComponentTypesFrom(
        types, "function_block", moduleId, [&module] { return module.getAvailableFunctionBlockTypes(); });
    appendComponentTypesFrom(types, "server", moduleId, [&module] { return module.getAvailableServerTypes(); });
    appendComponentTypesFrom(types, "streaming", moduleId, [&module] { return module.getAvailableStreamingTypes(); });
    // quack-snippet end
    return types;
}

// One module as the wire reports it. list_loaded_modules calls this once per
// module the manager already holds and load_module_from_host_path calls it once,
// on the module openDAQ has just returned, so a freshly loaded module's card and
// a listed module's card are built by the same code and cannot drift apart.
// Throws DaqException when IModuleInfo refuses; the two callers differ in what
// they do about that, so neither decision is taken here.
service::ModuleInfo describeModule(const ModulePtr& module)
{
    service::ModuleInfo entry;
    std::string version;

    // quack-snippet capability=module.read,module.load step=2
    // IModuleInfo carries the id, the display name and the version. The
    // version is not a string: IVersionInfo holds three integers, and a
    // module that carries no version info has none of them at all --
    // which is why ModuleInfo.version is nullable rather than "0.0.0".
    const auto info = module.getModuleInfo();
    entry.id = toStd(info.getId());
    entry.name = toStd(info.getName());
    if (const auto versionInfo = info.getVersionInfo(); versionInfo.assigned())
        version = std::to_string(versionInfo.getMajor()) + "." + std::to_string(versionInfo.getMinor()) + "." +
                  std::to_string(versionInfo.getPatch());
    // quack-snippet end

    if (!version.empty())
        entry.version = version;

    // quack-snippet capability=module.read,module.load uses=module-component-types,component-type-info step=3
    // Everything this module can instantiate, read as the four type
    // dictionaries of the shared region module-component-types and mapped
    // row by row by the shared region component-type-info. It rides inside
    // ModuleInfo so a module card needs no second request.
    entry.component_types = moduleComponentTypes(module, entry.id);
    // quack-snippet end

    return entry;
}

service::Json toJson(const BaseObjectPtr& value)
{
    if (!value.assigned())
        return nullptr;

    switch (value.getCoreType())
    {
        case ctBool:
            return static_cast<bool>(static_cast<Bool>(value));
        case ctInt:
            return static_cast<std::int64_t>(static_cast<Int>(value));
        case ctFloat:
            return static_cast<double>(static_cast<Float>(value));
        case ctString:
            return describe(value);
        case ctList:
        {
            service::Json out = service::Json::array();
            for (const auto& item : value.asPtr<IList>())
                out.push_back(toJson(item));
            return out;
        }
        case ctDict:
        {
            service::Json out = service::Json::object();
            for (const auto& [k, v] : value.asPtr<IDict>())
                out[describe(k)] = toJson(v);
            return out;
        }
        case ctStruct:
        {
            const auto s = value.asPtr<IStruct>();
            service::Json out = service::Json::object();
            for (const auto& field : s.getFieldNames())
                out[toStd(field)] = toJson(s.get(field));
            return out;
        }
        default:
            return describe(value);
    }
}

// The closed value_type set. Properties whose openDAQ core type has no member
// of that set (ctObject, ctProc, ctFunc, ...) are not representable on the M1
// wire and are omitted rather than misreported.
bool wireValueType(const PropertyPtr& property, std::string& out)
{
    // quack-snippet shared=property-wire-value-type
    // A property with selection values is a selection whatever its storage type
    // says; otherwise the core type of the property decides.
    if (property.getSelectionValues().assigned())
    {
        out = "selection";
        return true;
    }
    switch (property.getValueType())
    {
        case ctBool:   out = "bool";   return true;
        case ctInt:    out = "int";    return true;
        case ctFloat:  out = "float";  return true;
        case ctString: out = "string"; return true;
        case ctStruct: out = "struct"; return true;
        default:       return false;
    }
    // quack-snippet end
}

bool isRepresentable(const PropertyPtr& property)
{
    std::string ignored;
    try
    {
        return wireValueType(property, ignored);
    }
    catch (const std::exception&)
    {
        return false;
    }
}

// The whole descriptor mechanism: everything openDAQ can say about one
// property. The shared region property-descriptor: get_property_descriptors
// and the descriptor re-read that answers a value change both use it.
service::PropertyDescriptor toDescriptor(const PropertyPtr& property)
{
    service::PropertyDescriptor d;
    // quack-snippet shared=property-descriptor uses=property-wire-value-type
    d.name = toStd(property.getName());
    d.id = d.name;  // openDAQ property names are the identifiers
    wireValueType(property, d.value_type);  // shared region property-wire-value-type
    d.read_only = static_cast<bool>(property.getReadOnly());
    d.visible = static_cast<bool>(property.getVisible());
    d.default_value = toJson(property.getDefaultValue());

    if (const auto unit = property.getUnit(); unit.assigned())
        d.unit = toStd(unit.getSymbol());
    if (const auto description = property.getDescription(); description.assigned() && !toStd(description).empty())
        d.description = toStd(description);
    if (const auto min = property.getMinValue(); min.assigned())
        d.min = static_cast<double>(static_cast<Float>(min));
    if (const auto max = property.getMaxValue(); max.assigned())
        d.max = static_cast<double>(static_cast<Float>(max));
    if (const auto validator = property.getValidator(); validator.assigned())
        d.validator = toStd(validator.getEval());
    if (const auto coercer = property.getCoercer(); coercer.assigned())
        d.coercer = toStd(coercer.getEval());

    if (const auto selection = property.getSelectionValues(); selection.assigned())
    {
        std::vector<std::string> values;
        if (const auto asList = selection.asPtrOrNull<IList>(); asList.assigned())
        {
            for (const auto& item : asList)
                values.push_back(describe(item));
        }
        else if (const auto asDict = selection.asPtrOrNull<IDict>(); asDict.assigned())
        {
            for (const auto& [k, v] : asDict)
                values.push_back(describe(v));
        }
        d.selection_values = std::move(values);
    }

    if (const auto suggested = property.getSuggestedValues(); suggested.assigned())
    {
        std::vector<service::Json> values;
        for (const auto& item : suggested)
            values.push_back(toJson(item));
        d.suggested_values = std::move(values);
    }
    // quack-snippet end

    return d;
}

// JSON -> openDAQ value, shaped by the property's declared type. Coercion and
// validation stay openDAQ's business: this only builds a value of the right
// kind and lets setPropertyValue judge it.
BaseObjectPtr fromJson(const PropertyPtr& property, const service::Json& value)
{
    // quack-snippet shared=json-to-opendaq-value
    // Building the openDAQ value that set_property_value will write: the
    // property's own value type picks the pointer type, and a struct has to be
    // rebuilt field by field through a StructBuilder seeded from the current
    // value, because openDAQ rejects a struct whose field types do not match.
    const auto type = property.getValueType();
    switch (type)
    {
        case ctBool:
            if (value.is_boolean())
                return BooleanPtr(value.get<bool>());
            if (value.is_number())
                return BooleanPtr(value.get<double>() != 0.0);
            break;
        case ctInt:
            if (value.is_number_integer())
                return IntegerPtr(value.get<std::int64_t>());
            if (value.is_number())
                return IntegerPtr(static_cast<Int>(value.get<double>()));
            if (value.is_boolean())
                return IntegerPtr(value.get<bool>() ? 1 : 0);
            break;
        case ctFloat:
            if (value.is_number())
                return FloatPtr(value.get<double>());
            break;
        case ctString:
            if (value.is_string())
                return StringPtr(value.get<std::string>());
            break;
        case ctStruct:
        {
            if (!value.is_object())
                break;
            // Struct fields are strongly typed: an incoming JSON 5 must become a
            // Float if the field holds a Float, or openDAQ rejects the build.
            const auto current = property.getValue().asPtr<IStruct>();
            auto builder = StructBuilder(current);
            for (auto it = value.begin(); it != value.end(); ++it)
            {
                const auto& item = it.value();
                const auto existing = current.hasField(it.key()) ? current.get(it.key()) : BaseObjectPtr();
                const auto fieldType = existing.assigned() ? existing.getCoreType() : ctUndefined;

                if (fieldType == ctBool || (fieldType == ctUndefined && item.is_boolean()))
                    builder.set(it.key(), BooleanPtr(item.is_boolean() ? item.get<bool>() : item.get<double>() != 0.0));
                else if (fieldType == ctFloat || (fieldType == ctUndefined && item.is_number_float()))
                    builder.set(it.key(), FloatPtr(item.get<double>()));
                else if (fieldType == ctInt || (fieldType == ctUndefined && item.is_number_integer()))
                    builder.set(it.key(), IntegerPtr(item.get<std::int64_t>()));
                else if (fieldType == ctString || (fieldType == ctUndefined && item.is_string()))
                    builder.set(it.key(), StringPtr(item.get<std::string>()));
                else
                    throw ServiceError(ErrorCode::InvalidValue,
                                       "struct field \"" + it.key() + "\" cannot take " + item.dump());
            }
            return builder.build();
        }
        default:
            throw ServiceError(ErrorCode::Unsupported,
                               "property \"" + toStd(property.getName()) +
                                   "\" has an openDAQ value type that the M1 wire contract does not carry");
    }
    // quack-snippet end

    throw ServiceError(ErrorCode::InvalidValue,
                       "value " + value.dump() + " does not fit property \"" + toStd(property.getName()) + "\"");
}

}  // namespace

// ---------------------------------------------------------------------------

struct DaqBackend::Impl
{
    struct Subscription
    {
        std::uint32_t id = 0;
        SignalPtr signal;
        StreamReaderPtr reader;
        service::SampleSink sink;
        std::atomic<bool> stop{false};
        std::thread thread;
    };

    InstancePtr instance;
    service::EventSink eventSink;

    std::mutex subMutex;
    std::map<std::uint32_t, std::shared_ptr<Subscription>> subscriptions;

    // IModuleManager::loadModule appends to the manager's library vector while
    // getModules() walks that same vector, and both are reachable from any
    // session's socket thread. One mutex serialises list_loaded_modules against
    // load_module_from_host_path so a load never runs underneath a list.
    std::mutex moduleManagerMutex;

    // Descriptor snapshots, keyed by component global id then property name.
    // openDAQ 3.31 has no "property descriptor changed" core event, so a change
    // is detected by re-reading the descriptors after a value write and
    // comparing against the last snapshot handed to a client.
    std::mutex snapshotMutex;
    std::map<std::string, std::map<std::string, std::string>> descriptorSnapshots;

    // Core-event callbacks run on openDAQ's own threads while the property
    // object is being mutated; re-entering the SDK from there risks deadlock,
    // so descriptor re-reads are queued onto this worker instead.
    std::mutex workMutex;
    std::condition_variable workCv;
    std::deque<std::string> workQueue;
    std::atomic<bool> workerStop{false};
    std::thread worker;

    void emit(const service::Event& event) const
    {
        if (eventSink)
            eventSink(event);
    }

    ComponentPtr resolve(const std::string& id) const
    {
        const auto root = instance.getRootDevice();
        const std::string rootId = toStd(root.getGlobalId());

        if (id == rootId)
            return root;

        if (id.rfind(rootId + "/", 0) == 0)
        {
            const auto relative = id.substr(rootId.size() + 1);
            ComponentPtr found;
            try
            {
                found = root.findComponent(relative);
            }
            catch (const DaqException&)
            {
                found = nullptr;
            }
            if (found.assigned())
                return found;
        }

        throw ServiceError(ErrorCode::NotFound, "no component with id \"" + id + "\"");
    }

    PropertyObjectPtr resolvePropertyObject(const std::string& id) const
    {
        const auto component = resolve(id);
        const auto object = component.asPtrOrNull<IPropertyObject>();
        if (!object.assigned())
            throw ServiceError(ErrorCode::NotFound, "component \"" + id + "\" carries no properties");
        return object;
    }

    // Resolving a node id to the IDevice facet of the component it names. The
    // shared region device-of-component: lock_device, unlock_device,
    // get_device_operation_modes and set_device_operation_mode all start here.
    DevicePtr deviceOf(const std::string& id, const char* wireMethod) const
    {
        const auto component = resolve(id);  // not_found when the id names nothing at all
        // quack-snippet shared=device-of-component
        // openDAQ declares lock, unlock and the operation modes on IDevice, not
        // on IComponent, so the component has to be taken through its IDevice
        // facet before any of them can be called. A component that does not
        // carry that facet is not a device -- and it EXISTS, so refusing with
        // not_found would be a lie; the contract's word for it is unsupported.
        const auto device = component.asPtrOrNull<IDevice>();
        // quack-snippet end
        if (!device.assigned())
            throw ServiceError(ErrorCode::Unsupported,
                               "component \"" + id + "\" is a " + kindOf(component) + ", not a device, so " +
                                   wireMethod + " has nothing to act on");
        return device;
    }

    PropertyPtr resolveProperty(const PropertyObjectPtr& object, const std::string& nodeId, const std::string& name) const
    {
        try
        {
            // quack-snippet shared=property-by-name
            return object.getProperty(name);
            // quack-snippet end
        }
        catch (const DaqException& e)
        {
            throw ServiceError(service::mapNativeErrorCode(static_cast<std::uint32_t>(e.getErrCode())),
                               "property \"" + name + "\" not found on \"" + nodeId + "\": " + e.getErrorMessage());
        }
    }

    // The whole component -> Node mapping. The shared region component-node:
    // connect_device, get_component_tree and the component_added core event all
    // use it.
    service::Node buildNode(const ComponentPtr& component) const
    {
        service::Node node;
        // quack-snippet shared=component-node uses=component-kind,property-wire-value-type,component-state
        // Identity, then the two structural facts openDAQ exposes: a component
        // knows its parent, and a component that is a Folder knows its items.
        // Properties come from the IPropertyObject facet, which most but not
        // all components have.
        node.id = toStd(component.getGlobalId());
        node.name = toStd(component.getName());
        node.kind = kindOf(component);  // shared region component-kind

        if (const auto parent = component.getParent(); parent.assigned())
            node.parent_id = toStd(parent.getGlobalId());

        if (const auto folder = component.asPtrOrNull<IFolder>(); folder.assigned())
            for (const auto& child : folder.getItems())
                node.child_ids.push_back(toStd(child.getGlobalId()));

        if (const auto object = component.asPtrOrNull<IPropertyObject>(); object.assigned())
            for (const auto& property : object.getAllProperties())
                if (isRepresentable(property))  // shared region property-wire-value-type
                    node.property_ids.push_back(toStd(property.getName()));
        // quack-snippet end

        // The six state fields, read by the shared region component-state. A
        // component whose state openDAQ refuses to report keeps them null
        // rather than taking the whole tree read down with it: contract
        // types.Node makes every one of them nullable precisely so a host can
        // say "I did not determine this" instead of guessing a value.
        try
        {
            readComponentState(component, node);
        }
        catch (const std::exception& e)
        {
            std::cerr << "[opendaq] component state for \"" << node.id << "\" (kind " << node.kind
                      << ") could not be read, so its six state fields stay null: " << e.what() << "\n";
        }

        return node;
    }

    std::vector<service::PropertyDescriptor> describeProperties(const PropertyObjectPtr& object) const
    {
        std::vector<service::PropertyDescriptor> out;
        // quack-snippet shared=property-descriptor-enumeration uses=property-wire-value-type,property-descriptor
        // Same enumeration get_property_descriptors performs, reached from the
        // core-event side instead of from a request.
        for (const auto& property : object.getAllProperties())
        {
            try
            {
                if (!isRepresentable(property))       // shared region property-wire-value-type
                    continue;
                out.push_back(toDescriptor(property));  // shared region property-descriptor
            }
            catch (const std::exception& e)
            {
                std::cerr << "[opendaq] skipping property \"" << toStd(property.getName())
                          << "\": " << e.what() << "\n";
            }
        }
        // quack-snippet end
        return out;
    }

    void snapshot(const std::string& nodeId, const std::vector<service::PropertyDescriptor>& descriptors)
    {
        std::map<std::string, std::string> shot;
        for (const auto& d : descriptors)
            shot[d.id] = service::toJson(d).dump();

        std::lock_guard<std::mutex> lock(snapshotMutex);
        descriptorSnapshots[nodeId] = std::move(shot);
    }

    // Re-read a component's descriptors and emit property_descriptor_changed
    // for every one that actually moved since the client last saw it. Nothing
    // is emitted for a component the client has never asked about.
    void refreshDescriptors(const std::string& nodeId)
    {
        PropertyObjectPtr object;
        try
        {
            object = resolvePropertyObject(nodeId);
        }
        catch (const std::exception&)
        {
            return;
        }

        std::vector<service::PropertyDescriptor> descriptors;
        try
        {
            descriptors = describeProperties(object);
        }
        catch (const std::exception& e)
        {
            std::cerr << "[opendaq] descriptor refresh for \"" << nodeId << "\" failed: " << e.what() << "\n";
            return;
        }

        std::vector<service::PropertyDescriptor> changed;
        {
            std::lock_guard<std::mutex> lock(snapshotMutex);
            auto it = descriptorSnapshots.find(nodeId);
            if (it == descriptorSnapshots.end())
                return;  // client has never read this node's descriptors

            for (const auto& d : descriptors)
            {
                const auto dumped = service::toJson(d).dump();
                auto previous = it->second.find(d.id);
                if (previous == it->second.end() || previous->second != dumped)
                {
                    changed.push_back(d);
                    it->second[d.id] = dumped;
                }
            }
        }

        for (const auto& d : changed)
        {
            service::Event event;
            event.kind = service::EventKind::PropertyDescriptorChanged;
            event.node_id = nodeId;
            event.descriptor = d;
            emit(event);
        }
    }

    void queueDescriptorRefresh(const std::string& nodeId)
    {
        {
            std::lock_guard<std::mutex> lock(workMutex);
            workQueue.push_back(nodeId);
        }
        workCv.notify_one();
    }

    void runWorker()
    {
        for (;;)
        {
            std::string nodeId;
            {
                std::unique_lock<std::mutex> lock(workMutex);
                workCv.wait(lock, [this] { return workerStop || !workQueue.empty(); });
                if (workerStop && workQueue.empty())
                    return;
                nodeId = workQueue.front();
                workQueue.pop_front();
            }
            refreshDescriptors(nodeId);
        }
    }

    // Decoding one openDAQ core event. Every parameter openDAQ passes arrives
    // in an untyped dictionary whose keys depend on the event id, so this is
    // the mapping a reader needs to raise the same four server-pushed events
    // from another language.
    void onCoreEvent(const ComponentPtr& sender, const CoreEventArgsPtr& args)
    {
        try
        {
            // quack-snippet shared=core-event-decoding uses=component-node,property-descriptor-enumeration
            const auto parameters = args.getParameters();
            const auto senderId = sender.assigned() ? toStd(sender.getGlobalId()) : std::string{};

            switch (static_cast<CoreEventId>(args.getEventId()))
            {
                case CoreEventId::PropertyValueChanged:
                {
                    service::Event event;
                    event.kind = service::EventKind::PropertyChanged;
                    event.node_id = senderId;
                    event.property_id = describe(parameters.get("Name"));
                    event.value = toJson(parameters.get("Value"));
                    emit(event);
                    queueDescriptorRefresh(senderId);
                    break;
                }
                case CoreEventId::ComponentAdded:
                {
                    const auto added = parameters.get("Component").asPtrOrNull<IComponent>();
                    if (!added.assigned())
                        break;
                    service::Event event;
                    event.kind = service::EventKind::ComponentAdded;
                    event.node = buildNode(added);
                    emit(event);
                    break;
                }
                case CoreEventId::ComponentRemoved:
                {
                    service::Event event;
                    event.kind = service::EventKind::ComponentRemoved;
                    event.node_id = senderId + "/" + describe(parameters.get("Id"));
                    emit(event);
                    break;
                }
                case CoreEventId::ConnectionStatusChanged:
                {
                    const auto status = describe(parameters.get("StatusValue"));
                    if (status == "Connected")
                        break;
                    service::Event event;
                    event.kind = service::EventKind::DeviceDisconnected;
                    event.node_id = senderId;
                    event.reason = status + (parameters.hasKey("Message")
                                                 ? ": " + describe(parameters.get("Message"))
                                                 : std::string{});
                    emit(event);
                    break;
                }
                default:
                    break;
            }
            // quack-snippet end
        }
        catch (const std::exception& e)
        {
            std::cerr << "[opendaq] core event handling failed: " << e.what() << "\n";
        }
    }

    void pump(const std::shared_ptr<Subscription>& sub)
    {
        std::vector<double> values(kPumpBufferSamples);
        std::vector<std::int64_t> domain(kPumpBufferSamples);

        while (!sub->stop)
        {
            SizeT count = kPumpBufferSamples;
            ReaderStatusPtr status;
            try
            {
                // quack-snippet capability=streaming.decimated,streaming.raw step=3
                status = sub->reader.readWithDomain(values.data(), domain.data(), &count, kPumpTimeoutMs);
                // quack-snippet end
            }
            catch (const std::exception& e)
            {
                std::cerr << "[opendaq] read on subscription " << sub->id << " failed: " << e.what() << "\n";
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
                continue;
            }

            if (count > 0 && sub->sink)
                sub->sink(sub->id, static_cast<std::uint64_t>(domain[0]), values.data(), static_cast<std::size_t>(count));

            // quack-snippet capability=streaming.decimated,streaming.raw step=4
            // A descriptor change invalidates the reader: readWithDomain
            // returns an invalid status once and every later read would keep
            // returning nothing, so the reader has to be built again over the
            // same signal. This is the same construction subscribe_signal does.
            if (status.assigned() && !status.getValid())
            {
                try
                {
                    sub->reader = StreamReader(sub->signal, SampleType::Float64, SampleType::Int64);
                }
                catch (const std::exception& e)
                {
                    std::cerr << "[opendaq] could not rebuild reader " << sub->id << ": " << e.what() << "\n";
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                }
            }
            // quack-snippet end

            if (count == 0)
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
    }
};

// ---------------------------------------------------------------------------

DaqBackend::DaqBackend(const std::string& modulePath, int logLevel)
    : impl_(std::make_unique<Impl>())
{
    // Both values arrive from manifest.json; neither is hardcoded anywhere in
    // this source tree. OPENDAQ_LOG_LEVEL is what openDAQ's logger components
    // consult when a component has no explicit level of its own.
#ifdef _WIN32
    _putenv_s("OPENDAQ_LOG_LEVEL", std::to_string(logLevel).c_str());
#else
    setenv("OPENDAQ_LOG_LEVEL", std::to_string(logLevel).c_str(), 1);
#endif

    auto* impl = impl_.get();

    // quack-snippet shared=instance-with-module-path
    // The Instance is built with the module path from the manifest, and the
    // core-event handler must be attached to the Context's OnCoreEvent before
    // anything is added, or the additions that follow are never announced.
    impl_->instance = InstanceFromBuilder(
        InstanceBuilder().setModulePath(modulePath).setGlobalLogLevel(static_cast<LogLevel>(logLevel)));

    impl_->instance.getContext().getOnCoreEvent() +=
        [impl](const ComponentPtr& sender, const CoreEventArgsPtr& args) { impl->onCoreEvent(sender, args); };
    // quack-snippet end

    impl_->worker = std::thread([impl] { impl->runWorker(); });
}

DaqBackend::~DaqBackend()
{
    std::vector<std::shared_ptr<Impl::Subscription>> pending;
    {
        std::lock_guard<std::mutex> lock(impl_->subMutex);
        for (auto& [id, sub] : impl_->subscriptions)
            pending.push_back(sub);
        impl_->subscriptions.clear();
    }
    for (auto& sub : pending)
    {
        sub->stop = true;
        if (sub->thread.joinable())
            sub->thread.join();
        sub->reader = nullptr;
    }

    impl_->workerStop = true;
    impl_->workCv.notify_all();
    if (impl_->worker.joinable())
        impl_->worker.join();

    impl_->eventSink = nullptr;
    impl_->instance = nullptr;
}

void DaqBackend::setEventSink(service::EventSink sink)
{
    impl_->eventSink = std::move(sink);
}

std::string DaqBackend::rootId() const
{
    return toStd(impl_->instance.getRootDevice().getGlobalId());
}

// --- scan_available_devices ------------------------------------------------

std::vector<service::DeviceInfo> DaqBackend::scanAvailableDevices()
{
    ListPtr<IDeviceInfo> available;
    try
    {
        // quack-snippet capability=device.scan uses=instance-with-module-path step=1
        // Discovery. Every loaded module is asked what it can see right now;
        // the answer is DeviceInfo objects, not devices. Nothing is added to
        // the Instance and no connection is opened by this call, which is why
        // it is a separate capability from device.connect.
        available = impl_->instance.getAvailableDevices();
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    std::vector<service::DeviceInfo> out;
    for (const auto& info : available)
    {
        if (!info.assigned())
            continue;

        service::DeviceInfo entry;
        // quack-snippet capability=device.scan step=2
        // The three fields the wire carries. getConnectionString is precisely
        // the string connect_device takes back; the serial number is a plain
        // DeviceInfo property that many devices leave empty.
        entry.connection_string = toStd(info.getConnectionString());
        entry.name = toStd(info.getName());
        const auto serial = toStd(info.getSerialNumber());
        // quack-snippet end
        if (!serial.empty())
            entry.serial = serial;

        out.push_back(std::move(entry));
    }

    std::cout << "[service] scan_available_devices: discovery reported " << out.size() << " device(s)";
    for (const auto& entry : out)
        std::cout << "\n[service]   " << entry.connection_string << "  (name " << entry.name << ", serial "
                  << (entry.serial ? *entry.serial : std::string("none")) << ")";
    std::cout << std::endl;
    return out;
}

// --- disconnect_device -----------------------------------------------------

void DaqBackend::disconnectDevice(const std::string& nodeId)
{
    const auto component = impl_->resolve(nodeId);

    // quack-snippet capability=device.connect step=2
    // Undoing an addDevice. The component has to be taken through its IDevice
    // facet, because removeDevice is declared over a device, not a component,
    // and the device is removed from the same Instance that added it. openDAQ
    // raises its ComponentRemoved core event for the vanished subtree, which is
    // what becomes the contract's component_removed.
    const auto device = component.asPtrOrNull<IDevice>();
    // quack-snippet end
    if (!device.assigned())
        throw ServiceError(ErrorCode::NotFound,
                           "component \"" + nodeId + "\" is a " + kindOf(component) +
                               ", not a device; disconnect_device takes the node id connect_device answered with");

    try
    {
        // quack-snippet capability=device.connect step=3
        impl_->instance.removeDevice(device);
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    std::cout << "[service] disconnect_device " << nodeId << ": removed from the openDAQ Instance" << std::endl;
}

// --- connect_device --------------------------------------------------------

service::Node DaqBackend::connectDevice(const std::string& connectionString)
{
    // The openDAQ Instance outlives any single WebSocket session, so a browser
    // reload or a second client asks to connect a device that is already added.
    // addDevice() refuses a duplicate, so an already-added device with the same
    // connection string is reused and connect_device stays idempotent.
    DevicePtr existing;
    DevicePtr device;
    try
    {
        // quack-snippet capability=device.connect uses=instance-with-module-path,component-node step=1
        for (const auto& added : impl_->instance.getDevices())
        {
            const auto info = added.getInfo();
            if (info.assigned() && info.getConnectionString().toStdString() == connectionString)
            {
                existing = added;
                break;
            }
        }
        device = existing.assigned() ? existing : impl_->instance.addDevice(connectionString);
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    if (!device.assigned())
        throw ServiceError(ErrorCode::NotFound, "no device at \"" + connectionString + "\"");

    // The component -> Node mapping is the shared region component-node.
    const service::Node node = impl_->buildNode(device);
    std::cout << "[service] connect_device " << connectionString << " -> "
              << (existing.assigned() ? "reusing already-added device " : "added device ") << node.id
              << " (name " << node.name << ")" << std::endl;
    return node;
}

// --- get_component_tree ----------------------------------------------------

std::vector<service::Node> DaqBackend::getComponentTree(const std::optional<std::string>& rootId)
{
    const ComponentPtr root =
        rootId.has_value() ? impl_->resolve(*rootId) : ComponentPtr(impl_->instance.getRootDevice());

    std::vector<ComponentPtr> flat;
    try
    {
        // quack-snippet capability=tree.read uses=component-node
        std::function<void(const ComponentPtr&)> walk = [&flat, &walk](const ComponentPtr& component)
        {
            flat.push_back(component);
            const auto folder = component.asPtrOrNull<IFolder>();
            if (folder.assigned())
                for (const auto& child : folder.getItems())
                    walk(child);
        };
        walk(root);
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    // The component -> Node mapping for each of them is the shared region
    // component-node.
    std::vector<service::Node> nodes;
    nodes.reserve(flat.size());
    for (const auto& component : flat)
        nodes.push_back(impl_->buildNode(component));
    return nodes;
}

// --- get_property_descriptors ----------------------------------------------

std::vector<service::PropertyDescriptor> DaqBackend::getPropertyDescriptors(const std::string& nodeId)
{
    const auto object = impl_->resolvePropertyObject(nodeId);

    ListPtr<IProperty> properties;
    try
    {
        // quack-snippet capability=property.read
        properties = object.getAllProperties();
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    std::vector<service::PropertyDescriptor> out;
    // quack-snippet capability=property.read uses=property-wire-value-type,property-descriptor
    // Each property is described by the shared region property-descriptor; a
    // property whose openDAQ core type has no member of the wire's value_type
    // set is omitted rather than misreported, which is the shared region
    // property-wire-value-type.
    for (const auto& property : properties)
    {
        try
        {
            if (!isRepresentable(property))
                continue;
            out.push_back(toDescriptor(property));
        }
        catch (const std::exception& e)
        {
            std::cerr << "[opendaq] skipping property on \"" << nodeId << "\": " << e.what() << "\n";
        }
    }
    // quack-snippet end

    impl_->snapshot(nodeId, out);
    return out;
}

// --- get_property_value ----------------------------------------------------

service::Json DaqBackend::getPropertyValue(const std::string& nodeId, const std::string& propertyId)
{
    const auto object = impl_->resolvePropertyObject(nodeId);
    impl_->resolveProperty(object, nodeId, propertyId);  // shared region property-by-name

    BaseObjectPtr value;
    try
    {
        // quack-snippet capability=property.read uses=property-by-name
        value = object.getPropertyValue(propertyId);
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    return toJson(value);
}

// --- set_property_value ----------------------------------------------------

void DaqBackend::setPropertyValue(const std::string& nodeId, const std::string& propertyId, const service::Json& value)
{
    const auto object = impl_->resolvePropertyObject(nodeId);
    const auto property = impl_->resolveProperty(object, nodeId, propertyId);  // shared region property-by-name

    // quack-snippet capability=property.write uses=property-by-name
    // openDAQ answers a write to a read-only property with an error code that
    // does not distinguish it from a rejected value, so the flag is read first.
    const bool readOnly = static_cast<bool>(property.getReadOnly());
    // quack-snippet end
    if (readOnly)
        throw ServiceError(ErrorCode::ReadOnly, "property \"" + propertyId + "\" on \"" + nodeId + "\" is read-only");

    BaseObjectPtr converted;
    try
    {
        converted = fromJson(property, value);  // shared region json-to-opendaq-value
    }
    catch (const DaqException& e)
    {
        // Building the value already went through openDAQ (struct fields).
        throw translate(e, MapContext::PropertyWrite);
    }

    try
    {
        // quack-snippet capability=property.write uses=json-to-opendaq-value
        object.setPropertyValue(propertyId, converted);
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        // The property exists (it was resolved above), so a NOTFOUND raised by
        // the write itself means the value was rejected, not the property.
        throw translate(e, MapContext::PropertyWrite);
    }
}

// --- list_function_block_types ---------------------------------------------

std::vector<std::string> DaqBackend::listFunctionBlockTypes()
{
    DictPtr<IString, IFunctionBlockType> types;
    try
    {
        // quack-snippet capability=function_block.add uses=instance-with-module-path step=1
        // What the loaded modules can instantiate right now, as a dictionary
        // keyed by the very type id that add_function_block takes. This is a
        // question about the modules, not about any one component, so it is
        // asked of the Instance.
        types = impl_->instance.getAvailableFunctionBlockTypes();
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    std::vector<std::string> out;
    if (types.assigned())
    {
        // quack-snippet capability=function_block.add step=2
        // The wire carries the ids only. The FunctionBlockType object also
        // knows a display name and a description, which the M1 contract's
        // array-of-string return has no room for.
        for (const auto& [typeId, type] : types)
            out.push_back(StringPtr(typeId).toStdString());
        // quack-snippet end
    }

    std::sort(out.begin(), out.end());
    std::cout << "[service] list_function_block_types: " << out.size() << " type(s) available";
    for (const auto& id : out)
        std::cout << "\n[service]   " << id;
    std::cout << std::endl;
    return out;
}

// --- add_function_block ----------------------------------------------------

service::Node DaqBackend::addFunctionBlock(const std::string& parentId, const std::string& typeId)
{
    const auto parent = impl_->resolve(parentId);

    // quack-snippet capability=function_block.add step=3
    // openDAQ hangs function blocks off a device, so the parent has to carry
    // IDevice. A signal or a plain folder cannot own one.
    const DevicePtr parentDevice = parent.asPtrOrNull<IDevice>();
    // quack-snippet end
    if (!parentDevice.assigned())
        throw ServiceError(ErrorCode::Unsupported,
                           "component \"" + parentId + "\" is a " + kindOf(parent) +
                               "; openDAQ adds a function block to a device, so parent_id must name a device node");

    FunctionBlockPtr added;
    try
    {
        // quack-snippet capability=function_block.add uses=component-node step=4
        // The device instantiates the type and places the new block in its own
        // "FB" folder. That insertion is what makes openDAQ raise its
        // ComponentAdded core event, which this host turns into the contract's
        // component_added -- the operation itself pushes no event of its own.
        added = parentDevice.addFunctionBlock(typeId);
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    if (!added.assigned())
        throw ServiceError(ErrorCode::NotFound,
                           "openDAQ added no function block for type id \"" + typeId + "\" on \"" + parentId +
                               "\"; list_function_block_types names the ids this host can instantiate");

    // The component -> Node mapping is the shared region component-node.
    const service::Node node = impl_->buildNode(added);
    std::cout << "[service] add_function_block " << typeId << " under " << parentId << " -> " << node.id << " (name "
              << node.name << ", " << node.child_ids.size() << " child component(s), " << node.property_ids.size()
              << " property/properties)" << std::endl;
    return node;
}

// --- remove_function_block -------------------------------------------------

void DaqBackend::removeFunctionBlock(const std::string& nodeId)
{
    const auto component = impl_->resolve(nodeId);

    const FunctionBlockPtr functionBlock = component.asPtrOrNull<IFunctionBlock>();
    if (!functionBlock.assigned())
        throw ServiceError(ErrorCode::NotFound,
                           "component \"" + nodeId + "\" is a " + kindOf(component) +
                               ", not a function block; remove_function_block takes the node id "
                               "add_function_block answered with");

    // A Channel is a FunctionBlock in openDAQ's type hierarchy, but it belongs
    // to its device's channel set and no removeFunctionBlock call will take it.
    if (component.asPtrOrNull<IChannel>().assigned())
        throw ServiceError(ErrorCode::NotFound,
                           "component \"" + nodeId +
                               "\" is a channel; a channel is part of its device and is not a removable function "
                               "block, so there is no function block with that id to remove");

    DevicePtr owner;
    // quack-snippet capability=function_block.add step=5
    // A function block is removed through the device that owns it, and openDAQ
    // parents it under that device's "FB" folder rather than under the device
    // directly -- so the owner is the nearest IDevice ancestor, not the parent.
    for (ComponentPtr walker = component.getParent(); walker.assigned(); walker = walker.getParent())
    {
        const DevicePtr candidate = walker.asPtrOrNull<IDevice>();
        if (candidate.assigned())
        {
            owner = candidate;
            break;
        }
    }
    // quack-snippet end

    if (!owner.assigned())
        throw ServiceError(ErrorCode::NotFound,
                           "function block \"" + nodeId +
                               "\" has no device among its ancestors, so no openDAQ device can remove it");

    const std::string ownerId = toStd(ComponentPtr(owner).getGlobalId());
    try
    {
        // quack-snippet capability=function_block.add step=6
        // The removal is what makes openDAQ raise its ComponentRemoved core
        // event, which this host turns into the contract's component_removed.
        owner.removeFunctionBlock(functionBlock);
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    std::cout << "[service] remove_function_block " << nodeId << ": removed by owning device " << ownerId << std::endl;
}

// --- subscribe_signal ------------------------------------------------------

void DaqBackend::subscribeSignal(const std::string& signalId, std::uint32_t subscriptionId, service::SampleSink sink)
{
    const auto component = impl_->resolve(signalId);

    // quack-snippet capability=streaming.decimated,streaming.raw step=1
    // Only a component that carries ISignal can be read from, and a
    // StreamReader is what turns that signal into samples: it is asked for
    // Float64 values against an Int64 domain, and openDAQ converts whatever the
    // signal's own descriptor says into those two types.
    const auto signal = component.asPtrOrNull<ISignal>();
    // quack-snippet end
    if (!signal.assigned())
        throw ServiceError(ErrorCode::InvalidValue, "component \"" + signalId + "\" is not a signal");

    auto sub = std::make_shared<Impl::Subscription>();
    sub->id = subscriptionId;
    sub->signal = signal;
    sub->sink = std::move(sink);

    try
    {
        // quack-snippet capability=streaming.decimated,streaming.raw step=2
        sub->reader = StreamReader(signal, SampleType::Float64, SampleType::Int64);
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    {
        std::lock_guard<std::mutex> lock(impl_->subMutex);
        impl_->subscriptions[subscriptionId] = sub;
    }

    auto* impl = impl_.get();
    sub->thread = std::thread([impl, sub] { impl->pump(sub); });
}

// --- unsubscribe_signal ----------------------------------------------------

void DaqBackend::unsubscribeSignal(std::uint32_t subscriptionId)
{
    std::shared_ptr<Impl::Subscription> sub;
    {
        std::lock_guard<std::mutex> lock(impl_->subMutex);
        auto it = impl_->subscriptions.find(subscriptionId);
        if (it == impl_->subscriptions.end())
            return;  // the session registry already reported an unknown id
        sub = it->second;
        impl_->subscriptions.erase(it);
    }

    sub->stop = true;
    if (sub->thread.joinable())
        sub->thread.join();

    // quack-snippet capability=streaming.decimated,streaming.raw step=5
    sub->reader = nullptr;  // releasing the reader disconnects it from the signal
    // quack-snippet end
}

// --- get_device_operation_modes --------------------------------------------

std::vector<std::string> DaqBackend::getDeviceOperationModes(const std::string& nodeId)
{
    // The IDevice facet is the shared region device-of-component; a component
    // that is not a device is refused there with unsupported.
    const DevicePtr device = impl_->deviceOf(nodeId, "get_device_operation_modes");

    std::vector<OperationModeType> modes;
    try
    {
        // quack-snippet capability=device.mode uses=device-of-component,device-available-operation-modes step=1
        // The whole of this operation is two SDK acts: take the component
        // through its IDevice facet, which is the shared region
        // device-of-component, and ask that device which modes it offers, which
        // is the shared region device-available-operation-modes. Everything
        // else in this handler is bookkeeping.
        modes = availableOperationModes(device);
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    std::vector<std::string> out;
    out.reserve(modes.size());
    for (const auto mode : modes)
        out.push_back(operationModeWireName(mode));

    OperationModeType current = OperationModeType::Unknown;
    try
    {
        current = device.getOperationMode();
    }
    catch (const DaqException&)
    {
    }

    std::cout << "[service] get_device_operation_modes " << nodeId << ": " << out.size()
              << " mode(s) available, current mode " << operationModeWireName(current);
    for (const auto& name : out)
        std::cout << "\n[service]   " << name;
    std::cout << std::endl;
    return out;
}

// --- set_device_operation_mode ---------------------------------------------

void DaqBackend::setDeviceOperationMode(const std::string& nodeId, const std::string& mode)
{
    const DevicePtr device = impl_->deviceOf(nodeId, "set_device_operation_mode");

    OperationModeType requested = OperationModeType::Unknown;
    if (!operationModeFromWireName(mode, requested))
        throw ServiceError(ErrorCode::InvalidValue,
                           "\"" + mode + "\" is not an operation mode name; contract Node.operation_mode has " +
                               everyOperationModeWireName());

    bool locked = false;
    try
    {
        // quack-snippet capability=device.mode uses=device-of-component step=2
        // A locked device must refuse the write, and openDAQ's
        // setOperationMode does not consult the lock at all -- so the flag is
        // read first, exactly the way set_property_value reads getReadOnly()
        // before writing. read_only is the closed error set's word for
        // "openDAQ will not let this be changed while the target is protected".
        locked = static_cast<bool>(device.isLocked());
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    if (locked)
        throw ServiceError(ErrorCode::ReadOnly,
                           "device \"" + nodeId + "\" is locked, so its operation mode cannot be set to \"" + mode +
                               "\"; unlock_device first");

    std::vector<OperationModeType> available;
    try
    {
        // quack-snippet capability=device.mode uses=device-available-operation-modes step=3
        // The same list the getter answers with, read again here for a
        // different purpose: to judge the requested mode before writing it.
        available = availableOperationModes(device);
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    if (std::find(available.begin(), available.end(), requested) == available.end())
    {
        std::string offered;
        for (const auto candidate : available)
            offered += (offered.empty() ? "" : ", ") + std::string(operationModeWireName(candidate));
        throw ServiceError(ErrorCode::InvalidValue,
                           "device \"" + nodeId + "\" does not offer operation mode \"" + mode +
                               "\"; get_device_operation_modes answers " +
                               (offered.empty() ? std::string("no mode at all") : offered));
    }

    try
    {
        // quack-snippet capability=device.mode uses=operation-mode-names step=4
        // setOperationMode answers OPENDAQ_IGNORED -- a SUCCESS code, not an
        // error -- for a mode the device does not offer, so the write would
        // silently do nothing and the caller would never learn. That is why the
        // available list is checked above and a mode outside it is refused as
        // invalid_value before this call is ever made. The change also
        // propagates to the device's own components, which is why openDAQ has
        // both setOperationMode and setOperationModeRecursive: this is the
        // non-recursive one, so sub-devices keep the mode they are in.
        device.setOperationMode(requested);
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    OperationModeType nowInEffect = OperationModeType::Unknown;
    try
    {
        nowInEffect = device.getOperationMode();
    }
    catch (const DaqException&)
    {
    }

    std::cout << "[service] set_device_operation_mode " << nodeId << " -> " << mode
              << ": openDAQ now reports getOperationMode() as " << operationModeWireName(nowInEffect) << std::endl;
}

// --- lock_device -----------------------------------------------------------

void DaqBackend::lockDevice(const std::string& nodeId)
{
    const DevicePtr device = impl_->deviceOf(nodeId, "lock_device");

    try
    {
        // quack-snippet capability=device.lock uses=device-of-component step=1
        // IDevice::lock() takes no user. openDAQ's other overload,
        // IDevicePrivate::lock(IUser*), records who locked it and permits only
        // that user to unlock; this host builds a local Instance with no
        // authentication, so the lock is anonymous and any later caller may
        // undo it. A device already locked by a DIFFERENT user answers
        // OPENDAQ_ERR_DEVICE_LOCKED, which this host's closed-set mapping turns
        // into read_only -- the refusal the contract names for this row.
        device.lock();
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    bool locked = false;
    try
    {
        locked = static_cast<bool>(device.isLocked());
    }
    catch (const DaqException&)
    {
    }

    std::cout << "[service] lock_device " << nodeId << ": openDAQ isLocked() now reports "
              << (locked ? "true" : "false") << ", which is what every Node.locked under this device will carry"
              << std::endl;
}

// --- unlock_device ---------------------------------------------------------

void DaqBackend::unlockDevice(const std::string& nodeId, bool force)
{
    const DevicePtr device = impl_->deviceOf(nodeId, "unlock_device");

    try
    {
        if (force)
        {
            // quack-snippet capability=device.lock uses=device-of-component step=3
            // The forced unlock is not on IDevice at all. It is
            // IDevicePrivate::forceUnlock(), reached by an interface query, and
            // it drops the lock whoever holds it. A build that cannot reach
            // IDevicePrivate raises OPENDAQ_ERR_NOINTERFACE here, which the
            // closed-set mapping turns into unsupported -- the exact code the
            // contract names for a host that cannot serve force: true.
            device.asPtr<IDevicePrivate>().forceUnlock();
            // quack-snippet end
        }
        else
        {
            // quack-snippet capability=device.lock uses=device-of-component step=2
            // IDevice::unlock() answers OPENDAQ_ERR_ACCESSDENIED when another
            // user holds the lock, and that becomes read_only. That refusal is
            // precisely the signal a client turns into the offer to force, so
            // force is a parameter of this same row rather than a row of its
            // own. A device locked anonymously, as this host locks it, unlocks
            // here without any force at all.
            device.unlock();
            // quack-snippet end
        }
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    bool locked = true;
    try
    {
        locked = static_cast<bool>(device.isLocked());
    }
    catch (const DaqException&)
    {
    }

    std::cout << "[service] unlock_device " << nodeId << " (force " << (force ? "true" : "false")
              << ", so openDAQ was asked through " << (force ? "IDevicePrivate::forceUnlock()" : "IDevice::unlock()")
              << "): isLocked() now reports " << (locked ? "true" : "false") << std::endl;
}

// --- list_loaded_modules ---------------------------------------------------

std::vector<service::ModuleInfo> DaqBackend::listLoadedModules()
{
    ListPtr<IModule> modules;
    std::lock_guard<std::mutex> serialiseAgainstLoad(impl_->moduleManagerMutex);
    try
    {
        // quack-snippet capability=module.read uses=instance-with-module-path step=1
        // Every module the Instance loaded out of the manifest's module path.
        // The module manager hangs off the Instance, not off any device, which
        // is why this operation needs no connected device: the answer is a fact
        // about this process, settled when the Instance was built.
        modules = impl_->instance.getModuleManager().getModules();
        // quack-snippet end
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    std::vector<service::ModuleInfo> out;
    for (const auto& module : modules)
    {
        if (!module.assigned())
            continue;

        try
        {
            out.push_back(describeModule(module));
        }
        catch (const DaqException& e)
        {
            std::cerr << "[opendaq] skipping a loaded module whose IModuleInfo could not be read: "
                      << e.getErrorMessage() << "\n";
            continue;
        }
    }

    std::size_t typeCount = 0;
    for (const auto& entry : out)
        typeCount += entry.component_types.size();

    std::cout << "[service] list_loaded_modules: the module manager holds " << out.size() << " module(s) offering "
              << typeCount << " component type(s) in total";
    for (const auto& entry : out)
    {
        std::cout << "\n[service]   " << entry.id << "  (name " << entry.name << ", version "
                  << (entry.version ? *entry.version : std::string("none reported")) << ", "
                  << entry.component_types.size() << " component type(s))";
        for (const auto& type : entry.component_types)
            std::cout << "\n[service]     " << type.kind << " " << type.id << "  (name " << type.name << ", prefix "
                      << (type.connection_string_prefix ? *type.connection_string_prefix : std::string("none")) << ")";
    }
    std::cout << std::endl;
    return out;
}

// --- load_module_from_host_path --------------------------------------------

namespace
{

// How many device types and function block types the Instance offers right now.
// Printed either side of a load so the log carries the literal numbers a loaded
// module moved, rather than the assertion that it moved something.
struct InstantiableTypeCounts
{
    std::size_t device_types = 0;
    std::size_t function_block_types = 0;
};

InstantiableTypeCounts countInstantiableTypes(const InstancePtr& instance)
{
    InstantiableTypeCounts counts;
    try
    {
        const auto deviceTypes = instance.getAvailableDeviceTypes();
        if (deviceTypes.assigned())
            counts.device_types = static_cast<std::size_t>(deviceTypes.getCount());
    }
    catch (const DaqException&)
    {
    }
    try
    {
        const auto functionBlockTypes = instance.getAvailableFunctionBlockTypes();
        if (functionBlockTypes.assigned())
            counts.function_block_types = static_cast<std::size_t>(functionBlockTypes.getCount());
    }
    catch (const DaqException&)
    {
    }
    return counts;
}

}  // namespace

service::ModuleInfo DaqBackend::loadModuleFromHostPath(const std::string& hostPath)
{
    // hostPath names a file on the machine THIS process runs on. openDAQ's
    // IModuleManager has no overload that takes module bytes -- loadModule
    // takes a path, addModule takes an already-constructed IModule -- so there
    // is nothing uploaded here and nothing spooled to a temporary file.
    if (hostPath.empty())
        throw ServiceError(ErrorCode::InvalidValue,
                           "params.host_path is empty; it must name a module file on the filesystem of the machine "
                           "this host runs on, for example "
                           "\"C:/openDAQ/bin/Release/ref_device_module-64-3.module.dll\"");

    std::error_code filesystemError;
    const std::filesystem::path requested(hostPath);
    std::filesystem::path resolved = std::filesystem::absolute(requested, filesystemError);
    if (filesystemError)
    {
        resolved = requested;
        filesystemError.clear();
    }

    // openDAQ checks the file extension before it checks that the file is
    // there, so a path carried over from another machine comes back as "wrong
    // extension" when the true answer is that this host has no such file.
    // Existence is settled here first and answered as not_found, naming the
    // absolute path this process resolved so the caller can see what was tried.
    if (!std::filesystem::exists(resolved, filesystemError))
        throw ServiceError(ErrorCode::NotFound,
                           "host_path \"" + hostPath + "\" resolves to \"" + resolved.string() +
                               "\" on this host's filesystem and no file exists there" +
                               (filesystemError ? " (" + filesystemError.message() + ")" : std::string{}));

    const InstantiableTypeCounts before = countInstantiableTypes(impl_->instance);

    ModulePtr loaded;
    {
        std::lock_guard<std::mutex> serialiseAgainstList(impl_->moduleManagerMutex);
        try
        {
            // quack-snippet capability=module.load uses=instance-with-module-path step=1
            // The one openDAQ call that loads a module that was not swept out of
            // the module path at construction. It takes an ABSOLUTE path on the
            // filesystem of the process that runs it -- there is no bytes-in
            // sibling on IModuleManager -- and the extension it insists on is
            // the one this platform builds modules with: ".module.dll" on
            // Windows, ".dylib" on macOS, ".module.so" elsewhere. It both loads
            // and adds, so the module is in getModules() the moment it returns,
            // and the module it hands back IS the loaded module: no re-listing
            // is needed to describe what just arrived.
            loaded = impl_->instance.getModuleManager().loadModule(resolved.string());
            // quack-snippet end
        }
        catch (const DaqException& e)
        {
            throw translate(e, MapContext::ModuleLoad);
        }
    }

    if (!loaded.assigned())
        throw ServiceError(ErrorCode::Internal,
                           "openDAQ's IModuleManager::loadModule(\"" + resolved.string() +
                               "\") reported success but handed back no module object");

    service::ModuleInfo entry;
    try
    {
        entry = describeModule(loaded);
    }
    catch (const DaqException& e)
    {
        throw ServiceError(ErrorCode::Internal,
                           "openDAQ loaded \"" + resolved.string() +
                               "\" but its IModuleInfo could not be read afterwards: " + e.getErrorMessage());
    }

    const InstantiableTypeCounts after = countInstantiableTypes(impl_->instance);

    std::cout << "[service] load_module_from_host_path: asked openDAQ to load \"" << hostPath << "\", resolved on this "
              << "host's filesystem to \"" << resolved.string() << "\"\n"
              << "[service]   loaded module id " << entry.id << "  (name " << entry.name << ", version "
              << (entry.version ? *entry.version : std::string("none reported")) << ", "
              << entry.component_types.size() << " component type(s))";
    for (const auto& type : entry.component_types)
        std::cout << "\n[service]     " << type.kind << " " << type.id << "  (name " << type.name << ", prefix "
                  << (type.connection_string_prefix ? *type.connection_string_prefix : std::string("none")) << ")";
    // What this load changed for every OTHER operation, as literal counts. The
    // M1 contract has five server-pushed events and none of them says "the
    // module set changed", so a client that is not the caller learns this only
    // by asking again; these two lines are what there is to ask about.
    std::cout << "\n[service]   the Instance offered " << before.device_types << " device type(s) and "
              << before.function_block_types << " function block type(s) before this load, and " << after.device_types
              << " device type(s) and " << after.function_block_types << " function block type(s) after it, so "
              << "scan_available_devices, connect_device, list_function_block_types and list_loaded_modules can all "
              << "answer differently from this point on" << std::endl;

    return entry;
}

}  // namespace qs::opendaq
