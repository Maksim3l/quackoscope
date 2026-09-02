#!/usr/bin/env python3
"""Resolve the openDAQ build tree and write Quackoscope's manifest.json.

The default path is VERIFY-ONLY. The openDAQ build tree on this machine is
already populated, so the script inspects it, confirms it is usable, and writes
the manifest. It never rebuilds unless --rebuild is passed explicitly.

Usage
-----
    python tools/sdk-build/resolve_sdk.py [<commit>] [options]

    <commit>    Any git revision understood by `git rev-parse` inside the
                openDAQ source tree. Defaults to that tree's current HEAD.

The manifest (spec Part 2.3) is written with exactly these keys:

    commit, sdk_version, mode, build_dir, module_path, log_level,
    rust { mode, crate_version, provenance }

sdk_version describes the BINARIES, not the source tree
-------------------------------------------------------
sdk_version is read out of the built opendaq-64-3.dll's Windows version
resource (ProductVersion "3.31.0.661a96e9") and converted to the form a running
Instance reports ("3.31.0_661a96e9"). It is never read from
<openDAQ>/opendaq_version: that file describes whatever source is checked out
right now, which is not necessarily the source the binaries were compiled from,
and reading it is how a manifest came to claim 3.41.0dev for binaries that
report 3.31.0_661a96e9. The commit stamped into the DLL is cross-checked against
the commit being recorded, and any divergence between the binaries and the
source tree's HEAD is reported in full rather than quietly resolved.

The openDAQ CMake package directory
-----------------------------------
The manifest key set is fixed by spec and does not grow, so the resolved CMake
package directory is not a manifest key. It is printed as `-- cmake package`
and, in the form the host build consumes it, as the complete `-- host configure`
command line carrying -DopenDAQ_DIR=. That directory is the openDAQ *install*
tree; the build root is not usable (see tools/sdk-build/README.md).

manifest.json holds absolute, machine-specific paths. It is gitignored and this
script regenerates it. Running the script twice produces byte-identical output.

Rebuild path (NON-DEFAULT, --rebuild)
-------------------------------------
Taken verbatim from the openDAQ repository's own documentation:

  * README.md lines 162-163 and 180:
        cmake --list-presets=all
        cmake --preset "x64/msvc-22/full"
        cmake --build build/x64/msvc-22/full

  * CMakeBasePresets.json defines the preset `x64/msvc-22/full`
    (inherits full/release + msvc-22 + msvc-x64), with
    binaryDir = build/${presetName}, generator "Visual Studio 17 2022",
    architecture x64.

`--config Release` is appended to the build step. That flag is NOT in the
README line; it is required because "Visual Studio 17 2022" is a multi-config
generator, for which the preset's CMAKE_BUILD_TYPE=Release has no effect on
`cmake --build`. This addition is called out here rather than silently applied.

The install step is also NOT documented in BUILD.md, CMake-Options.md,
CMakePresets.json or the CI workflows. It is inferred: the tree on this machine
contains build/x64/msvc-22/full/install, which is the only location carrying a
usable CMake package (lib/cmake/opendaq/openDAQConfig.cmake + openDAQ.cmake +
openDAQ-release.cmake). CMakeCache.txt records
CMAKE_INSTALL_PREFIX=C:/Program Files/openDAQ, so that tree was produced by an
explicit `--prefix` override, not by a default install. --rebuild therefore runs

        cmake --install <build> --config Release --prefix <build>/install

and this is flagged as an inferred, undocumented step.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# Defaults. Every one of these is overridable on the command line; nothing here
# is consumed by host source code -- the host only ever reads manifest.json.
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OPENDAQ_ROOT = Path("C:/Users/lokna/Project/openDAQ")
DEFAULT_PRESET = "x64/msvc-22/full"
DEFAULT_CONFIG = "Release"
DEFAULT_MANIFEST = REPO_ROOT / "manifest.json"
DEFAULT_LOG_LEVEL = 0  # OPENDAQ_LOG_LEVEL_TRACE, per opendaq/log_level.h

# Files that must exist in the build output directory for the tree to count as
# resolved. Names are the openDAQ 3.x x64 naming scheme.
REQUIRED_CORE_BINARIES = (
    "opendaq-64-3.dll",
    "daqcoretypes-64-3.dll",
    "daqcoreobjects-64-3.dll",
)
MODULE_SUFFIX = ".module.dll"


class ResolveError(RuntimeError):
    pass


def posix(p: Path) -> str:
    """Absolute path with forward slashes, the form the manifest uses."""
    return str(p.resolve()).replace("\\", "/")


def git(root: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise ResolveError(
            f"git {' '.join(args)} failed in {root}: {proc.stderr.strip()}"
        )
    return proc.stdout.strip()


def read_windows_product_version_resource(binary_path: Path) -> str:
    """The ProductVersion string from a Windows PE file's version resource.

    Reads the same value PowerShell reports as
    `(Get-Item <dll>).VersionInfo.ProductVersion`, via version.dll
    (GetFileVersionInfoSizeW / GetFileVersionInfoW / VerQueryValueW). For
    openDAQ's opendaq-64-3.dll this is a four-part string whose last part is the
    short commit the DLL was compiled from, e.g. "3.31.0.661a96e9".
    """
    import ctypes
    from ctypes import wintypes

    if os.name != "nt":
        raise ResolveError(
            f"cannot read a Windows version resource on os.name={os.name!r}; "
            f"the built artifact {binary_path} carries its version there, and "
            f"the source tree's opendaq_version file must not be substituted "
            f"for it (it describes the checked-out source, not this binary)"
        )

    path_text = str(binary_path)
    version_api = ctypes.WinDLL("version", use_last_error=True)
    version_api.GetFileVersionInfoSizeW.argtypes = [
        wintypes.LPCWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    version_api.GetFileVersionInfoSizeW.restype = wintypes.DWORD
    version_api.GetFileVersionInfoW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
    ]
    version_api.GetFileVersionInfoW.restype = wintypes.BOOL
    version_api.VerQueryValueW.argtypes = [
        wintypes.LPCVOID,
        wintypes.LPCWSTR,
        ctypes.POINTER(wintypes.LPVOID),
        ctypes.POINTER(wintypes.UINT),
    ]
    version_api.VerQueryValueW.restype = wintypes.BOOL

    ignored_handle = wintypes.DWORD(0)
    resource_size = version_api.GetFileVersionInfoSizeW(
        path_text, ctypes.byref(ignored_handle)
    )
    if resource_size == 0:
        raise ResolveError(
            f"GetFileVersionInfoSizeW({path_text}) returned 0 "
            f"(GetLastError={ctypes.get_last_error()}): that file carries no "
            f"version resource, so the built SDK version cannot be read from it"
        )

    resource = ctypes.create_string_buffer(resource_size)
    if not version_api.GetFileVersionInfoW(path_text, 0, resource_size, resource):
        raise ResolveError(
            f"GetFileVersionInfoW({path_text}, size={resource_size}) failed "
            f"(GetLastError={ctypes.get_last_error()})"
        )

    translation_block = wintypes.LPVOID()
    translation_bytes = wintypes.UINT(0)
    if not version_api.VerQueryValueW(
        resource,
        "\\VarFileInfo\\Translation",
        ctypes.byref(translation_block),
        ctypes.byref(translation_bytes),
    ):
        raise ResolveError(
            f"VerQueryValueW(\\VarFileInfo\\Translation) failed for {path_text} "
            f"(GetLastError={ctypes.get_last_error()}); the version resource has "
            f"no string table to read ProductVersion from"
        )

    words = ctypes.cast(translation_block, ctypes.POINTER(wintypes.WORD))
    translations = [
        (words[i * 2], words[i * 2 + 1]) for i in range(translation_bytes.value // 4)
    ]
    if not translations:
        raise ResolveError(
            f"version resource of {path_text} lists zero language/codepage pairs"
        )

    attempted = []
    for language, codepage in translations:
        sub_block = f"\\StringFileInfo\\{language:04x}{codepage:04x}\\ProductVersion"
        attempted.append(sub_block)
        value_block = wintypes.LPVOID()
        value_chars = wintypes.UINT(0)
        if version_api.VerQueryValueW(
            resource, sub_block, ctypes.byref(value_block), ctypes.byref(value_chars)
        ):
            product_version = ctypes.wstring_at(value_block, value_chars.value)
            product_version = product_version.rstrip("\x00").strip()
            if product_version:
                return product_version

    raise ResolveError(
        f"no non-empty ProductVersion string in the version resource of "
        f"{path_text}; queried " + ", ".join(attempted)
    )


def read_sdk_identity_from_built_dll(build_dir: Path) -> dict:
    """The SDK version and commit of the BINARIES, taken from the binaries.

    manifest.sdk_version must describe the DLLs the host will actually load, not
    whatever the openDAQ source tree happens to have checked out. openDAQ stamps
    opendaq-64-3.dll's version resource with "<base>.<short commit>"
    ("3.31.0.661a96e9"); a running Instance reports the same identity with an
    underscore ("3.31.0_661a96e9"). This reads the resource and converts it to
    the runtime form, which is what goes into the manifest.
    """
    dll = build_dir / "opendaq-64-3.dll"
    if not dll.is_file():
        raise ResolveError(
            f"cannot read the built SDK version: {dll} does not exist. "
            f"sdk_version is derived from the built artifact, never from "
            f"<openDAQ>/opendaq_version."
        )

    product_version = read_windows_product_version_resource(dll)
    parts = product_version.split(".")
    if len(parts) != 4:
        raise ResolveError(
            f"{dll} reports ProductVersion {product_version!r}, which is not the "
            f"expected 4-part <major>.<minor>.<patch>.<short commit> form; "
            f"refusing to guess what commit these binaries came from"
        )

    base_version = ".".join(parts[:3])
    artifact_commit_short = parts[3]
    if not re.fullmatch(r"[0-9a-f]{7,40}", artifact_commit_short):
        raise ResolveError(
            f"{dll} reports ProductVersion {product_version!r}, whose last part "
            f"{artifact_commit_short!r} is not a git short commit (7-40 lowercase "
            f"hex characters). These binaries carry no commit identity, so the "
            f"manifest cannot be cross-checked against them and would be "
            f"attributing them to a commit on nothing but hope."
        )
    runtime_version = f"{base_version}_{artifact_commit_short}"

    print(
        f"-- sdk_version read from the built artifact {dll}: "
        f"ProductVersion {product_version} -> runtime form {runtime_version}",
        file=sys.stderr,
    )
    return {
        "product_version_resource": product_version,
        "base_version": base_version,
        "artifact_commit_short": artifact_commit_short,
        "runtime_version": runtime_version,
        "dll": dll,
    }


def read_source_tree_declared_version(opendaq_root: Path) -> str:
    """<openDAQ>/opendaq_version, used ONLY to report source/binary divergence.

    This value never becomes manifest.sdk_version. It describes the source that
    is checked out right now, which may not be the source the binaries in
    build/.../bin/Release were compiled from.
    """
    version_file = opendaq_root / "opendaq_version"
    if not version_file.is_file():
        return f"<missing file {version_file}>"
    return version_file.read_text(encoding="utf-8").strip() or f"<empty file {version_file}>"


def verify_build_tree(package_root: Path, build_dir: Path, config: str) -> dict:
    """Confirm the existing build tree is usable. Never builds anything."""
    problems = []

    if not build_dir.is_dir():
        problems.append(f"build output directory does not exist: {build_dir}")
    else:
        for name in REQUIRED_CORE_BINARIES:
            if not (build_dir / name).is_file():
                problems.append(f"missing core binary: {build_dir / name}")
        modules = sorted(p.name for p in build_dir.glob("*" + MODULE_SUFFIX))
        if not modules:
            problems.append(f"no *{MODULE_SUFFIX} found in {build_dir}")

    cache = package_root / "CMakeCache.txt"
    if not cache.is_file():
        problems.append(f"missing CMakeCache.txt: {cache}")

    if problems:
        raise ResolveError(
            "build tree verification failed:\n  - " + "\n  - ".join(problems)
        )

    modules = sorted(p.name for p in build_dir.glob("*" + MODULE_SUFFIX))

    return {
        "modules": modules,
        "cmake_package_dir": posix(resolve_cmake_package_dir(package_root, config)),
    }


def install_prefix_command(package_root: Path, config: str) -> str:
    """The exact command that produces the install prefix the host builds against."""
    return (
        f'cmake --install {posix(package_root)} --config {config} '
        f'--prefix {posix(package_root / "install")}'
    )


def resolve_cmake_package_dir(package_root: Path, config: str) -> Path:
    """Locate the openDAQ CMake package directory and prove find_package() works.

    The build root's own openDAQConfig.cmake is NOT consumable: it ships no
    exported targets file, PACKAGE_PREFIX_DIR resolves wrongly, and its
    find_dependency(fmt) / find_dependency(date) calls find nothing. Only the
    install tree beside it carries a usable package. Rather than trust the
    presence of two filenames, this actually runs find_package(openDAQ REQUIRED)
    against the directory and requires the daq::opendaq target to appear.
    """
    cmake_pkg = package_root / "install" / "lib" / "cmake" / "opendaq"
    config_file = cmake_pkg / "openDAQConfig.cmake"
    targets_file = cmake_pkg / "openDAQ.cmake"

    missing = [str(f) for f in (config_file, targets_file) if not f.is_file()]
    if missing:
        raise ResolveError(
            "the openDAQ CMake package the host builds against does not exist.\n"
            f"  expected directory : {posix(cmake_pkg)}\n"
            "  missing files      : " + "\n                       ".join(missing) + "\n"
            f"  the build root {posix(package_root)} is NOT a substitute: its "
            "openDAQConfig.cmake has no exported targets file beside it and its "
            "find_dependency(fmt) call fails with \"Could not find a package "
            "configuration file provided by fmt\".\n"
            "  create the install prefix with exactly this command:\n"
            f"      {install_prefix_command(package_root, config)}"
        )

    print(
        f"-- verifying find_package(openDAQ REQUIRED) against {posix(cmake_pkg)}",
        file=sys.stderr,
    )
    with tempfile.TemporaryDirectory(prefix="quackoscope-opendaq-package-") as scratch:
        source_dir = Path(scratch) / "source"
        source_dir.mkdir()
        (source_dir / "CMakeLists.txt").write_text(
            "cmake_minimum_required(VERSION 3.20)\n"
            "project(opendaq_cmake_package_usability NONE)\n"
            "find_package(openDAQ REQUIRED)\n"
            "if(NOT TARGET daq::opendaq)\n"
            '    message(FATAL_ERROR "openDAQ package found but target '
            'daq::opendaq was not defined")\n'
            "endif()\n",
            encoding="utf-8",
        )
        cmd = [
            "cmake",
            "-S",
            str(source_dir),
            "-B",
            str(Path(scratch) / "build"),
            f"-DopenDAQ_DIR={posix(cmake_pkg)}",
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise ResolveError(
                f"the openDAQ CMake package at {posix(cmake_pkg)} exists but "
                f"find_package(openDAQ REQUIRED) against it failed.\n"
                f"  command  : {' '.join(cmd)}\n"
                f"  exit code: {proc.returncode}\n"
                f"  cmake stdout:\n{proc.stdout.rstrip()}\n"
                f"  cmake stderr:\n{proc.stderr.rstrip()}\n"
                f"  regenerate the install prefix with:\n"
                f"      {install_prefix_command(package_root, config)}"
            )

    return cmake_pkg


def rebuild_commands(opendaq_root: Path, preset: str, config: str) -> list[list[str]]:
    build_dir = opendaq_root / "build" / preset
    return [
        ["cmake", "--preset", preset],
        ["cmake", "--build", f"build/{preset}", "--config", config],
        [
            "cmake",
            "--install",
            str(build_dir),
            "--config",
            config,
            "--prefix",
            str(build_dir / "install"),
        ],
    ]


def run_rebuild(opendaq_root: Path, preset: str, config: str) -> None:
    print("!! --rebuild: running a FULL openDAQ build. This takes hours.",
          file=sys.stderr)
    for cmd in rebuild_commands(opendaq_root, preset, config):
        print("+ " + " ".join(cmd), file=sys.stderr)
        proc = subprocess.run(cmd, cwd=str(opendaq_root))
        if proc.returncode != 0:
            raise ResolveError(f"rebuild step failed: {' '.join(cmd)}")


def build_manifest(
    commit: str,
    sdk_version: str,
    build_dir: Path,
    log_level: int,
) -> dict:
    """The manifest object. Key order here is the spec's key order."""
    return {
        "commit": commit,
        "sdk_version": sdk_version,
        "mode": "local_build",
        "build_dir": posix(build_dir),
        "module_path": posix(build_dir),
        "log_level": log_level,
        "rust": {
            "mode": "crates.io",
            "crate_version": None,
            "provenance": "different",
        },
    }


