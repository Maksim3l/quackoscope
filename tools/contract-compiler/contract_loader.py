"""Loads contract/contract.yaml and enforces the lints that section 10 of the
contract declares as fail_build.

Every failure raises ContractLintFailure carrying the offending value verbatim,
so the caller can print the exact input that failed rather than a bare
"invalid contract".
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent.parent
CONTRACT_YAML_PATH = REPOSITORY_ROOT / "contract" / "contract.yaml"


class ContractLintFailure(Exception):
    """A contract lint declared on_violation: fail_build was violated."""

    def __init__(self, lint_name: str, offending_value: str, explanation: str) -> None:
        super().__init__(
            f"contract lint '{lint_name}' failed\n"
            f"  offending value: {offending_value}\n"
            f"  {explanation}"
        )
        self.lint_name = lint_name
        self.offending_value = offending_value
        self.explanation = explanation


def snake_case_wire_name(tokens: list[str]) -> str:
    """The frozen wire join. Used everywhere a wire method or event name is needed."""
    return "_".join(tokens)


def load_contract(contract_yaml_path: Path = CONTRACT_YAML_PATH) -> dict:
    print(f"reading contract: {contract_yaml_path}")
    if not contract_yaml_path.is_file():
        raise ContractLintFailure(
            "contract_file_exists",
            str(contract_yaml_path),
            "the contract file does not exist at that path",
        )
    raw_text = contract_yaml_path.read_text(encoding="utf-8")
    contract = yaml.safe_load(raw_text)
    print(
        f"  parsed {len(raw_text)} bytes, {len(contract)} top-level sections: "
        + ", ".join(contract.keys())
    )
    enforce_declared_lints(contract)
    return contract


def enforce_declared_lints(contract: dict) -> None:
    """Runs the compiler-side lints of contract section 10.

    host_covers_every_operation and no_undeclared_public_method are host-build
    lints, not compiler lints: they need a host's method table, which the
    compiler does not have. They are not run here.
    """
    operations = contract["operations"]
    capabilities = contract["capabilities"]
    types = contract["types"]
    primitives = set(contract["primitives"])
    error_code_values = set(contract["error_codes"]["values"])
    casing_targets = contract["casing"]["targets"]

    print("enforcing contract lints declared with on_violation: fail_build")

    # --- error_code_closed_set --------------------------------------------
    error_codes_seen = 0
    for operation in operations:
        wire_name = snake_case_wire_name(operation["tokens"])
        for code in operation["errors"]:
            error_codes_seen += 1
            if code not in error_code_values:
                raise ContractLintFailure(
                    "error_code_closed_set",
                    f"operations[{wire_name}].errors contains {code!r}",
                    "error_codes.values is "
                    + ", ".join(sorted(error_code_values)),
                )
    print(
        f"  error_code_closed_set          : {error_codes_seen} error codes across "
        f"{len(operations)} operations, all members of the closed set of "
        f"{len(error_code_values)}"
    )

    # --- capability_ids_resolve -------------------------------------------
    capability_ids = [capability["id"] for capability in capabilities]
    capability_id_set = set(capability_ids)
    for operation in operations:
        wire_name = snake_case_wire_name(operation["tokens"])
        if operation["capability"] not in capability_id_set:
            raise ContractLintFailure(
                "capability_ids_resolve",
                f"operations[{wire_name}].capability = {operation['capability']!r}",
                "capabilities[].id values are " + ", ".join(capability_ids),
            )
    print(
        f"  capability_ids_resolve         : all {len(operations)} operations name one "
        f"of the {len(capability_ids)} capability ids"
    )

    # --- capability_operation_lists_agree ---------------------------------
    forward: dict[str, str] = {}
    for capability in capabilities:
        for token_list in capability["operations"]:
            wire_name = snake_case_wire_name(token_list)
            if wire_name in forward:
                raise ContractLintFailure(
                    "capability_operation_lists_agree",
                    f"wire method {wire_name!r}",
                    f"listed under two capabilities: {forward[wire_name]} and "
                    f"{capability['id']}",
                )
            forward[wire_name] = capability["id"]
    backward = {
        snake_case_wire_name(operation["tokens"]): operation["capability"]
        for operation in operations
    }
    if forward != backward:
        only_forward = sorted(set(forward.items()) - set(backward.items()))
        only_backward = sorted(set(backward.items()) - set(forward.items()))
        raise ContractLintFailure(
            "capability_operation_lists_agree",
            f"capabilities[].operations says {only_forward}, "
            f"operations[].capability says {only_backward}",
            "the two views of the capability/operation mapping disagree",
        )
    print(
        f"  capability_operation_lists_agree: the {len(forward)} entries of "
        f"capabilities[].operations and operations[].capability agree in both "
        f"directions"
    )

    # --- type_references_resolve ------------------------------------------
    known_type_names = set(types.keys())
    resolvable = primitives | known_type_names
    references_seen = 0

    def assert_type_name_resolves(type_name: str, where: str) -> None:
        nonlocal references_seen
        references_seen += 1
        if type_name not in resolvable:
            raise ContractLintFailure(
                "type_references_resolve",
                f"{where} names type {type_name!r}",
                "resolvable names are the primitives "
                + ", ".join(sorted(primitives))
                + " and the records "
                + ", ".join(sorted(known_type_names)),
            )

    def assert_field_path_resolves(field_path: str, where: str) -> None:
        nonlocal references_seen
        references_seen += 1
        head, _, tail = field_path.partition(".")
        if head == "capabilities":
            if tail != "id":
                raise ContractLintFailure(
                    "type_references_resolve",
                    f"{where} references {field_path!r}",
                    "the only referencable capability field path is capabilities.id",
                )
            return
        if head not in types or tail not in types[head]["fields"]:
            raise ContractLintFailure(
                "type_references_resolve",
                f"{where} references {field_path!r}",
                "no such field path; known records are "
                + ", ".join(sorted(known_type_names)),
            )

    for type_name, type_definition in types.items():
        for field_name, field in type_definition["fields"].items():
            where = f"types.{type_name}.{field_name}"
            assert_type_name_resolves(field["type"], where)
            if "items" in field:
                assert_type_name_resolves(field["items"], where + ".items")
            if "references" in field:
                assert_field_path_resolves(field["references"], where)

    for operation in operations:
        wire_name = snake_case_wire_name(operation["tokens"])
        for parameter in operation["params"]:
            where = f"operations.{wire_name}.params.{parameter['name']}"
            assert_type_name_resolves(parameter["type"], where)
            if "references" in parameter:
                assert_field_path_resolves(parameter["references"], where)
        returns = operation["returns"]
        assert_type_name_resolves(returns["type"], f"operations.{wire_name}.returns")
        if "items" in returns:
            assert_type_name_resolves(
                returns["items"], f"operations.{wire_name}.returns.items"
            )

    for event in contract["events"]["items"]:
        wire_name = snake_case_wire_name(event["tokens"])
        for payload_field in event["payload"]:
            where = f"events.{wire_name}.payload.{payload_field['name']}"
            assert_type_name_resolves(payload_field["type"], where)
            if "references" in payload_field:
                assert_field_path_resolves(payload_field["references"], where)

    print(
        f"  type_references_resolve        : {references_seen} type and reference "
        f"names resolve against {len(primitives)} primitives and "
        f"{len(known_type_names)} records"
    )

    # --- naming_override_needs_reason -------------------------------------
    override_count = 0
    for operation in operations:
        wire_name = snake_case_wire_name(operation["tokens"])
        for target_name, override in (operation.get("naming_overrides") or {}).items():
            override_count += 1
            if target_name not in casing_targets:
                raise ContractLintFailure(
                    "naming_override_needs_reason",
                    f"operations[{wire_name}].naming_overrides.{target_name}",
                    "names a target absent from casing.targets, which are "
                    + ", ".join(casing_targets.keys()),
                )
            reason = (override or {}).get("reason", "")
            if not isinstance(reason, str) or not reason.strip():
                raise ContractLintFailure(
                    "naming_override_needs_reason",
                    f"operations[{wire_name}].naming_overrides.{target_name}"
                    f" = {override!r}",
                    "naming_override_schema.reason_required is true and "
                    "on_missing_reason is fail_build",
                )
    print(
        f"  naming_override_needs_reason   : {override_count} per-language naming "
        f"overrides declared across {len(operations)} operations, every one carrying "
        f"a non-empty reason"
    )

    # --- reserved_word_escaped, consistency of the field-level annotation ---
    annotated_fields = 0
    for type_name, type_definition in types.items():
        for field_name, field in type_definition["fields"].items():
            if "wire_key_is_language_keyword_in" not in field:
                continue
            annotated_fields += 1
            annotated = set(field["wire_key_is_language_keyword_in"])
            derived = {
                target_name
                for target_name, target in casing_targets.items()
                if field_name in target["reserved_words"]
            }
            if annotated != derived:
                raise ContractLintFailure(
                    "reserved_word_escaped",
                    f"types.{type_name}.{field_name}."
                    f"wire_key_is_language_keyword_in = {sorted(annotated)}",
                    f"casing.targets[].reserved_words puts {field_name!r} in "
                    f"{sorted(derived)}; the annotation and the reserved word lists "
                    f"must name the same targets",
                )
    print(
        f"  reserved_word_escaped          : {annotated_fields} field annotated with "
        f"wire_key_is_language_keyword_in agrees with casing.targets[].reserved_words"
    )


def main() -> int:
    try:
        load_contract()
    except ContractLintFailure as failure:
        print(f"CONTRACT LINT FAILURE\n{failure}", file=sys.stderr)
        return 1
    print("every compiler-side contract lint passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
