"""Compiles generated/cpp/quackoscope-contract.hpp with MSVC.

The translation unit it compiles is itself generated from contract/contract.yaml:
it derives one class that inherits both WireOperationHandler and WireEventSink
and overrides every pure virtual, then instantiates it. That instantiation is
the mechanism lints.host_covers_every_operation describes: a handler the host
has not written leaves the class abstract, and the build fails at compile time
rather than at runtime.

    python tools/contract-compiler/compile_generated_cpp_header_with_msvc.py

The scratch CMake project is created under a temporary directory and removed
again; hosts/cpp/build is never touched.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import emit_cpp_handler_interface
from contract_loader import REPOSITORY_ROOT, load_contract, snake_case_wire_name
from name_casing import build_symbol_name, field_symbol_name

GENERATED_CPP_DIRECTORY = REPOSITORY_ROOT / "generated" / "cpp"
MANIFEST_PATH = REPOSITORY_ROOT / "manifest.json"
CMAKE_GENERATOR = "Visual Studio 18 2026"
EXECUTABLE_NAME = "instantiate-generated-cpp-handler-interface"


def resolve_nlohmann_include_directory() -> Path:
    """nlohmann_json lives in the openDAQ build tree recorded in manifest.json,
    exactly where hosts/cpp/CMakeLists.txt looks for it. Nothing is downloaded."""
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    build_directory = Path(manifest["build_dir"])
    # manifest.build_dir is <sdk build root>/bin/Release.
    sdk_build_root = build_directory.parent.parent
    include_directory = sdk_build_root / "_deps" / "nlohmann_json-src" / "include"
    header = include_directory / "nlohmann" / "json.hpp"
    print(f"reading manifest: {MANIFEST_PATH}")
    print(f"  build_dir            = {build_directory}")
    print(f"  openDAQ build root   = {sdk_build_root}")
    print(f"  nlohmann include dir = {include_directory}")
    if not header.is_file():
        raise SystemExit(
            f"nlohmann/json.hpp not found at {header}. The generated C++ header "
            f"aliases the contract's `any` to nlohmann::json, so that header must "
            f"be reachable."
        )
    print(f"  found                  {header}")
    return include_directory


def build_instantiating_translation_unit(contract: dict) -> str:
    """Generates a .cpp that overrides every pure virtual of both interfaces."""
    target = contract["casing"]["targets"]["cpp"]
    lines = [
        "// GENERATED FILE. Produced by",
        "// tools/contract-compiler/compile_generated_cpp_header_with_msvc.py from",
        "// contract/contract.yaml. It exists to prove that",
        "// generated/cpp/quackoscope-contract.hpp compiles and that its two",
        "// interfaces are satisfiable: the class below overrides every pure virtual",
        "// and is then instantiated, so a missing handler is a compile error.",
        "",
        '#include "quackoscope-contract.hpp"',
        "",
        "#include <cstdio>",
        "",
        "namespace qc = ::quackoscope::contract;",
        "",
        "namespace",
        "{",
        "",
        "// The generated signatures name the contract's own types unqualified, so",
        "// this translation unit pulls the contract namespace in wholesale.",
        "using namespace ::quackoscope::contract;",
        "",
        "class EveryContractMethodImplemented final",
        "    : public qc::WireOperationHandler",
        "    , public qc::WireEventSink",
        "{",
        "public:",
    ]

    for operation in contract["operations"]:
        symbol = build_symbol_name(
            operation["tokens"], operation["kind"], target, is_operation=False
        )
        returns = operation["returns"]
        if returns["type"] == "array":
            inner = emit_cpp_handler_interface.PRIMITIVE_CPP_TYPES.get(
                returns["items"], returns["items"]
            )
            return_type = f"std::vector<{inner}>"
        else:
            return_type = emit_cpp_handler_interface.PRIMITIVE_CPP_TYPES.get(
                returns["type"], returns["type"]
            )
        parameters = []
        argument_names = []
        for parameter in operation["params"]:
            rendered = emit_cpp_handler_interface.PRIMITIVE_CPP_TYPES.get(
                parameter["type"], parameter["type"]
            )
            rendered = emit_cpp_handler_interface.wrap_for_presence(
                rendered, parameter["presence"]
            )
            by_value = rendered in ("bool", "double", "std::int64_t")
            declaration = rendered if by_value else f"const {rendered}&"
            name = field_symbol_name(parameter["name"], target)
            parameters.append(f"{declaration} {name}")
            argument_names.append(name)
        lines.append(
            f"    {return_type} {symbol}({', '.join(parameters)}) override"
        )
        lines.append("    {")
        for name in argument_names:
            lines.append(f"        (void) {name};")
        if return_type != "void":
            lines.append("        return {};")
        lines.append("    }")
        lines.append("")

    for event in contract["events"]["items"]:
        symbol = build_symbol_name(event["tokens"], "event", target, is_operation=False)
        parameters = []
        argument_names = []
        for payload_field in event["payload"]:
            rendered = emit_cpp_handler_interface.PRIMITIVE_CPP_TYPES.get(
                payload_field["type"], payload_field["type"]
            )
            rendered = emit_cpp_handler_interface.wrap_for_presence(
                rendered, payload_field["presence"]
            )
            name = field_symbol_name(payload_field["name"], target)
            parameters.append(f"const {rendered}& {name}")
            argument_names.append(name)
        lines.append(f"    void {symbol}({', '.join(parameters)}) override")
        lines.append("    {")
        for name in argument_names:
            lines.append(f"        (void) {name};")
        lines.append("    }")
        lines.append("")

    lines.pop()
    lines.append("};")
    lines.append("")
    lines.append("}  // namespace")
    lines.append("")
    lines.append("int main()")
    lines.append("{")
    lines.append("    EveryContractMethodImplemented implementation;")
    lines.append("    qc::WireOperationHandler& operations = implementation;")
    lines.append("    qc::WireEventSink& events = implementation;")
    lines.append("")
    lines.append("    // Exercise the records, the enums and the error channel so the")
    lines.append("    // header is not merely parsed but used.")
    lines.append("    qc::Node node;")
    lines.append('    node.id_ = "RefDev0";')
    lines.append("    node.kind = qc::NodeKind::device;")
    lines.append("    events.componentAdded(node);")
    lines.append("")
    lines.append("    qc::PropertyDescriptor descriptor;")
    lines.append('    descriptor.id_ = "GlobalSampleRate";')
    lines.append("    descriptor.valueType = qc::PropertyDescriptorValueType::float_;")
    lines.append("    descriptor.readOnly = false;")
    lines.append("")
    lines.append(
        '    const qc::WireCallFailed failure{qc::WireErrorCode::readOnly, '
        '"locked while acquiring"};'
    )
    lines.append("")
    lines.append(
        '    std::printf("generated/cpp/quackoscope-contract.hpp compiled and '
        'linked\\n");'
    )
    lines.append(
        '    std::printf("  protocol_version           = %s\\n", '
        "std::string(qc::PROTOCOL_VERSION).c_str());"
    )
    lines.append(
        '    std::printf("  WIRE_METHOD_NAMES entries  = %zu\\n", '
        "sizeof(qc::WIRE_METHOD_NAMES) / sizeof(qc::WIRE_METHOD_NAMES[0]));"
    )
    lines.append(
        '    std::printf("  WIRE_EVENT_NAMES entries   = %zu\\n", '
        "sizeof(qc::WIRE_EVENT_NAMES) / sizeof(qc::WIRE_EVENT_NAMES[0]));"
    )
    lines.append(
        '    std::printf("  BASELINE_CAPABILITY_IDS    = %zu\\n", '
        "sizeof(qc::BASELINE_CAPABILITY_IDS) / sizeof(qc::BASELINE_CAPABILITY_IDS[0]));"
    )
    lines.append(
        '    std::printf("  first wire method          = %s\\n", '
        "std::string(qc::WIRE_METHOD_NAMES[0]).c_str());"
    )
    lines.append(
        '    std::printf("  Node.kind wire name        = %s\\n", '
        "std::string(qc::wireName(node.kind)).c_str());"
    )
    lines.append(
        '    std::printf("  PropertyDescriptor.default_ engaged = %s\\n", '
        'descriptor.default_.has_value() ? "true" : "false");'
    )
    lines.append(
        '    std::printf("  WireCallFailed code        = %s\\n", '
        "std::string(qc::wireName(failure.error.code)).c_str());"
    )
    lines.append(
        '    std::printf("  BINARY_FRAME_HEADER_BYTES  = %zu\\n", '
        "qc::BINARY_FRAME_HEADER_BYTES);"
    )
    lines.append("")
    lines.append("    const auto devices = operations.scanAvailableDevices();")
    lines.append(
        '    std::printf("  scanAvailableDevices() returned %zu DeviceInfo records\\n", '
        "devices.size());"
    )
    lines.append("    return 0;")
    lines.append("}")
    lines.append("")

    wire_names = ", ".join(
        snake_case_wire_name(operation["tokens"]) for operation in contract["operations"]
    )
    lines.insert(
        6,
        f"// Overridden wire methods: {wire_names}",
    )
    return "\n".join(lines)


CMAKELISTS_TEXT = """cmake_minimum_required(VERSION 3.20)
project(quackoscope_generated_cpp_header_compiles CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable({executable} {executable}.cpp)
target_include_directories({executable} PRIVATE
    "${{QUACKOSCOPE_GENERATED_CPP_DIR}}"
    "${{QUACKOSCOPE_NLOHMANN_INCLUDE_DIR}}")
target_compile_options({executable} PRIVATE /W4 /WX)
"""


def run_and_echo(command: list[str], working_directory: Path) -> None:
    print(f"running: {' '.join(command)}")
    print(f"  in: {working_directory}")
    completed = subprocess.run(
        command, cwd=working_directory, capture_output=True, text=True
    )
    for line in (completed.stdout + completed.stderr).splitlines():
        print(f"  | {line}")
    if completed.returncode != 0:
        raise SystemExit(
            f"command failed with exit code {completed.returncode}: "
            f"{' '.join(command)}"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Compiles generated/cpp/quackoscope-contract.hpp with MSVC by "
            "generating and building a translation unit that overrides every pure "
            "virtual of its two interfaces."
        )
    )
    parser.add_argument(
        "--keep-scratch-project",
        action="store_true",
        help="leave the scratch CMake project on disk instead of deleting it",
    )
    arguments = parser.parse_args(argv)

    header = GENERATED_CPP_DIRECTORY / "quackoscope-contract.hpp"
    if not header.is_file():
        raise SystemExit(
            f"{header} does not exist. Run "
            f"tools/contract-compiler/compile_contract_to_generated_targets.py first."
        )
    print(f"compiling generated header: {header} ({header.stat().st_size} bytes)")

    nlohmann_include_directory = resolve_nlohmann_include_directory()
    contract = load_contract()
    translation_unit = build_instantiating_translation_unit(contract)

    scratch_root = Path(tempfile.mkdtemp(prefix="quackoscope-cpp-header-compile-"))
    print(f"scratch CMake project: {scratch_root}")
    try:
        source_path = scratch_root / f"{EXECUTABLE_NAME}.cpp"
        source_path.write_text(translation_unit, encoding="utf-8")
        print(
            f"  wrote {source_path.name} ({source_path.stat().st_size} bytes), "
            f"{len(contract['operations'])} operation overrides and "
            f"{len(contract['events']['items'])} event overrides"
        )
        (scratch_root / "CMakeLists.txt").write_text(
            CMAKELISTS_TEXT.format(executable=EXECUTABLE_NAME), encoding="utf-8"
        )

        build_directory = scratch_root / "build"
        run_and_echo(
            [
                "cmake",
                "-S",
                str(scratch_root),
                "-B",
                str(build_directory),
                "-G",
                CMAKE_GENERATOR,
                "-A",
                "x64",
                f"-DQUACKOSCOPE_GENERATED_CPP_DIR={GENERATED_CPP_DIRECTORY.as_posix()}",
                f"-DQUACKOSCOPE_NLOHMANN_INCLUDE_DIR="
                f"{nlohmann_include_directory.as_posix()}",
            ],
            scratch_root,
        )
        run_and_echo(
            ["cmake", "--build", str(build_directory), "--config", "Release"],
            scratch_root,
        )
        executable = build_directory / "Release" / f"{EXECUTABLE_NAME}.exe"
        run_and_echo([str(executable)], scratch_root)
        print(
            f"generated/cpp/quackoscope-contract.hpp compiled with {CMAKE_GENERATOR} "
            f"at /W4 /WX, and a class overriding all "
            f"{len(contract['operations'])} handler methods and "
            f"{len(contract['events']['items'])} event methods instantiated and ran"
        )
    finally:
        if arguments.keep_scratch_project:
            print(f"scratch CMake project kept at {scratch_root}")
        else:
            shutil.rmtree(scratch_root, ignore_errors=True)
            print(f"removed scratch CMake project {scratch_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
