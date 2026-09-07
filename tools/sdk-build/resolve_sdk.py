#!/usr/bin/env python3
"""Resolve the openDAQ build tree and write Quackoscope's manifest.json.

The default path is VERIFY-ONLY. If the openDAQ build tree is already populated,
the script inspects it, confirms it is usable, and writes the manifest. It never
rebuilds unless --rebuild is passed explicitly.

Usage
-----
    python tools/sdk-build/resolve_sdk.py [<commit>] [options]

    <commit>    Any git revision understood by `git rev-parse` inside the
                openDAQ source tree. Defaults to that tree's current HEAD.

The manifest (spec Part 2.3) is written with exactly these keys:

    commit, sdk_version, mode, build_dir, module_path, log_level,
    rust { mode, crate_version, provenance }

Nothing about this machine is hardcoded
---------------------------------------
Three facts vary per developer machine, and every one of them is discovered and
printed with its source rather than guessed:

  * the openDAQ source checkout      -- --opendaq-root, else the environment
                                        variable QUACKOSCOPE_OPENDAQ_ROOT, else
                                        the sibling checkout <repo parent>/openDAQ
  * the preset / build tree          -- --preset, else the single build tree
                                        found under <openDAQ root>/build
  * the CMake generator that must    -- CMAKE_GENERATOR:INTERNAL and
    be used to build the host           CMAKE_GENERATOR_PLATFORM:INTERNAL, read
                                        out of that build tree's CMakeCache.txt

The generator is deliberately NOT an option with a default. The host links
daq::opendaq, so it must be compiled by the same MSVC toolset that produced the
SDK binaries, and the build tree's own CMakeCache.txt is the only record of what
that toolset was. A default here is what made this script print
-G "Visual Studio 17 2022" on a machine whose SDK was built by
"Visual Studio 18 2026". Discovery cannot be stale; a default can.

sdk_version describes the BINARIES, not the source tree
-------------------------------------------------------
sdk_version is read out of the built opendaq-64-3.dll's Windows version
resource (ProductVersion "3.41.0.bec37b44") and converted to the form a running
Instance reports ("3.41.0_bec37b44"). It is never read from
<openDAQ>/opendaq_version: that file describes whatever source is checked out
right now, which is not necessarily the source the binaries were compiled from,
and reading it is how a manifest came to claim 3.41.0dev for binaries that
report 3.41.0_bec37b44. The commit stamped into the DLL is cross-checked against
the commit being recorded, and any divergence between the binaries and the
source tree's HEAD is reported in full rather than quietly resolved.

The openDAQ CMake package directory
-----------------------------------
The manifest key set is fixed by spec and does not grow, so the resolved CMake
package directory is not a manifest key. It is printed as `-- cmake package`
and, in the form the host build consumes it, as the complete `-- host configure`
command line carrying -G, -A and -DopenDAQ_DIR=. That directory is the openDAQ
*install* tree; the build root is not usable (see tools/sdk-build/README.md).

manifest.json holds absolute, machine-specific paths. It is gitignored and this
script regenerates it. Running the script twice produces byte-identical output.

Rebuild path (NON-DEFAULT, --rebuild)
-------------------------------------
The configure and build steps are taken verbatim from the openDAQ repository's
own documentation, with the resolved preset substituted for the README's
example preset:

  * README.md, "Generate CMake project for specific compiler / preset" and
    "Build the project" (lines 164-165 and 184 at openDAQ 6e54a041):
        cmake --list-presets=all
        cmake --preset "<preset>"
        cmake --build build/<preset>

  * CMakeBasePresets.json defines each x64/msvc-NN/full preset with
    binaryDir = build/${presetName} and architecture x64, so the preset name and
    the build directory under build/ are the same string. That is what makes
    discovering the preset from the build tree layout sound.

`--config <config>` is appended to the build step. That flag is NOT in the
README line; it is required because the Visual Studio generators are
multi-config, for which the preset's CMAKE_BUILD_TYPE=Release has no effect on
`cmake --build`. It is appended only when the resolved generator really is
multi-config, and this addition is called out here rather than silently applied.

The install step is also NOT documented in BUILD.md, CMake-Options.md,
CMakePresets.json or the CI workflows. It is inferred: a build tree that has
been installed carries build/<preset>/install with the only usable CMake package
(lib/cmake/opendaq/openDAQConfig.cmake + openDAQ.cmake + openDAQ-release.cmake),
while CMakeCache.txt records CMAKE_INSTALL_PREFIX=C:/Program Files/openDAQ, so
that tree is produced by an explicit `--prefix` override, not by a default
install. --rebuild therefore runs

        cmake --install <build> --config <config> --prefix <build>/install

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
# Defaults. Only values that are the same on every machine appear here. The
# openDAQ root, the preset and the CMake generator are machine-specific and are
# resolved at run time (resolve_opendaq_root / resolve_build_tree /
# read_cmake_generator_from_build_tree), never defaulted. Nothing here is
# consumed by host source code -- the host only ever reads manifest.json.
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]
OPENDAQ_ROOT_ENVIRONMENT_VARIABLE = "QUACKOSCOPE_OPENDAQ_ROOT"
SIBLING_OPENDAQ_DIRECTORY_NAME = "openDAQ"
DEFAULT_CONFIG = "Release"
DEFAULT_MANIFEST = REPO_ROOT / "manifest.json"
DEFAULT_LOG_LEVEL = 0  # OPENDAQ_LOG_LEVEL_TRACE, per opendaq/log_level.h

# How deep under <openDAQ root>/build a CMakeCache.txt may sit for the build
# tree to be discovered. openDAQ preset names are 2-3 segments
# ("x64/msvc-26/full", "x64/gcc/full/debug"), so 4 covers every shipped preset.
MAX_PRESET_PATH_SEGMENTS = 4

# Files that must exist in the build output directory for the tree to count as
# resolved. Names are the openDAQ 3.x x64 naming scheme.
REQUIRED_CORE_BINARIES = (
    "opendaq-64-3.dll",
    "daqcoretypes-64-3.dll",
    "daqcoreobjects-64-3.dll",
)
MODULE_SUFFIX = ".module.dll"

# CMake generators that build every configuration from one configure step, and
# therefore need --config on `cmake --build`.
MULTI_CONFIG_GENERATOR_PATTERN = re.compile(
    r"^(Visual Studio \d+ \d+|Xcode|.*Multi-Config)$"
)


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


# ---------------------------------------------------------------------------
# Machine-specific facts, discovered rather than defaulted
# ---------------------------------------------------------------------------


def reject_reason_for_opendaq_checkout(candidate: Path) -> str | None:
    """Why this path is not a usable openDAQ checkout, or None if it is one."""
    if not candidate.is_dir():
        return "no such directory"
    if not (candidate / ".git").exists():
        return "exists but has no .git, so it is not an openDAQ checkout"
    return None


def resolve_opendaq_root(explicit_root: Path | None) -> Path:
    """Locate the openDAQ source checkout, printing where the answer came from.

    Order: the --opendaq-root argument, then the environment variable
    QUACKOSCOPE_OPENDAQ_ROOT, then the checkout sitting beside this repository.
    There is no built-in path: a path naming one developer's home directory is
    wrong on every other machine, and it fails late and confusingly (`not a git
    checkout: C:\\Users\\someone\\Project\\openDAQ`) instead of saying what it
    was looking for.

    The first two sources are somebody stating where the checkout is, so a bad
    value there is an error naming that value -- never a silent fall-through to
    a different tree, which would resolve the manifest against a checkout the
    caller did not ask for.
    """
    stated: list[tuple[str, Path]] = []
    if explicit_root is not None:
        stated.append(("--opendaq-root argument", explicit_root))
    environment_value = os.environ.get(OPENDAQ_ROOT_ENVIRONMENT_VARIABLE)
    if environment_value:
        stated.append(
            (f"environment variable {OPENDAQ_ROOT_ENVIRONMENT_VARIABLE}",
             Path(environment_value))
        )

    for source, candidate in stated:
        resolved = candidate.expanduser().absolute()
        reason = reject_reason_for_opendaq_checkout(resolved)
        if reason is not None:
            raise ResolveError(
                f"the openDAQ source checkout named by the {source} is not "
                f"usable.\n"
                f"  given    : {candidate}\n"
                f"  resolved : {str(resolved).replace(chr(92), '/')}\n"
                f"  problem  : {reason}\n"
                f"  Correct that value, or drop it to fall back to the "
                f"{SIBLING_OPENDAQ_DIRECTORY_NAME} checkout beside this "
                f"repository ({posix(REPO_ROOT.parent)})."
            )
        print(
            f"-- openDAQ root resolved from {source}: {posix(resolved)}",
            file=sys.stderr,
        )
        return resolved.resolve()

    sibling = REPO_ROOT.parent / SIBLING_OPENDAQ_DIRECTORY_NAME
    reason = reject_reason_for_opendaq_checkout(sibling)
    if reason is not None:
        raise ResolveError(
            f"cannot locate the openDAQ source checkout. No --opendaq-root "
            f"argument was given and {OPENDAQ_ROOT_ENVIRONMENT_VARIABLE} is not "
            f"set, so the only candidate was the checkout beside this "
            f"repository:\n"
            f"  candidate : {posix(REPO_ROOT.parent)}/{SIBLING_OPENDAQ_DIRECTORY_NAME}\n"
            f"  problem   : {reason}\n"
            f"  Point at it with --opendaq-root <path>, or set "
            f"{OPENDAQ_ROOT_ENVIRONMENT_VARIABLE}=<path>."
        )
    print(
        f"-- openDAQ root resolved from the {SIBLING_OPENDAQ_DIRECTORY_NAME} "
        f"checkout beside this repository ({posix(REPO_ROOT.parent)}): "
        f"{posix(sibling)}",
        file=sys.stderr,
    )
    return sibling.resolve()


def available_configure_presets(opendaq_root: Path) -> list[str]:
    """The preset names `cmake --list-presets=all` reports in the openDAQ tree."""
    proc = subprocess.run(
        ["cmake", "--list-presets=all"],
        cwd=str(opendaq_root),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return []
    names = []
    for line in proc.stdout.splitlines():
        match = re.match(r'\s+"([^"]+)"', line)
        if match:
            names.append(match.group(1))
    return names


def discover_build_trees(opendaq_root: Path) -> list[str]:
    """Preset names for every configured build tree under <openDAQ root>/build.

    A build tree is a directory holding a CMakeCache.txt. openDAQ's presets set
    binaryDir = build/${presetName}, so that directory's path relative to
    build/ IS the preset name.
    """
    build_root = opendaq_root / "build"
    if not build_root.is_dir():
        return []
    found = []
    for cache in build_root.rglob("CMakeCache.txt"):
        relative = cache.parent.relative_to(build_root)
        if len(relative.parts) <= MAX_PRESET_PATH_SEGMENTS:
            found.append(relative.as_posix())
    return sorted(found)


def resolve_build_tree(opendaq_root: Path, explicit_preset: str | None) -> str:
    """Decide which preset's build tree to read, printing why.

    Explicit --preset wins. Otherwise the build trees actually present under
    <openDAQ root>/build are discovered; exactly one is used, several is an
    error naming all of them, none is an error naming the presets the openDAQ
    tree offers.
    """
    build_root = opendaq_root / "build"
    if explicit_preset:
        cache = build_root / explicit_preset / "CMakeCache.txt"
        if not cache.is_file():
            discovered = discover_build_trees(opendaq_root)
            raise ResolveError(
                f"--preset {explicit_preset!r} names a build tree that is not "
                f"configured: {posix(build_root / explicit_preset)} has no "
                f"CMakeCache.txt.\n"
                f"  configured build trees under {posix(build_root)}: "
                + (", ".join(discovered) if discovered else "(none)")
            )
        print(
            f"-- preset from --preset argument: {explicit_preset} "
            f"(build tree {posix(build_root / explicit_preset)})",
            file=sys.stderr,
        )
        return explicit_preset

    discovered = discover_build_trees(opendaq_root)
    if len(discovered) == 1:
        preset = discovered[0]
        print(
            f"-- preset discovered as the only configured build tree under "
            f"{posix(build_root)}: {preset}",
            file=sys.stderr,
        )
        return preset
    if not discovered:
        presets = available_configure_presets(opendaq_root)
        raise ResolveError(
            f"no configured build tree under {posix(build_root)}: searched "
            f"{MAX_PRESET_PATH_SEGMENTS} levels deep for CMakeCache.txt and "
            f"found none. openDAQ has not been configured in this checkout.\n"
            f"  presets this checkout offers (cmake --list-presets=all in "
            f"{posix(opendaq_root)}): "
            + (", ".join(presets) if presets else "(cmake --list-presets=all failed)")
            + "\n  Configure one, then rerun; or pass --preset <name> to name "
            "the tree you intend to use."
        )
    raise ResolveError(
        f"{len(discovered)} configured build trees exist under "
        f"{posix(build_root)}, so which one the manifest should describe is "
        f"ambiguous:\n  - " + "\n  - ".join(discovered) + "\n"
        "  Name one with --preset <name>."
    )


def read_cmake_cache_entries(cache_file: Path) -> dict[str, str]:
    """Every NAME:TYPE=VALUE line of a CMakeCache.txt, keyed by NAME."""
    if not cache_file.is_file():
        raise ResolveError(f"missing CMakeCache.txt: {posix(cache_file)}")
    entries: dict[str, str] = {}
    for line in cache_file.read_text(encoding="utf-8", errors="replace").splitlines():
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_\-]*):[A-Z]+=(.*)$", line)
        if match:
            entries[match.group(1)] = match.group(2)
    return entries


def read_cmake_generator_from_build_tree(package_root: Path) -> dict:
    """The generator and platform that produced the openDAQ binaries.

    The host links daq::opendaq, so it must be built by the same toolset. The
    build tree records exactly which one in its own CMakeCache.txt; that is the
    authority, and it is read rather than assumed.
    """
    cache_file = package_root / "CMakeCache.txt"
    entries = read_cmake_cache_entries(cache_file)

    generator = entries.get("CMAKE_GENERATOR", "").strip()
    if not generator:
        raise ResolveError(
            f"{posix(cache_file)} has no CMAKE_GENERATOR entry, so the CMake "
            f"generator that built the openDAQ binaries in {posix(package_root)} "
            f"cannot be determined. The host must be configured with the same "
            f"generator; refusing to print a guessed -G line."
        )
    platform = entries.get("CMAKE_GENERATOR_PLATFORM", "").strip()

    print(
        f"-- CMake generator read from {posix(cache_file)}: "
        f"CMAKE_GENERATOR={generator}, CMAKE_GENERATOR_PLATFORM="
        + (platform if platform else "(empty)"),
        file=sys.stderr,
    )
    return {
        "generator": generator,
        "platform": platform,
        "cache_file": cache_file,
        "multi_config": bool(MULTI_CONFIG_GENERATOR_PATTERN.match(generator)),
    }


def generator_arguments(toolchain: dict) -> str:
    """The -G / -A fragment of a configure command line, from the cache values."""
    fragment = f'-G "{toolchain["generator"]}"'
    if toolchain["platform"]:
        fragment += f' -A {toolchain["platform"]}'
    return fragment


# ---------------------------------------------------------------------------
# Build tree verification
# ---------------------------------------------------------------------------


def verify_build_tree(package_root: Path, build_dir: Path, config: str) -> dict:
    """Confirm the existing build tree is usable. Never builds anything."""
    problems = []

    if not build_dir.is_dir():
        binaries_root = package_root / "bin"
        siblings = (
            sorted(p.name for p in binaries_root.iterdir() if p.is_dir())
            if binaries_root.is_dir()
            else []
        )
        problems.append(
            f"build output directory does not exist: {posix(build_dir)} "
            f"(--config {config}); configuration directories present under "
            f"{posix(binaries_root)}: "
            + (", ".join(siblings) if siblings else "(none)")
        )
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


# ---------------------------------------------------------------------------
# SDK identity, read out of the built artifact
# ---------------------------------------------------------------------------


def read_windows_product_version_resource(binary_path: Path) -> str:
    """The ProductVersion string from a Windows PE file's version resource.

    Reads the same value PowerShell reports as
    `(Get-Item <dll>).VersionInfo.ProductVersion`, via version.dll
    (GetFileVersionInfoSizeW / GetFileVersionInfoW / VerQueryValueW). For
    openDAQ's opendaq-64-3.dll this is a four-part string whose last part is the
    short commit the DLL was compiled from, e.g. "3.41.0.bec37b44".
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
    ("3.41.0.bec37b44"); a running Instance reports the same identity with an
    underscore ("3.41.0_bec37b44"). This reads the resource and converts it to
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


