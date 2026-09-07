"""Quackoscope host (Python) -- transport layer.

One WebSocket endpoint at /ws (JSON control plane, binary data plane) plus the
built SPA served from ./dist as static files. Written on socket + threading from
the standard library; no third-party dependency. Nothing here imports opendaq.

The dist root is canonicalised once and every resolved file must sit under it,
so a request target such as "/../../Windows/win.ini" or "/../dist-evil/x" can
never escape the SPA build directory.
"""

import base64
import hashlib
import json
import mimetypes
import os
import socket
import struct
import threading
import traceback
from urllib.parse import unquote

from . import wire

_WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_OPCODE_CONTINUATION = 0x0
_OPCODE_TEXT = 0x1
_OPCODE_BINARY = 0x2
_OPCODE_CLOSE = 0x8
_OPCODE_PING = 0x9
_OPCODE_PONG = 0xA


class WebSocketConnection:
    """One live socket. send_text and send_binary are safe from the reader
    thread and from any number of sample-pump threads at once."""

    def __init__(self, sock, peer):
        self._socket = sock
        self._send_lock = threading.Lock()
        self.peer = peer
        self.closed = False

    def send_text(self, text):
        self._send_frame(_OPCODE_TEXT, text.encode("utf-8"))

    def send_json(self, envelope):
        self.send_text(json.dumps(envelope, separators=(",", ":")))

    def send_binary(self, payload):
        self._send_frame(_OPCODE_BINARY, payload)

    def _send_frame(self, opcode, payload):
        length = len(payload)
        if length < 126:
            header = struct.pack("!BB", 0x80 | opcode, length)
        elif length < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 126, length)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 127, length)
        with self._send_lock:
            if self.closed:
                return
            try:
                self._socket.sendall(header + payload)
            except OSError:
                self.closed = True

    def close(self):
        with self._send_lock:
            if self.closed:
                return
            self.closed = True
        try:
            self._socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self._socket.close()
        except OSError:
            pass


class _SocketReader:
    def __init__(self, sock):
        self._socket = sock
        self._buffer = b""

    def read_exactly(self, count):
        while len(self._buffer) < count:
            chunk = self._socket.recv(65536)
            if not chunk:
                raise ConnectionError("peer closed the socket")
            self._buffer += chunk
        out, self._buffer = self._buffer[:count], self._buffer[count:]
        return out

    def read_http_head(self):
        while b"\r\n\r\n" not in self._buffer:
            chunk = self._socket.recv(65536)
            if not chunk:
                raise ConnectionError("peer closed the socket before sending a request line")
            self._buffer += chunk
            if len(self._buffer) > 65536:
                raise ConnectionError("HTTP request head exceeded 64 KiB")
        head, self._buffer = self._buffer.split(b"\r\n\r\n", 1)
        return head.decode("latin-1")


def _read_websocket_message(reader):
    """Returns (opcode, payload) with continuation frames already joined."""
    message_opcode = None
    chunks = []
    while True:
        first, second = struct.unpack("!BB", reader.read_exactly(2))
        fin = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", reader.read_exactly(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", reader.read_exactly(8))[0]
        mask = reader.read_exactly(4) if masked else None
        payload = reader.read_exactly(length) if length else b""
        if mask:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))

        if opcode in (_OPCODE_CLOSE, _OPCODE_PING, _OPCODE_PONG):
            return opcode, payload

        if opcode != _OPCODE_CONTINUATION:
            message_opcode = opcode
        chunks.append(payload)
        if fin:
            return message_opcode, b"".join(chunks)


