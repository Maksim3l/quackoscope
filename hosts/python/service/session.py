"""Quackoscope host (Python) -- service layer.

The fourteen operations of the M1 contract this host serves, the per-session
registries that decide what a session may address, and the data-plane path that
turns a block of samples into one binary frame. Nothing here imports opendaq;
nothing here talks to a socket except through the connection object the
transport hands over.
"""

import json
import threading

from transport import wire

from .sample_decimator import decimate_to_pixel_columns
from .wire_dtos import module_info_to_json, node_to_json, property_descriptor_to_json
from .wire_errors import (
    INTERNAL,
    INVALID_VALUE,
    NOT_CONNECTED,
    NOT_FOUND,
    UNSUPPORTED,
    ServiceError,
)


# The wire methods _dispatch answers, and the only source the handshake's
# capability list is computed from: a method served without being named here
# would be missing from the declared capabilities, and a method named here
# without a handler would be declared and then refused.
SERVED_WIRE_METHODS = (
    "connect_device",
    "disconnect_device",
    "get_component_tree",
    "get_property_descriptors",
    "get_property_value",
    "set_property_value",
    "subscribe_signal",
    "unsubscribe_signal",
    "get_device_operation_modes",
    "set_device_operation_mode",
    "lock_device",
    "unlock_device",
    "list_loaded_modules",
    "load_module_from_host_path",
)

# Which code stands for "this session cannot address that node", per operation.
#
# _require_node_reachable_from_session answers not_connected when the session
# holds no device at all, because that is the truer statement -- but four of the
# five new operations do not declare not_connected in
# contract/contract.yaml, and answering a code outside an operation's declared
# subset is a conformance defect. For those, the same condition is reported as
# not_found: from the session's side the node genuinely does not exist, since a
# device another session connected is not addressable here either.
_UNREACHABLE_NODE_CODE_BY_WIRE_METHOD = {
    "get_component_tree": NOT_CONNECTED,        # errors [not_connected, not_found]
    "get_property_descriptors": NOT_CONNECTED,  # errors [not_found, not_connected]
    "get_property_value": NOT_CONNECTED,        # errors [not_found, not_connected]
    "set_property_value": NOT_FOUND,            # errors [not_found, read_only, invalid_value]
    "subscribe_signal": NOT_CONNECTED,          # errors [not_found, not_connected]
    "get_device_operation_modes": NOT_CONNECTED,  # errors [not_found, not_connected, unsupported]
    "set_device_operation_mode": NOT_FOUND,     # errors [not_found, invalid_value, read_only,
                                                #         unsupported]
    "lock_device": NOT_FOUND,                   # errors [not_found, read_only, unsupported]
    "unlock_device": NOT_FOUND,                 # errors [not_found, read_only, unsupported]
}


def _require_string(params, key):
    value = params.get(key)
    if not isinstance(value, str):
        raise ServiceError(INVALID_VALUE, "params.%s must be a string" % key)
    return value


def _parse_whole_uint32(text):
    """int("12abc") raises but int(" 12 ") and int("+12") do not; a subscription
    id has to be the whole decimal string and nothing else."""
    if not text or len(text) > 10 or not text.isdigit():
        return None
    value = int(text)
    return value if value <= 0xFFFFFFFF else None


def _require_positive_int(params, key):
    value = params.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ServiceError(INVALID_VALUE, "params.%s must be an integer" % key)
    if value <= 0 or value > 1000000:
        raise ServiceError(INVALID_VALUE, "params.%s must be in [1, 1000000]" % key)
    return value


class _SessionState:
    def __init__(self):
        self.device_node_ids_by_connection_string = {}
        self.subscriptions = {}  # subscription id -> (signal_id, pixel_columns)


