"""Drives a running Quackoscope host through all seven M1 operations.

It speaks the wire itself over a raw socket -- handshake, masked client frames,
JSON control plane, binary data plane -- so nothing about the host is taken on
trust. Every request, every reply and every decoded binary frame header is
printed with its literal values.

    python hosts/python/exercise_seven_operations_over_websocket.py --port 7789
"""

import argparse
import base64
import json
import os
import socket
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WireClient:
    def __init__(self, host, port):
        self._socket = socket.create_connection((host, port), timeout=15)
        self._buffer = b""
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        self._socket.sendall(
            (
                "GET /ws HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (host, port, key)
            ).encode("ascii")
        )
        while b"\r\n\r\n" not in self._buffer:
            self._buffer += self._socket.recv(65536)
        head, self._buffer = self._buffer.split(b"\r\n\r\n", 1)
        status = head.decode("latin-1").split("\r\n")[0]
        print("handshake response status line: %s" % status)
        assert "101" in status, "the host refused the WebSocket upgrade: %s" % status
        self._next_id = 1

    def _read_exactly(self, count):
        while len(self._buffer) < count:
            chunk = self._socket.recv(65536)
            if not chunk:
                raise ConnectionError("host closed the socket")
            self._buffer += chunk
        out, self._buffer = self._buffer[:count], self._buffer[count:]
        return out

    def _send(self, opcode, payload):
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        length = len(payload)
        if length < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | length)
        elif length < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, length)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, length)
        self._socket.sendall(header + mask + masked)

    def _receive(self):
        first, second = struct.unpack("!BB", self._read_exactly(2))
        opcode = first & 0x0F
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read_exactly(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exactly(8))[0]
        return opcode, self._read_exactly(length) if length else b""

    def call(self, method, params):
        request_id = self._next_id
        self._next_id += 1
        request = {"id": request_id, "method": method, "params": params}
        print("\n--> %s" % json.dumps(request))
        self._send(0x1, json.dumps(request).encode("utf-8"))
        while True:
            opcode, payload = self._receive()
            if opcode != 0x1:
                continue  # a binary data frame arriving mid-call is not this reply
            reply = json.loads(payload.decode("utf-8"))
            if reply.get("id") == request_id:
                text = json.dumps(reply)
                print("<-- %s" % (text if len(text) < 1200 else text[:1200] + " ...(truncated)"))
                return reply

    def receive_binary_frames(self, wanted, timeout_seconds):
        frames = []
        deadline = time.time() + timeout_seconds
        self._socket.settimeout(timeout_seconds)
        while len(frames) < wanted and time.time() < deadline:
            opcode, payload = self._receive()
            if opcode == 0x2:
                frames.append(payload)
        return frames

    def close(self):
        try:
            self._send(0x8, b"")
        except OSError:
            pass
        self._socket.close()


def decode_data_frame_header(frame):
    subscription_id, domain_start, sample_count, encoding = struct.unpack("<IQIB", frame[:17])
    values = struct.unpack("<%dd" % ((len(frame) - 17) // 8), frame[17:])
    return subscription_id, domain_start, sample_count, encoding, values


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7789)
    parser.add_argument("--connection-string", default="daqref://device0")
    parser.add_argument("--pixel-columns", type=int, default=8)
    args = parser.parse_args(argv)

    client = WireClient(args.host, args.port)
    print("connected to ws://%s:%d/ws" % (args.host, args.port))

    device = client.call("connect_device", {"connection_string": args.connection_string})["result"]
    device_id = device["id"]
    print(
        "connect_device: device node id %s named %s, kind %s, %d children"
        % (device_id, device["name"], device["kind"], len(device["child_ids"]))
    )

    tree = client.call("get_component_tree", {"root_id": device_id})["result"]
    print("get_component_tree: %d nodes" % len(tree))
    for node in tree[:6]:
        print("   %-58s kind=%-14s properties=%d" % (node["id"], node["kind"], len(node["property_ids"])))

    descriptors = client.call("get_property_descriptors", {"node_id": device_id})["result"]
    print("get_property_descriptors: %d descriptors on %s" % (len(descriptors), device_id))
    for d in descriptors:
        print(
            "   %-24s value_type=%-10s read_only=%-5s unit=%-6s min=%-8s max=%-10s default=%r"
            % (d["id"], d["value_type"], d["read_only"], d["unit"], d["min"], d["max"], d["default"])
        )

    before = client.call(
        "get_property_value", {"node_id": device_id, "property_id": "GlobalSampleRate"}
    )["result"]
    print("get_property_value: the DEVICE reports GlobalSampleRate = %r" % before)

    written = 2000.0 if before != 2000.0 else 5000.0
    client.call(
        "set_property_value",
        {"node_id": device_id, "property_id": "GlobalSampleRate", "value": written},
    )
    after = client.call(
        "get_property_value", {"node_id": device_id, "property_id": "GlobalSampleRate"}
    )["result"]
    print(
        "set_property_value then read-back: wrote %r, the DEVICE now reports %r (was %r) -> %s"
        % (written, after, before, "MATCH" if after == written else "MISMATCH")
    )

    read_only_attempt = client.call(
        "set_property_value",
        {"node_id": device_id, "property_id": "GlobalSampleRate", "value": "not a number"},
    )
    print("rejected write answered: %s" % json.dumps(read_only_attempt))

    signal_id = None
    for node in tree:
        if node["kind"] == "signal" and node["id"].endswith("AI0"):
            signal_id = node["id"]
            break
    if signal_id is None:
        signal_id = next(node["id"] for node in tree if node["kind"] == "signal")

    subscription_id = client.call(
        "subscribe_signal", {"signal_id": signal_id, "pixel_columns": args.pixel_columns}
    )["result"]
    print(
        "subscribe_signal: subscription_id %r on %s with pixel_columns=%d"
        % (subscription_id, signal_id, args.pixel_columns)
    )

    frames = client.receive_binary_frames(wanted=3, timeout_seconds=10)
    print("received %d binary data frame(s)" % len(frames))
    for index, frame in enumerate(frames):
        sub, domain_start, sample_count, encoding, values = decode_data_frame_header(frame)
        print(
            "   frame %d: %d bytes | subscription_id=%d domain_start=%d sample_count=%d "
            "encoding=%d (%s) payload_doubles=%d"
            % (
                index,
                len(frame),
                sub,
                domain_start,
                sample_count,
                encoding,
                "raw" if encoding == 0 else "min_max_envelope",
                len(values),
            )
        )
        print("      first payload doubles: %s" % ", ".join("%.6f" % v for v in values[:6]))

    client.call("unsubscribe_signal", {"subscription_id": subscription_id})
    print("unsubscribe_signal: released %s" % subscription_id)

    print("\n-- closed-error-set checks --")
    for method, params in (
        ("get_property_value", {"node_id": device_id + "/NoSuchChild", "property_id": "X"}),
        ("get_property_value", {"node_id": device_id, "property_id": "NoSuchProperty"}),
        ("unsubscribe_signal", {"subscription_id": "12abc"}),
        ("summon_duck", {}),
    ):
        reply = client.call(method, params)
        print("   %s -> code %s" % (method, reply.get("error", {}).get("code")))

    client.close()
    print("\nall seven operations were exercised against %s:%d" % (args.host, args.port))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
