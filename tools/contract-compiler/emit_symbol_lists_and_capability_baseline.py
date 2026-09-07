"""Generator for the two target-independent artifacts:

  symbol-list.json        per target, every symbol the target exposes and the
                          wire methods that symbol covers. The getter/setter
                          collapse of contract 1.1 means a symbol can stand for
                          two wire methods, so this list is not a casing
                          transform of the wire names and cannot be recomputed
                          from one.

  capability-baseline.json  the full capability set the schema defines. Gap
                          lists are computed as this baseline minus a host's
                          declared capabilities; a host never writes a gap list
                          of its own, only the reason per gap.
"""

from __future__ import annotations

import json

from contract_loader import snake_case_wire_name
from symbol_inventory import build_symbol_list

# TypeScript has no row in contract.yaml casing.targets. Its symbols are the
# frozen snake_case wire names verbatim, so its symbol list is built with the
# wire target's rules. See the contract-compiler report.
TYPESCRIPT_NAMING_BASIS_TARGET = "wire"


def as_json_document(document: dict) -> str:
    return json.dumps(document, indent=2, sort_keys=False) + "\n"


def generate_symbol_list(contract: dict, target_name: str) -> str:
    if target_name == "typescript":
        casing_target_name = TYPESCRIPT_NAMING_BASIS_TARGET
        naming_basis = (
            "contract.yaml casing.targets has no typescript row; every wire-derived "
            "symbol is the frozen snake_case wire name verbatim, which is the wire "
            "target's rules"
        )
    else:
        casing_target_name = target_name
        naming_basis = f"contract.yaml casing.targets.{target_name}"

    target = contract["casing"]["targets"][casing_target_name]
    symbols = build_symbol_list(contract, casing_target_name)
    document = {
        "target": target_name,
        "naming_basis": naming_basis,
        "join": target["join"],
        "getter_prefix": target["getter_prefix"],
        "setter_prefix": target["setter_prefix"],
        "async_style": target["async_style"],
        "collapse_getter_setter_pairs": target["collapse_getter_setter_pairs"],
        "reserved_word_strategy": target["reserved_word_strategy"],
        "symbol_count": len(symbols),
        "symbols": symbols,
    }
    return as_json_document(document)


def generate_capability_baseline(contract: dict) -> str:
    operations_by_wire_name = {
        snake_case_wire_name(operation["tokens"]): operation
        for operation in contract["operations"]
    }
    capabilities = []
    for capability in contract["capabilities"]:
        wire_methods = [
            snake_case_wire_name(token_list) for token_list in capability["operations"]
        ]
        capabilities.append(
            {
                "id": capability["id"],
                "wire_methods": wire_methods,
                "kinds": [operations_by_wire_name[m]["kind"] for m in wire_methods],
            }
        )
    gap_generation = contract["gap_generation"]
    document = {
        "contract_name": contract["contract"]["name"],
        "protocol_version": contract["contract"]["protocol_version"],
        "purpose": (
            "the baseline a host's gap list is computed against: gaps = these "
            "capability ids minus the ids the host declares in its handshake"
        ),
        "gap_computed_as": gap_generation["computed_as"],
        "gap_declared_by_host": gap_generation["declared_by_host"],
        "host_may_declare_gap_list": gap_generation["host_may_declare_gap_list"],
        "gap_kinds": gap_generation["kinds"],
        "capability_count": len(capabilities),
        "wire_method_count": sum(len(c["wire_methods"]) for c in capabilities),
        "capabilities": capabilities,
    }
    return as_json_document(document)