class HostServer:
    """Serves /ws and the SPA in ./dist. `handler` provides on_open(connection),
    on_close(connection) and on_request(connection, method, params), the last
    returning (ok, result, code, detail)."""

    def __init__(self, address, port, dist_dir, handler):
        self._address = address
        self._port = port
        self._handler = handler
        self._dist_dir = dist_dir
        self._canonical_dist_root = (
            os.path.realpath(dist_dir) if dist_dir and os.path.isdir(dist_dir) else None
        )
        self._listener = None

    def serve_forever(self):
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind((self._address, self._port))
        self._listener.listen(64)
        print(
            "[transport] listening on http://%s:%d and on the WebSocket endpoint ws://%s:%d/ws"
            % (self._address, self._port, self._address, self._port),
            flush=True,
        )
        if self._canonical_dist_root:
            print("[transport] serving the SPA build from %s" % self._canonical_dist_root, flush=True)
        else:
            print(
                '[transport] no SPA build at "%s": GET answers 503; the wire contract on /ws '
                "is still live" % self._dist_dir,
                flush=True,
            )
        while True:
            client, peer = self._listener.accept()
            threading.Thread(target=self._serve_one_socket, args=(client, peer), daemon=True).start()

    def _serve_one_socket(self, client, peer):
        peer_text = "%s:%d" % peer
        reader = _SocketReader(client)
        try:
            head = reader.read_http_head()
            request_line = head.split("\r\n", 1)[0]
            parts = request_line.split(" ")
            if len(parts) < 2:
                self._send_http(client, 400, "text/plain; charset=utf-8", b"malformed request line\n")
                return
            method, target = parts[0], parts[1]
            headers = {}
            for line in head.split("\r\n")[1:]:
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.strip().lower()] = value.strip()

            if target.split("?", 1)[0] == "/ws" and "websocket" in headers.get("upgrade", "").lower():
                self._accept_websocket(client, reader, headers, peer_text)
                return

            if method not in ("GET", "HEAD"):
                self._send_http(client, 405, "text/plain; charset=utf-8", b"only GET and HEAD are served\n")
                return
            self._serve_static_file(client, target, peer_text, body_wanted=(method == "GET"))
        except (ConnectionError, OSError):
            pass
        except Exception:
            traceback.print_exc()
        finally:
            try:
                client.close()
            except OSError:
                pass

    # --- WebSocket -------------------------------------------------------

    def _accept_websocket(self, client, reader, headers, peer_text):
        key = headers.get("sec-websocket-key")
        if not key:
            self._send_http(client, 400, "text/plain; charset=utf-8", b"missing Sec-WebSocket-Key\n")
            return
        accept = base64.b64encode(
            hashlib.sha1((key + _WEBSOCKET_GUID).encode("ascii")).digest()
        ).decode("ascii")
        client.sendall(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
            ).encode("ascii")
        )
        print("[transport] WebSocket /ws opened from %s" % peer_text, flush=True)

        connection = WebSocketConnection(client, peer_text)
        self._handler.on_open(connection)
        try:
            while True:
                opcode, payload = _read_websocket_message(reader)
                if opcode == _OPCODE_CLOSE:
                    break
                if opcode == _OPCODE_PING:
                    connection._send_frame(_OPCODE_PONG, payload)
                    continue
                if opcode == _OPCODE_PONG:
                    continue
                if opcode != _OPCODE_TEXT:
                    print(
                        "[transport] ignoring a %d-byte binary frame from %s: the control plane "
                        "is JSON text only" % (len(payload), peer_text),
                        flush=True,
                    )
                    continue
                self._answer_request(connection, payload.decode("utf-8", "replace"))
        except (ConnectionError, OSError, struct.error):
            pass
        finally:
            self._handler.on_close(connection)
            connection.close()
            print("[transport] WebSocket /ws from %s closed" % peer_text, flush=True)

    def _answer_request(self, connection, text):
        request, error_envelope = wire.decode_request(text)
        if request is None:
            connection.send_json(error_envelope)
            return
        ok, result, code, detail = self._handler.on_request(connection, request.method, request.params)
        if ok:
            connection.send_json(wire.encode_result(request.id, result))
        else:
            connection.send_json(wire.encode_error(request.id, code, detail))

    # --- static files ----------------------------------------------------

    def _serve_static_file(self, client, target, peer_text, body_wanted):
        if self._canonical_dist_root is None:
            self._send_http(
                client,
                503,
                "text/plain; charset=utf-8",
                (
                    'quackoscope-host-python: no SPA build at "%s".\nThe wire contract is still '
                    "live on /ws -- run the Vite dev server for the UI.\n" % self._dist_dir
                ).encode("utf-8"),
            )
            return

        path = unquote(target.split("?", 1)[0].split("#", 1)[0])
        if path in ("", "/"):
            path = "/index.html"

        # A decoded target is not usable as a location under the dist root: an
        # absolute path or a drive letter names a root of its own, and "\" is a
        # separator on Windows. Reject those outright, then canonicalise and
        # require the result to sit under the canonical dist root, so no sibling
        # directory such as "dist-evil" can ever pass as a child of "dist".
        if "\x00" in path or "\\" in path or ":" in path:
            self._refuse_static(client, target, peer_text, "it carries a path separator or a drive letter")
            return

        root = self._canonical_dist_root
        candidate = os.path.realpath(os.path.join(root, path.lstrip("/")))
        if os.path.normcase(candidate) != os.path.normcase(root) and not os.path.normcase(
            candidate
        ).startswith(os.path.normcase(root) + os.sep):
            print(
                "[transport] refused GET %s from %s: it resolves to %s, which is outside the "
                "dist root %s" % (target, peer_text, candidate, root),
                flush=True,
            )
            self._send_http(client, 403, "text/plain; charset=utf-8", b"outside the dist root\n")
            return

        # SPA fallback: an unknown route is index.html, an unknown asset is 404.
        if not os.path.isfile(candidate):
            if "." in os.path.basename(candidate):
                self._send_http(client, 404, "text/plain; charset=utf-8", b"no such file in dist\n")
                return
            candidate = os.path.join(root, "index.html")
            if not os.path.isfile(candidate):
                self._send_http(client, 404, "text/plain; charset=utf-8", b"no index.html in dist\n")
                return

        with open(candidate, "rb") as handle:
            body = handle.read()
        content_type = mimetypes.guess_type(candidate)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in (
            "application/javascript",
            "image/svg+xml",
        ):
            content_type += "; charset=utf-8"
        self._send_http(client, 200, content_type, body if body_wanted else b"", len(body))

    def _refuse_static(self, client, target, peer_text, refusal):
        print(
            "[transport] refused GET %s from %s: %s; dist root is %s"
            % (target, peer_text, refusal, self._canonical_dist_root),
            flush=True,
        )
        self._send_http(client, 400, "text/plain; charset=utf-8", b"unusable request target\n")

    @staticmethod
    def _send_http(client, status, content_type, body, content_length=None):
        reasons = {
            200: "OK",
            400: "Bad Request",
            403: "Forbidden",
            404: "Not Found",
            405: "Method Not Allowed",
            503: "Service Unavailable",
        }
        if content_length is None:
            content_length = len(body)
        head = (
            "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\n"
            "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
            % (status, reasons.get(status, "Status"), content_type, content_length)
        )
        try:
            client.sendall(head.encode("latin-1") + body)
        except OSError:
            pass
