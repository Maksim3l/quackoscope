"""Quackoscope host (Python) -- openDAQ layer.

The only module in this host that imports opendaq. It answers the service
layer's vocabulary (Node, PropertyDescriptor, plain JSON values) and knows
nothing about sockets.

The openDAQ calls of every operation sit inside quack-snippet markers, the same
syntax hosts/cpp/src/opendaq/daq_backend.cpp uses, so that
tools/snippet-extractor can put the C++ and the Python spelling of one
capability side by side:

    (hash) quack-snippet capability=<id>[,<id>...] [uses=<name>,...] [step=<n>]
    (hash) quack-snippet end

    (hash) quack-snippet shared=<name> [uses=<name>,...] [step=<n>]
    (hash) quack-snippet end

where (hash) is the Python comment character. It is spelled out here rather
than written literally because tools/snippet-extractor reads every comment in
this file that starts with the marker word, and would otherwise try to parse
this documentation as four malformed markers and fail the build.

Everything that is this host's own plumbing -- locks, registries, error
translation, thread management -- stays OUTSIDE every region.
"""

import collections
import json
import os
import sys
import threading
import time

from service.wire_dtos import (
    ComponentAttribute,
    ComponentTypeInfo,
    ModuleInfo,
    Node,
    PropertyDescriptor,
    component_added_envelope,
    component_removed_envelope,
    device_disconnected_envelope,
    property_changed_envelope,
    property_descriptor_changed_envelope,
    property_descriptor_to_json,
)
from service.wire_errors import (
    CONTEXT_GENERAL,
    CONTEXT_PROPERTY_WRITE,
    INTERNAL,
    INVALID_VALUE,
    NOT_CONNECTED,
    NOT_FOUND,
    READ_ONLY,
    UNSUPPORTED,
    ServiceError,
    map_native_error_code,
    map_native_error_message,
    narrow_to_declared_error_subset,
)

_PUMP_BUFFER_SAMPLES = 4096
_PUMP_TIMEOUT_MS = 100

# The three enum vocabularies the M1 contract added to types.Node, each mapped
# from the openDAQ member name that produces it. openDAQ's names are CamelCase
# and the contract's are the same words lowercased into the frozen wire join, so
# a generic camelCase-to-snake_case rule would produce all six of these
# correctly today and would silently invent a wire value the day openDAQ adds a
# member -- these tables are written out instead, and a member absent from a
# table is reported as null rather than as a guessed string.
#
# openDAQ side, verified by reading the running SDK on this machine:
#   ComponentStatusType   Ok, Warning, Error
#     (core/opendaq/modulemanager/src/context_impl.cpp)
#   ConnectionStatusType  Connected, Reconnecting, Unrecoverable, Removed
#   OperationModeType     Unknown = 0, Idle = 1, Operation = 2, SafeOperation = 3
#     (core/opendaq/component/include/opendaq/component.h)
_WIRE_COMPONENT_STATUS_BY_OPENDAQ_NAME = {
    "Ok": "ok",
    "Warning": "warning",
    "Error": "error",
}
_WIRE_CONNECTION_STATUS_BY_OPENDAQ_NAME = {
    "Connected": "connected",
    "Reconnecting": "reconnecting",
    "Unrecoverable": "unrecoverable",
    "Removed": "removed",
}
_WIRE_OPERATION_MODE_BY_OPENDAQ_NAME = {
    "Unknown": "unknown",
    "Idle": "idle",
    "Operation": "operation",
    "SafeOperation": "safe_operation",
}
_OPENDAQ_OPERATION_MODE_NAME_BY_WIRE = {
    wire_name: opendaq_name
    for opendaq_name, wire_name in _WIRE_OPERATION_MODE_BY_OPENDAQ_NAME.items()
}

# The status keys IComponentStatusContainer is keyed by. They are openDAQ's own
# strings, not the contract's field names.
_COMPONENT_STATUS_KEY = "ComponentStatus"
_CONNECTION_STATUS_KEY = "ConnectionStatus"

# The error subsets contract/contract.yaml declares for the five operations
# added with device.mode, device.lock and module.read. Answering outside one of
# these is a conformance defect, so every native failure on those paths is put
# through narrow_to_declared_error_subset against the list here.
_DECLARED_ERRORS = {
    "get_device_operation_modes": (NOT_FOUND, NOT_CONNECTED, UNSUPPORTED),
    # NO read_only. It used to be here, because the contract used to read
    # "read_only: the device is locked". openDAQ does not do that:
    # GenericDevice::setOperationMode (device_impl.h:1257-1281) consults no lock
    # at all, and the device lock refuses writes only in the config-protocol
    # server (config_server_access_control.h:75-81), which this in-process host
    # is never on. Verified on openDAQ 3.41.0_bec37b44 on this machine:
    # daqref://device0 was locked and `device.operation_mode = Idle` then
    # succeeded and read back 1.
    "set_device_operation_mode": (NOT_FOUND, INVALID_VALUE, UNSUPPORTED),
    "lock_device": (NOT_FOUND, READ_ONLY, UNSUPPORTED),
    "unlock_device": (NOT_FOUND, READ_ONLY, UNSUPPORTED),
    "list_loaded_modules": (NOT_CONNECTED, INTERNAL),
    "load_module_from_host_path": (NOT_FOUND, NOT_CONNECTED, INVALID_VALUE, INTERNAL),
    "get_component_attributes": (NOT_FOUND, NOT_CONNECTED, INVALID_VALUE),
    "set_component_attribute": (NOT_FOUND, READ_ONLY, INVALID_VALUE),
    "list_server_types": (NOT_CONNECTED,),
    "add_server": (NOT_CONNECTED, UNSUPPORTED, INVALID_VALUE, INTERNAL),
    "remove_server": (NOT_FOUND, UNSUPPORTED, INTERNAL),
    "set_server_discovery_enabled": (NOT_FOUND, UNSUPPORTED, INTERNAL, INVALID_VALUE),
    "start_recording": (NOT_FOUND, UNSUPPORTED, INTERNAL, INVALID_VALUE),
    "stop_recording": (NOT_FOUND, UNSUPPORTED, INTERNAL),
    "begin_batched_property_update": (NOT_FOUND, NOT_CONNECTED, INVALID_VALUE),
    "end_batched_property_update": (NOT_FOUND, NOT_CONNECTED, INVALID_VALUE),
    "save_instance_configuration_to_string": (NOT_CONNECTED, INTERNAL),
    "load_instance_configuration_from_string": (NOT_CONNECTED, INVALID_VALUE, INTERNAL),
}

# The attribute rows of the reference's ATTRIBUTES treeview
# (gui_demo/components/generic_attributes_treeview.py:126-166), each as
# (wire id, the label the reference prints, the wire value_type, the Locked flag
# the reference hardcodes, the openDAQ Python attribute name to getattr/setattr).
#
# The wire id and the binding's attribute name differ on exactly three rows, and
# contract/contract.yaml section 3 says why: the reference's own Attribute keys
# there are '.domain_signal', 'related_signals' and 'signal', while what crosses
# the wire is a GLOBAL ID STRING read off the object those names hold. So the
# wire id carries the _id/_ids suffix and this table remembers the shorter name
# the SDK answers to.
#
# The five signal rows and the three input-port rows are added only when the
# component carries that cast, which is what makes the attribute set per-kind
# rather than fixed.
_ATTRIBUTE_VALUE_TYPE_BOOL = "bool"
_ATTRIBUTE_VALUE_TYPE_STRING = "string"
_ATTRIBUTE_VALUE_TYPE_STRING_LIST = "string_list"

_COMPONENT_ATTRIBUTE_ROWS = (
    ("name", "Name", _ATTRIBUTE_VALUE_TYPE_STRING, False, "name"),
    ("description", "Description", _ATTRIBUTE_VALUE_TYPE_STRING, False, "description"),
    ("active", "Active", _ATTRIBUTE_VALUE_TYPE_BOOL, False, "active"),
    ("global_id", "Global ID", _ATTRIBUTE_VALUE_TYPE_STRING, True, "global_id"),
    ("local_id", "Local ID", _ATTRIBUTE_VALUE_TYPE_STRING, True, "local_id"),
    ("tags", "Tags", _ATTRIBUTE_VALUE_TYPE_STRING_LIST, False, "tags"),
    ("visible", "Visible", _ATTRIBUTE_VALUE_TYPE_BOOL, False, "visible"),
)
_SIGNAL_ATTRIBUTE_ROWS = (
    ("public", "Public", _ATTRIBUTE_VALUE_TYPE_BOOL, False, "public"),
    ("domain_signal_id", "Domain Signal ID", _ATTRIBUTE_VALUE_TYPE_STRING, True, "domain_signal"),
    (
        "related_signal_ids",
        "Related Signals IDs",
        _ATTRIBUTE_VALUE_TYPE_STRING_LIST,
        True,
        "related_signals",
    ),
    ("streamed", "Streamed", _ATTRIBUTE_VALUE_TYPE_BOOL, True, "streamed"),
    ("last_value", "Last Value", None, True, "last_value"),
)
_INPUT_PORT_ATTRIBUTE_ROWS = (
    ("public", "Public", _ATTRIBUTE_VALUE_TYPE_BOOL, False, "public"),
    ("signal_id", "Signal ID", _ATTRIBUTE_VALUE_TYPE_STRING, True, "signal"),
    ("requires_signal", "Requires Signal", _ATTRIBUTE_VALUE_TYPE_BOOL, True, "requires_signal"),
)

# openDAQ core event ids, copied from CoreEventId in
# core/coreobjects/include/coreobjects/core_event_args_ids.h. The Python
# bindings hand the id over as a plain int on ICoreEventArgs.event_id, so the
# four this host acts on are spelled out numerically. Every other id --
# TypeAdded (130), DataDescriptorChanged (80), DeviceOperationModeChanged (180)
# and the rest -- is deliberately ignored: the M1 contract has five events and
# no envelope to carry those in.
_CORE_EVENT_PROPERTY_VALUE_CHANGED = 0
_CORE_EVENT_COMPONENT_ADDED = 40
_CORE_EVENT_COMPONENT_REMOVED = 50
_CORE_EVENT_CONNECTION_STATUS_CHANGED = 170


def import_opendaq_from_module_path(module_path):
    """The bindings and the SDK DLLs live in the same directory, the one
    manifest.json names. Both the import path and the DLL search path have to
    point at it before `import opendaq` can succeed."""
    if os.name == "nt":
        os.environ["PATH"] = module_path + os.pathsep + os.environ.get("PATH", "")
        os.add_dll_directory(module_path)
    if module_path not in sys.path:
        sys.path.insert(0, module_path)
    import opendaq  # noqa: E402

    return opendaq


class _NativeErrorTranslator:
    """openDAQ's Python bindings raise plain Python exceptions. When one carries
    a numeric ErrCode the closed-set mapping uses it; otherwise the native
    message text is the only classifier left."""

    @staticmethod
    def translate(exception, context=CONTEXT_GENERAL):
        native_code = getattr(exception, "error_code", None)
        if native_code is None:
            native_code = getattr(exception, "errCode", None)
        message = str(exception)
        if isinstance(native_code, int):
            return ServiceError(map_native_error_code(native_code & 0xFFFFFFFF, context), message)
        return ServiceError(map_native_error_message(message, context), message)


