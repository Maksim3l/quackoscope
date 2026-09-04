"""Imports generated/python/ and proves its handler protocol is satisfiable.

    python tools/contract-compiler/verify_generated_python_imports_and_protocol_is_satisfiable.py

What it establishes, in order:
  1. contract_types.py imports and every dataclass, enum and constant it declares
     is reachable.
  2. Each record round-trips wire JSON: from_wire(to_wire(record)) == record, with
     the wire keys the contract declares rather than the Python member names,
     which differ wherever casing.targets.python.reserved_words escapes one.
  3. wire_operation_handler.py imports and its two Protocols are satisfied by a
     class whose methods are generated from contract.yaml, checked with
     isinstance against the runtime_checkable Protocols and then actually called.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

# generated/ holds source only. Importing from it must not leave __pycache__
# directories behind in the repository.
sys.dont_write_bytecode = True

sys.path.insert(0, str(Path(__file__).resolve().parent))

from contract_loader import REPOSITORY_ROOT, load_contract, snake_case_wire_name
from name_casing import build_symbol_name, field_symbol_name

GENERATED_PYTHON_DIRECTORY = REPOSITORY_ROOT / "generated" / "python"


def sample_wire_record_for(record_name: str, contract: dict) -> dict:
    """A wire-form payload for one record, every key present. Recurses into a
    field that holds another record, which types.ModuleInfo.component_types is
    the first field in the contract to do."""
    return {
        field_name: sample_value_for(field, contract)
        for field_name, field in contract["types"][record_name]["fields"].items()
    }


def sample_value_for(field: dict, contract: dict) -> object:
    """A value of the right shape for one record field, used to build a record
    that is then round-tripped through the wire form."""
    declared = field["type"]
    record_names = set(contract["types"].keys())
    if declared == "enum":
        return field["values"][0]
    if declared in record_names:
        return sample_wire_record_for(declared, contract)
    if declared == "array":
        if field["items"] in record_names:
            return [sample_wire_record_for(field["items"], contract)]
        return ["sample_item"] if field["items"] == "string" else [1.0]
    return {
        "string": "sample_text",
        "int": 7,
        "float": 1000.0,
        "number": 1000.0,
        "bool": True,
        "any": {"nested": 1},
    }[declared]


def main() -> int:
    print(f"importing generated Python from: {GENERATED_PYTHON_DIRECTORY}")
    if not (GENERATED_PYTHON_DIRECTORY / "contract_types.py").is_file():
        raise SystemExit(
            f"{GENERATED_PYTHON_DIRECTORY / 'contract_types.py'} does not exist. Run "
            f"tools/contract-compiler/compile_contract_to_generated_targets.py first."
        )
    sys.path.insert(0, str(GENERATED_PYTHON_DIRECTORY))
    contract_types = importlib.import_module("contract_types")
    handler_module = importlib.import_module("wire_operation_handler")
    print(f"  contract_types            -> {contract_types.__file__}")
    print(f"  wire_operation_handler    -> {handler_module.__file__}")

    contract = load_contract()
    target = contract["casing"]["targets"]["python"]

    print(
        f"  PROTOCOL_VERSION          = {contract_types.PROTOCOL_VERSION}\n"
        f"  WIRE_METHOD_NAMES         = {len(contract_types.WIRE_METHOD_NAMES)} entries, "
        f"first {contract_types.WIRE_METHOD_NAMES[0]}\n"
        f"  WIRE_EVENT_NAMES          = {len(contract_types.WIRE_EVENT_NAMES)} entries, "
        f"first {contract_types.WIRE_EVENT_NAMES[0]}\n"
        f"  BASELINE_CAPABILITY_IDS   = {len(contract_types.BASELINE_CAPABILITY_IDS)} "
        f"entries, first {contract_types.BASELINE_CAPABILITY_IDS[0]}\n"
        f"  BINARY_FRAME_HEADER_BYTES = {contract_types.BINARY_FRAME_HEADER_BYTES}"
    )

    # --- 2. wire round trip per record -------------------------------------
    print(f"round-tripping {len(contract['types'])} records through their wire form")
    for record_name, record in contract["types"].items():
        record_class = getattr(contract_types, record_name)
        wire_payload = sample_wire_record_for(record_name, contract)
        instance = record_class.from_wire(wire_payload)
        round_tripped = record_class.to_wire(instance)
        if round_tripped != wire_payload:
            raise SystemExit(
                f"{record_name}.to_wire(from_wire(payload)) changed the payload\n"
                f"  in : {wire_payload}\n"
                f"  out: {round_tripped}"
            )
        member_names = [
            field_symbol_name(field_name, target) for field_name in record["fields"]
        ]
        escaped = [
            f"{wire}->{member}"
            for wire, member in zip(record["fields"], member_names)
            if wire != member
        ]
        print(
            f"  {record_name:<19} {len(record['fields'])} fields round-tripped"
            + (f", reserved word escapes: {', '.join(escaped)}" if escaped else "")
        )

    # --- 3. the protocol is satisfiable ------------------------------------
    print("building a class that satisfies WireOperationHandler and WireEventSink")
    namespace: dict[str, object] = {}
    method_lines: list[str] = ["class EveryContractMethodImplemented:"]
    called: list[tuple[str, list[object]]] = []
    for operation in contract["operations"]:
        symbol = build_symbol_name(
            operation["tokens"], operation["kind"], target, is_operation=False
        )
        parameter_names = [
            field_symbol_name(parameter["name"], target)
            for parameter in operation["params"]
        ]
        method_lines.append(
            f"    def {symbol}(self, {''.join(n + ', ' for n in parameter_names)}):"
        )
        method_lines.append(f"        return ({parameter_names!r}, {symbol!r})")
        called.append((symbol, ["sample_text"] * len(parameter_names)))
    for event in contract["events"]["items"]:
        symbol = build_symbol_name(event["tokens"], "event", target, is_operation=False)
        parameter_names = [
            field_symbol_name(payload_field["name"], target)
            for payload_field in event["payload"]
        ]
        method_lines.append(
            f"    def {symbol}(self, {''.join(n + ', ' for n in parameter_names)}):"
        )
        method_lines.append("        return None")
        called.append((symbol, ["sample_text"] * len(parameter_names)))
    exec("\n".join(method_lines), namespace)  # noqa: S102 - generated from the contract
    implementation = namespace["EveryContractMethodImplemented"]()

    for protocol_name in ("WireOperationHandler", "WireEventSink"):
        protocol = getattr(handler_module, protocol_name)
        if not isinstance(implementation, protocol):
            missing = [
                name
                for name in dir(protocol)
                if not name.startswith("_") and not hasattr(implementation, name)
            ]
            raise SystemExit(
                f"the generated class does not satisfy {protocol_name}; "
                f"missing members: {missing}"
            )
        method_names = [
            name for name in dir(protocol) if not name.startswith("_")
        ]
        print(
            f"  isinstance(implementation, {protocol_name}) is True over "
            f"{len(method_names)} protocol methods"
        )

    for symbol, arguments in called:
        getattr(implementation, symbol)(*arguments)
    print(f"  called all {len(called)} protocol methods on the implementation")

    declared_wire_methods = list(contract_types.WIRE_METHOD_NAMES)
    expected_wire_methods = [
        snake_case_wire_name(operation["tokens"]) for operation in contract["operations"]
    ]
    if declared_wire_methods != expected_wire_methods:
        raise SystemExit(
            "contract_types.WIRE_METHOD_NAMES disagrees with contract.yaml\n"
            f"  generated: {declared_wire_methods}\n"
            f"  contract : {expected_wire_methods}"
        )
    print(
        f"  WIRE_METHOD_NAMES matches the {len(expected_wire_methods)} operations of "
        f"contract.yaml in order"
    )

    print(
        f"generated/python imports, {len(contract['types'])} records round-trip their "
        f"wire form, and both Protocols are satisfied by a class with "
        f"{len(called)} methods"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
