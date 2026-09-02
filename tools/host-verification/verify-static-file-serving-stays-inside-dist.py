"""Starts quackoscope-host-cpp on a port of its own and proves that its static
file plane serves nothing outside the SPA dist directory.

The hole this exists to keep shut: serveStatic used to build the file path as
    std::filesystem::path(distDir) / std::filesystem::path(target.substr(1))
and on Windows an absolute right-hand operand REPLACES the left one, so
    GET /C:/Windows/win.ini
discarded the dist root entirely and returned that file over HTTP.

Run:  python tools/host-verification/verify-static-file-serving-stays-inside-dist.py
      pnpm verify-static-file-serving-stays-inside-dist
Exits 0 when every escape attempt was refused, 1 when any of them was served.
"""

import argparse
import http.client
import os
import pathlib
import socket
import subprocess
import sys
import time

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def free_loopback_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def request_raw_target(port: int, method: str, target: str):
    """Sends target verbatim, without any client-side path normalisation."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    connection.putrequest(method, target, skip_host=False, skip_accept_encoding=True)
    connection.endheaders()
    response = connection.getresponse()
    body = response.read()
    connection.close()
    return response.status, body


def wait_until_listening(process, port: int, log_path: pathlib.Path, seconds: float):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if process.poll() is not None:
            raise SystemExit(
                f"quackoscope-host-cpp exited with code {process.returncode} before it listened on "
                f"127.0.0.1:{port}. Its output is in {log_path}:\n"
                + log_path.read_text(encoding="utf-8", errors="replace")[-2000:]
            )
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.25)
    raise SystemExit(f"quackoscope-host-cpp did not listen on 127.0.0.1:{port} within {seconds} s")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--host-executable",
        default=str(REPO_ROOT / "hosts" / "cpp" / "build" / "Release" / "quackoscope-host-cpp.exe"),
    )
    parser.add_argument("--manifest", default=str(REPO_ROOT / "manifest.json"))
    parser.add_argument("--dist", default=str(REPO_ROOT / "dist"))
    parser.add_argument("--port", type=int, default=0, help="0 picks a free loopback port")
    parser.add_argument("--startup-seconds", type=float, default=90.0)
    args = parser.parse_args()

    executable = pathlib.Path(args.host_executable)
    if not executable.is_file():
        print(f"no host executable at {executable}", file=sys.stderr)
        print("build it with: cmake --build hosts/cpp/build --config Release", file=sys.stderr)
        return 2

    port = args.port or free_loopback_port()
    log_path = pathlib.Path(os.environ.get("TEMP", ".")) / f"quackoscope-host-cpp-on-{port}.log"

    # Every one of these must be refused. The first is the original defect; the
    # rest are the other spellings Windows accepts for a location of its own.
    escape_attempts = [
        ("/C:/Windows/win.ini", "absolute path with a drive letter"),
        ("/c:/windows/win.ini", "absolute path with a lower-case drive letter"),
        ("/C%3A/Windows/win.ini", "drive letter hidden behind a percent-encoded colon"),
        ("//127.0.0.1/C$/Windows/win.ini", "UNC share reference"),
        ("/%5C%5C127.0.0.1%5CC$%5CWindows%5Cwin.ini", "percent-encoded UNC share reference"),
        ("/../manifest.json", "parent-directory hop out of the dist root"),
        ("/%2e%2e/manifest.json", "percent-encoded parent-directory hop"),
        ("/assets/../../manifest.json", "parent-directory hop after a real subdirectory"),
        ("/..%5Cmanifest.json", "parent-directory hop through a backslash"),
    ]

    print(f"quackoscope-host-cpp        {executable}")
    print(f"manifest                    {args.manifest}")
    print(f"dist root that may be read  {pathlib.Path(args.dist).resolve()}")
    print(f"port                        127.0.0.1:{port}")
    print(f"host output                 {log_path}")

    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            [
                str(executable),
                "--manifest", args.manifest,
                "--dist", args.dist,
                "--port", str(port),
                "--address", "127.0.0.1",
            ],
            cwd=str(REPO_ROOT),
            stdout=log,
            stderr=subprocess.STDOUT,
        )

    served_anyway = []
    try:
        wait_until_listening(process, port, log_path, args.startup_seconds)
        print(f"host is listening on 127.0.0.1:{port}; sending {len(escape_attempts)} escape attempts\n")

        for target, what in escape_attempts:
            status, body = request_raw_target(port, "GET", target)
            refused = status in (400, 403, 404)
            print(f"GET {target}")
            print(f"    {what}")
            print(f"    -> HTTP {status}, {len(body)} bytes: "
                  f"{'refused' if refused else 'SERVED, the dist root was escaped'}")
            if not refused:
                print(f"    first 120 bytes: {body[:120]!r}")
                served_anyway.append((target, status, len(body)))

        # The plane still has to serve what it is for.
        status, body = request_raw_target(port, "GET", "/index.html")
        print(f"\nGET /index.html -> HTTP {status}, {len(body)} bytes "
              f"(the SPA shell, which must still be served)")
        if status != 200 or not body:
            served_anyway.append(("/index.html not served", status, len(body)))

        # A HEAD carries the headers and no body.
        status, body = request_raw_target(port, "HEAD", "/index.html")
        print(f"HEAD /index.html -> HTTP {status}, {len(body)} body bytes "
              f"(a HEAD response must carry none)")
        if len(body) != 0:
            served_anyway.append(("HEAD /index.html returned a body", status, len(body)))
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()

    if served_anyway:
        print(f"\n{len(served_anyway)} of {len(escape_attempts) + 2} requests were answered wrongly:")
        for target, status, size in served_anyway:
            print(f"  {target} -> HTTP {status}, {size} bytes")
        return 1

    print(f"\nall {len(escape_attempts)} escape attempts were refused, /index.html was served from "
          f"{pathlib.Path(args.dist).resolve()}, and HEAD carried no body")
    return 0


if __name__ == "__main__":
    sys.exit(main())