class SessionHub:
    """One instance per host process; one _SessionState per live WebSocket."""

    def __init__(self, backend, handshake_message):
        self._backend = backend
        # Section 1.6: serialised once, sent verbatim as the first message of
        # every session. It never varies between sessions.
        self._handshake_message = handshake_message
        self._handshake_text = json.dumps(handshake_message, separators=(",", ":"))
        self._lock = threading.Lock()
        self._sessions = {}
        self._connections = {}
        self._sessions_holding_device = {}
        self._next_subscription_id = 1

    # --- connection lifecycle ---------------------------------------------

    def on_open(self, connection):
        with self._lock:
            self._sessions[id(connection)] = _SessionState()
            self._connections[id(connection)] = connection
            live = len(self._sessions)
        # Section 1.6: the handshake goes out before anything else on this
        # socket, and before the session is answered anything at all.
        connection.send_text(self._handshake_text)
        print(
            "[service] session opened for %s (%d live); handshake sent first: protocol_version "
            "%s, implementation %s %s, sdk %s at commit %s, %d capabilit%s (%s), %d gap(s) (%s)"
            % (
                connection.peer,
                live,
                self._handshake_message["protocol_version"],
                self._handshake_message["implementation"]["name"],
                self._handshake_message["implementation"]["version"],
                self._handshake_message["sdk"]["version"],
                self._handshake_message["sdk"]["commit"],
                len(self._handshake_message["capabilities"]),
                "y" if len(self._handshake_message["capabilities"]) == 1 else "ies",
                ", ".join(self._handshake_message["capabilities"]),
                len(self._handshake_message["gaps"]),
                ", ".join(
                    "%s/%s" % (gap["capability"], gap["kind"])
                    for gap in self._handshake_message["gaps"]
                ),
            ),
            flush=True,
        )

    def on_close(self, connection):
        with self._lock:
            state = self._sessions.pop(id(connection), None)
            self._connections.pop(id(connection), None)
            live = len(self._sessions)
            if state is None:
                return
            devices_to_release = []
            for connection_string, node_id in state.device_node_ids_by_connection_string.items():
                holders = self._sessions_holding_device.get(connection_string, 0) - 1
                if holders <= 0:
                    self._sessions_holding_device.pop(connection_string, None)
                    devices_to_release.append((connection_string, node_id))
                else:
                    self._sessions_holding_device[connection_string] = holders

        # A dropped socket invalidates the session: every subscription it held
        # goes away, and so does every device no other live session is holding.
        for subscription_id in list(state.subscriptions):
            try:
                self._backend.unsubscribe_signal(subscription_id)
            except Exception as e:
                print(
                    "[service] teardown of subscription %d failed: %s" % (subscription_id, e),
                    flush=True,
                )
        for connection_string, node_id in devices_to_release:
            try:
                self._backend.release_device(node_id)
                print(
                    "[service] released device %s (%s); no live session holds it any more"
                    % (node_id, connection_string),
                    flush=True,
                )
            except Exception as e:
                print(
                    "[service] releasing device %s (%s) failed: %s"
                    % (node_id, connection_string, e),
                    flush=True,
                )

        print(
            "[service] session closed: %d subscription(s) and %d device(s) dropped, %d of those "
            "removed from the instance, %d session(s) still live"
            % (
                len(state.subscriptions),
                len(state.device_node_ids_by_connection_string),
                len(devices_to_release),
                live,
            ),
            flush=True,
        )

    # --- request dispatch --------------------------------------------------

    def on_request(self, connection, method, params):
        """Returns the transport's Outcome shape: (ok, result, code, detail)."""
        try:
            return True, self._dispatch(connection, method, params), "", ""
        except ServiceError as e:
            return False, None, e.code, e.detail
        except Exception as e:
            return False, None, INTERNAL, "%s: %s" % (type(e).__name__, e)

    def _dispatch(self, connection, method, params):
        state = self._look_up_session(connection)
        if method == "connect_device":
            return self._connect_device(state, params)
        if method == "disconnect_device":
            return self._disconnect_device(state, params)
        if method == "get_component_tree":
            return self._get_component_tree(state, params)
        if method == "get_property_descriptors":
            return self._get_property_descriptors(state, params)
        if method == "get_property_value":
            return self._get_property_value(state, params)
        if method == "set_property_value":
            return self._set_property_value(state, params)
        if method == "subscribe_signal":
            return self._subscribe_signal(connection, state, params)
        if method == "unsubscribe_signal":
            return self._unsubscribe_signal(state, params)
        if method == "get_device_operation_modes":
            return self._get_device_operation_modes(state, params)
        if method == "set_device_operation_mode":
            return self._set_device_operation_mode(state, params)
        if method == "lock_device":
            return self._lock_device(state, params)
        if method == "unlock_device":
            return self._unlock_device(state, params)
        if method == "list_loaded_modules":
            return self._list_loaded_modules(state, params)
        if method == "load_module_from_host_path":
            return self._load_module_from_host_path(state, params)
        raise ServiceError(
            UNSUPPORTED,
            'unknown method "%s"; quackoscope-host-python serves %s'
            % (method, ", ".join(SERVED_WIRE_METHODS)),
        )

    def _look_up_session(self, connection):
        with self._lock:
            state = self._sessions.get(id(connection))
        if state is None:
            raise ServiceError(NOT_CONNECTED, "this WebSocket session is already closed")
        return state

    def _require_device_in_session(self, state, wire_method):
        with self._lock:
            empty = not state.device_node_ids_by_connection_string
        if empty:
            raise ServiceError(
                _UNREACHABLE_NODE_CODE_BY_WIRE_METHOD[wire_method],
                "this session has connected no device; call connect_device first (a device "
                "another session connected is not visible here)",
            )

    def _require_node_reachable_from_session(self, state, params, key, wire_method):
        node_id = _require_string(params, key)
        with self._lock:
            held = dict(state.device_node_ids_by_connection_string)
        for device_node_id in held.values():
            if node_id == device_node_id or node_id.startswith(device_node_id + "/"):
                return node_id
        if not held:
            raise ServiceError(
                _UNREACHABLE_NODE_CODE_BY_WIRE_METHOD[wire_method],
                'this session has connected no device, so "%s" is not addressable; call '
                "connect_device first" % node_id,
            )
        raise ServiceError(
            NOT_FOUND,
            'no component with id "%s" in this session; it holds %s'
            % (node_id, ", ".join(held.values())),
        )

    # --- device.connect, tree.read, property.read/write, streaming.decimated ---

    def _connect_device(self, state, params):
        connection_string = _require_string(params, "connection_string")
        if not connection_string:
            raise ServiceError(
                INVALID_VALUE,
                'params.connection_string is empty; it must name a device, e.g. "daqref://device0"',
            )

        # Idempotent within the session: the backend hands back the already-added
        # device for a connection string this process has seen, and the holder
        # count only moves the first time THIS session asks for it.
        node = self._backend.connect_device(connection_string)
        with self._lock:
            if connection_string not in state.device_node_ids_by_connection_string:
                state.device_node_ids_by_connection_string[connection_string] = node.id
                self._sessions_holding_device[connection_string] = (
                    self._sessions_holding_device.get(connection_string, 0) + 1
                )
        return node_to_json(node)

    def _disconnect_device(self, state, params):
        node_id = _require_string(params, "node_id")

        with self._lock:
            connection_string = None
            for held_connection_string, held_node_id in (
                state.device_node_ids_by_connection_string.items()
            ):
                if held_node_id == node_id:
                    connection_string = held_connection_string
                    break

            if connection_string is None:
                holds_instead = (
                    ", ".join(state.device_node_ids_by_connection_string.values())
                    or "no device at all"
                )
                raise ServiceError(
                    NOT_FOUND,
                    'this session did not connect a device with id "%s"; it holds %s'
                    % (node_id, holds_instead),
                )

            del state.device_node_ids_by_connection_string[connection_string]
            holders_left = self._sessions_holding_device.get(connection_string, 1) - 1
            if holders_left <= 0:
                self._sessions_holding_device.pop(connection_string, None)
                this_session_was_the_last_holder = True
            else:
                self._sessions_holding_device[connection_string] = holders_left
                this_session_was_the_last_holder = False

        if not this_session_was_the_last_holder:
            # The device stays in the openDAQ Instance for the sessions that
            # still hold it; it simply stops being addressable from this one.
            print(
                "[service] disconnect_device %s (%s): dropped from this session, kept in the "
                "openDAQ Instance because %d other session(s) still hold it"
                % (node_id, connection_string, holders_left),
                flush=True,
            )
            return None

        self._backend.disconnect_device(node_id)
        print(
            "[service] disconnect_device %s (%s): dropped from this session, which was the last "
            "holder, so it was removed from the openDAQ Instance too" % (node_id, connection_string),
            flush=True,
        )
        return None

    def _get_component_tree(self, state, params):
        self._require_device_in_session(state, "get_component_tree")
        if isinstance(params.get("root_id"), str):
            roots = [
                self._require_node_reachable_from_session(
                    state, params, "root_id", "get_component_tree"
                )
            ]
        else:
            # No root_id means "everything this session can see", which is
            # exactly the devices it connected itself -- never another session's.
            with self._lock:
                roots = list(state.device_node_ids_by_connection_string.values())
        out = []
        for root in roots:
            for node in self._backend.get_component_tree(root):
                out.append(node_to_json(node))
        return out

    def _get_property_descriptors(self, state, params):
        self._require_device_in_session(state, "get_property_descriptors")
        node_id = self._require_node_reachable_from_session(
            state, params, "node_id", "get_property_descriptors"
        )
        return [property_descriptor_to_json(d) for d in self._backend.get_property_descriptors(node_id)]

    def _get_property_value(self, state, params):
        self._require_device_in_session(state, "get_property_value")
        node_id = self._require_node_reachable_from_session(
            state, params, "node_id", "get_property_value"
        )
        return self._backend.get_property_value(node_id, _require_string(params, "property_id"))

    def _set_property_value(self, state, params):
        self._require_device_in_session(state, "set_property_value")
        if "value" not in params:
            raise ServiceError(INVALID_VALUE, "params.value is required")
        node_id = self._require_node_reachable_from_session(
            state, params, "node_id", "set_property_value"
        )
        self._backend.set_property_value(
            node_id, _require_string(params, "property_id"), params["value"]
        )
        return None

    def _subscribe_signal(self, connection, state, params):
        self._require_device_in_session(state, "subscribe_signal")
        signal_id = self._require_node_reachable_from_session(
            state, params, "signal_id", "subscribe_signal"
        )
        pixel_columns = _require_positive_int(params, "pixel_columns")

        with self._lock:
            subscription_id = self._next_subscription_id
            self._next_subscription_id += 1

        def sink(sent_subscription_id, domain_start, values):
            self._emit_frame(connection, sent_subscription_id, pixel_columns, domain_start, values)

        self._backend.subscribe_signal(signal_id, subscription_id, sink)
        with self._lock:
            state.subscriptions[subscription_id] = (signal_id, pixel_columns)

        # The subscription_id on the wire is the decimal text of the uint32 that
        # rides in the binary frame header.
        return str(subscription_id)

    def _unsubscribe_signal(self, state, params):
        text = _require_string(params, "subscription_id")
        subscription_id = _parse_whole_uint32(text)
        if subscription_id is None:
            raise ServiceError(
                INVALID_VALUE,
                "params.subscription_id must be the decimal text of a uint32, whole and with "
                'nothing else in it; got "%s"' % text,
            )
        with self._lock:
            if subscription_id not in state.subscriptions:
                raise ServiceError(
                    NOT_FOUND, 'no subscription "%s" on this session' % text
                )
            del state.subscriptions[subscription_id]
        self._backend.unsubscribe_signal(subscription_id)
        return None

    # --- device.mode --------------------------------------------------------

    def _get_device_operation_modes(self, state, params):
        self._require_device_in_session(state, "get_device_operation_modes")
        node_id = self._require_node_reachable_from_session(
            state, params, "node_id", "get_device_operation_modes"
        )
        return self._backend.get_device_operation_modes(node_id)

    def _set_device_operation_mode(self, state, params):
        self._require_device_in_session(state, "set_device_operation_mode")
        node_id = self._require_node_reachable_from_session(
            state, params, "node_id", "set_device_operation_mode"
        )
        mode = params.get("mode")
        if not isinstance(mode, str):
            # invalid_value and not internal: set_device_operation_mode declares
            # [not_found, invalid_value, read_only, unsupported], and a
            # non-string mode is exactly a bad value.
            raise ServiceError(
                INVALID_VALUE,
                "params.mode must be a string naming one of the operation modes "
                "get_device_operation_modes answers; got %r" % (mode,),
            )
        self._backend.set_device_operation_mode(node_id, mode)
        return None

    # --- device.lock --------------------------------------------------------

    def _lock_device(self, state, params):
        self._require_device_in_session(state, "lock_device")
        node_id = self._require_node_reachable_from_session(
            state, params, "node_id", "lock_device"
        )
        self._backend.lock_device(node_id)
        return None

    def _unlock_device(self, state, params):
        self._require_device_in_session(state, "unlock_device")
        node_id = self._require_node_reachable_from_session(
            state, params, "node_id", "unlock_device"
        )
        # force is presence: optional, so an absent key is not an error; it means
        # the plain IDevice.unlock(). A present key that is not a bool is a bad
        # value, but unlock_device declares [not_found, read_only, unsupported]
        # and none of those can say "bad parameter", so a non-bool is read as
        # its truthiness and the choice made is printed instead of guessed at.
        force = bool(params.get("force", False))
        if "force" in params and not isinstance(params["force"], bool):
            print(
                "[service] unlock_device was sent params.force = %r, which is not a bool; "
                "unlock_device declares no error code for a malformed parameter, so it is read as "
                "force = %r" % (params["force"], force),
                flush=True,
            )
        self._backend.unlock_device(node_id, force)
        return None

    # --- module.read --------------------------------------------------------

    def _list_loaded_modules(self, state, params):
        # No device is required: the modules are a fact about the openDAQ
        # Instance this process built from the manifest's module path, and the
        # Modules view is exactly what a client opens BEFORE it has connected
        # anything. The only not_connected list_loaded_modules can answer is the
        # one _look_up_session already raised for a socket that is gone.
        return [module_info_to_json(module) for module in self._backend.list_loaded_modules()]

    # --- module.load --------------------------------------------------------

    def _load_module_from_host_path(self, state, params):
        # No device is required here either, for the same reason
        # list_loaded_modules needs none: the module manager belongs to the
        # openDAQ Instance this process built, not to any connected device. The
        # only not_connected this operation can answer is the one
        # _look_up_session already raised for a socket that is gone.
        #
        # A non-string host_path is invalid_value and not internal:
        # load_module_from_host_path declares [not_found, not_connected,
        # invalid_value, internal], and a parameter of the wrong type is exactly
        # a bad value. Emptiness, absoluteness and whether anything is at the
        # path are decided one layer down, where the host's own filesystem and
        # its module directory are known.
        host_path = _require_string(params, "host_path")
        return module_info_to_json(self._backend.load_module_from_host_path(host_path))

    # --- data plane ---------------------------------------------------------

    def _emit_frame(self, connection, subscription_id, pixel_columns, domain_start, values):
        block = decimate_to_pixel_columns(values, pixel_columns)
        if block.sample_count == 0:
            return
        connection.send_binary(
            wire.encode_data_frame(
                subscription_id,
                domain_start,
                block.sample_count,
                block.encoding,
                block.payload,
            )
        )

    # --- server push --------------------------------------------------------

    def publish(self, envelope):
        with self._lock:
            targets = list(self._connections.values())
        for connection in targets:
            connection.send_json(envelope)
        print(
            "[service] pushed %s to %d session(s): payload keys %s"
            % (
                envelope.get("event"),
                len(targets),
                ", ".join(sorted(envelope.get("payload", {}))) or "<none>",
            ),
            flush=True,
        )
