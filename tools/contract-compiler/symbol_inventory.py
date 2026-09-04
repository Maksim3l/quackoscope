"""Builds, for one target language, the list of symbols the target exposes and
records for each symbol WHICH WIRE METHODS IT COVERS.

This exists because the getter/setter collapse of contract section 1.1 breaks
the one-to-one wire mapping: a collapsed C# property or Python @property is one
symbol standing for two wire methods. lints.naming_matches_symbol_coverage
therefore checks a symbol's name against its covers_wire_methods list, never
against a casing transform of a single wire name, and this module produces that
list.
"""

from __future__ import annotations

from contract_loader import ContractLintFailure, snake_case_wire_name
from name_casing import build_symbol_name, event_symbol_name, operation_symbol_name


def derive_getter_setter_pairs(contract: dict) -> list[tuple[dict, dict]]:
    """Applies casing.getter_setter_pairing.pair_predicate to the operation
    table and returns the pairs it finds, then asserts they are exactly the
    pairs contract.yaml declares."""
    pairing = contract["casing"]["getter_setter_pairing"]
    predicate = pairing["pair_predicate"]
    operations = contract["operations"]

    getters = [op for op in operations if op["kind"] == "getter"]
    setters = [op for op in operations if op["kind"] == "setter"]

    derived: list[tuple[dict, dict]] = []
    for getter in getters:
        for setter in setters:
            if predicate["tokens_equal_after_dropping_leading_verb"]:
                if getter["tokens"][1:] != setter["tokens"][1:]:
                    continue
            if predicate["capability_equal"] and getter["capability"] != setter["capability"]:
                continue
            derived.append((getter, setter))

    declared = {
        (snake_case_wire_name(p["getter"]), snake_case_wire_name(p["setter"]))
        for p in pairing["pairs"]
    }
    found = {
        (snake_case_wire_name(g["tokens"]), snake_case_wire_name(s["tokens"]))
        for g, s in derived
    }
    if declared != found:
        raise ContractLintFailure(
            "capability_operation_lists_agree",
            f"casing.getter_setter_pairing.pairs declares {sorted(declared)}, "
            f"pair_predicate over the operation table yields {sorted(found)}",
            "the declared pair list and the pair predicate must agree",
        )
    return derived


def pair_collapses(getter: dict, setter: dict, contract: dict) -> bool:
    """casing.getter_setter_pairing.collapse_predicate. A pair collapses only
    when the accessor can carry the same information as the two wire calls,
    i.e. the getter takes no arguments and the setter takes exactly [value]."""
    predicate = contract["casing"]["getter_setter_pairing"]["collapse_predicate"]
    if len(getter["params"]) != predicate["getter_params_count"]:
        return False
    return [p["name"] for p in setter["params"]] == predicate["setter_params"]


def build_symbol_list(contract: dict, target_name: str) -> list[dict]:
    """The symbol list for one target. Entry fields are exactly the four of
    casing.symbol_list.entry_fields."""
    target = contract["casing"]["targets"][target_name]
    collapse_allowed = target["collapse_getter_setter_pairs"]
    pairs = derive_getter_setter_pairs(contract)

    collapsed_wire_names: set[str] = set()
    entries: list[dict] = []

    for getter, setter in pairs:
        if not (collapse_allowed and pair_collapses(getter, setter, contract)):
            continue
        # Shared token remainder after dropping the leading get/set verb.
        shared_tokens = list(getter["tokens"][1:])
        entries.append(
            {
                "symbol": build_symbol_name(
                    shared_tokens, "property", target, is_operation=False
                ),
                "kind": "property",
                "covers_wire_methods": [
                    snake_case_wire_name(getter["tokens"]),
                    snake_case_wire_name(setter["tokens"]),
                ],
            }
        )
        collapsed_wire_names.add(snake_case_wire_name(getter["tokens"]))
        collapsed_wire_names.add(snake_case_wire_name(setter["tokens"]))

    for operation in contract["operations"]:
        wire_name = snake_case_wire_name(operation["tokens"])
        if wire_name in collapsed_wire_names:
            continue
        symbol, override_reason = operation_symbol_name(operation, target_name, target)
        entry = {
            "symbol": symbol,
            "kind": "call",
            "covers_wire_methods": [wire_name],
        }
        if override_reason is not None:
            entry["naming_override_reason"] = override_reason
        entries.append(entry)

    for event in contract["events"]["items"]:
        entries.append(
            {
                "symbol": event_symbol_name(event, target),
                "kind": "event",
                "covers_wire_methods": [snake_case_wire_name(event["tokens"])],
            }
        )

    for type_name in contract["types"]:
        entries.append(
            {
                "symbol": type_name,
                "kind": "type",
                "covers_wire_methods": [type_name],
            }
        )

    assert_every_symbol_name_matches_its_coverage(contract, target_name, entries)
    return entries


def assert_every_symbol_name_matches_its_coverage(
    contract: dict, target_name: str, entries: list[dict]
) -> None:
    """lints.naming_matches_symbol_coverage.

    A symbol covering one wire method must be that method's name under the
    target's casing rules. A symbol covering two (a collapsed getter/setter
    pair) must be the shared token remainder under those same rules. Neither
    check is a casing transform of a single wire name applied blindly: the
    coverage list decides which token list the name is checked against.
    """
    target = contract["casing"]["targets"][target_name]
    operations_by_wire_name = {
        snake_case_wire_name(op["tokens"]): op for op in contract["operations"]
    }
    events_by_wire_name = {
        snake_case_wire_name(ev["tokens"]): ev for ev in contract["events"]["items"]
    }

    for entry in entries:
        covered = entry["covers_wire_methods"]
        if not covered:
            raise ContractLintFailure(
                "naming_matches_symbol_coverage",
                f"{target_name} symbol {entry['symbol']!r}",
                "covers_wire_methods has min_items 1 but is empty",
            )
        if "naming_override_reason" in entry:
            continue
        if entry["kind"] == "type":
            expected = covered[0]
        elif entry["kind"] == "event":
            expected = event_symbol_name(events_by_wire_name[covered[0]], target)
        elif entry["kind"] == "call":
            operation = operations_by_wire_name[covered[0]]
            expected, _ = operation_symbol_name(operation, target_name, target)
        elif entry["kind"] == "property":
            getter = operations_by_wire_name[covered[0]]
            expected = build_symbol_name(
                list(getter["tokens"][1:]), "property", target, is_operation=False
            )
        else:
            raise ContractLintFailure(
                "naming_matches_symbol_coverage",
                f"{target_name} symbol {entry['symbol']!r} kind={entry['kind']!r}",
                "casing.symbol_list.entry_fields.kind values are call, property, "
                "event and type",
            )
        if entry["symbol"] != expected:
            raise ContractLintFailure(
                "naming_matches_symbol_coverage",
                f"{target_name} symbol {entry['symbol']!r} covering {covered}",
                f"the casing rules of target {target_name} over that coverage list "
                f"produce {expected!r}",
            )
