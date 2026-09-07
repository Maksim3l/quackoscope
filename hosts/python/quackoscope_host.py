"""Quackoscope host (Python) -- entry point.

Reads module_path and log_level out of manifest.json (never hardcoded), builds
the openDAQ backend on that module path, and serves the M1 wire contract on
127.0.0.1:<port>/ws together with the built SPA in ./dist.

    python hosts/python/quackoscope_host.py --manifest manifest.json --port 7789
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from opendaq_backend.daq_backend import DaqBackend  # noqa: E402
from service.handshake import build_handshake_message, print_handshake_it_will_send  # noqa: E402
from service.session import SERVED_WIRE_METHODS, SessionHub  # noqa: E402
from transport.websocket_server import HostServer  # noqa: E402


def read_manifest(manifest_path):
    print("reading manifest: %s" % manifest_path, flush=True)
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    missing = [key for key in ("module_path", "log_level") if key not in manifest]
    if missing:
        raise SystemExit(
            "manifest %s is missing the key(s) %s; the host takes both from the manifest and "
            "hardcodes neither" % (manifest_path, ", ".join(missing))
        )

    module_path = str(manifest["module_path"])
    log_level = int(manifest["log_level"])
    print("module_path      = %s" % module_path, flush=True)
    print("log_level        = %d" % log_level, flush=True)
    print("manifest sdk_version = %s" % manifest.get("sdk_version"), flush=True)
    print("manifest commit      = %s" % manifest.get("commit"), flush=True)
    if not os.path.isdir(module_path):
        raise SystemExit(
            "module_path %s from %s is not a directory; openDAQ cannot be loaded from it"
            % (module_path, manifest_path)
        )
    return module_path, log_level, manifest


def main(argv):
    parser = argparse.ArgumentParser(
        prog="quackoscope_host.py",
        description="Serves the Quackoscope M1 wire contract against a local openDAQ SDK.",
    )
    parser.add_argument(
        "--manifest",
        default="manifest.json",
        help="path to manifest.json, which supplies module_path and log_level (default: manifest.json)",
    )
    parser.add_argument(
        "--port", type=int, default=7788, help="TCP port to listen on (default: 7788)"
    )
    parser.add_argument(
        "--address", default="127.0.0.1", help="address to bind (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--dist",
        default="dist",
        help="directory holding the built SPA, served as static files (default: dist)",
    )
    args = parser.parse_args(argv)

    module_path, log_level, manifest = read_manifest(args.manifest)
    manifest_sdk_version = manifest.get("sdk_version")
    manifest_commit = manifest.get("commit")

    backend = DaqBackend(module_path, log_level)
    running_sdk_version = backend.sdk_version()
    print(
        "SDK version reported by the running SDK: %s  |  manifest sdk_version = %s  -> %s"
        % (
            running_sdk_version,
            manifest_sdk_version,
            "MATCH" if running_sdk_version == manifest_sdk_version else "MISMATCH",
        ),
        flush=True,
    )

    # Section 1.6 of the contract. sdk.version and sdk.commit are the
    # manifest's; the capability list is computed from the wire methods the
    # session hub actually serves, and the gap list from the contract's eight
    # baseline capabilities minus those.
    handshake_message = build_handshake_message(
        manifest_sdk_version, manifest_commit, SERVED_WIRE_METHODS, args.manifest
    )
    print_handshake_it_will_send(handshake_message)

    hub = SessionHub(backend, handshake_message)
    # The five contract events are raised by openDAQ's core event; this is the
    # wire that carries them from the SDK layer out to every live session.
    backend.set_event_sink(hub.publish)
    server = HostServer(args.address, args.port, os.path.abspath(args.dist), hub)
    print(
        "quackoscope-host-python is up: %d operations (%s) on ws://%s:%d/ws, SPA from %s"
        % (
            len(SERVED_WIRE_METHODS),
            ", ".join(SERVED_WIRE_METHODS),
            args.address,
            args.port,
            os.path.abspath(args.dist),
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("quackoscope-host-python stopping on Ctrl-C", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