def write_manifest(manifest: dict, path: Path) -> bool:
    """Write atomically. Returns True if the bytes on disk changed."""
    text = json.dumps(manifest, indent=2, sort_keys=False) + "\n"
    data = text.encode("utf-8")

    previous = path.read_bytes() if path.is_file() else None
    if previous == data:
        return False

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="resolve_sdk.py",
        description=(
            "Resolve the openDAQ build tree and write manifest.json. "
            "Verifies the existing tree by default; --rebuild is opt-in."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "commit",
        nargs="?",
        default=None,
        help="openDAQ git revision (default: HEAD of the openDAQ source tree)",
    )
    parser.add_argument("--opendaq-root", type=Path, default=DEFAULT_OPENDAQ_ROOT)
    parser.add_argument("--preset", default=DEFAULT_PRESET)
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--log-level", type=int, default=DEFAULT_LOG_LEVEL)
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="NON-DEFAULT: actually build openDAQ before writing the manifest",
    )
    parser.add_argument(
        "--show-rebuild",
        action="store_true",
        help="print the rebuild commands and exit without running them",
    )
    parser.add_argument(
        "--allow-commit-mismatch",
        action="store_true",
        help=(
            "write the manifest even when the requested commit is not the "
            "openDAQ tree's HEAD (the existing build tree cannot be attributed "
            "to any other commit)"
        ),
    )
    args = parser.parse_args(argv)

    opendaq_root = args.opendaq_root.resolve()
    package_root = opendaq_root / "build" / args.preset
    build_dir = package_root / "bin" / args.config

    if args.show_rebuild:
        for cmd in rebuild_commands(opendaq_root, args.preset, args.config):
            print(" ".join(cmd))
        return 0

    if not (opendaq_root / ".git").exists():
        raise ResolveError(f"not a git checkout: {opendaq_root}")

    head = git(opendaq_root, "rev-parse", "HEAD")
    requested = args.commit or "HEAD"
    commit = git(opendaq_root, "rev-parse", requested)
    # Describe the commit actually being recorded, not whatever HEAD happens to
    # be: `git describe --tags --always` with no revision argument describes HEAD
    # and would print a describe string that does not belong to `commit`.
    describe = git(opendaq_root, "describe", "--tags", "--always", commit)
    head_describe = git(opendaq_root, "describe", "--tags", "--always", head)

    if commit != head and not args.rebuild and not args.allow_commit_mismatch:
        raise ResolveError(
            f"requested commit {commit} ({requested}) is not the openDAQ tree's "
            f"HEAD {head}. The existing build tree was produced from the checked "
            f"out source, so the manifest would misattribute it. Check out that "
            f"commit and rerun, pass --rebuild, or pass --allow-commit-mismatch."
        )

    if args.rebuild:
        run_rebuild(opendaq_root, args.preset, args.config)
    else:
        print(f"-- verify-only: not rebuilding {package_root}", file=sys.stderr)

    info = verify_build_tree(package_root, build_dir, args.config)

    # sdk_version describes the BINARIES the host loads, so it is read out of
    # them. The source tree's opendaq_version is read only to report divergence.
    artifact = read_sdk_identity_from_built_dll(build_dir)
    sdk_version = artifact["runtime_version"]
    artifact_commit_short = artifact["artifact_commit_short"]
    source_declared_version = read_source_tree_declared_version(opendaq_root)

    head_short = head[: len(artifact_commit_short)]
    binaries_match_source_head = artifact_commit_short == head_short

    if not binaries_match_source_head:
        print(
            "\n"
            "!! SOURCE AND BINARIES DISAGREE -- the openDAQ working tree is not the tree these binaries were built from.\n"
            f"!!   source tree HEAD      {head} ({head_describe})\n"
            f"!!     declares version    {source_declared_version}  (from {opendaq_root / 'opendaq_version'})\n"
            f"!!   built binaries        {artifact['dll']}\n"
            f"!!     stamped commit      {artifact_commit_short}\n"
            f"!!     stamped version     {artifact['product_version_resource']} -> reported at runtime as {sdk_version}\n"
            f"!!   manifest.sdk_version is taken from the BINARIES: {sdk_version}.\n"
            f"!!   The source tree's {source_declared_version} describes code that has NOT been compiled into "
            f"{posix(build_dir)}.\n"
            f"!!   Resolve by rebuilding openDAQ from {head}, or by checking out {artifact_commit_short} to match the binaries.",
            file=sys.stderr,
        )

    if not commit.startswith(artifact_commit_short):
        raise ResolveError(
            "refusing to write a manifest that attributes one commit's binaries to another commit.\n"
            f"  commit to be recorded : {commit} ({describe}) -- requested as {requested!r}\n"
            f"  binaries were built at: {artifact_commit_short} "
            f"(stamped into {artifact['dll']} as ProductVersion {artifact['product_version_resource']})\n"
            f"  binaries report SDK version {sdk_version} at runtime; the source tree declares {source_declared_version}\n"
            f"  the binaries are the ones at {posix(build_dir)}, and they are commit {artifact_commit_short}.\n"
            f"  Either rerun as `python {Path(__file__).name} {artifact_commit_short} --allow-commit-mismatch` "
            f"to record the commit the binaries actually are, or rebuild openDAQ from {commit} with --rebuild."
        )

    manifest = build_manifest(commit, sdk_version, build_dir, args.log_level)
    changed = write_manifest(manifest, args.manifest.resolve())

    host_configure = (
        f'cmake -S hosts/cpp -B hosts/cpp/build -G "Visual Studio 17 2022" -A x64 '
        f'-DopenDAQ_DIR={info["cmake_package_dir"]}'
    )

    print(f"-- openDAQ root      {posix(opendaq_root)}")
    print(f"-- commit            {commit}  ({describe})")
    print(f"-- source tree HEAD  {head}  ({head_describe}), opendaq_version {source_declared_version}")
    print(f"-- sdk_version       {sdk_version}  (from {artifact['dll'].name} ProductVersion {artifact['product_version_resource']})")
    print(f"-- source vs binary  {'binaries are source tree HEAD' if binaries_match_source_head else 'DIVERGED -- binaries are ' + artifact_commit_short + ', source HEAD is ' + head_short}")
    print(f"-- build_dir         {manifest['build_dir']}")
    print(f"-- module_path       {manifest['module_path']}")
    print(f"-- modules found     {len(info['modules'])}")
    print(f"-- log_level         {manifest['log_level']}")
    print(f"-- cmake package     {info['cmake_package_dir']}  (find_package(openDAQ) verified against it)")
    print(f"-- host configure    {host_configure}")
    print(f"-- manifest          {posix(args.manifest)} ({'written' if changed else 'unchanged'})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ResolveError as exc:
        print(f"resolve_sdk.py: {exc}", file=sys.stderr)
        sys.exit(1)