# ---------------------------------------------------------------------------
# Rebuild path (non-default)
# ---------------------------------------------------------------------------


def rebuild_commands(
    opendaq_root: Path, preset: str, config: str, multi_config: bool
) -> list[list[str]]:
    build_dir = opendaq_root / "build" / preset
    build_step = ["cmake", "--build", f"build/{preset}"]
    if multi_config:
        build_step += ["--config", config]
    return [
        ["cmake", "--preset", preset],
        build_step,
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


def run_rebuild(
    opendaq_root: Path, preset: str, config: str, multi_config: bool
) -> None:
    print(
        f"!! --rebuild: running a FULL openDAQ build of preset {preset} in "
        f"{posix(opendaq_root)}. This takes hours.",
        file=sys.stderr,
    )
    for cmd in rebuild_commands(opendaq_root, preset, config, multi_config):
        print("+ " + " ".join(cmd), file=sys.stderr)
        proc = subprocess.run(cmd, cwd=str(opendaq_root))
        if proc.returncode != 0:
            raise ResolveError(f"rebuild step failed: {' '.join(cmd)}")


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


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
    parser.add_argument(
        "--opendaq-root",
        type=Path,
        default=None,
        help=(
            "openDAQ source checkout. No built-in default: falls back to "
            f"${OPENDAQ_ROOT_ENVIRONMENT_VARIABLE}, then to the "
            f"{SIBLING_OPENDAQ_DIRECTORY_NAME} checkout beside this repository"
        ),
    )
    parser.add_argument(
        "--preset",
        default=None,
        help=(
            "openDAQ CMake preset, which is also its directory under "
            "<openDAQ root>/build. No built-in default: falls back to the single "
            "configured build tree found there"
        ),
    )
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

    opendaq_root = resolve_opendaq_root(args.opendaq_root)
    preset = resolve_build_tree(opendaq_root, args.preset)
    package_root = opendaq_root / "build" / preset
    build_dir = package_root / "bin" / args.config
    toolchain = read_cmake_generator_from_build_tree(package_root)

    if args.show_rebuild:
        for cmd in rebuild_commands(
            opendaq_root, preset, args.config, toolchain["multi_config"]
        ):
            print(" ".join(cmd))
        return 0

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
        run_rebuild(opendaq_root, preset, args.config, toolchain["multi_config"])
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

    generator_fragment = generator_arguments(toolchain)
    host_configure = (
        f"cmake -S hosts/cpp -B hosts/cpp/build {generator_fragment} "
        f'-DopenDAQ_DIR={info["cmake_package_dir"]}'
    )
    host_build = "cmake --build hosts/cpp/build" + (
        f" --config {args.config}" if toolchain["multi_config"] else ""
    )
    load_path_verifier_configure = (
        "cmake -S tools/sdk-build/verify-opendaq-load-path "
        "-B tools/sdk-build/verify-opendaq-load-path/build "
        f"{generator_fragment}"
    )

    summary = [
        ("openDAQ root", posix(opendaq_root)),
        ("preset", f"{preset}  (build tree {posix(package_root)})"),
        ("commit", f"{commit}  ({describe})"),
        ("source tree HEAD",
         f"{head}  ({head_describe}), opendaq_version {source_declared_version}"),
        ("sdk_version",
         f"{sdk_version}  (from {artifact['dll'].name} ProductVersion "
         f"{artifact['product_version_resource']})"),
        ("source vs binary",
         "binaries are source tree HEAD" if binaries_match_source_head
         else f"DIVERGED -- binaries are {artifact_commit_short}, "
              f"source HEAD is {head_short}"),
        ("build_dir", manifest["build_dir"]),
        ("module_path", manifest["module_path"]),
        ("modules found", str(len(info["modules"]))),
        ("log_level", str(manifest["log_level"])),
        ("cmake package",
         f"{info['cmake_package_dir']}  (find_package(openDAQ) verified against it)"),
        ("cmake generator",
         toolchain["generator"]
         + (f", platform {toolchain['platform']}" if toolchain["platform"]
            else ", no platform")
         + "  (read from CMAKE_GENERATOR/CMAKE_GENERATOR_PLATFORM in "
         + posix(toolchain["cache_file"]) + "; "
         + ("multi-config, so --config is required on cmake --build"
            if toolchain["multi_config"]
            else "single-config, so cmake --build takes no --config")
         + ")"),
        ("host configure", host_configure),
        ("host build", host_build),
        ("load-path verifier configure", load_path_verifier_configure),
        ("manifest",
         f"{posix(args.manifest)} ({'written' if changed else 'unchanged'})"),
    ]
    label_width = max(len(label) for label, _ in summary)
    for label, value in summary:
        print(f"-- {label.ljust(label_width)}  {value}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ResolveError as exc:
        print(f"resolve_sdk.py: {exc}", file=sys.stderr)
        sys.exit(1)
