"""Asserts the produced name of every operation in every target language, plus
the acronym table and the keyword collisions of contract section 1.1.

    python tools/contract-compiler/assert_operation_names_match_casing_table.py

    python tools/contract-compiler/assert_operation_names_match_casing_table.py \
        --contract <path to a contract.yaml> \
        --expected-names <path to a transcribed-names yaml>

WHERE THE EXPECTATIONS COME FROM, AND WHY THEY ARE NOT READ OUT OF THE COMPILER

Every expected name lives in
tools/contract-compiler/operation-and-event-names-transcribed-from-contract-section-1-1.yaml,
transcribed BY HAND from the section 1.1 join table:

    | Target | Join        | Getter convention | Async convention   |
    | wire   | snake_case  | keep get_ prefix  | n/a                |
    | C++    | camelCase   | get prefix        | callback or future |
    | C#     | PascalCase  | property where a getter/setter pair exists | Async suffix |
    | Python | snake_case  | @property where a pair exists, else get_ prefix | async def |
    | Rust   | snake_case  | no prefix on getters, set_ on setters | async fn |

None of it is read back out of the generator. This assertion exists to catch the
compiler agreeing with itself, so deriving the expectations from the compiler's
own output - the cure every other hand-maintained table in this repository got,
which is to read generated/wire/capability-baseline.json and refuse to run on
disagreement - would defeat its entire purpose here.

HOW THAT HAND-WRITTEN TABLE IS STOPPED FROM DRIFTING ANYWAY

assert_the_expected_rows_are_exactly_the_contract_rows() below checks that the
transcribed table's operation keys are EXACTLY contract.yaml's wire method names,
in the same order, and the same for events. A row contract.yaml grew that nobody
transcribed fails by name; a row here that contract.yaml dropped fails by name.
So the table cannot silently fall behind: it can only fail loudly and be
transcribed.

FAILURE IS PRINTED ON BOTH STREAMS, ON PURPOSE

This script prints roughly 250 passing lines on stdout. A failure printed on
stderr alone means `python ... | tail` shows a green-looking tail while the
process exits 1. Every failure is therefore printed on stdout AND on stderr, and
the last line of stdout on a failing run is a banner naming the count, so no
pipeline that reads only stdout can mistake a failing run for a passing one.

EXIT CODE: 0 only when every assertion matched. 1 otherwise.
"""

from __future__ import annotations

import argparse
import copy
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from contract_loader import CONTRACT_YAML_PATH, load_contract, snake_case_wire_name
from name_casing import build_symbol_name, field_symbol_name
from symbol_inventory import build_symbol_list

DEFAULT_EXPECTED_NAMES_PATH = (
    Path(__file__).resolve().parent
    / "operation-and-event-names-transcribed-from-contract-section-1-1.yaml"
)

# The shape each reserved_word_strategy imposes on an escaped identifier.
RESERVED_WORD_STRATEGY_SHAPES = {
    "none": lambda rendered: rendered,
    "suffix_underscore": lambda rendered: rendered + "_",
    "prefix_at": lambda rendered: "@" + rendered,
    "prefix_raw_identifier": lambda rendered: "r#" + rendered,
}


class CasingMismatch(Exception):
    pass


class TranscribedNamesUnusable(Exception):
    """The hand-written expectations file is absent or not shaped like a table."""


