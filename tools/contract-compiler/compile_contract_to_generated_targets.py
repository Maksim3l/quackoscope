"""The contract compiler entry point.

Reads contract/contract.yaml and writes generated/<target>/ for every target,
one generator per target. Prints every file it writes with its byte count.

    python tools/contract-compiler/compile_contract_to_generated_targets.py

Writing somewhere other than generated/, which is what the golden-file
comparison does:

    python tools/contract-compiler/compile_contract_to_generated_targets.py \
        --output-directory <dir>
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import emit_cpp_handler_interface
import emit_python_dataclasses_and_handler_protocol
import emit_symbol_lists_and_capability_baseline
import emit_typescript_types_and_client
from contract_loader import (
    CONTRACT_YAML_PATH,
    REPOSITORY_ROOT,
    ContractLintFailure,
    load_contract,
)

DEFAULT_OUTPUT_DIRECTORY = REPOSITORY_ROOT / "generated"

# Targets that receive generated source code. The remaining casing targets
# receive only a symbol list, which is what M3.2 scopes them to.
CODE_GENERATORS = {
    "typescript": emit_typescript_types_and_client.generate,
    "cpp": emit_cpp_handler_interface.generate,
    "python": emit_python_dataclasses_and_handler_protocol.generate,
}

SYMBOL_LIST_TARGETS = ["typescript", "cpp", "csharp", "python", "rust", "wire"]

# The capability baseline is target-independent. It lives under the wire target
# because capability ids are wire-level names, identical in every language.
CAPABILITY_BASELINE_RELATIVE_PATH = "wire/capability-baseline.json"


def build_all_generated_files(contract: dict) -> dict[str, str]:
    """Returns {relative posix path under the output directory: file text}."""
    files: dict[str, str] = {}

    for target_name, generate in CODE_GENERATORS.items():
        for file_name, text in generate(contract).items():
            files[f"{target_name}/{file_name}"] = text

    for target_name in SYMBOL_LIST_TARGETS:
        files[f"{target_name}/symbol-list.json"] = (
            emit_symbol_lists_and_capability_baseline.generate_symbol_list(
                contract, target_name
            )
        )

    files[CAPABILITY_BASELINE_RELATIVE_PATH] = (
        emit_symbol_lists_and_capability_baseline.generate_capability_baseline(contract)
    )

    return dict(sorted(files.items()))


def write_generated_files(files: dict[str, str], output_directory: Path) -> None:
    print(f"writing {len(files)} generated files under: {output_directory}")
    written_bytes = 0
    for relative_path, text in files.items():
        destination = output_directory / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        encoded = text.encode("utf-8")
        # newline="" keeps the LF line endings the generators produce, so the
        # golden comparison is byte-identical on Windows and on Linux.
        with open(destination, "wb") as handle:
            handle.write(encoded)
        written_bytes += len(encoded)
        print(f"  {len(encoded):>7} bytes  {relative_path}")
    print(f"  {written_bytes} bytes total across {len(files)} files")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Compiles contract/contract.yaml into generated/<target>/ for every "
            "target."
        )
    )
    parser.add_argument(
        "--output-directory",
        type=Path,
        default=DEFAULT_OUTPUT_DIRECTORY,
        help=(
            "directory to write the per-target folders into "
            f"(default: {DEFAULT_OUTPUT_DIRECTORY})"
        ),
    )
    arguments = parser.parse_args(argv)

    try:
        contract = load_contract(CONTRACT_YAML_PATH)
        files = build_all_generated_files(contract)
    except ContractLintFailure as failure:
        print(
            f"CONTRACT LINT FAILURE while compiling {CONTRACT_YAML_PATH}\n{failure}",
            file=sys.stderr,
        )
        return 1

    targets_written = sorted({relative.split("/")[0] for relative in files})
    print(
        f"compiling {len(contract['operations'])} operations, "
        f"{len(contract['events']['items'])} events, {len(contract['types'])} types and "
        f"{len(contract['capabilities'])} capabilities into "
        f"{len(targets_written)} target folders: " + ", ".join(targets_written)
    )
    write_generated_files(files, arguments.output_directory)
    print(
        f"contract compiled: {CONTRACT_YAML_PATH} -> "
        f"{arguments.output_directory} ({len(files)} files, "
        f"{len(targets_written)} targets)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
