"""Drives a running Quackoscope host through the twelve contract rows that
carry attribute.read, attribute.write, server.add (list_server_types,
add_server AND remove_server), server.discovery, recorder.control,
property.batched_update, configuration.save and configuration.load -- their
successes AND the failure each one declares.

It speaks the wire itself over a raw socket, reusing the WireClient of
exercise_seven_operations_over_websocket.py, so nothing about the host is taken
on trust. The handshake is printed verbatim; every request and every reply is
printed with its literal values.

    python hosts/python/exercise_attributes_servers_recorder_batched_update_and_configuration_over_websocket.py --port 8122
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from exercise_seven_operations_over_websocket import WireClient  # noqa: E402


def read_handshake_verbatim(client):
    """The section 1.6 message is the first frame on the socket, before any
    reply. It is printed exactly as it arrived."""
    opcode, payload = client._receive()  # noqa: SLF001 -- this file IS the wire client
    assert opcode == 0x1, "the first frame was opcode %d, not text" % opcode
    text = payload.decode("utf-8")
    print("=" * 78)
    print("HANDSHAKE, verbatim, as the first frame of the session:")
    print(text)
    print("=" * 78)
    return json.loads(text)


def expect_error(reply, wire_method, expected_code):
    error = reply.get("error")
    if error is None:
        print(
            "!!! %s answered a RESULT where %s was expected: %s"
            % (wire_method, expected_code, json.dumps(reply.get("result"))[:400])
        )
        return False
    if error["code"] != expected_code:
        print(
            "!!! %s answered %s where %s was expected; detail: %s"
            % (wire_method, error["code"], expected_code, error["detail"])
        )
        return False
    print("    %s answered %s as declared: %s" % (wire_method, expected_code, error["detail"]))
    return True


def expect_result(reply, wire_method):
    error = reply.get("error")
    if error is not None:
        print("!!! %s failed: %s: %s" % (wire_method, error["code"], error["detail"]))
        return None
    return reply.get("result")


def find_first_of_kind(nodes, kind):
    for node in nodes:
        if node["kind"] == kind:
            return node
    return None


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8122)
    parser.add_argument("--connection-string", default="daqref://device0")
    parser.add_argument(
        "--server-type-id",
        default="OpenDAQNativeStreaming",
        help="the server type add_server is asked for (default: OpenDAQNativeStreaming)",
    )
    args = parser.parse_args(argv)

    client = WireClient(args.host, args.port)
    handshake = read_handshake_verbatim(client)
    print(
        "handshake declares %d capabilities and %d gaps"
        % (len(handshake["capabilities"]), len(handshake["gaps"]))
    )

    device = expect_result(
        client.call("connect_device", {"connection_string": args.connection_string}),
        "connect_device",
    )
    device_id = device["id"]
    print(
        "connected %s; its Node carries updating=%r and recording=%r"
        % (device_id, device["updating"], device["recording"])
    )

    tree = expect_result(client.call("get_component_tree", {"root_id": device_id}), "get_component_tree")
    print(
        "get_component_tree walked %d nodes; kinds present: %s"
        % (len(tree), ", ".join(sorted({node["kind"] for node in tree})))
    )
    print(
        "   Node.updating across the tree: %s"
        % ", ".join(sorted({repr(node["updating"]) for node in tree}))
    )
    print(
        "   Node.recording across the tree: %s"
        % ", ".join(sorted({repr(node["recording"]) for node in tree}))
    )
    signal = find_first_of_kind(tree, "signal")
    signal_id = signal["id"] if signal else None
    print("first signal in the tree: %s" % signal_id)

    print("\n### attribute.read -- get_component_attributes")
    client.call("get_component_attributes", {"node_id": device_id})
    if signal_id:
        client.call("get_component_attributes", {"node_id": signal_id})
    expect_error(
        client.call("get_component_attributes", {"node_id": device_id + "/NoSuchComponent"}),
        "get_component_attributes",
        "not_found",
    )

    print("\n### attribute.write -- set_component_attribute")
    client.call(
        "set_component_attribute",
        {
            "node_id": device_id,
            "attribute_id": "description",
            "value": "written by exercise_attributes_servers_recorder_batched_update_and_configuration_over_websocket",
        },
    )
    client.call("get_component_attributes", {"node_id": device_id})
    expect_error(
        client.call(
            "set_component_attribute",
            {"node_id": device_id, "attribute_id": "global_id", "value": "anything"},
        ),
        "set_component_attribute(global_id)",
        "read_only",
    )
    expect_error(
        client.call(
            "set_component_attribute",
            {"node_id": device_id, "attribute_id": "visible", "value": False},
        ),
        "set_component_attribute(visible)",
        "read_only",
    )
    expect_error(
        client.call(
            "set_component_attribute",
            {"node_id": device_id, "attribute_id": "name", "value": 17},
        ),
        "set_component_attribute(name = 17)",
        "invalid_value",
    )
    expect_error(
        client.call(
            "set_component_attribute",
            {"node_id": device_id, "attribute_id": "no_such_attribute", "value": True},
        ),
        "set_component_attribute(no_such_attribute)",
        "not_found",
    )
    # tags IS WRITABLE, through ITagsPrivate. IComponent has getTags and no
    # setTags (component.h:164) and ITags itself is read-only (tags.h:39-60), so
    # setattr on it raises -- but the writer is a separate interface,
    # ITagsPrivate::add/remove/replace (tags_private.h:34-56), and the openDAQ
    # Python binding carries it: py_tags_private.cpp:43-69 defines add, remove
    # and replace, and the generated opendaq.pyi declares class
    # ITagsPrivate(IBaseObject) with can_cast_from/cast_from at lines 6403-6430.
    # Enumerated on this machine against openDAQ 3.41.0_bec37b44:
    #   daq.ITagsPrivate.can_cast_from(device.tags) -> True
    #   dir(daq.ITagsPrivate) -> add, can_cast_from, cast_from, convert_from,
    #                            core_type, from_raw_interface, get_raw_interface,
    #                            remove, replace, to_native_object
    expect_result(
        client.call(
            "set_component_attribute",
            {"node_id": device_id, "attribute_id": "tags", "value": ["quackoscope"]},
        ),
        "set_component_attribute(tags = [quackoscope]) through ITagsPrivate.replace",
    )
    tags_after_write = expect_result(
        client.call("get_component_attributes", {"node_id": device_id}),
        "get_component_attributes, to read the tags back",
    )
    print(
        "    tags read back as %r, and ComponentAttribute.read_only for that row is %r"
        % (
            [a["value"] for a in (tags_after_write or []) if a["id"] == "tags"],
            [a["read_only"] for a in (tags_after_write or []) if a["id"] == "tags"],
        )
    )
    expect_result(
        client.call(
            "set_component_attribute",
            {"node_id": device_id, "attribute_id": "tags", "value": []},
        ),
        "set_component_attribute(tags = []) putting the list back as it was found",
    )
    expect_error(
        client.call(
            "set_component_attribute",
            {"node_id": device_id, "attribute_id": "tags", "value": "not-a-list"},
        ),
        'set_component_attribute(tags = "not-a-list")',
        "invalid_value",
    )

    if signal_id:
        print("   a bool attribute on the ISignal facet, written and restored:")
        client.call(
            "set_component_attribute",
            {"node_id": signal_id, "attribute_id": "public", "value": False},
        )
        client.call(
            "set_component_attribute",
            {"node_id": signal_id, "attribute_id": "public", "value": True},
        )

    # error_policy.malformed_parameter_becomes: invalid_value. A parameter that
    # violates its declared wire type never reaches openDAQ -- a node lookup is
    # IComponent::findComponent(IString* id, ...) and an integer is not an
    # IString*, while startRecording, beginUpdate, enableDiscovery and
    # disableDiscovery take no arguments at all -- so not_found would assert a
    # lookup that never happened. Each of these five rows now declares
    # invalid_value for exactly that.
    print("\n### a parameter of the wrong type is invalid_value on every row that declares it")
    expect_error(
        client.call("get_component_attributes", {"node_id": 17}),
        "get_component_attributes(node_id = 17)",
        "invalid_value",
    )
    expect_error(
        client.call("start_recording", {"node_id": None}),
        "start_recording(node_id = null)",
        "invalid_value",
    )
    expect_error(
        client.call("begin_batched_property_update", {"node_id": []}),
        "begin_batched_property_update(node_id = [])",
        "invalid_value",
    )
    expect_error(
        client.call("set_server_discovery_enabled", {"node_id": 1, "enabled": True}),
        "set_server_discovery_enabled(node_id = 1)",
        "invalid_value",
    )
    expect_error(
        client.call(
            "set_server_discovery_enabled",
            {"node_id": "/openDAQDevice/Srv/OpenDAQNativeStreaming", "enabled": "yes"},
        ),
        'set_server_discovery_enabled(enabled = "yes")',
        "invalid_value",
    )
    # remove_server is the one row of the six whose declared subset is
    # [not_found, unsupported, internal] and so has NO invalid_value to answer
    # with; not_found is the one of the three that is about the request.
    expect_error(
        client.call("remove_server", {"node_id": 17}),
        "remove_server(node_id = 17)",
        "not_found",
    )

    print("\n### server.add -- list_server_types and add_server")
    server_types = expect_result(client.call("list_server_types", {}), "list_server_types")
    print(
        "list_server_types answered %d type(s): %s"
        % (
            len(server_types or []),
            ", ".join("%s (%s)" % (t["id"], t["kind"]) for t in (server_types or [])),
        ),
    )
    expect_error(
        client.call("add_server", {"type_id": "quackoscope-no-such-server-type"}),
        "add_server(unknown type)",
        "unsupported",
    )
    added_server = expect_result(
        client.call("add_server", {"type_id": args.server_type_id}), "add_server"
    )
    server_node_id = added_server["id"] if added_server else None
    if added_server:
        print(
            "add_server answered a Node with id %s, kind %s, name %s"
            % (added_server["id"], added_server["kind"], added_server["name"])
        )

    expect_error(
        client.call("add_server", {"type_id": args.server_type_id}),
        "add_server(the same type a second time)",
        "invalid_value",
    )

    print("\n### server.discovery -- set_server_discovery_enabled")
    if server_node_id:
        client.call(
            "set_server_discovery_enabled", {"node_id": server_node_id, "enabled": True}
        )
        client.call(
            "set_server_discovery_enabled", {"node_id": server_node_id, "enabled": False}
        )
    expect_error(
        client.call("set_server_discovery_enabled", {"node_id": device_id, "enabled": True}),
        "set_server_discovery_enabled(a device)",
        "unsupported",
    )
    expect_error(
        client.call(
            "set_server_discovery_enabled",
            {"node_id": "/openDAQDevice/NoSuchServer", "enabled": True},
        ),
        "set_server_discovery_enabled(unknown node)",
        "not_found",
    )

    print("\n### server.add -- remove_server, the undo of the add")
    expect_error(
        client.call("remove_server", {"node_id": device_id}),
        "remove_server(a device, which is not a server)",
        "unsupported",
    )
    expect_error(
        client.call("remove_server", {"node_id": "/openDAQDevice/Srv/NoSuchServer"}),
        "remove_server(unknown node)",
        "not_found",
    )
    if server_node_id:
        expect_result(
            client.call("remove_server", {"node_id": server_node_id}),
            "remove_server(%s)" % server_node_id,
        )
        print(
            "remove_server took %s down; openDAQ's IDevice::removeServer runs "
            "ServerImpl::removed, which calls IServer::stop(), so its listening socket is closed"
            % server_node_id
        )
        expect_error(
            client.call("remove_server", {"node_id": server_node_id}),
            "remove_server(%s, a second time)" % server_node_id,
            "not_found",
        )
        re_added = expect_result(
            client.call("add_server", {"type_id": args.server_type_id}),
            "add_server(%s) again, now that the first one is gone" % args.server_type_id,
        )
        if re_added:
            print(
                "add_server answered %s a second time, which is what makes the removal a real "
                "undo rather than a delisting: the type was refused as a duplicate while the "
                "first server was up" % re_added["id"]
            )
            expect_result(
                client.call("remove_server", {"node_id": re_added["id"]}),
                "remove_server(%s), leaving the instance as it was found" % re_added["id"],
            )

    print("\n### recorder.control -- start_recording and stop_recording")
    expect_error(
        client.call("start_recording", {"node_id": device_id}),
        "start_recording(a device)",
        "unsupported",
    )
    expect_error(
        client.call("stop_recording", {"node_id": device_id}),
        "stop_recording(a device)",
        "unsupported",
    )
    expect_error(
        client.call("start_recording", {"node_id": device_id + "/NoSuchRecorder"}),
        "start_recording(unknown node)",
        "not_found",
    )

    print("\n### property.batched_update -- begin and end")
    client.call("begin_batched_property_update", {"node_id": device_id})
    during = expect_result(
        client.call("get_component_tree", {"root_id": device_id}), "get_component_tree"
    )
    print(
        "   while the batch is open, Node.updating on %s reads %r, and across the subtree: %s"
        % (
            device_id,
            during[0]["updating"] if during else None,
            ", ".join(sorted({repr(node["updating"]) for node in during or []})),
        )
    )
    client.call(
        "set_property_value",
        {"node_id": device_id, "property_id": "NumberOfChannels", "value": 3},
    )
    print("   the write above is HELD by the open batch, not applied")
    client.call("end_batched_property_update", {"node_id": device_id})
    client.call("get_property_value", {"node_id": device_id, "property_id": "NumberOfChannels"})
    expect_error(
        client.call("end_batched_property_update", {"node_id": device_id}),
        "end_batched_property_update(no batch open)",
        "invalid_value",
    )

    print("\n### configuration.save -- save_instance_configuration_to_string")
    saved = expect_result(
        client.call("save_instance_configuration_to_string", {}),
        "save_instance_configuration_to_string",
    )
    if saved is not None:
        print(
            "save_instance_configuration_to_string answered %d characters, %d bytes of UTF-8"
            % (len(saved), len(saved.encode("utf-8")))
        )
        print("   first 240 characters: %s" % saved[:240])

    print("\n### configuration.load -- load_instance_configuration_from_string")
    expect_error(
        client.call(
            "load_instance_configuration_from_string", {"configuration": "not a configuration"}
        ),
        "load_instance_configuration_from_string(not a configuration)",
        "invalid_value",
    )
    if saved is not None:
        client.call("load_instance_configuration_from_string", {"configuration": saved})

    client.close()
    print("\nsocket closed; the driver made every one of the eleven new wire calls above")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
