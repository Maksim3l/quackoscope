// Quackoscope host (C++) -- openDAQ layer.
//
// THE ONLY translation unit that includes an openDAQ header. Nothing here
// knows about sockets, HTTP or the WebSocket envelope; it speaks the service
// layer's DTOs and throws service::ServiceError with codes drawn from the
// closed set by service::mapNativeErrorCode.
//
// Every operation marks the SDK calls a reader would need in order to write
// that same operation against openDAQ in another language, inside
//     // region: snippet ... // endregion
// markers. Where several operations share a mechanism -- kindOf, buildNode,
// wireValueType, toDescriptor, fromJson, resolveProperty's getProperty, the
// core-event decoding -- that helper carries its own region and the operations
// point at it by name, so a marked region is separable and comparable across
// languages without silently duplicating the shared part.
//
// Session bookkeeping, JSON marshalling into service::Json, node-id registry
// lookups (resolve/resolvePropertyObject) and the native-error-code mapping
// stay OUTSIDE every region: they are this host's plumbing, not openDAQ.

#include "opendaq/daq_backend.hpp"

#include "service/error.hpp"

#include <opendaq/opendaq.h>

#include <atomic>
#include <condition_variable>
#include <cstdlib>
#include <deque>
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

// How a component's kind is decided. Shared by buildNode; referenced from
// connect_device, get_component_tree and the core-event decoding.
const char* kindOf(const ComponentPtr& component)
{
    // region: snippet
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
    // endregion
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
    // region: snippet
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
    // endregion
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
// property. Shared by get_property_descriptors and by the descriptor re-read
// that answers a value change, so it carries the region and both point here.
service::PropertyDescriptor toDescriptor(const PropertyPtr& property)
{
    service::PropertyDescriptor d;
    // region: snippet
    d.name = toStd(property.getName());
    d.id = d.name;  // openDAQ property names are the identifiers
    wireValueType(property, d.value_type);  // its own region, above
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
    // endregion

    return d;
}

// JSON -> openDAQ value, shaped by the property's declared type. Coercion and
// validation stay openDAQ's business: this only builds a value of the right
// kind and lets setPropertyValue judge it.
BaseObjectPtr fromJson(const PropertyPtr& property, const service::Json& value)
{
    // region: snippet
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
    // endregion

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

    PropertyPtr resolveProperty(const PropertyObjectPtr& object, const std::string& nodeId, const std::string& name) const
    {
        try
        {
            // region: snippet
            return object.getProperty(name);
            // endregion
        }
        catch (const DaqException& e)
        {
            throw ServiceError(service::mapNativeErrorCode(static_cast<std::uint32_t>(e.getErrCode())),
                               "property \"" + name + "\" not found on \"" + nodeId + "\": " + e.getErrorMessage());
        }
    }

    // The whole component -> Node mapping. Shared by connect_device,
    // get_component_tree and the component_added core event, so it carries the
    // region and all three point here.
    service::Node buildNode(const ComponentPtr& component) const
    {
        service::Node node;
        // region: snippet
        // Identity, then the two structural facts openDAQ exposes: a component
        // knows its parent, and a component that is a Folder knows its items.
        // Properties come from the IPropertyObject facet, which most but not
        // all components have.
        node.id = toStd(component.getGlobalId());
        node.name = toStd(component.getName());
        node.kind = kindOf(component);  // its own region, above

        if (const auto parent = component.getParent(); parent.assigned())
            node.parent_id = toStd(parent.getGlobalId());

        if (const auto folder = component.asPtrOrNull<IFolder>(); folder.assigned())
            for (const auto& child : folder.getItems())
                node.child_ids.push_back(toStd(child.getGlobalId()));

        if (const auto object = component.asPtrOrNull<IPropertyObject>(); object.assigned())
            for (const auto& property : object.getAllProperties())
                if (isRepresentable(property))  // wireValueType's region, above
                    node.property_ids.push_back(toStd(property.getName()));
        // endregion

        return node;
    }

    std::vector<service::PropertyDescriptor> describeProperties(const PropertyObjectPtr& object) const
    {
        std::vector<service::PropertyDescriptor> out;
        // region: snippet
        // Same enumeration get_property_descriptors performs, reached from the
        // core-event side instead of from a request.
        for (const auto& property : object.getAllProperties())
        {
            try
            {
                if (!isRepresentable(property))       // wireValueType's region, above
                    continue;
                out.push_back(toDescriptor(property));  // its own region, above
            }
            catch (const std::exception& e)
            {
                std::cerr << "[opendaq] skipping property \"" << toStd(property.getName())
                          << "\": " << e.what() << "\n";
            }
        }
        // endregion
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
            // region: snippet
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
            // endregion
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
                // region: snippet
                status = sub->reader.readWithDomain(values.data(), domain.data(), &count, kPumpTimeoutMs);
                // endregion
            }
            catch (const std::exception& e)
            {
                std::cerr << "[opendaq] read on subscription " << sub->id << " failed: " << e.what() << "\n";
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
                continue;
            }

            if (count > 0 && sub->sink)
                sub->sink(sub->id, static_cast<std::uint64_t>(domain[0]), values.data(), static_cast<std::size_t>(count));

            // region: snippet
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
            // endregion

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

    // region: snippet
    // The Instance is built with the module path from the manifest, and the
    // core-event handler must be attached to the Context's OnCoreEvent before
    // anything is added, or the additions that follow are never announced.
    impl_->instance = InstanceFromBuilder(
        InstanceBuilder().setModulePath(modulePath).setGlobalLogLevel(static_cast<LogLevel>(logLevel)));

    impl_->instance.getContext().getOnCoreEvent() +=
        [impl](const ComponentPtr& sender, const CoreEventArgsPtr& args) { impl->onCoreEvent(sender, args); };
    // endregion

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

void DaqBackend::releaseDevice(const std::string& nodeId)
{
    const auto component = impl_->resolve(nodeId);
    const auto device = component.asPtrOrNull<IDevice>();
    if (!device.assigned())
        throw ServiceError(ErrorCode::InvalidValue, "component \"" + nodeId + "\" is not a device");

    try
    {
        // region: snippet
        impl_->instance.removeDevice(device);
        // endregion
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }
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
        // region: snippet
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
        // endregion
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    if (!device.assigned())
        throw ServiceError(ErrorCode::NotFound, "no device at \"" + connectionString + "\"");

    // The component -> Node mapping is buildNode's region.
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
        // region: snippet
        std::function<void(const ComponentPtr&)> walk = [&flat, &walk](const ComponentPtr& component)
        {
            flat.push_back(component);
            const auto folder = component.asPtrOrNull<IFolder>();
            if (folder.assigned())
                for (const auto& child : folder.getItems())
                    walk(child);
        };
        walk(root);
        // endregion
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    // The component -> Node mapping for each of them is buildNode's region.
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
        // region: snippet
        properties = object.getAllProperties();
        // endregion
    }
    catch (const DaqException& e)
    {
        throw translate(e);
    }

    std::vector<service::PropertyDescriptor> out;
    // region: snippet
    // Each property is described by toDescriptor (its own region); a property
    // whose openDAQ core type has no member of the wire's value_type set is
    // omitted rather than misreported, which is wireValueType's region.
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
    // endregion

    impl_->snapshot(nodeId, out);
    return out;
}

// --- get_property_value ----------------------------------------------------

service::Json DaqBackend::getPropertyValue(const std::string& nodeId, const std::string& propertyId)
{
    const auto object = impl_->resolvePropertyObject(nodeId);
    impl_->resolveProperty(object, nodeId, propertyId);  // getProperty is its own region

    BaseObjectPtr value;
    try
    {
        // region: snippet
        value = object.getPropertyValue(propertyId);
        // endregion
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
    const auto property = impl_->resolveProperty(object, nodeId, propertyId);  // getProperty is its own region

    // region: snippet
    // openDAQ answers a write to a read-only property with an error code that
    // does not distinguish it from a rejected value, so the flag is read first.
    const bool readOnly = static_cast<bool>(property.getReadOnly());
    // endregion
    if (readOnly)
        throw ServiceError(ErrorCode::ReadOnly, "property \"" + propertyId + "\" on \"" + nodeId + "\" is read-only");

    BaseObjectPtr converted;
    try
    {
        converted = fromJson(property, value);  // its own region
    }
    catch (const DaqException& e)
    {
        // Building the value already went through openDAQ (struct fields).
        throw translate(e, MapContext::PropertyWrite);
    }

    try
    {
        // region: snippet
        object.setPropertyValue(propertyId, converted);
        // endregion
    }
    catch (const DaqException& e)
    {
        // The property exists (it was resolved above), so a NOTFOUND raised by
        // the write itself means the value was rejected, not the property.
        throw translate(e, MapContext::PropertyWrite);
    }
}

// --- subscribe_signal ------------------------------------------------------

void DaqBackend::subscribeSignal(const std::string& signalId, std::uint32_t subscriptionId, service::SampleSink sink)
{
    const auto component = impl_->resolve(signalId);

    // region: snippet
    // Only a component that carries ISignal can be read from, and a
    // StreamReader is what turns that signal into samples: it is asked for
    // Float64 values against an Int64 domain, and openDAQ converts whatever the
    // signal's own descriptor says into those two types.
    const auto signal = component.asPtrOrNull<ISignal>();
    // endregion
    if (!signal.assigned())
        throw ServiceError(ErrorCode::InvalidValue, "component \"" + signalId + "\" is not a signal");

    auto sub = std::make_shared<Impl::Subscription>();
    sub->id = subscriptionId;
    sub->signal = signal;
    sub->sink = std::move(sink);

    try
    {
        // region: snippet
        sub->reader = StreamReader(signal, SampleType::Float64, SampleType::Int64);
        // endregion
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

    // region: snippet
    sub->reader = nullptr;  // releasing the reader disconnects it from the signal
    // endregion
}

}  // namespace qs::opendaq
