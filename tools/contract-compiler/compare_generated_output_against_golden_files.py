"""Golden-file comparison for the contract compiler.

    python tools/contract-compiler/compare_generated_output_against_golden_files.py

Compares three things and exits non-zero, with a unified diff, if any pair
disagrees:

  1. a fresh compile of contract/contract.yaml against the committed golden
     files under tools/contract-compiler/golden/, which catches an unintended
     change in a generator or in the contract;
  2. the committed generated/ tree against those same golden files, which
     catches a generated/ tree that was never regenerated after a contract
     change;
  3. the file lists on both sides, which catches a target folder or a file that
     appeared or disappeared.

Rewrite the golden files after an intended change:

    python tools/contract-compiler/compare_generated_output_against_golden_files.py \
        --update-golden-files
"""

from __future__ import annotations

import argparse
import difflib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from compile_contract_to_generated_targets import (
    DEFAULT_OUTPUT_DIRECTORY,
    build_all_generated_files,
)
from contract_loader import CONTRACT_YAML_PATH, ContractLintFailure, load_contract

GOLDEN_DIRECTORY = Path(__file__).resolve().parent / "golden"


def read_tree(root: Path, only_relative_paths: set[str] | None = None) -> dict[str, str]:
    """Reads files under root as text, keyed by posix relative path. Read in
    binary and decoded so a CRLF on disk is a difference, not silently
    normalised away.

    only_relative_paths restricts the read to the compiler's own output. It is
    used for generated/, which this repository shares with work that is not the
    contract compiler's: a file no contract target owns is never read, never
    compared and never reported."""
    if not root.is_dir():
        return {}
    files: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if only_relative_paths is not None and relative not in only_relative_paths:
            continue
        files[relative] = path.read_bytes().decode("utf-8")
    return files


def write_tree(root: Path, files: dict[str, str]) -> None:
    for relative_path, text in files.items():
        destination = root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        with open(destination, "wb") as handle:
            handle.write(text.encode("utf-8"))


def report_differences(
    label_left: str,
    left: dict[str, str],
    label_right: str,
    right: dict[str, str],
) -> list[str]:
    """Returns a list of human-readable difference reports, empty when equal."""
    reports: list[str] = []

    only_left = sorted(set(left) - set(right))
    only_right = sorted(set(right) - set(left))
    for relative_path in only_left:
        reports.append(
            f"{relative_path}\n"
            f"  present in {label_left} ({len(left[relative_path])} bytes), "
            f"absent from {label_right}"
        )
    for relative_path in only_right:
        reports.append(
            f"{relative_path}\n"
            f"  present in {label_right} ({len(right[relative_path])} bytes), "
            f"absent from {label_left}"
        )

    for relative_path in sorted(set(left) & set(right)):
        left_text = left[relative_path]
        right_text = right[relative_path]
        if left_text == right_text:
            continue
        diff = list(
            difflib.unified_diff(
                left_text.splitlines(keepends=True),
                right_text.splitlines(keepends=True),
                fromfile=f"{label_left}/{relative_path}",
                tofile=f"{label_right}/{relative_path}",
                n=3,
            )
        )
        changed_lines = sum(
            1 for line in diff if line.startswith(("+", "-")) and not line.startswith(("+++", "---"))
        )
        reports.append(
            f"{relative_path}\n"
            f"  {label_left}: {len(left_text)} bytes, "
            f"{label_right}: {len(right_text)} bytes, "
            f"{changed_lines} changed lines\n"
            + "".join(f"    {line}" if line.endswith("\n") else f"    {line}\n" for line in diff)
        )
    return reports


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Compares a fresh compile of contract/contract.yaml, and the committed "
            "generated/ tree, against the golden files under "
            "tools/contract-compiler/golden/."
        )
    )
    parser.add_argument(
        "--update-golden-files",
        action="store_true",
        help=(
            "overwrite the golden files with a fresh compile instead of comparing. "
            "Use only after an intended contract or generator change."
        ),
    )
    arguments = parser.parse_args(argv)

    try:
        contract = load_contract(CONTRACT_YAML_PATH)
        freshly_compiled = build_all_generated_files(contract)
    except ContractLintFailure as failure:
        print(
            f"CONTRACT LINT FAILURE while compiling {CONTRACT_YAML_PATH}\n{failure}",
            file=sys.stderr,
        )
        return 1

    fresh_bytes = sum(len(text.encode("utf-8")) for text in freshly_compiled.values())
    print(
        f"compiled {CONTRACT_YAML_PATH} in memory: {len(freshly_compiled)} files, "
        f"{fresh_bytes} bytes"
    )

    if arguments.update_golden_files:
        stale = set(read_tree(GOLDEN_DIRECTORY)) - set(freshly_compiled)
        for relative_path in sorted(stale):
            (GOLDEN_DIRECTORY / relative_path).unlink()
            print(f"  removed stale golden file {relative_path}")
        write_tree(GOLDEN_DIRECTORY, freshly_compiled)
        print(
            f"wrote {len(freshly_compiled)} golden files ({fresh_bytes} bytes) under "
            f"{GOLDEN_DIRECTORY}"
        )
        return 0

    golden = read_tree(GOLDEN_DIRECTORY)
    print(
        f"read golden files: {GOLDEN_DIRECTORY} ({len(golden)} files, "
        f"{sum(len(t.encode('utf-8')) for t in golden.values())} bytes)"
    )
    if not golden:
        print(
            f"NO GOLDEN FILES\n"
            f"  {GOLDEN_DIRECTORY} holds no files. Create them with "
            f"--update-golden-files.",
            file=sys.stderr,
        )
        return 1

    committed = read_tree(DEFAULT_OUTPUT_DIRECTORY, set(freshly_compiled))
    print(
        f"read committed output: {DEFAULT_OUTPUT_DIRECTORY} ({len(committed)} of the "
        f"{len(freshly_compiled)} compiler-owned files present)"
    )

    failures = 0

    reports = report_differences(
        "fresh-compile", freshly_compiled, "golden", golden
    )
    if reports:
        failures += 1
        print(
            f"\nGOLDEN FILE MISMATCH: a fresh compile of {CONTRACT_YAML_PATH} differs "
            f"from {GOLDEN_DIRECTORY} in {len(reports)} files",
            file=sys.stderr,
        )
        for report in reports:
            print(f"  {report}", file=sys.stderr)
    else:
        print(
            f"  fresh compile == golden       : all {len(golden)} files byte-identical"
        )

    reports = report_differences("golden", golden, "generated", committed)
    if reports:
        failures += 1
        print(
            f"\nGOLDEN FILE MISMATCH: the committed {DEFAULT_OUTPUT_DIRECTORY} tree "
            f"differs from {GOLDEN_DIRECTORY} in {len(reports)} files",
            file=sys.stderr,
        )
        for report in reports:
            print(f"  {report}", file=sys.stderr)
    else:
        print(
            f"  golden == generated/          : all {len(golden)} files byte-identical"
        )

    if failures:
        print(
            f"\n{failures} of 2 comparisons failed. If the change was intended, "
            f"rerun the compiler and then this script with --update-golden-files.",
            file=sys.stderr,
        )
        return 1

    print(
        f"golden files match: {len(golden)} files across "
        f"{len({p.split('/')[0] for p in golden})} targets are byte-identical in a "
        f"fresh compile, in {GOLDEN_DIRECTORY} and in {DEFAULT_OUTPUT_DIRECTORY}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