def load_transcribed_names(path: Path) -> dict:
    """Reads the hand-written section 1.1 expectations and checks their shape.

    Says exactly what it read and from where, so a run against a different file
    (the drift test does exactly that) cannot be mistaken for a normal run.
    """
    print(f"reading the hand-transcribed section 1.1 expectations: {path}")
    if not path.is_file():
        raise TranscribedNamesUnusable(
            f"{path} does not exist, so this assertion has no independent opinion "
            "about what the compiler should produce and refuses to run. It is a "
            "hand-written file, NOT generated output: restore it from git rather "
            "than regenerating anything."
        )
    raw_text = path.read_text(encoding="utf-8")
    document = yaml.safe_load(raw_text)

    for key in ("targets_in_column_order", "operations", "events", "acronym_tokens",
                "keyword_collisions_to_watch"):
        if key not in document:
            raise TranscribedNamesUnusable(f"{path} has no '{key}' key")

    targets = list(document["targets_in_column_order"])
    for section in ("operations", "events"):
        for wire_name, row in document[section].items():
            if not isinstance(row, list) or len(row) != len(targets):
                raise TranscribedNamesUnusable(
                    f"{path}: {section} row {wire_name!r} has {len(row) if isinstance(row, list) else 'no'} "
                    f"columns, and targets_in_column_order names {len(targets)}: {targets}"
                )

    print(
        f"  parsed {len(raw_text)} bytes: {len(document['operations'])} operation rows, "
        f"{len(document['events'])} event rows, {len(document['acronym_tokens'])} acronym "
        f"tokens, {len(document['keyword_collisions_to_watch'])} keyword collisions, "
        f"columns {targets}"
    )
    return {
        "path": path,
        "targets": targets,
        "operations": {name: list(row) for name, row in document["operations"].items()},
        "events": {name: list(row) for name, row in document["events"].items()},
        "acronym_tokens": list(document["acronym_tokens"]),
        "keyword_collisions_to_watch": list(document["keyword_collisions_to_watch"]),
    }


def assert_the_expected_rows_are_exactly_the_contract_rows(
    what: str,
    contract_wire_names: list[str],
    expected_rows: dict[str, list[str]],
    expected_names_path: Path,
    contract_path: Path,
    mismatches: list[str],
) -> None:
    """The drift guard: the transcribed row set must equal the contract's, exactly.

    Names every row that is on one side and not the other, so a failing run says
    which row somebody has to go and transcribe rather than only that two lists
    differ.
    """
    transcribed = list(expected_rows)
    in_contract_without_a_row = [n for n in contract_wire_names if n not in expected_rows]
    transcribed_but_not_in_contract = [n for n in transcribed if n not in contract_wire_names]

    for name in in_contract_without_a_row:
        mismatches.append(
            f"{what} '{name}' is declared in {contract_path} but has NO transcribed row "
            f"in {expected_names_path}. The contract grew and the hand-written section "
            f"1.1 expectations did not: add a '{name}' row there, transcribed from "
            f"section 1.1 by hand, naming the wire, cpp, csharp, python and rust "
            f"spelling. Do not copy it out of the compiler's output - this assertion "
            f"is the independent second opinion that catches the compiler agreeing "
            f"with itself."
        )
    for name in transcribed_but_not_in_contract:
        mismatches.append(
            f"{what} '{name}' has a transcribed row in {expected_names_path} but is NOT "
            f"declared in {contract_path}. The contract dropped it and the hand-written "
            f"expectations still carry it: delete that row."
        )
    if not in_contract_without_a_row and not transcribed_but_not_in_contract:
        if transcribed != contract_wire_names:
            mismatches.append(
                f"the {what} rows of {expected_names_path} name the same set as "
                f"{contract_path} but in a different order\n"
                f"  contract.yaml order: {contract_wire_names}\n"
                f"  transcribed order  : {transcribed}"
            )
        else:
            print(
                f"  the {len(transcribed)} transcribed {what} rows are exactly the "
                f"{len(contract_wire_names)} {what}s of {contract_path}, in the same order"
            )