class DaqBackend:
    """One openDAQ Instance, the devices added to it, and the reader threads."""

    def __init__(self, module_path, log_level):
        # Both values arrive from manifest.json; neither is hardcoded anywhere
        # in this source tree. OPENDAQ_LOG_LEVEL is what openDAQ's logger
        # components consult when a component has no explicit level of its own.
        os.environ["OPENDAQ_LOG_LEVEL"] = str(log_level)
        self._daq = import_opendaq_from_module_path(module_path)

        print(
            "[opendaq] constructing an openDAQ Instance with module_path = %s and "
            "OPENDAQ_LOG_LEVEL = %d" % (module_path, log_level),
            flush=True,
        )
        # quack-snippet shared=instance-with-module-path
        # The Instance is built with the module path from the manifest, which is
        # the directory openDAQ scans for its module DLLs.
        builder = self._daq.InstanceBuilder()
        builder.add_module_path(module_path)
        instance = builder.build()
        # quack-snippet end
        self._instance = instance

        # Kept so load_module_from_host_path can name, in its refusal of a
        # relative path, the directory this host already swept for modules.
        self._module_path = module_path

        # load_module mutates the module manager, and every live WebSocket
        # session shares one. Two sessions loading at once is serialised here.
        self._module_load_lock = threading.Lock()

        self._device_lock = threading.Lock()
        self._device_node_ids_by_connection_string = {}
        self._subscription_lock = threading.Lock()
        self._subscriptions = {}

        # Where the five contract events go once the host has wired a sink.
        self._event_sink = None

        # Descriptor snapshots, keyed by component global id then property id,
        # each value the JSON text of the descriptor as the client last saw it.
        # openDAQ raises no "property descriptor changed" core event, so a
        # descriptor change is found by re-reading the descriptors after a value
        # write and diffing against the snapshot.
        self._descriptor_snapshot_lock = threading.Lock()
        self._descriptor_snapshots_by_node_id = {}

        # A core-event callback runs on openDAQ's own thread while the property
        # object it belongs to is still being mutated; re-entering the SDK from
        # there to re-read every descriptor risks deadlock, so the re-read is
        # queued onto this worker instead.
        self._descriptor_refresh_condition = threading.Condition()
        self._descriptor_refresh_queue = collections.deque()
        self._descriptor_refresh_stopping = False
        self._descriptor_refresh_worker = threading.Thread(
            target=self._run_descriptor_refresh_worker,
            name="quackoscope-descriptor-refresh",
            daemon=True,
        )
        self._descriptor_refresh_worker.start()

        # quack-snippet shared=instance-with-module-path step=1
        # The core-event handler has to be attached to the Context's OnCoreEvent
        # before anything is added, or the additions that follow are never
        # announced. The per-component hook (component.on_component_core_event)
        # fires only for events raised on that one component, so the Context's
        # is the hook that sees the whole tree.
        self._core_event_handler = self._daq.EventHandler(self._on_core_event)
        self._instance.context.on_core_event.add_handler(self._core_event_handler)
        # quack-snippet end

        print(
            "[opendaq] Instance constructed; its root component global id is %s, and core event "
            "ids %d (PropertyValueChanged), %d (ComponentAdded), %d (ComponentRemoved) and %d "
            "(ConnectionStatusChanged) are now subscribed on its Context"
            % (
                self._instance.global_id,
                _CORE_EVENT_PROPERTY_VALUE_CHANGED,
                _CORE_EVENT_COMPONENT_ADDED,
                _CORE_EVENT_COMPONENT_REMOVED,
                _CORE_EVENT_CONNECTION_STATUS_CHANGED,
            ),
            flush=True,
        )

    # --- server-pushed events ---------------------------------------------

    def set_event_sink(self, event_sink):
        """The service layer hands over the callable that broadcasts one event
        envelope to every live session."""
        self._event_sink = event_sink
        print(
            "[opendaq] event sink attached: component_added, component_removed, property_changed, "
            "property_descriptor_changed and device_disconnected will be pushed to sessions",
            flush=True,
        )

    def _emit(self, envelope):
        event_sink = self._event_sink
        if event_sink is None:
            print(
                "[opendaq] no event sink is attached, so the %s event raised by the SDK reaches "
                "no session" % envelope.get("event"),
                flush=True,
            )
            return
        event_sink(envelope)

    def _on_core_event(self, sender, args):
        """One openDAQ core event -> at most one M1 contract event. Every
        parameter openDAQ passes arrives in an untyped dictionary whose keys
        depend on the event id, so this is the mapping a reader needs to raise
        the same events from another language."""
        try:
            daq = self._daq
            # quack-snippet shared=core-event-decoding uses=component-node,property-descriptor-enumeration
            core_args = daq.ICoreEventArgs.cast_from(args)
            event_id = int(core_args.event_id)
            parameters = core_args.parameters
            parameter_names = [str(key) for key in parameters.keys()]
            try:
                sender_id = str(daq.IComponent.cast_from(sender).global_id)
            except Exception:
                # TypeAdded and TypeRemoved are raised with no sender component.
                sender_id = ""

            if event_id == _CORE_EVENT_PROPERTY_VALUE_CHANGED:
                # Parameters: Owner, Name, Value, Path. The sender is the
                # component that owns the property object, which is the node id
                # the contract's property_changed carries.
                self._emit(
                    property_changed_envelope(
                        sender_id,
                        str(parameters["Name"]),
                        self._value_to_json(parameters["Value"]),
                    )
                )
                # A write can reshape other descriptors on the same component
                # (openDAQ reference channels hide SampleRate when
                # UseGlobalSampleRate is on), and openDAQ raises no event for
                # that, so the descriptors are re-read and diffed.
                self._queue_descriptor_refresh(sender_id)

            elif event_id == _CORE_EVENT_COMPONENT_ADDED:
                # Parameter: Component, the component that was added. The sender
                # is its parent folder.
                added = parameters["Component"]
                if daq.IComponent.can_cast_from(added):
                    self._emit(
                        component_added_envelope(
                            self._build_node(daq.IComponent.cast_from(added))
                        )
                    )

            elif event_id == _CORE_EVENT_COMPONENT_REMOVED:
                # Parameter: Id, the LOCAL id of the removed component. The
                # global id the contract wants is the sender's plus that.
                self._emit(
                    component_removed_envelope(sender_id + "/" + str(parameters["Id"]))
                )

            elif event_id == _CORE_EVENT_CONNECTION_STATUS_CHANGED:
                # Parameters: StatusName, StatusValue (an Enumeration reading
                # "Connected", "Reconnecting", "Unrecoverable" or "Removed"),
                # ConnectionString, ProtocolType, StreamingObject, Message.
                # Only the statuses that are not "Connected" are a disconnect.
                # The Python bindings stringify an Enumeration as
                # "ConnectionStatusType.Reconnecting" and expose .value as the
                # ordinal, so the bare member name comes off .name.
                status_value = parameters["StatusValue"]
                status = (
                    str(daq.IEnumeration.cast_from(status_value).name)
                    if daq.IEnumeration.can_cast_from(status_value)
                    else str(status_value)
                )
                if status != "Connected":
                    message = parameters["Message"] if "Message" in parameter_names else None
                    self._emit(
                        device_disconnected_envelope(
                            sender_id,
                            status if message is None else "%s: %s" % (status, message),
                        )
                    )
            # quack-snippet end
        except Exception as e:
            print(
                "[opendaq] decoding a core event from sender %r failed: %s: %s"
                % (sender, type(e).__name__, e),
                flush=True,
            )

    # --- descriptor snapshots (plumbing, not a snippet) --------------------

    def _snapshot_descriptors(self, node_id, descriptors):
        """Remember the descriptors exactly as this client was handed them, so a
        later re-read can say which ones actually moved."""
        snapshot = {
            d.id: json.dumps(property_descriptor_to_json(d), sort_keys=True) for d in descriptors
        }
        with self._descriptor_snapshot_lock:
            self._descriptor_snapshots_by_node_id[node_id] = snapshot

    def _queue_descriptor_refresh(self, node_id):
        if not node_id:
            return
        with self._descriptor_refresh_condition:
            if node_id not in self._descriptor_refresh_queue:
                self._descriptor_refresh_queue.append(node_id)
                self._descriptor_refresh_condition.notify()

    def _run_descriptor_refresh_worker(self):
        while True:
            with self._descriptor_refresh_condition:
                while not self._descriptor_refresh_queue and not self._descriptor_refresh_stopping:
                    self._descriptor_refresh_condition.wait()
                if self._descriptor_refresh_stopping and not self._descriptor_refresh_queue:
                    return
                node_id = self._descriptor_refresh_queue.popleft()
            self._refresh_descriptors(node_id)

    def _refresh_descriptors(self, node_id):
        """Re-read one component's descriptors and push
        property_descriptor_changed for every one that moved since the client
        last saw it. A component the client has never read descriptors for has
        no snapshot, and nothing is pushed for it."""
        with self._descriptor_snapshot_lock:
            if node_id not in self._descriptor_snapshots_by_node_id:
                return

        try:
            component = self._resolve_component(node_id)
            property_object = self._as_property_object(component, node_id)
            descriptors = self._describe_properties(property_object)
        except ServiceError as e:
            print(
                '[opendaq] descriptor refresh for "%s" stopped: %s (%s)'
                % (node_id, e.detail, e.code),
                flush=True,
            )
            return
        except Exception as e:
            print(
                '[opendaq] descriptor refresh for "%s" failed: %s: %s'
                % (node_id, type(e).__name__, e),
                flush=True,
            )
            return

        changed = []
        with self._descriptor_snapshot_lock:
            snapshot = self._descriptor_snapshots_by_node_id.get(node_id)
            if snapshot is None:
                return
            for descriptor in descriptors:
                dumped = json.dumps(property_descriptor_to_json(descriptor), sort_keys=True)
                if snapshot.get(descriptor.id) != dumped:
                    changed.append(descriptor)
                    snapshot[descriptor.id] = dumped

        for descriptor in changed:
            self._emit(property_descriptor_changed_envelope(node_id, descriptor))
        print(
            "[opendaq] descriptor refresh of %s re-read %d descriptor(s); %d moved since the "
            "client last read them: %s"
            % (
                node_id,
                len(descriptors),
                len(changed),
                ", ".join(d.id for d in changed) or "none",
            ),
            flush=True,
        )

    def sdk_version(self):
        """What the SDK that actually loaded reports about itself."""
        return str(self._instance.info.sdk_version)

    def instance_server_folder_node_id(self):
        """The global id of the openDAQ Instance's Servers folder, or None if
        this instance carries none.

        A SERVER BELONGS TO NO SESSION, which this host already acts on in
        add_server (IDevice::addServer is called on the INSTANCE, because
        device_impl.h:1465-1476 refuses every other parent), in remove_server
        and in set_server_discovery_enabled. So a server node never lands under
        any connected device: it lands here, at <instance root>/Srv/<type id>,
        and a session that could see only its own devices could not see the
        server it had just created. This is the id that puts that branch of
        openDAQ's one tree back in view.

        Read off the SDK -- IFolder.get_item("Srv") on the instance -- never
        spelled out as a string, so the day openDAQ renames the folder this
        answers the new name or None instead of a stale guess.
        """
        daq = self._daq
        try:
            folder = self._as_folder(self._instance)
            if folder is None or not folder.has_item("Srv"):
                print(
                    "[opendaq] the openDAQ Instance %s carries no item named Srv, so this host "
                    "reports no servers folder in the component tree"
                    % str(self._instance.global_id),
                    flush=True,
                )
                return None
            return str(daq.IComponent.cast_from(folder.get_item("Srv")).global_id)
        except Exception as e:
            print(
                "[opendaq] the servers folder of instance %s could not be read (%s: %s), so the "
                "component tree carries no server rows this time"
                % (str(self._instance.global_id), type(e).__name__, e),
                flush=True,
            )
            return None

    # --- component resolution (plumbing, not a snippet) -------------------

    def _resolve_component(self, node_id):
        """Global ids are unique, so the tree walk from the instance root finds
        exactly one component or none."""
        for component in self._walk_components(self._instance):
            if component.global_id == node_id:
                return component
        raise ServiceError(NOT_FOUND, 'no component with global id "%s" on this instance' % node_id)

    def _walk_components(self, root):
        stack = [root]
        while stack:
            component = stack.pop()
            yield component
            folder = self._as_folder(component)
            if folder is not None:
                for child in folder.items:
                    stack.append(child)

    def _as_folder(self, component):
        daq = self._daq
        try:
            if daq.IFolder.can_cast_from(component):
                return daq.IFolder.cast_from(component)
        except Exception:
            return None
        return None

    def _as_property_object(self, component, node_id):
        daq = self._daq
        try:
            # quack-snippet shared=property-object-of-component
            # get_property_value, set_property_value, begin_update and end_update
            # are all declared on IPropertyObject, not on IComponent, so a
            # component is taken through that facet before any of them is called.
            # Every openDAQ component in the tree carries it -- IComponent
            # derives from IPropertyObject -- which is why the reference casts
            # unconditionally for begin/endUpdate instead of testing first.
            carries_property_object = daq.IPropertyObject.can_cast_from(component)
            property_object = (
                daq.IPropertyObject.cast_from(component) if carries_property_object else None
            )
            # quack-snippet end
            if property_object is not None:
                return property_object
        except Exception:
            pass
        raise ServiceError(
            UNSUPPORTED, 'component "%s" carries no properties' % node_id
        )

    def _as_server(self, component, node_id, wire_method):
        """The IServer facet of a component, or `unsupported`.

        `unsupported` and not `not_found` for the same reason _as_device gives:
        the node exists -- it was just resolved -- it simply is not a server.
        """
        daq = self._daq
        # quack-snippet shared=server-of-component
        # enableDiscovery and disableDiscovery are declared on IServer and
        # nowhere else, and IDevice::removeServer takes an IServer* argument
        # (device.h:300-304), so a component has to be taken through its IServer
        # facet before any of the three can be reached. Asking with can_cast_from
        # first avoids the "Invalid cast" the cast itself would raise on a
        # component that is not a server.
        is_server = daq.IServer.can_cast_from(component)
        server = daq.IServer.cast_from(component) if is_server else None
        # quack-snippet end
        if server is None:
            raise ServiceError(
                UNSUPPORTED,
                'component "%s" is a %s, not a server; %s acts on server rows only'
                % (node_id, self._kind_of(component), wire_method),
            )
        return server

    def _as_recorder(self, component, node_id, wire_method):
        """The IRecorder facet of a component, or `unsupported`.

        This is the same cast the reference makes to decide whether a Start/Stop
        control exists at all (block_view.py:169-171,
        daq.IRecorder.can_cast_from(self.node)), and `unsupported` is the honest
        answer for every component that is not a recorder.
        """
        daq = self._daq
        # quack-snippet shared=recorder-of-component
        # startRecording, stopRecording and isRecording are declared on
        # IRecorder, which a recorder function block carries in addition to
        # IFunctionBlock. Nothing else in the tree carries it, so the cast is
        # also the answer to "is this node a recorder at all".
        is_recorder = daq.IRecorder.can_cast_from(component)
        recorder = daq.IRecorder.cast_from(component) if is_recorder else None
        # quack-snippet end
        if recorder is None:
            raise ServiceError(
                UNSUPPORTED,
                'component "%s" is a %s and does not carry IRecorder, so %s cannot act on it; '
                "openDAQ declares startRecording and stopRecording on IRecorder only"
                % (node_id, self._kind_of(component), wire_method),
            )
        return recorder

    def _as_device(self, component, node_id, wire_method):
        """The IDevice facet of a component, or `unsupported`.

        `unsupported` and not `not_found`: the node exists -- it was just
        resolved -- it simply is not a device, and contract/contract.yaml says
        in as many words that not_found would be a lie there.
        """
        daq = self._daq
        # quack-snippet shared=device-of-component
        # lock, unlock, operation_mode and available_operation_modes are all
        # declared on IDevice, not on IComponent, so a component has to be taken
        # through its IDevice facet before any of them can be called. A
        # component that does not carry the facet is not a device; asking
        # first with can_cast_from avoids the "Invalid cast" the cast itself
        # would raise.
        is_device = daq.IDevice.can_cast_from(component)
        device = daq.IDevice.cast_from(component) if is_device else None
        # quack-snippet end
        if device is None:
            raise ServiceError(
                UNSUPPORTED,
                'component "%s" is a %s, not a device; %s acts on device rows only'
                % (node_id, self._kind_of(component), wire_method),
            )
        return device

    def _translated_within_declared_subset(self, exception, wire_method, fallback_code):
        """One native openDAQ failure -> a ServiceError whose code is inside the
        subset contract/contract.yaml declares for `wire_method`."""
        translated = _NativeErrorTranslator.translate(exception)
        code, detail = narrow_to_declared_error_subset(
            translated.code,
            translated.detail,
            wire_method,
            _DECLARED_ERRORS[wire_method],
            fallback_code,
        )
        return ServiceError(code, detail)

    # --- shared regions ---------------------------------------------------

    def _kind_of(self, component):
        daq = self._daq
        # quack-snippet shared=component-kind
        # openDAQ has no "kind" attribute: a component's kind is whichever of
        # these interfaces it can be cast to, and the order matters because a
        # Channel is also a FunctionBlock and a Device is also a Folder.
        if daq.IChannel.can_cast_from(component):
            return "channel"
        if daq.IDevice.can_cast_from(component):
            return "device"
        if daq.IFunctionBlock.can_cast_from(component):
            return "function_block"
        if daq.ISignal.can_cast_from(component):
            return "signal"
        # IServer is asked AFTER the four above and BEFORE the folder fallback,
        # because a Server is an IFolder (server.h derives it from IFolder) and
        # would otherwise be reported as a plain folder. It is not a Device, a
        # Channel, a FunctionBlock or a Signal, so nothing above it can claim it.
        if daq.IServer.can_cast_from(component):
            return "server"
        # Everything else -- folders and plain components such as
        # Synchronization -- is reported as a folder; the contract's kind set
        # has no other container.
        return "folder"
        # quack-snippet end

    def _wire_value_type(self, prop):
        """The closed value_type set. A property whose openDAQ core type has no
        member of that set (ctObject, ctProc, ctFunc, ...) is not representable
        on the M1 wire; None means "omit it rather than misreport it"."""
        daq = self._daq
        # quack-snippet shared=property-wire-value-type
        # A property with selection values is a selection whatever its storage
        # type says; otherwise the core type of the property decides.
        if prop.selection_values is not None:
            return "selection"
        by_core_type = {
            daq.CoreType.ctBool: "bool",
            daq.CoreType.ctInt: "int",
            daq.CoreType.ctFloat: "float",
            daq.CoreType.ctString: "string",
            daq.CoreType.ctStruct: "struct",
        }
        return by_core_type.get(prop.value_type)
        # quack-snippet end

    def _is_representable(self, prop):
        try:
            return self._wire_value_type(prop) is not None
        except Exception:
            return False

    def _value_to_json(self, value):
        """openDAQ value -> plain JSON. The bindings already hand back Python
        scalars for the scalar core types; containers are walked."""
        if value is None:
            return None
        if isinstance(value, (bool, int, float, str)):
            return value
        if isinstance(value, (list, tuple)):
            return [self._value_to_json(item) for item in value]
        if isinstance(value, dict):
            return {str(k): self._value_to_json(v) for k, v in value.items()}
        daq = self._daq
        try:
            if daq.IStruct.can_cast_from(value):
                struct_value = daq.IStruct.cast_from(value)
                return {
                    str(name): self._value_to_json(struct_value.get(name))
                    for name in struct_value.field_names
                }
        except Exception:
            pass
        return str(value)

    def _to_descriptor(self, prop):
        """Everything openDAQ can say about one property."""
        d = PropertyDescriptor()
        # quack-snippet shared=property-descriptor uses=property-wire-value-type
        d.name = str(prop.name)
        d.id = d.name  # openDAQ property names are the identifiers
        d.value_type = self._wire_value_type(prop)  # shared region property-wire-value-type
        d.read_only = bool(prop.read_only)
        d.visible = bool(prop.visible)
        d.default_value = self._value_to_json(prop.default_value)

        unit = prop.unit
        if unit is not None:
            d.unit = str(unit.symbol)
        description = prop.description
        if description is not None and str(description) != "":
            d.description = str(description)
        if prop.min_value is not None:
            d.min = float(prop.min_value)
        if prop.max_value is not None:
            d.max = float(prop.max_value)
        if prop.validator is not None:
            d.validator = str(prop.validator.eval)
        if prop.coercer is not None:
            d.coercer = str(prop.coercer.eval)

        selection = prop.selection_values
        if selection is not None:
            if isinstance(selection, dict):
                d.selection_values = [str(v) for v in selection.values()]
            else:
                d.selection_values = [str(v) for v in selection]

        suggested = prop.suggested_values
        if suggested is not None:
            d.suggested_values = [self._value_to_json(v) for v in suggested]
        # quack-snippet end
        return d

    def _property_by_name(self, property_object, node_id, name):
        try:
            # quack-snippet shared=property-by-name
            return property_object.get_property(name)
            # quack-snippet end
        except Exception as e:
            raise ServiceError(
                NOT_FOUND,
                'property "%s" not found on "%s": %s' % (name, node_id, e),
            )

    def _nearest_ancestor_device(self, component):
        """The device whose lock a component inherits: itself if it is one, else
        the closest device above it. The instance root is a device, so every
        component in the tree has one."""
        daq = self._daq
        # quack-snippet shared=effective-device-lock-state uses=device-of-component
        # openDAQ's lock lives on IDevice and nowhere else, so the effective
        # lock of a channel or a signal is the lock of the device it hangs
        # under; the walk goes up IComponent.parent until a component carries
        # the IDevice facet.
        current = component
        while current is not None:
            if daq.IDevice.can_cast_from(current):
                return daq.IDevice.cast_from(current)
            parent = current.parent
            current = daq.IComponent.cast_from(parent) if parent is not None else None
        return None
        # quack-snippet end

    def _active_of(self, component):
        # quack-snippet shared=component-state step=1
        # IComponent.active is an attribute, not a property; the bindings hand
        # it back as an int, so it is made a bool for the wire's bool field.
        return bool(component.active)
        # quack-snippet end

    def _updating_of(self, component):
        """IPropertyObject.updating: true while a begin_batched_property_update is
        open on this component and every property write against it is held."""
        daq = self._daq
        # quack-snippet shared=component-state step=5 uses=property-object-of-component
        # updating is a read-only Python property on IPropertyObject, and the
        # bindings hand it back as an int, so it is made a bool for the wire.
        # The reference reads exactly this on every row of the tree
        # (_set_node_update_status_recursive, gui_demo.py:1434-1445) and paints
        # the row red when it is true.
        return bool(daq.IPropertyObject.cast_from(component).updating)
        # quack-snippet end

    def _recording_of(self, component):
        """IRecorder.is_recording, or None for a component that does not carry
        IRecorder -- which is every component of the reference device."""
        daq = self._daq
        # quack-snippet shared=component-state step=6 uses=recorder-of-component
        # is_recording is only askable of a component that carries IRecorder, so
        # the cast comes first and a component without the facet reports null
        # rather than false: false would claim it is a recorder that happens not
        # to be recording.
        if not daq.IRecorder.can_cast_from(component):
            return None
        return bool(daq.IRecorder.cast_from(component).is_recording)
        # quack-snippet end

    def _component_status_and_message_of(self, component):
        """(status name, message) as openDAQ spells them, or (None, None) when
        this component publishes no ComponentStatus at all."""
        daq = self._daq
        # quack-snippet shared=component-status-container
        # get_status raises "Not found" for a key the container does not hold,
        # so the container's own key list decides whether to ask at all. The
        # status value is an Enumeration; its member name is on .name, while
        # str() of it would read "ComponentStatusType.Ok".
        container = component.status_container
        if _COMPONENT_STATUS_KEY not in [str(key) for key in container.statuses.keys()]:
            return None, None
        status_name = str(
            daq.IEnumeration.cast_from(container.get_status(_COMPONENT_STATUS_KEY)).name
        )
        message = str(container.get_status_message(_COMPONENT_STATUS_KEY))
        # quack-snippet end
        return status_name, (message or None)

    def _connection_status_of(self, device):
        """The openDAQ ConnectionStatus name of one device, or None when this
        device publishes none -- which is what a locally added device does."""
        daq = self._daq
        # quack-snippet shared=component-state step=3
        # A device carries its connection statuses in a container of their own,
        # IDevice.connection_status_container, keyed "ConnectionStatus" for the
        # configuration connection plus one key per streaming connection. A
        # device that was added locally publishes none of them at all.
        container = device.connection_status_container
        if _CONNECTION_STATUS_KEY not in [str(key) for key in container.statuses.keys()]:
            return None
        return str(daq.IEnumeration.cast_from(container.get_status(_CONNECTION_STATUS_KEY)).name)
        # quack-snippet end

    def _operation_mode_name_of(self, device):
        """The openDAQ OperationModeType member name of one device's CURRENT
        mode."""
        # quack-snippet shared=component-state step=4 uses=operation-mode-names
        # IDevice.operation_mode is a Python property holding an
        # OperationModeType member, so the member name comes straight off it.
        return str(device.operation_mode.name)
        # quack-snippet end

    def _read_component_state_into(self, node, component):
        """The six state fields of types.Node. Each is read on its own and each
        failure leaves that one field null, because contract/contract.yaml reads
        null as "this host does not report it" -- so one unreadable field must
        not cost the other five, nor the node itself."""
        try:
            node.active = self._active_of(component)
        except Exception as e:
            print(
                '[opendaq] IComponent.active on "%s" raised %s: %s; Node.active stays null'
                % (component.global_id, type(e).__name__, e),
                flush=True,
            )

        try:
            status_name, message = self._component_status_and_message_of(component)
            if status_name is not None:
                node.component_status = _WIRE_COMPONENT_STATUS_BY_OPENDAQ_NAME.get(status_name)
                if node.component_status is None:
                    print(
                        '[opendaq] component "%s" reports ComponentStatus "%s", which is not one '
                        "of the contract's [%s]; Node.component_status stays null"
                        % (
                            component.global_id,
                            status_name,
                            ", ".join(_WIRE_COMPONENT_STATUS_BY_OPENDAQ_NAME.values()),
                        ),
                        flush=True,
                    )
                node.component_status_message = message
        except Exception as e:
            print(
                '[opendaq] reading the ComponentStatus of "%s" raised %s: %s; '
                "Node.component_status stays null"
                % (component.global_id, type(e).__name__, e),
                flush=True,
            )

        try:
            owning_device = self._nearest_ancestor_device(component)
            if owning_device is not None:
                node.locked = bool(owning_device.locked)
        except Exception as e:
            print(
                '[opendaq] the effective lock of "%s" could not be read: %s: %s; Node.locked '
                "stays null" % (component.global_id, type(e).__name__, e),
                flush=True,
            )

        try:
            node.updating = self._updating_of(component)
        except Exception as e:
            print(
                '[opendaq] IPropertyObject.updating on "%s" raised %s: %s; Node.updating stays '
                "null" % (component.global_id, type(e).__name__, e),
                flush=True,
            )

        try:
            # null on every component that does not carry IRecorder, which is
            # what tells a client to draw no Start/Stop control at all.
            node.recording = self._recording_of(component)
        except Exception as e:
            print(
                '[opendaq] IRecorder.is_recording on "%s" raised %s: %s; Node.recording stays '
                "null" % (component.global_id, type(e).__name__, e),
                flush=True,
            )

        if not self._daq.IDevice.can_cast_from(component):
            # connection_status and operation_mode are device rows only; on
            # every other kind they stay null, which is what the contract says.
            return
        device = self._daq.IDevice.cast_from(component)

        try:
            status_name = self._connection_status_of(device)
            if status_name is not None:
                node.connection_status = _WIRE_CONNECTION_STATUS_BY_OPENDAQ_NAME.get(status_name)
        except Exception as e:
            print(
                '[opendaq] reading the ConnectionStatus of device "%s" raised %s: %s; '
                "Node.connection_status stays null"
                % (component.global_id, type(e).__name__, e),
                flush=True,
            )

        try:
            node.operation_mode = _WIRE_OPERATION_MODE_BY_OPENDAQ_NAME.get(
                self._operation_mode_name_of(device)
            )
        except Exception as e:
            print(
                '[opendaq] reading the operation mode of device "%s" raised %s: %s; '
                "Node.operation_mode stays null"
                % (component.global_id, type(e).__name__, e),
                flush=True,
            )

    def _build_node(self, component):
        node = Node()
        # quack-snippet shared=component-node uses=component-kind,property-wire-value-type,component-state,component-status-container,effective-device-lock-state
        # Identity, then the two structural facts openDAQ exposes: a component
        # knows its parent, and a component that is a Folder knows its items.
        # Properties come from the IPropertyObject facet, which most but not all
        # components have.
        node.id = str(component.global_id)
        node.name = str(component.name)
        node.kind = self._kind_of(component)  # shared region component-kind

        parent = component.parent
        if parent is not None:
            node.parent_id = str(self._daq.IComponent.cast_from(parent).global_id)

        folder = self._as_folder(component)
        if folder is not None:
            node.child_ids = [str(child.global_id) for child in folder.items]

        if self._daq.IPropertyObject.can_cast_from(component):
            property_object = self._daq.IPropertyObject.cast_from(component)
            for prop in property_object.all_properties:
                if self._is_representable(prop):  # shared region property-wire-value-type
                    node.property_ids.append(str(prop.name))
        # quack-snippet end
        self._read_component_state_into(node, component)  # shared region component-state
        return node

    def _describe_properties(self, property_object):
        out = []
        # quack-snippet shared=property-descriptor-enumeration uses=property-wire-value-type,property-descriptor
        for prop in property_object.all_properties:
            try:
                if not self._is_representable(prop):  # shared region property-wire-value-type
                    continue
                out.append(self._to_descriptor(prop))  # shared region property-descriptor
            except Exception as e:
                print('[opendaq] skipping property "%s": %s' % (prop.name, e), flush=True)
        # quack-snippet end
        return out

    def _json_to_opendaq_value(self, prop, value):
        """JSON -> openDAQ value, shaped by the property's declared type.
        Coercion and validation stay openDAQ's business: this only builds a
        value of the right kind and lets set_property_value judge it."""
        daq = self._daq
        # quack-snippet shared=json-to-opendaq-value
        # Building the openDAQ value that set_property_value will write: the
        # property's own value type picks the Python type, and a struct has to
        # be rebuilt field by field from the current value, because openDAQ
        # rejects a struct whose field types do not match.
        value_type = prop.value_type
        if value_type == daq.CoreType.ctBool:
            if isinstance(value, bool):
                return value
            if isinstance(value, (int, float)):
                return value != 0
        elif value_type == daq.CoreType.ctInt:
            if isinstance(value, bool):
                return 1 if value else 0
            if isinstance(value, int):
                return value
            if isinstance(value, float):
                return int(value)
        elif value_type == daq.CoreType.ctFloat:
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return float(value)
        elif value_type == daq.CoreType.ctString:
            if isinstance(value, str):
                return value
        elif value_type == daq.CoreType.ctStruct:
            if isinstance(value, dict):
                current = daq.IStruct.cast_from(prop.value)
                builder = daq.StructBuilderFromExisting(current)
                for field_name, field_value in value.items():
                    existing = current.get(field_name) if field_name in current.field_names else None
                    if isinstance(existing, bool) or isinstance(field_value, bool):
                        builder.set(field_name, bool(field_value))
                    elif isinstance(existing, float) or isinstance(field_value, float):
                        builder.set(field_name, float(field_value))
                    elif isinstance(existing, int) or isinstance(field_value, int):
                        builder.set(field_name, int(field_value))
                    elif isinstance(existing, str) or isinstance(field_value, str):
                        builder.set(field_name, str(field_value))
                    else:
                        raise ServiceError(
                            INVALID_VALUE,
                            'struct field "%s" cannot take %r' % (field_name, field_value),
                        )
                return daq.StructFromBuilder(builder)
        else:
            raise ServiceError(
                UNSUPPORTED,
                'property "%s" has an openDAQ value type that the M1 wire contract does not carry'
                % prop.name,
            )
        # quack-snippet end
        raise ServiceError(
            INVALID_VALUE,
            'value %r does not fit property "%s"' % (value, prop.name),
        )

    # --- connect_device ---------------------------------------------------

    def connect_device(self, connection_string):
        with self._device_lock:
            already = self._device_node_ids_by_connection_string.get(connection_string)
        if already is not None:
            print(
                '[opendaq] connect_device("%s") is already satisfied by %s on this instance'
                % (connection_string, already),
                flush=True,
            )
            return self._build_node(self._resolve_component(already))

        try:
            # quack-snippet capability=device.connect uses=instance-with-module-path,component-node
            # Adding a device is one call on the Instance: openDAQ picks the
            # module that claims the connection string and hands back the new
            # device component, already in the tree under the instance root.
            device = self._instance.add_device(connection_string)
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise _NativeErrorTranslator.translate(e)

        node = self._build_node(device)
        with self._device_lock:
            self._device_node_ids_by_connection_string[connection_string] = node.id
        print(
            '[opendaq] connect_device("%s") added device %s named "%s" with %d child component(s)'
            % (connection_string, node.id, node.name, len(node.child_ids)),
            flush=True,
        )
        return node

    # --- disconnect_device --------------------------------------------------

    def disconnect_device(self, node_id):
        """Undoing an add_device. This is what the disconnect_device wire method
        calls; release_device below is the same removal on the teardown path,
        where nobody is left to answer an error to."""
        component = self._resolve_component(node_id)

        # quack-snippet capability=device.connect step=2
        # removeDevice is declared over a device, not a component, so the
        # component has to be taken through its IDevice facet first, and the
        # device is removed from the same Instance that added it. openDAQ
        # raises its ComponentRemoved core event for the vanished subtree.
        is_device = self._daq.IDevice.can_cast_from(component)
        device = self._daq.IDevice.cast_from(component) if is_device else None
        # quack-snippet end
        if device is None:
            raise ServiceError(
                NOT_FOUND,
                'component "%s" is a %s, not a device; disconnect_device takes the node id '
                "connect_device answered with" % (node_id, self._kind_of(component)),
            )

        try:
            # quack-snippet shared=device-removal
            self._instance.remove_device(device)
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise _NativeErrorTranslator.translate(e)

        with self._device_lock:
            connection_strings = [
                connection_string
                for connection_string, held in self._device_node_ids_by_connection_string.items()
                if held == node_id
            ]
            for connection_string in connection_strings:
                del self._device_node_ids_by_connection_string[connection_string]

        print(
            "[opendaq] disconnect_device %s (%s): removed from the openDAQ Instance"
            % (node_id, ", ".join(connection_strings) or "no connection string on record"),
            flush=True,
        )

    def release_device(self, node_id):
        """Session teardown's removal: the same call as disconnect_device, but
        the socket that would have been told about a failure is already gone, so
        the failure is printed instead of raised."""
        try:
            self.disconnect_device(node_id)
        except ServiceError as e:
            print(
                "[opendaq] releasing device %s on session teardown answered %s: %s"
                % (node_id, e.code, e.detail),
                flush=True,
            )
        except Exception as e:
            print("[opendaq] removing device %s failed: %s" % (node_id, e), flush=True)
        with self._device_lock:
            for connection_string, held in list(self._device_node_ids_by_connection_string.items()):
                if held == node_id:
                    del self._device_node_ids_by_connection_string[connection_string]

    # --- get_component_tree -----------------------------------------------

    def get_component_tree(self, root_id):
        root = self._resolve_component(root_id)
        nodes = []
        # quack-snippet capability=tree.read uses=component-node
        # The tree is walked through the Folder facet: a component that is a
        # Folder lists its items, and every item is described by the same
        # component -> Node mapping.
        for component in self._walk_components(root):
            nodes.append(self._build_node(component))
        # quack-snippet end
        print(
            "[opendaq] get_component_tree(%s) walked %d component(s)" % (root_id, len(nodes)),
            flush=True,
        )
        return nodes

    # --- get_property_descriptors ------------------------------------------

    def get_property_descriptors(self, node_id):
        component = self._resolve_component(node_id)
        property_object = self._as_property_object(component, node_id)
        # quack-snippet capability=property.read uses=property-wire-value-type,property-descriptor
        # Each property is described by the shared region property-descriptor; a
        # property whose type has no member of the wire's closed value_type set
        # is omitted rather than misreported.
        descriptors = self._describe_properties(property_object)
        # quack-snippet end
        # What the client is about to be handed is what a later re-read is
        # diffed against, so this is the moment the snapshot is taken.
        self._snapshot_descriptors(node_id, descriptors)
        print(
            "[opendaq] get_property_descriptors(%s) described %d propert%s and snapshotted them "
            "for property_descriptor_changed detection"
            % (node_id, len(descriptors), "y" if len(descriptors) == 1 else "ies"),
            flush=True,
        )
        return descriptors

    # --- get_property_value -------------------------------------------------

    def get_property_value(self, node_id, property_id):
        component = self._resolve_component(node_id)
        property_object = self._as_property_object(component, node_id)
        self._property_by_name(property_object, node_id, property_id)  # shared region property-by-name
        try:
            # quack-snippet capability=property.read uses=property-by-name
            value = property_object.get_property_value(property_id)
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise _NativeErrorTranslator.translate(e)
        as_json = self._value_to_json(value)
        print(
            "[opendaq] get_property_value(%s, %s) read %r from the device"
            % (node_id, property_id, as_json),
            flush=True,
        )
        return as_json

    # --- set_property_value -------------------------------------------------

    def set_property_value(self, node_id, property_id, value):
        component = self._resolve_component(node_id)
        property_object = self._as_property_object(component, node_id)
        prop = self._property_by_name(property_object, node_id, property_id)  # shared region property-by-name

        # quack-snippet capability=property.write uses=property-by-name
        # openDAQ answers a write to a read-only property with an error that
        # does not distinguish it from a rejected value, so the flag is read
        # first.
        read_only = bool(prop.read_only)
        # quack-snippet end
        if read_only:
            raise ServiceError(
                READ_ONLY, 'property "%s" on "%s" is read-only' % (property_id, node_id)
            )

        try:
            converted = self._json_to_opendaq_value(prop, value)  # shared region json-to-opendaq-value
        except ServiceError:
            raise
        except Exception as e:
            raise _NativeErrorTranslator.translate(e, CONTEXT_PROPERTY_WRITE)

        try:
            # quack-snippet capability=property.write uses=json-to-opendaq-value
            property_object.set_property_value(property_id, converted)
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            # The property exists (it was resolved above), so a "not found"
            # raised by the write itself means the value was rejected, not the
            # property.
            raise _NativeErrorTranslator.translate(e, CONTEXT_PROPERTY_WRITE)
        print(
            "[opendaq] set_property_value(%s, %s) wrote %r to the device"
            % (node_id, property_id, value),
            flush=True,
        )

    # --- subscribe_signal ---------------------------------------------------

    def subscribe_signal(self, signal_id, subscription_id, sample_sink):
        daq = self._daq
        component = self._resolve_component(signal_id)

        # quack-snippet capability=streaming.decimated,streaming.raw step=1
        # Only a component that carries ISignal can be read from, and a
        # StreamReader is what turns that signal into samples: it is asked for
        # Float64 values against an Int64 domain, and openDAQ converts whatever
        # the signal's own descriptor says into those two types.
        is_signal = daq.ISignal.can_cast_from(component)
        signal = daq.ISignal.cast_from(component) if is_signal else None
        # quack-snippet end
        if signal is None:
            raise ServiceError(INVALID_VALUE, 'component "%s" is not a signal' % signal_id)

        try:
            # quack-snippet capability=streaming.decimated,streaming.raw step=2
            reader = daq.StreamReader(signal, daq.SampleType.Float64, daq.SampleType.Int64)
            # quack-snippet end
        except Exception as e:
            raise _NativeErrorTranslator.translate(e)

        subscription = {
            "id": subscription_id,
            "signal": signal,
            "reader": reader,
            "sink": sample_sink,
            "stop": threading.Event(),
        }
        with self._subscription_lock:
            self._subscriptions[subscription_id] = subscription
        thread = threading.Thread(
            target=self._pump_samples, args=(subscription,), daemon=True
        )
        subscription["thread"] = thread
        thread.start()
        print(
            "[opendaq] subscribe_signal(%s) is reading Float64 samples against an Int64 domain "
            "as subscription %d" % (signal_id, subscription_id),
            flush=True,
        )

    def _pump_samples(self, subscription):
        while not subscription["stop"].is_set():
            try:
                # quack-snippet capability=streaming.decimated,streaming.raw step=3
                # One read hands back the values and the domain ticks that go
                # with them; the first domain tick of the block is what the
                # binary frame header carries as domain_start.
                values, domain = subscription["reader"].read_with_domain(
                    _PUMP_BUFFER_SAMPLES, _PUMP_TIMEOUT_MS
                )
                # quack-snippet end
            except Exception as e:
                print(
                    "[opendaq] read on subscription %d failed: %s" % (subscription["id"], e),
                    flush=True,
                )
                time.sleep(0.1)
                continue

            count = len(values)
            if count > 0:
                subscription["sink"](
                    subscription["id"], int(domain[0]), [float(v) for v in values]
                )
            else:
                time.sleep(0.005)

    # --- unsubscribe_signal -------------------------------------------------

    def unsubscribe_signal(self, subscription_id):
        with self._subscription_lock:
            subscription = self._subscriptions.pop(subscription_id, None)
        if subscription is None:
            return  # the session registry already reported an unknown id
        subscription["stop"].set()
        thread = subscription.get("thread")
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        # quack-snippet capability=streaming.decimated,streaming.raw step=5
        subscription["reader"] = None  # releasing the reader disconnects it from the signal
        # quack-snippet end
        print("[opendaq] unsubscribe_signal released subscription %d" % subscription_id, flush=True)

    # --- get_device_operation_modes -----------------------------------------

    def _operation_mode_member_name_of_ordinal(self, ordinal):
        """One element of IDevice.available_operation_modes -> the
        OperationModeType member name it stands for."""
        # quack-snippet shared=operation-mode-names
        # available_operation_modes hands back the ORDINALS of OperationModeType
        # (1, 2, 3 on the reference device), not its members, so each one is put
        # back through the enum before its member name can be read.
        return str(self._daq.OperationModeType(int(ordinal)).name)
        # quack-snippet end

    def get_device_operation_modes(self, node_id):
        """The modes one device offers. The CURRENT mode is not here: it rides
        on every device row as Node.operation_mode."""
        component = self._resolve_component(node_id)
        device = self._as_device(component, node_id, "get_device_operation_modes")

        try:
            # quack-snippet capability=device.mode uses=device-of-component,operation-mode-names step=1
            # Which modes this device will accept is one read on the device.
            available_ordinals = [int(ordinal) for ordinal in device.available_operation_modes]
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(
                e, "get_device_operation_modes", UNSUPPORTED
            )

        modes = []
        unmapped = []
        for ordinal in available_ordinals:
            member_name = self._operation_mode_member_name_of_ordinal(ordinal)
            wire_name = _WIRE_OPERATION_MODE_BY_OPENDAQ_NAME.get(member_name)
            if wire_name is None:
                unmapped.append("%d (%s)" % (ordinal, member_name))
            else:
                modes.append(wire_name)
        if unmapped:
            print(
                "[opendaq] device %s offers operation mode ordinal(s) %s that types.Node."
                "operation_mode does not enumerate; they are left out of the answer"
                % (node_id, ", ".join(unmapped)),
                flush=True,
            )
        print(
            "[opendaq] get_device_operation_modes(%s) read available_operation_modes = %s from "
            "the device, which is %s on the wire; its current mode is %s"
            % (
                node_id,
                available_ordinals,
                ", ".join(modes) or "an empty list",
                _WIRE_OPERATION_MODE_BY_OPENDAQ_NAME.get(
                    self._operation_mode_name_of(device), "unreadable"
                ),
            ),
            flush=True,
        )
        return modes

    # --- set_device_operation_mode ------------------------------------------

    def set_device_operation_mode(self, node_id, mode):
        component = self._resolve_component(node_id)
        device = self._as_device(component, node_id, "set_device_operation_mode")

        member_name = _OPENDAQ_OPERATION_MODE_NAME_BY_WIRE.get(mode)
        if member_name is None:
            raise ServiceError(
                INVALID_VALUE,
                'operation mode "%s" is not one of the values types.Node.operation_mode '
                "enumerates: %s"
                % (mode, ", ".join(sorted(_OPENDAQ_OPERATION_MODE_NAME_BY_WIRE))),
            )

        # OPENDAQ ITSELF ACCEPTS AN UNAVAILABLE MODE AND DOES NOTHING, so this
        # refusal is the CONTRACT'S rule and not openDAQ's, and it is kept
        # outside the quack-snippet region below for exactly that reason -- the
        # snippet must show only calls that produce what the user saw.
        #
        # GenericDevice::setOperationMode (device_impl.h:1258-1259) returns
        # OPENDAQ_IGNORED when the requested mode is not in
        # onGetAvailableOperationModes, and OPENDAQ_IGNORED is 0x00000006u
        # (errors.h:38) against OPENDAQ_FAILED = (x) & 0x80000000u (errors.h:28),
        # so it is a SUCCESS and no binding raises. Confirmed on openDAQ
        # 3.41.0_bec37b44 on this machine: daqref://device0 answers
        # available_operation_modes [1, 2, 3] (Idle, Operation, SafeOperation),
        # and `device.operation_mode = OperationModeType.Unknown` (0) raised
        # nothing and left operation_mode reading 2.
        #
        # contract/contract.yaml operations[set_device_operation_mode] declares
        # invalid_value as "a mode name outside Node.operation_mode's values, OR
        # ONE THE DEVICE DID NOT LIST AS AVAILABLE", so this host answers what
        # the contract asks for and says here, in full, that openDAQ would have
        # answered a silent success instead. That divergence is a live open
        # question for whoever owns the contract; it is not this host quietly
        # deciding one.
        available = self.get_device_operation_modes(node_id)
        if mode not in available:
            raise ServiceError(
                INVALID_VALUE,
                'device "%s" does not offer operation mode "%s"; '
                "get_device_operation_modes answers %s for it. openDAQ itself would ACCEPT this "
                "write and silently do nothing -- GenericDevice::setOperationMode "
                "(device_impl.h:1258-1259) returns OPENDAQ_IGNORED, which is a success -- so this "
                "invalid_value is contract/contract.yaml's rule for the row, not openDAQ's"
                % (node_id, mode, ", ".join(available) or "an empty list"),
            )

        was = self._operation_mode_name_of(device)
        try:
            # quack-snippet capability=device.mode uses=device-of-component,operation-mode-names step=2
            # There is no set_operation_mode and no setDeviceOperationMode: in
            # the Python bindings the mode is a SETTABLE PROPERTY on the device,
            # assigned an OperationModeType member. This one assignment is the
            # whole operation.
            #
            # THE DEVICE LOCK IS NOT CONSULTED HERE, and this host does not
            # consult it either. GenericDevice::setOperationMode
            # (device_impl.h:1257-1281) checks onGetAvailableOperationModes,
            # takes the tree lock guard and writes -- there is no lock test in
            # it. The user lock refuses writes only in the config-protocol
            # server, ConfigServerAccessControl::protectLockedComponent
            # (config_server_access_control.h:75-81), and this host holds an
            # in-process Instance, so that path is never on. Checked on openDAQ
            # 3.41.0_bec37b44 by locking daqref://device0 and writing the mode
            # anyway: it succeeded. Node.locked is a LABEL for the client, never
            # a refusal from here.
            device.operation_mode = getattr(self._daq.OperationModeType, member_name)
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(
                e, "set_device_operation_mode", INVALID_VALUE
            )

        now = self._operation_mode_name_of(device)
        print(
            "[opendaq] set_device_operation_mode(%s, %s) assigned OperationModeType.%s; the "
            "device read back %s (it was %s before the write), and its locked flag is %r"
            % (node_id, mode, member_name, now, was, bool(device.locked)),
            flush=True,
        )

    # --- lock_device ---------------------------------------------------------

    def lock_device(self, node_id):
        component = self._resolve_component(node_id)
        device = self._as_device(component, node_id, "lock_device")
        was_locked = bool(device.locked)

        try:
            # quack-snippet capability=device.lock uses=device-of-component step=1
            # One call on the device, and it takes no argument:
            # device_impl.h:1040-1044 implements the public IDevice::lock() as
            # literally `return this->lock(nullptr);`. The user-taking form is on
            # IDevicePrivate (device_private.h:39-42) and over the wire the user
            # comes from the CONNECTION (config_server_device.h:78 calls
            # lock(context.user)), never from the caller.
            #
            # WITH NO AUTHENTICATION CONFIGURED THE LOCK IS HELD BY NOBODY, so
            # this call never refuses here and this host synthesises no refusal
            # of its own. UserLockImpl::lock (user_lock_impl.cpp:15-27) collapses
            # an ANONYMOUS user to nullptr before storing it, and every
            # connection is User("", "") because AuthenticationProvider()
            # defaults to allowAnonymous = true
            # (authentication_provider_factory.h:31-35). It returns
            # OPENDAQ_ERR_DEVICE_LOCKED in exactly one case,
            # `userLock.has_value() && userLock != userPtr`
            # (user_lock_impl.cpp:21-22) -- a DIFFERENT NAMED user -- so a second
            # lock of an anonymously-locked device compares nullptr against
            # nullptr and succeeds. Confirmed on this machine: two sockets each
            # locked daqref://device0 and both succeeded.
            device.lock()
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(e, "lock_device", READ_ONLY)

        print(
            "[opendaq] lock_device(%s) called IDevice.lock(); IDevice.locked read %r before the "
            "call and %r after it" % (node_id, was_locked, bool(device.locked)),
            flush=True,
        )

    # --- unlock_device -------------------------------------------------------

    def unlock_device(self, node_id, force):
        component = self._resolve_component(node_id)
        device = self._as_device(component, node_id, "unlock_device")
        was_locked = bool(device.locked)

        if not force:
            try:
                # quack-snippet capability=device.lock uses=device-of-component step=2
                # The plain unlock, and it takes no argument either
                # (device_impl.h:1046-1048 is `return this->unlock(nullptr);`).
                #
                # ANY CALLER CLEARS AN ANONYMOUSLY-TAKEN LOCK, which is the only
                # kind this application can take. UserLockImpl::unlock
                # (user_lock_impl.cpp:29-36) returns OPENDAQ_ERR_ACCESSDENIED
                # only when `userLock.has_value() && userLock != nullptr &&
                # userLock != user`; the `!= nullptr` term is what lets a
                # different caller clear it. openDAQ's own test says so:
                # LockUnlockAnonymous (test_device.cpp:399-430) locks anonymously
                # and then asserts that unlock(jure) and unlock(tomaz), two
                # DIFFERENT users, each succeed.
                #
                # So read_only is unreachable on this row here and this host does
                # not invent it to keep a second session out. Confirmed on
                # openDAQ 3.41.0_bec37b44: unlock() on daqref://device0 succeeded
                # in every state it was tried in -- from a second socket, and on
                # a device that was not locked at all.
                device.unlock()
                # quack-snippet end
            except ServiceError:
                raise
            except Exception as e:
                raise self._translated_within_declared_subset(e, "unlock_device", READ_ONLY)
            print(
                "[opendaq] unlock_device(%s, force=False) called IDevice.unlock(); IDevice.locked "
                "read %r before the call and %r after it"
                % (node_id, was_locked, bool(device.locked)),
                flush=True,
            )
            return

        daq = self._daq
        # quack-snippet capability=device.lock uses=device-of-component step=3
        # The forced unlock is not on IDevice at all: it is on IDevicePrivate,
        # a separate interface the device has to be cast to first, and it
        # ignores who holds the lock.
        carries_device_private = daq.IDevicePrivate.can_cast_from(component)
        device_private = daq.IDevicePrivate.cast_from(component) if carries_device_private else None
        # quack-snippet end
        if device_private is None:
            raise ServiceError(
                UNSUPPORTED,
                'device "%s" does not carry IDevicePrivate, so unlock_device cannot force the '
                "unlock; call it again with force omitted or false to try the plain "
                "IDevice.unlock()" % node_id,
            )

        try:
            # quack-snippet capability=device.lock uses=device-of-component step=4
            device_private.force_unlock()
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(e, "unlock_device", READ_ONLY)

        print(
            "[opendaq] unlock_device(%s, force=True) cast the device to IDevicePrivate and called "
            "force_unlock(); IDevice.locked read %r before the call and %r after it"
            % (node_id, was_locked, bool(device.locked)),
            flush=True,
        )

    # --- list_loaded_modules -------------------------------------------------

    def _component_type_info_of(self, value, carries_connection_prefix):
        """One value out of a module's type dictionary, read into
        (id, name, description, connection_string_prefix)."""
        daq = self._daq
        # quack-snippet shared=component-type-info
        # A type dictionary hands back the bare object it holds, which answers
        # nothing until it is cast: IComponentType carries the id, the name and
        # the description that every kind has, and connection_string_prefix
        # lives one interface further down, on IDeviceType and IStreamingType
        # only -- a function block type and a server type have no prefix at all.
        component_type = daq.IComponentType.cast_from(value)
        identifier = str(component_type.id)
        type_name = str(component_type.name)
        description = str(component_type.description)
        prefix = None
        if carries_connection_prefix:
            prefix = str(
                daq.IDeviceType.cast_from(value).connection_string_prefix
                if daq.IDeviceType.can_cast_from(value)
                else daq.IStreamingType.cast_from(value).connection_string_prefix
            )
        return identifier, type_name, description, prefix
        # quack-snippet end

    def _offered_component_types(self, module, attribute_name, carries_connection_prefix):
        """One of a module's four type dictionaries, read into plain tuples of
        (id, name, description, connection_string_prefix)."""
        # quack-snippet shared=module-component-types uses=component-type-info
        # A module says what it can create through four dictionaries, one per
        # kind: available_device_types, available_function_block_types,
        # available_server_types and available_streaming_types. Each is keyed by
        # the type id and holds the type object. A module that implements none
        # of a kind raises "Not Implemented" rather than answering an empty one.
        offered = getattr(module, attribute_name)
        return [
            self._component_type_info_of(offered[key], carries_connection_prefix)
            for key in list(offered.keys())
        ]
        # quack-snippet end

    def _component_types_of_module(self, module, module_name):
        """The four type dictionaries of one module, flattened into the wire's
        ComponentTypeInfo records."""
        out = []
        for attribute_name, wire_kind, carries_connection_prefix in (
            ("available_device_types", "device", True),
            ("available_function_block_types", "function_block", False),
            ("available_server_types", "server", False),
            ("available_streaming_types", "streaming", True),
        ):
            try:
                rows = self._offered_component_types(
                    module, attribute_name, carries_connection_prefix
                )
            except Exception as e:
                print(
                    '[opendaq] module "%s" answered %s with %s: %s; it contributes no %s type to '
                    "list_loaded_modules"
                    % (module_name, attribute_name, type(e).__name__, e, wire_kind),
                    flush=True,
                )
                continue
            for identifier, type_name, description, prefix in rows:
                component_type = ComponentTypeInfo()
                component_type.id = identifier
                component_type.name = type_name
                component_type.kind = wire_kind
                component_type.description = description or None
                component_type.connection_string_prefix = prefix or None
                out.append(component_type)
        return out

    def _module_info_record_of(self, module):
        """One openDAQ IModule read into the wire's ModuleInfo record.

        The same region serves both operations of the module pair: the record
        list_loaded_modules returns per module and the record
        load_module_from_host_path returns for the one it just loaded are read
        off IModuleInfo by exactly these calls."""
        # quack-snippet capability=module.read,module.load uses=module-component-types,component-type-info step=2
        # IModuleInfo carries the id and the name. The version is not a string
        # but a separate object with three integer parts, and a module built
        # without version metadata answers none at all.
        info = module.module_info
        identifier = str(info.id)
        module_name = str(info.name)
        version_info = info.version_info
        version = None
        if version_info is not None:
            version = "%d.%d.%d" % (
                int(version_info.major),
                int(version_info.minor),
                int(version_info.patch),
            )
        # quack-snippet end
        module_info = ModuleInfo()
        module_info.id = identifier
        module_info.name = module_name
        module_info.version = version
        module_info.component_types = self._component_types_of_module(module, module_name)
        return module_info

    def list_loaded_modules(self):
        try:
            # quack-snippet capability=module.read uses=instance-with-module-path step=1
            # The module manager belongs to the Instance's Context and holds
            # every module openDAQ loaded from the module path.
            loaded_modules = self._instance.module_manager.modules
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(e, "list_loaded_modules", INTERNAL)

        out = []
        for module in loaded_modules:
            try:
                out.append(self._module_info_record_of(module))
            except ServiceError:
                raise
            except Exception as e:
                raise self._translated_within_declared_subset(e, "list_loaded_modules", INTERNAL)

        print(
            "[opendaq] list_loaded_modules read %d module(s) off the module manager of the "
            "Instance: %s"
            % (
                len(out),
                "; ".join(
                    "%s %s offering %d component type(s)"
                    % (
                        module_info.name,
                        module_info.version or "(no version info)",
                        len(module_info.component_types),
                    )
                    for module_info in out
                )
                or "none",
            ),
            flush=True,
        )
        return out

    # --- load_module_from_host_path -----------------------------------------

    def load_module_from_host_path(self, host_path):
        """The module.load operation.

        host_path is resolved on THIS machine's filesystem -- the one
        quackoscope-host-python runs on -- because openDAQ's IModuleManager
        offers no bytes-in entry point: loadModule(path) is the only way in, and
        addModule takes an already-constructed IModule, not a buffer. So the
        path is the host's, and this method refuses one that is not absolute
        rather than resolving it against a working directory the caller cannot
        see.
        """
        if not host_path:
            raise ServiceError(
                INVALID_VALUE,
                "params.host_path is empty; it must be an absolute path to a module file on the "
                "machine quackoscope-host-python runs on. That machine's module directory, the one "
                "this Instance was built with and swept at startup, is %s" % self._module_path,
            )
        if not os.path.isabs(host_path):
            raise ServiceError(
                INVALID_VALUE,
                'params.host_path "%s" is not absolute. It names a file on the machine '
                "quackoscope-host-python runs on, not on the caller's, and a relative path would be "
                "resolved against this process's working directory %s, which the caller cannot see. "
                "The module directory this Instance was built with is %s"
                % (host_path, os.getcwd(), self._module_path),
            )

        print(
            "[opendaq] load_module_from_host_path: asking the module manager of the Instance to "
            "load %s (a path on this machine, %s; this host's own module directory is %s)"
            % (host_path, os.name, self._module_path),
            flush=True,
        )

        with self._module_load_lock:
            try:
                modules_before = len(list(self._instance.module_manager.modules))
            except Exception:
                modules_before = -1
            try:
                # quack-snippet capability=module.load uses=instance-with-module-path step=1
                # IModuleManager.loadModule takes an absolute path on the machine
                # the SDK is running on and does two things: it loads the shared
                # library and it adds the module to the manager. So the IModule
                # it hands back is already in module_manager.modules -- there is
                # no separate add step, and re-loading an id that is already
                # there is refused by the add half.
                loaded_module = self._instance.module_manager.load_module(host_path)
                # quack-snippet end
            except ServiceError:
                raise
            except Exception as e:
                error = self._translated_within_declared_subset(
                    e, "load_module_from_host_path", INTERNAL
                )
                print(
                    '[opendaq] load_module_from_host_path("%s") failed: openDAQ raised %s "%s", '
                    "reported on the wire as %s"
                    % (host_path, type(e).__name__, e, error.code),
                    flush=True,
                )
                raise error

            try:
                module_info = self._module_info_record_of(loaded_module)
            except ServiceError:
                raise
            except Exception as e:
                raise self._translated_within_declared_subset(
                    e, "load_module_from_host_path", INTERNAL
                )

            try:
                modules_after = len(list(self._instance.module_manager.modules))
            except Exception:
                modules_after = -1

        print(
            '[opendaq] load_module_from_host_path("%s") loaded module id "%s", name "%s", version '
            "%s, offering %d component type(s): %s. The module manager held %d module(s) before "
            "the call and holds %d after it, so a list_loaded_modules answer taken before this "
            "call is now short by the module just named; the M1 contract has five events "
            "(component_added, component_removed, property_changed, "
            "property_descriptor_changed, device_disconnected) and none of them can carry a "
            "module list change, so no push goes out and every other live session sees the new "
            "module only when it calls list_loaded_modules again"
            % (
                host_path,
                module_info.id,
                module_info.name,
                module_info.version or "(no version info)",
                len(module_info.component_types),
                ", ".join(
                    "%s %s" % (component_type.kind, component_type.id)
                    for component_type in module_info.component_types
                )
                or "none",
                modules_before,
                modules_after,
            ),
            flush=True,
        )
        return module_info

    # --- get_component_attributes -------------------------------------------

    def _attribute_rows_reachable_on(self, component):
        """Every attribute row this component actually carries, as
        (wire_id, label, value_type, hardcoded_locked, binding_attribute_name,
        the object the attribute is read off), plus the labels openDAQ itself
        reports locked.

        The set is NOT fixed: seven IComponent rows always, five more if ISignal
        casts, three more if IInputPort casts. A component that carries neither
        cast yields seven rows -- it does not yield eight with a null value,
        which would claim the attribute exists and has no value.
        """
        daq = self._daq
        # quack-snippet shared=component-attribute-rows
        # An attribute is a member of the openDAQ interface itself, not an entry
        # in a property bag, so which attributes exist depends on which
        # interfaces the component carries. Every component is an IComponent;
        # the extra rows are reached by casting, exactly as the reference does.
        rows = [row + (component,) for row in _COMPONENT_ATTRIBUTE_ROWS]
        if daq.ISignal.can_cast_from(component):
            signal = daq.ISignal.cast_from(component)
            rows += [row + (signal,) for row in _SIGNAL_ATTRIBUTE_ROWS]
        if daq.IInputPort.can_cast_from(component):
            input_port = daq.IInputPort.cast_from(component)
            rows += [row + (input_port,) for row in _INPUT_PORT_ATTRIBUTE_ROWS]
        # IComponent.locked_attributes is openDAQ's own runtime statement that a
        # named attribute may not be written. It is keyed by the LABEL, which is
        # why the reference matches it against its own display keys.
        locked_labels = [str(label) for label in component.locked_attributes]
        # quack-snippet end
        return rows, locked_labels

    def _attribute_value_and_wire_type(self, wire_id, declared_value_type, holder, binding_name):
        """The value of one attribute and the wire value_type it is reported
        under, or (None, None) for a row this host will not report.

        Three rows do not hand back what their binding name holds: what crosses
        the wire for domain_signal, related_signals and signal is the GLOBAL ID
        of the object, never the object.
        """
        # quack-snippet capability=attribute.read uses=component-attribute-rows step=1
        # Three of the fourteen do not hand back what their binding name holds:
        # what crosses the wire for the domain signal, the related signals and an
        # input port's signal is the GLOBAL ID of the object, never the object.
        if wire_id == "domain_signal_id":
            domain_signal = holder.domain_signal
            return ("" if domain_signal is None else str(domain_signal.global_id)), "string"
        if wire_id == "related_signal_ids":
            related = holder.related_signals
            return [str(signal.global_id) for signal in related] if related else [], "string_list"
        if wire_id == "signal_id":
            connected_signal = holder.signal
            return ("" if connected_signal is None else str(connected_signal.global_id)), "string"
        if wire_id == "tags":
            # ITags is an object, not a list: IComponent has getTags and no
            # setTags (component.h:164), and the strings are on ITags.getList
            # (tags.h:39-60). The WRITER is a different interface again --
            # ITagsPrivate::add/remove/replace (tags_private.h:34-56), reached by
            # a cast from component.tags -- which is what set_component_attribute
            # uses below.
            return [str(tag) for tag in holder.tags.list], "string_list"
        raw = getattr(holder, binding_name)
        # quack-snippet end
        if declared_value_type == _ATTRIBUTE_VALUE_TYPE_BOOL:
            return bool(raw), _ATTRIBUTE_VALUE_TYPE_BOOL
        if declared_value_type == _ATTRIBUTE_VALUE_TYPE_STRING:
            return str(raw), _ATTRIBUTE_VALUE_TYPE_STRING
        # last_value is the one row with no declared type: it is whatever the
        # signal last carried, so the type is read off the value itself.
        value = self._value_to_json(raw)
        if isinstance(value, bool):
            return value, _ATTRIBUTE_VALUE_TYPE_BOOL
        if isinstance(value, int):
            return value, "int"
        if isinstance(value, float):
            return value, "float"
        if isinstance(value, str):
            return value, _ATTRIBUTE_VALUE_TYPE_STRING
        return None, None

    def get_component_attributes(self, node_id):
        component = self._resolve_component(node_id)
        try:
            rows, locked_labels = self._attribute_rows_reachable_on(component)
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(
                e, "get_component_attributes", NOT_FOUND
            )

        attributes = []
        omitted = []
        for wire_id, label, declared_value_type, hardcoded_locked, binding_name, holder in rows:
            try:
                value, value_type = self._attribute_value_and_wire_type(
                    wire_id, declared_value_type, holder, binding_name
                )
            except Exception as e:
                omitted.append("%s (%s: %s)" % (wire_id, type(e).__name__, e))
                continue
            if value_type is None:
                omitted.append(
                    "%s (openDAQ answered %r, which is none of bool, int, float, string or "
                    "string_list, and types.ComponentAttribute.value_type has no other member)"
                    % (wire_id, value)
                )
                continue
            if wire_id == "related_signal_ids" and not value:
                # The reference adds this row only when the signal has related
                # signals at all (generic_attributes_treeview.py:150-152); an
                # empty list here would be a row about nothing.
                omitted.append("related_signal_ids (this signal has no related signals)")
                continue
            attribute = ComponentAttribute()
            attribute.id = wire_id
            attribute.name = label
            attribute.value = value
            attribute.value_type = value_type
            attribute.read_only = bool(hardcoded_locked or label in locked_labels)
            attributes.append(attribute)

        print(
            "[opendaq] get_component_attributes(%s) read %d attribute row(s) off a %s: %s. "
            "IComponent.locked_attributes reported %s. %d row(s) were left out: %s"
            % (
                node_id,
                len(attributes),
                self._kind_of(component),
                ", ".join(
                    "%s=%r%s" % (a.id, a.value, " (read_only)" if a.read_only else "")
                    for a in attributes
                )
                or "none",
                ", ".join(locked_labels) or "no locked attribute",
                len(omitted),
                "; ".join(omitted) or "none",
            ),
            flush=True,
        )
        return attributes

    # --- set_component_attribute --------------------------------------------

    def set_component_attribute(self, node_id, attribute_id, value):
        component = self._resolve_component(node_id)
        try:
            rows, locked_labels = self._attribute_rows_reachable_on(component)
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(
                e, "set_component_attribute", NOT_FOUND
            )

        matched = None
        for row in rows:
            if row[0] == attribute_id:
                matched = row
                break
        if matched is None:
            raise ServiceError(
                NOT_FOUND,
                'component "%s" reports no attribute "%s"; get_component_attributes answers %s '
                "for it" % (node_id, attribute_id, ", ".join(row[0] for row in rows)),
            )

        wire_id, label, declared_value_type, hardcoded_locked, binding_name, holder = matched
        if hardcoded_locked:
            raise ServiceError(
                READ_ONLY,
                'attribute "%s" ("%s") on "%s" is read-only: it is one of the rows the reference '
                "hardcodes Locked (global_id, local_id, streamed, last_value, signal_id, "
                "requires_signal and the domain and related signal ids), because what it holds is "
                "openDAQ's own identity or a value derived from another component"
                % (wire_id, label, node_id),
            )
        if label in locked_labels:
            raise ServiceError(
                READ_ONLY,
                'attribute "%s" ("%s") on "%s" is read-only: openDAQ itself reports it in '
                "IComponent.locked_attributes, which reads [%s] for this component"
                % (wire_id, label, node_id, ", ".join(locked_labels)),
            )

        if declared_value_type == _ATTRIBUTE_VALUE_TYPE_BOOL:
            if not isinstance(value, bool):
                raise ServiceError(
                    INVALID_VALUE,
                    'attribute "%s" on "%s" is a bool; params.value was %r (%s)'
                    % (wire_id, node_id, value, type(value).__name__),
                )
            converted = value
        elif declared_value_type == _ATTRIBUTE_VALUE_TYPE_STRING:
            if not isinstance(value, str):
                raise ServiceError(
                    INVALID_VALUE,
                    'attribute "%s" on "%s" is a string; params.value was %r (%s)'
                    % (wire_id, node_id, value, type(value).__name__),
                )
            converted = value
        elif declared_value_type == _ATTRIBUTE_VALUE_TYPE_STRING_LIST:
            if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                raise ServiceError(
                    INVALID_VALUE,
                    'attribute "%s" on "%s" is a list of strings; params.value was %r'
                    % (wire_id, node_id, value),
                )
            converted = list(value)
        else:
            raise ServiceError(
                INVALID_VALUE,
                'attribute "%s" on "%s" has no declared wire value type, so this host will not '
                "write it" % (wire_id, node_id),
            )

        try:
            before, _ = self._attribute_value_and_wire_type(
                wire_id, declared_value_type, holder, binding_name
            )
        except Exception:
            before = "(unreadable before the write)"

        try:
            if wire_id == "tags":
                # quack-snippet capability=attribute.write uses=component-attribute-rows step=2
                # TAGS IS THE ONE ATTRIBUTE THAT IS NOT A setattr, because
                # IComponent has getTags and no setTags (component.h:164) and
                # ITags itself is read-only -- getList, contains, query
                # (tags.h:39-60). The writer is a SEPARATE INTERFACE,
                # ITagsPrivate::add/remove/replace (tags_private.h:34-56),
                # reached by casting the ITags object the component hands back.
                # replace() sets the whole list, which is what a wire value of
                # type string_list means.
                tags_private = self._daq.ITagsPrivate.cast_from(holder.tags)
                tags_private.replace(converted)
                # quack-snippet end
            else:
                # quack-snippet capability=attribute.write uses=component-attribute-rows step=1
                # Every attribute except tags is written with setattr on the
                # interface that declares it -- IComponent for name, description,
                # active and visible, ISignal or IInputPort for public -- never
                # through set_property_value. That is exactly what the reference
                # does: setattr(node, attribute, new_value),
                # generic_attributes_treeview.py:110.
                setattr(holder, binding_name, converted)
                # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(
                e, "set_component_attribute", INVALID_VALUE
            )

        try:
            after, _ = self._attribute_value_and_wire_type(
                wire_id, declared_value_type, holder, binding_name
            )
        except Exception as e:
            after = "(unreadable after the write: %s)" % e
        call_made = (
            "ITagsPrivate.cast_from(%s.tags).replace(%r)" % (type(holder).__name__, converted)
            if wire_id == "tags"
            else 'setattr(%s, "%s", %r)' % (type(holder).__name__, binding_name, converted)
        )
        print(
            "[opendaq] set_component_attribute(%s, %s) called %s; the attribute read %r before "
            "the write and %r after it"
            % (node_id, wire_id, call_made, before, after),
            flush=True,
        )

    # --- list_server_types ---------------------------------------------------

    def list_server_types(self):
        try:
            # quack-snippet capability=server.add uses=instance-with-module-path,component-type-info step=1
            # What the INSTANCE will accept, which is not the same question as
            # which server types each module offers: this dictionary is keyed by
            # the type id and holds the IServerType object, and it is the exact
            # dictionary the reference's add-server window is filled from.
            available = self._instance.available_server_types
            keys = [str(key) for key in available.keys()]
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(e, "list_server_types", NOT_CONNECTED)

        out = []
        for key in keys:
            try:
                # A server type carries no connection string prefix: that lives
                # on IDeviceType and IStreamingType only.
                identifier, type_name, description, _ = self._component_type_info_of(
                    available[key], False
                )
            except ServiceError:
                raise
            except Exception as e:
                raise self._translated_within_declared_subset(
                    e, "list_server_types", NOT_CONNECTED
                )
            component_type = ComponentTypeInfo()
            component_type.id = identifier
            component_type.name = type_name
            component_type.kind = "server"
            component_type.description = description or None
            component_type.connection_string_prefix = None
            out.append(component_type)

        print(
            "[opendaq] list_server_types read %d server type(s) off IInstance."
            "available_server_types: %s"
            % (
                len(out),
                "; ".join(
                    '%s ("%s")' % (component_type.id, component_type.name)
                    for component_type in out
                )
                or "none",
            ),
            flush=True,
        )
        return out

    # --- add_server ----------------------------------------------------------

    def add_server(self, type_id):
        try:
            available_ids = [str(key) for key in self._instance.available_server_types.keys()]
        except Exception as e:
            raise self._translated_within_declared_subset(e, "add_server", NOT_CONNECTED)
        if type_id not in available_ids:
            raise ServiceError(
                UNSUPPORTED,
                'this instance offers no server type "%s"; list_server_types answers %s'
                % (type_id, ", ".join(available_ids) or "an empty list"),
            )

        try:
            # quack-snippet capability=server.add uses=instance-with-module-path,component-node step=2
            # addServer is declared on IDevice and the reference calls it on the
            # INSTANCE always, never on the selected node, because only the root
            # device accepts servers. The second argument is the server's config
            # object; None means openDAQ's own defaults, which is what this
            # contract's row carries -- it takes a type id and nothing else. The
            # server it hands back is already in the instance's Servers folder.
            server = self._instance.add_server(type_id, None)
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            error = self._translated_within_declared_subset(e, "add_server", INTERNAL)
            print(
                '[opendaq] add_server("%s") failed: openDAQ raised %s "%s", reported on the wire '
                "as %s" % (type_id, type(e).__name__, e, error.code),
                flush=True,
            )
            raise error

        node = self._build_node(self._daq.IComponent.cast_from(server))
        print(
            '[opendaq] add_server("%s") added server %s named "%s", kind %s, IServer.id = %s; '
            "IInstance.servers now holds %d server(s): %s. remove_server takes it back down again"
            % (
                type_id,
                node.id,
                node.name,
                node.kind,
                str(self._daq.IServer.cast_from(server).id),
                len(list(self._instance.servers)),
                ", ".join(str(s.global_id) for s in self._instance.servers) or "none",
            ),
            flush=True,
        )
        return node

    # --- remove_server -------------------------------------------------------

    def remove_server(self, node_id):
        component = self._resolve_component(node_id)
        server = self._as_server(component, node_id, "remove_server")
        servers_before = [str(s.global_id) for s in self._instance.servers]

        try:
            # quack-snippet capability=server.add uses=instance-with-module-path,server-of-component step=3
            # removeServer is declared on IDevice (device.h:300-304) and, like
            # addServer, the reference target is the INSTANCE: onRemoveServer
            # (device_impl.h:1479-1487) is the exact mirror of onAddServer, with
            # the same root-device restriction, and IInstance forwards it
            # (instance_impl.cpp:271-274 is `return rootDevice->removeServer(server);`).
            # It takes the IServer object, so the wire's node_id is resolved to a
            # component and taken through its IServer facet first.
            #
            # THE SOCKET ACTUALLY CLOSES. folder_impl.h:598-605 removes the item,
            # which calls IComponent::removed, and ServerImpl::removed
            # (server_impl.h:199-202) is `checkErrorInfo(stop()); Super::removed();`
            # -- IServer::stop, whose own doc (server.h:55) is "Stops the server.
            # This is called when we remove the server from the Instance or
            # Instance is closing."
            self._instance.remove_server(server)
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            error = self._translated_within_declared_subset(e, "remove_server", INTERNAL)
            print(
                "[opendaq] remove_server(%s) failed: openDAQ raised %s \"%s\", reported on the "
                "wire as %s" % (node_id, type(e).__name__, e, error.code),
                flush=True,
            )
            raise error

        servers_after = [str(s.global_id) for s in self._instance.servers]
        print(
            "[opendaq] remove_server(%s) called IInstance.remove_server on the IServer facet of "
            "that component (IServer.id = %s); IInstance.servers held %d before the call (%s) and "
            "holds %d after it (%s), and ServerImpl::removed called IServer::stop() on the way "
            "out, so its listening socket is closed"
            % (
                node_id,
                str(server.id),
                len(servers_before),
                ", ".join(servers_before) or "none",
                len(servers_after),
                ", ".join(servers_after) or "none",
            ),
            flush=True,
        )

    # --- set_server_discovery_enabled ---------------------------------------

    def set_server_discovery_enabled(self, node_id, enabled):
        component = self._resolve_component(node_id)
        server = self._as_server(component, node_id, "set_server_discovery_enabled")

        try:
            # quack-snippet capability=server.discovery uses=server-of-component step=1
            # openDAQ has two methods and no state: IServer.enable_discovery and
            # IServer.disable_discovery start and stop the mDNS advertisement,
            # and NOTHING on IServer reports whether it is on. One wire setter
            # with a bool picks between them.
            if enabled:
                server.enable_discovery()
            else:
                server.disable_discovery()
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(
                e, "set_server_discovery_enabled", INTERNAL
            )

        print(
            "[opendaq] set_server_discovery_enabled(%s, %r) called IServer.%s() on server id %s. "
            "openDAQ publishes no discovery-state getter, so nothing is read back and this host "
            "reports no discovery field on any node"
            % (
                node_id,
                enabled,
                "enable_discovery" if enabled else "disable_discovery",
                str(server.id),
            ),
            flush=True,
        )

    # --- start_recording / stop_recording ------------------------------------

    def start_recording(self, node_id):
        component = self._resolve_component(node_id)
        recorder = self._as_recorder(component, node_id, "start_recording")
        was_recording = bool(recorder.is_recording)
        try:
            # quack-snippet capability=recorder.control uses=recorder-of-component step=1
            recorder.start_recording()
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(e, "start_recording", INTERNAL)
        print(
            "[opendaq] start_recording(%s) called IRecorder.start_recording(); "
            "IRecorder.is_recording read %r before the call and %r after it"
            % (node_id, was_recording, bool(recorder.is_recording)),
            flush=True,
        )

    def stop_recording(self, node_id):
        component = self._resolve_component(node_id)
        recorder = self._as_recorder(component, node_id, "stop_recording")
        was_recording = bool(recorder.is_recording)
        try:
            # quack-snippet capability=recorder.control uses=recorder-of-component step=2
            recorder.stop_recording()
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(e, "stop_recording", INTERNAL)
        print(
            "[opendaq] stop_recording(%s) called IRecorder.stop_recording(); "
            "IRecorder.is_recording read %r before the call and %r after it"
            % (node_id, was_recording, bool(recorder.is_recording)),
            flush=True,
        )

    # --- begin_batched_property_update / end_batched_property_update ---------

    def _property_object_for_batched_update(self, component, node_id, wire_method):
        """_as_property_object answers `unsupported`, which is outside the subset
        both batched-update rows declare. Every openDAQ component carries
        IPropertyObject, so this cannot fire -- but if it ever did, the code on
        the wire has to stay inside [not_found, not_connected(, invalid_value)],
        and not_found is the one of those that can be about a node."""
        try:
            return self._as_property_object(component, node_id)
        except ServiceError as e:
            raise ServiceError(
                NOT_FOUND,
                'component "%s" could not be taken through its IPropertyObject facet (%s: %s); '
                "contract/contract.yaml declares no unsupported for %s, because every openDAQ "
                "component is an IPropertyObject" % (node_id, e.code, e.detail, wire_method),
            )

    def begin_batched_property_update(self, node_id):
        component = self._resolve_component(node_id)
        property_object = self._property_object_for_batched_update(
            component, node_id, "begin_batched_property_update"
        )
        was_updating = bool(property_object.updating)
        try:
            # quack-snippet capability=property.batched_update uses=property-object-of-component step=1
            # beginUpdate is RECURSIVE over the component's child property
            # objects, so one call on a device puts its whole subtree into batch
            # mode -- for every session at once, because the batch belongs to the
            # component and not to the socket that opened it. Until endUpdate,
            # set_property_value is held rather than applied.
            property_object.begin_update()
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(
                e, "begin_batched_property_update", NOT_FOUND
            )
        print(
            "[opendaq] begin_batched_property_update(%s) called IPropertyObject.begin_update(); "
            "IPropertyObject.updating read %r before the call and %r after it. Every "
            "set_property_value against this component is now HELD until "
            "end_batched_property_update, and because beginUpdate is recursive the same holds for "
            "its child property objects"
            % (node_id, was_updating, bool(property_object.updating)),
            flush=True,
        )

    def end_batched_property_update(self, node_id):
        component = self._resolve_component(node_id)
        property_object = self._property_object_for_batched_update(
            component, node_id, "end_batched_property_update"
        )

        # The out-of-order call is answered, never swallowed. openDAQ raises
        # RuntimeError("The object is not in updating state") for it -- read off
        # openDAQ 3.41.0_bec37b44 on this machine by calling end_update() twice --
        # and the reference swallows exactly that with a bare
        # "except RuntimeError: pass" (gui_demo.py:1374-1378). Silence would tell
        # a user their batch was applied.
        if not bool(property_object.updating):
            raise ServiceError(
                INVALID_VALUE,
                'no batched update is open on "%s": IPropertyObject.updating reads False, so '
                "there is no begin_batched_property_update for this call to end. Nothing was "
                "applied and nothing was discarded" % node_id,
            )

        try:
            # quack-snippet capability=property.batched_update uses=property-object-of-component step=2
            # endUpdate applies everything set since beginUpdate, in one go, and
            # raises if no beginUpdate is open.
            property_object.end_update()
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(
                e, "end_batched_property_update", INVALID_VALUE
            )
        print(
            "[opendaq] end_batched_property_update(%s) called IPropertyObject.end_update(); "
            "IPropertyObject.updating read True before the call and %r after it, and every "
            "property write held since the matching begin has now been applied"
            % (node_id, bool(property_object.updating)),
            flush=True,
        )

    # --- save_instance_configuration_to_string -------------------------------

    def save_instance_configuration_to_string(self):
        try:
            # quack-snippet capability=configuration.save uses=instance-with-module-path step=1
            # saveConfiguration is declared on IDevice and answers a STRING, not
            # a path: openDAQ writes no file here. The Instance is a device, so
            # this serialises the whole instance -- every device under it, their
            # properties and their structure -- into one JSON document.
            configuration = str(self._instance.save_configuration())
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            raise self._translated_within_declared_subset(
                e, "save_instance_configuration_to_string", INTERNAL
            )
        print(
            "[opendaq] save_instance_configuration_to_string serialised the instance into %d "
            "character(s), %d byte(s) of UTF-8; it begins %r"
            % (len(configuration), len(configuration.encode("utf-8")), configuration[:120]),
            flush=True,
        )
        return configuration

    # --- load_instance_configuration_from_string -----------------------------

    def load_instance_configuration_from_string(self, configuration):
        print(
            "[opendaq] load_instance_configuration_from_string: handing %d character(s), %d "
            "byte(s) of UTF-8 to IDevice.load_configuration on the instance; it begins %r"
            % (len(configuration), len(configuration.encode("utf-8")), configuration[:120]),
            flush=True,
        )
        try:
            # quack-snippet capability=configuration.load uses=instance-with-module-path step=1
            # loadConfiguration takes the configuration STRING and an optional
            # IUpdateParameters. This contract's row carries no parameters, so
            # the second argument is left off and openDAQ's defaults apply --
            # the same call gui_demo.py's own _load_config path makes. It
            # replaces the configuration of every device under the instance in
            # one go.
            self._instance.load_configuration(configuration)
            # quack-snippet end
        except ServiceError:
            raise
        except Exception as e:
            error = self._translated_within_declared_subset(
                e, "load_instance_configuration_from_string", INVALID_VALUE
            )
            print(
                "[opendaq] load_instance_configuration_from_string failed: openDAQ raised %s "
                '"%s", reported on the wire as %s' % (type(e).__name__, e, error.code),
                flush=True,
            )
            raise error
        print(
            "[opendaq] load_instance_configuration_from_string applied the configuration; the "
            "instance root %s now holds %d device(s) directly under it"
            % (str(self._instance.global_id), len(list(self._instance.devices))),
            flush=True,
        )