def expected_acronym_rendering(token: str, target_name: str, is_leading: bool) -> str:
    """The 1.1 rule, applied without consulting contract.yaml's rendering table.

    snake_case targets lower everything. camelCase leaves a leading token lower
    and Pascal-cases the rest. C# keeps two-letter acronyms upper and
    Pascal-cases longer ones, in every position.
    """
    if target_name in ("wire", "python", "rust"):
        return token
    if target_name == "cpp":
        return token if is_leading else token.capitalize()
    if target_name == "csharp":
        return token.upper() if len(token) == 2 else token.capitalize()
    raise CasingMismatch(f"no 1.1 row for target {target_name!r}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Asserts every operation and event name the contract compiler produces "
            "against expectations transcribed by hand from contract section 1.1."
        )
    )
    parser.add_argument(
        "--contract",
        type=Path,
        default=CONTRACT_YAML_PATH,
        help=f"the contract to assert against (default: {CONTRACT_YAML_PATH})",
    )
    parser.add_argument(
        "--expected-names",
        type=Path,
        default=DEFAULT_EXPECTED_NAMES_PATH,
        help=(
            "the hand-transcribed section 1.1 expectations "
            f"(default: {DEFAULT_EXPECTED_NAMES_PATH})"
        ),
    )
    arguments = parser.parse_args(argv)

    try:
        transcribed = load_transcribed_names(arguments.expected_names)
    except TranscribedNamesUnusable as failure:
        print(f"\nTRANSCRIBED NAMES UNUSABLE: {failure}")
        print(f"\nTRANSCRIBED NAMES UNUSABLE: {failure}", file=sys.stderr)
        return 1

    expected_operation_names = transcribed["operations"]
    expected_event_names = transcribed["events"]
    expected_acronym_tokens = transcribed["acronym_tokens"]
    keyword_collisions_to_watch = transcribed["keyword_collisions_to_watch"]
    target_order = transcribed["targets"]
    expected_names_path = transcribed["path"]

    contract = load_contract(arguments.contract)
    targets = contract["casing"]["targets"]
    mismatches: list[str] = []
    assertions = 0

    # --- 0. the drift guard, run before a single name is compared ----------
    print(
        f"asserting the transcribed row sets of {expected_names_path} are exactly the "
        f"rows of {arguments.contract}"
    )
    contract_wire_names = [
        snake_case_wire_name(operation["tokens"]) for operation in contract["operations"]
    ]
    contract_event_names = [
        snake_case_wire_name(event["tokens"]) for event in contract["events"]["items"]
    ]
    assertions += 2
    assert_the_expected_rows_are_exactly_the_contract_rows(
        "operation", contract_wire_names, expected_operation_names,
        expected_names_path, arguments.contract, mismatches,
    )
    assert_the_expected_rows_are_exactly_the_contract_rows(
        "event", contract_event_names, expected_event_names,
        expected_names_path, arguments.contract, mismatches,
    )

    # --- 1. operation names, every operation in every target ---------------
    print(
        f"asserting the produced name of {len(expected_operation_names)} operations "
        f"in {len(target_order)} targets"
    )
    header = "  " + "wire method".ljust(26) + "".join(t.ljust(29) for t in target_order)
    print(header)
    for operation in contract["operations"]:
        wire_name = snake_case_wire_name(operation["tokens"])
        expected_row = expected_operation_names.get(wire_name)
        if expected_row is None:
            continue  # already reported by the drift guard, by name
        produced_row = []
        for target_name, expected in zip(target_order, expected_row):
            produced = build_symbol_name(
                operation["tokens"],
                operation["kind"],
                targets[target_name],
                is_operation=True,
            )
            produced_row.append(produced)
            assertions += 1
            if produced != expected:
                mismatches.append(
                    f"operation {wire_name!r} in target {target_name}: "
                    f"produced {produced!r}, section 1.1 requires {expected!r}"
                )
        print("  " + wire_name.ljust(26) + "".join(n.ljust(29) for n in produced_row))

    # --- 2. event names ----------------------------------------------------
    print(
        f"asserting the produced name of {len(expected_event_names)} events in "
        f"{len(target_order)} targets"
    )
    for event in contract["events"]["items"]:
        wire_name = snake_case_wire_name(event["tokens"])
        expected_row = expected_event_names.get(wire_name)
        if expected_row is None:
            continue  # already reported by the drift guard, by name
        for target_name, expected in zip(target_order, expected_row):
            produced = build_symbol_name(
                event["tokens"], "event", targets[target_name], is_operation=False
            )
            assertions += 1
            if produced != expected:
                mismatches.append(
                    f"event {wire_name!r} in target {target_name}: produced "
                    f"{produced!r}, section 1.1 requires {expected!r}"
                )
    print(f"  {len(expected_event_names)} events matched in every target")

    # --- 3. acronym tokens -------------------------------------------------
    declared_acronyms = contract["casing"]["acronym_tokens"]
    assertions += 1
    if declared_acronyms != expected_acronym_tokens:
        mismatches.append(
            f"casing.acronym_tokens in {arguments.contract} is {declared_acronyms}, "
            f"the acronym_tokens transcribed from section 1.1 in "
            f"{expected_names_path} are {expected_acronym_tokens}"
        )
    print(
        f"asserting the rendering of all {len(expected_acronym_tokens)} acronym tokens "
        f"in both positions in {len(target_order)} targets"
    )
    for token in expected_acronym_tokens:
        rendered_row = []
        for target_name in target_order:
            target = targets[target_name]
            # "alpha"/"beta" are ordinary tokens, chosen so no synthetic name
            # collides with a reserved word and the acronym rule is isolated.
            leading_produced = build_symbol_name(
                [token, "beta"], "field", target, is_operation=False
            )
            leading_expected = (
                expected_acronym_rendering(token, target_name, is_leading=True)
                + ("_beta" if target["join"] == "snake_case" else "Beta")
            )
            non_leading_produced = build_symbol_name(
                ["alpha", token], "field", target, is_operation=False
            )
            non_leading_prefix = "alpha" if target["join"] != "PascalCase" else "Alpha"
            non_leading_expected = (
                non_leading_prefix
                + ("_" if target["join"] == "snake_case" else "")
                + expected_acronym_rendering(token, target_name, is_leading=False)
            )
            assertions += 2
            if leading_produced != leading_expected:
                mismatches.append(
                    f"acronym {token!r} leading in {target_name}: produced "
                    f"{leading_produced!r}, section 1.1 requires {leading_expected!r}"
                )
            if non_leading_produced != non_leading_expected:
                mismatches.append(
                    f"acronym {token!r} non-leading in {target_name}: produced "
                    f"{non_leading_produced!r}, section 1.1 requires "
                    f"{non_leading_expected!r}"
                )
            rendered_row.append(f"{leading_produced}/{non_leading_produced}")
        print("  " + token.ljust(6) + "".join(cell.ljust(29) for cell in rendered_row))

    # --- 4. keyword collisions --------------------------------------------
    print(
        f"asserting the escape of the {len(keyword_collisions_to_watch)} keyword "
        f"collisions 1.1 names, plus the field name 'default'"
    )
    for word in keyword_collisions_to_watch + ["default"]:
        rendered_row = []
        for target_name in target_order:
            target = targets[target_name]
            produced = field_symbol_name(word, target)
            unescaped = build_symbol_name(
                [word], "field", {**target, "reserved_words": []}, is_operation=False
            )
            collides = word in target["reserved_words"]
            shape = RESERVED_WORD_STRATEGY_SHAPES[
                target["reserved_word_strategy"] if collides else "none"
            ]
            expected = shape(unescaped)
            assertions += 1
            if produced != expected:
                mismatches.append(
                    f"keyword {word!r} in {target_name}: produced {produced!r}, "
                    f"reserved_word_strategy "
                    f"{target['reserved_word_strategy'] if collides else 'none'} over "
                    f"{unescaped!r} requires {expected!r}"
                )
            if collides and produced == unescaped:
                mismatches.append(
                    f"keyword {word!r} is in casing.targets.{target_name}."
                    f"reserved_words but was emitted verbatim as {produced!r}, which "
                    f"violates lints.reserved_word_escaped"
                )
            rendered_row.append(produced + ("" if collides else "  (not reserved)"))
        print("  " + word.ljust(8) + "".join(cell.ljust(29) for cell in rendered_row))

    # --- 5. symbol coverage -----------------------------------------------
    print("asserting covers_wire_methods over every symbol of every target")
    for target_name in target_order:
        symbols = build_symbol_list(contract, target_name)
        calls = [s for s in symbols if s["kind"] == "call"]
        properties = [s for s in symbols if s["kind"] == "property"]
        covered = sorted(
            method
            for symbol in calls + properties
            for method in symbol["covers_wire_methods"]
        )
        assertions += 1
        if covered != sorted(contract_wire_names):
            mismatches.append(
                f"target {target_name}: the call and property symbols cover "
                f"{covered}, the operation table has {sorted(contract_wire_names)}"
            )
        print(
            f"  {target_name.ljust(8)} {len(calls)} call symbols, "
            f"{len(properties)} property symbols, covering all "
            f"{len(covered)} wire methods exactly once"
        )

    # --- 6. the collapse path, which no operation in this contract reaches ---
    #
    # get_property_value / set_property_value pair but cannot collapse: the
    # getter takes node_id and property_id, so no zero-argument accessor can
    # express it. That leaves the C#/Python collapse of 1.1 with no operation to
    # apply to, and the branch of the symbol list that makes covers_wire_methods
    # more than a casing transform therefore untested. This asserts it against a
    # synthetic pair that does satisfy collapse_predicate.
    print("asserting the getter/setter collapse against a synthetic collapsible pair")
    synthetic = copy.deepcopy(contract)
    synthetic["operations"] = list(contract["operations"]) + [
        {
            "tokens": ["get", "acquiring"],
            "kind": "getter",
            "capability": "property.read",
            "params": [],
            "returns": {"type": "bool"},
            "errors": ["not_connected"],
            "naming_overrides": {},
        },
        {
            "tokens": ["set", "acquiring"],
            "kind": "setter",
            "capability": "property.write",
            "params": [{"name": "value", "type": "bool", "presence": "required"}],
            "returns": {"type": "void"},
            "errors": ["read_only"],
            "naming_overrides": {},
        },
    ]
    synthetic["casing"]["getter_setter_pairing"]["pairs"] = list(
        contract["casing"]["getter_setter_pairing"]["pairs"]
    ) + [
        {
            "getter": ["get", "acquiring"],
            "setter": ["set", "acquiring"],
            "getter_capability": "property.read",
            "setter_capability": "property.write",
            "collapses": True,
        }
    ]
    expected_collapsed_symbol = {
        "wire": None,
        "cpp": None,
        "csharp": "Acquiring",
        "python": "acquiring",
        "rust": None,
    }
    for target_name in target_order:
        symbols = build_symbol_list(synthetic, target_name)
        collapsed = [
            symbol
            for symbol in symbols
            if symbol["kind"] == "property"
            and set(symbol["covers_wire_methods"]) == {"get_acquiring", "set_acquiring"}
        ]
        expected_symbol = expected_collapsed_symbol[target_name]
        assertions += 1
        if expected_symbol is None:
            if collapsed:
                mismatches.append(
                    f"target {target_name} has collapse_getter_setter_pairs false but "
                    f"collapsed the synthetic pair into {collapsed[0]['symbol']!r}"
                )
            call_symbols = {
                symbol["symbol"]
                for symbol in symbols
                if symbol["covers_wire_methods"] in (["get_acquiring"], ["set_acquiring"])
            }
            print(
                f"  {target_name.ljust(8)} did not collapse, two call symbols: "
                + ", ".join(sorted(call_symbols))
            )
        else:
            if len(collapsed) != 1 or collapsed[0]["symbol"] != expected_symbol:
                mismatches.append(
                    f"target {target_name}: the synthetic pair should collapse into "
                    f"one property symbol {expected_symbol!r} covering "
                    f"[get_acquiring, set_acquiring], produced {collapsed}"
                )
            else:
                print(
                    f"  {target_name.ljust(8)} collapsed into 1 property symbol "
                    f"{collapsed[0]['symbol']!r} covering "
                    f"{collapsed[0]['covers_wire_methods']}"
                )

    if mismatches:
        # Printed on BOTH streams. See "FAILURE IS PRINTED ON BOTH STREAMS" in
        # the module docstring: this script's 250 passing lines go to stdout, so
        # a failure on stderr alone lets `python ... | tail` look green.
        report = [
            "",
            "=" * 78,
            f"CASING TABLE MISMATCH: {len(mismatches)} of {assertions} assertions failed",
            f"  contract        : {arguments.contract}",
            f"  transcribed 1.1 : {expected_names_path}",
            "=" * 78,
        ]
        for mismatch in mismatches:
            report.append(f"  {mismatch}")
        report.append("=" * 78)
        report.append(
            f"FAILED: {len(mismatches)} of {assertions} casing assertions failed. "
            "assert_operation_names_match_casing_table.py is exiting 1."
        )
        report.append("=" * 78)
        for line in report:
            print(line)
        for line in report:
            print(line, file=sys.stderr)
        return 1

    print(
        f"all {assertions} casing assertions matched section 1.1: "
        f"{len(expected_operation_names)} operations and {len(expected_event_names)} "
        f"events in {len(target_order)} targets, {len(expected_acronym_tokens)} acronym "
        f"tokens in both positions, {len(keyword_collisions_to_watch) + 1} keyword "
        f"collisions, and the transcribed rows of {expected_names_path} are exactly "
        f"the rows of {arguments.contract}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
