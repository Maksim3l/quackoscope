"""Asserts the produced name of every operation in every target language, plus
the acronym table and the keyword collisions of contract section 1.1.

    python tools/contract-compiler/assert_operation_names_match_casing_table.py

Every expectation below is transcribed BY HAND from the section 1.1 table:

    | Target | Join        | Getter convention | Async convention   |
    | wire   | snake_case  | keep get_ prefix  | n/a                |
    | C++    | camelCase   | get prefix        | callback or future |
    | C#     | PascalCase  | property where a getter/setter pair exists | Async suffix |
    | Python | snake_case  | @property where a pair exists, else get_ prefix | async def |
    | Rust   | snake_case  | no prefix on getters, set_ on setters | async fn |

    Acronym tokens, always cased as a unit: id, ids, io, lt, ns, rpc, ui, csv.
    C# keeps two-letter acronyms upper, longer ones Pascal.
    Keyword collisions to watch: type, id, object, input, next, match, ref, async.

None of it is read back out of the generator, so a generator that drifts from
1.1 fails here rather than quietly producing a different name.
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from contract_loader import load_contract, snake_case_wire_name
from name_casing import build_symbol_name, field_symbol_name
from symbol_inventory import build_symbol_list

# --- transcribed from section 1.4's operation table, joined per 1.1 ---------
#
# C# takes the Async suffix on all 18 because every operation is a network round
# trip. C# and Python collapse a getter/setter pair into a property, but the
# contract's only pair, get/set_property_value, cannot collapse: the getter takes
# node_id and property_id and a zero-argument accessor cannot carry those. So
# both keep the get_ prefix here. Rust drops a leading "get" token, which is why
# get_component_tree is component_tree but the getter list_function_block_types,
# whose token list does not begin with "get", is unchanged.
EXPECTED_OPERATION_NAMES = {
    #  wire method name          wire                        cpp                       csharp                         python                      rust
    "scan_available_devices":  ("scan_available_devices",   "scanAvailableDevices",   "ScanAvailableDevicesAsync",   "scan_available_devices",   "scan_available_devices"),
    "connect_device":          ("connect_device",           "connectDevice",          "ConnectDeviceAsync",          "connect_device",           "connect_device"),
    "disconnect_device":       ("disconnect_device",        "disconnectDevice",       "DisconnectDeviceAsync",       "disconnect_device",        "disconnect_device"),
    "get_component_tree":      ("get_component_tree",       "getComponentTree",       "GetComponentTreeAsync",       "get_component_tree",       "component_tree"),
    "get_property_value":      ("get_property_value",       "getPropertyValue",       "GetPropertyValueAsync",       "get_property_value",       "property_value"),
    "get_property_descriptors":("get_property_descriptors", "getPropertyDescriptors", "GetPropertyDescriptorsAsync", "get_property_descriptors", "property_descriptors"),
    "set_property_value":      ("set_property_value",       "setPropertyValue",       "SetPropertyValueAsync",       "set_property_value",       "set_property_value"),
    "list_function_block_types":("list_function_block_types","listFunctionBlockTypes", "ListFunctionBlockTypesAsync", "list_function_block_types","list_function_block_types"),
    "add_function_block":      ("add_function_block",       "addFunctionBlock",       "AddFunctionBlockAsync",       "add_function_block",       "add_function_block"),
    "remove_function_block":   ("remove_function_block",    "removeFunctionBlock",    "RemoveFunctionBlockAsync",    "remove_function_block",    "remove_function_block"),
    "subscribe_signal":        ("subscribe_signal",         "subscribeSignal",        "SubscribeSignalAsync",        "subscribe_signal",         "subscribe_signal"),
    "unsubscribe_signal":      ("unsubscribe_signal",       "unsubscribeSignal",      "UnsubscribeSignalAsync",      "unsubscribe_signal",       "unsubscribe_signal"),
    "read_samples_raw":        ("read_samples_raw",         "readSamplesRaw",         "ReadSamplesRawAsync",         "read_samples_raw",         "read_samples_raw"),
    # The five rows the component-state, operation-mode, lock and Modules work
    # added. get_device_operation_modes is the second getter whose leading
    # "get" rust drops; lock_device and unlock_device do NOT collide with C#'s
    # "lock" keyword, because reserved_word_escaped matches the whole wire name
    # and the whole name is lock_device. list_loaded_modules begins with "list",
    # so rust leaves it alone exactly as it leaves list_function_block_types.
    "get_device_operation_modes": ("get_device_operation_modes", "getDeviceOperationModes", "GetDeviceOperationModesAsync", "get_device_operation_modes", "device_operation_modes"),
    "set_device_operation_mode":  ("set_device_operation_mode",  "setDeviceOperationMode",  "SetDeviceOperationModeAsync",  "set_device_operation_mode",  "set_device_operation_mode"),
    "lock_device":               ("lock_device",               "lockDevice",             "LockDeviceAsync",             "lock_device",              "lock_device"),
    "unlock_device":             ("unlock_device",             "unlockDevice",           "UnlockDeviceAsync",           "unlock_device",            "unlock_device"),
    "list_loaded_modules":       ("list_loaded_modules",       "listLoadedModules",      "ListLoadedModulesAsync",      "list_loaded_modules",      "list_loaded_modules"),
}

TARGET_ORDER = ["wire", "cpp", "csharp", "python", "rust"]

# --- transcribed from section 1.5's event table ----------------------------
EXPECTED_EVENT_NAMES = {
    #  wire event name                wire                           cpp                          csharp                       python                         rust
    "component_added":             ("component_added",             "componentAdded",             "ComponentAdded",             "component_added",             "component_added"),
    "component_removed":           ("component_removed",           "componentRemoved",           "ComponentRemoved",           "component_removed",           "component_removed"),
    "property_changed":            ("property_changed",            "propertyChanged",            "PropertyChanged",            "property_changed",            "property_changed"),
    "property_descriptor_changed": ("property_descriptor_changed", "propertyDescriptorChanged",  "PropertyDescriptorChanged",  "property_descriptor_changed", "property_descriptor_changed"),
    "device_disconnected":         ("device_disconnected",         "deviceDisconnected",         "DeviceDisconnected",         "device_disconnected",         "device_disconnected"),
}

# The closed acronym token list of 1.1, in the order 1.1 gives it.
EXPECTED_ACRONYM_TOKENS = ["id", "ids", "io", "lt", "ns", "rpc", "ui", "csv"]

# The keyword collisions 1.1 says to watch for.
KEYWORD_COLLISIONS_TO_WATCH = [
    "type",
    "id",
    "object",
    "input",
    "next",
    "match",
    "ref",
    "async",
]

# The shape each reserved_word_strategy imposes on an escaped identifier.
RESERVED_WORD_STRATEGY_SHAPES = {
    "none": lambda rendered: rendered,
    "suffix_underscore": lambda rendered: rendered + "_",
    "prefix_at": lambda rendered: "@" + rendered,
    "prefix_raw_identifier": lambda rendered: "r#" + rendered,
}


class CasingMismatch(Exception):
    pass


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


def main() -> int:
    contract = load_contract()
    targets = contract["casing"]["targets"]
    mismatches: list[str] = []
    assertions = 0

    # --- 1. operation names, every operation in every target ---------------
    print(
        f"asserting the produced name of {len(EXPECTED_OPERATION_NAMES)} operations "
        f"in {len(TARGET_ORDER)} targets"
    )
    header = "  " + "wire method".ljust(26) + "".join(t.ljust(29) for t in TARGET_ORDER)
    print(header)
    contract_wire_names = [
        snake_case_wire_name(operation["tokens"]) for operation in contract["operations"]
    ]
    if contract_wire_names != list(EXPECTED_OPERATION_NAMES):
        mismatches.append(
            "the operation table of contract.yaml is not the operation table this "
            f"assertion was written against\n  contract.yaml: {contract_wire_names}\n"
            f"  expected     : {list(EXPECTED_OPERATION_NAMES)}"
        )
    for operation in contract["operations"]:
        wire_name = snake_case_wire_name(operation["tokens"])
        expected_row = EXPECTED_OPERATION_NAMES.get(wire_name)
        if expected_row is None:
            mismatches.append(
                f"operation {wire_name!r} is in contract.yaml but has no expected row"
            )
            continue
        produced_row = []
        for target_name, expected in zip(TARGET_ORDER, expected_row):
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
        f"asserting the produced name of {len(EXPECTED_EVENT_NAMES)} events in "
        f"{len(TARGET_ORDER)} targets"
    )
    for event in contract["events"]["items"]:
        wire_name = snake_case_wire_name(event["tokens"])
        expected_row = EXPECTED_EVENT_NAMES.get(wire_name)
        if expected_row is None:
            mismatches.append(
                f"event {wire_name!r} is in contract.yaml but has no expected row"
            )
            continue
        for target_name, expected in zip(TARGET_ORDER, expected_row):
            produced = build_symbol_name(
                event["tokens"], "event", targets[target_name], is_operation=False
            )
            assertions += 1
            if produced != expected:
                mismatches.append(
                    f"event {wire_name!r} in target {target_name}: produced "
                    f"{produced!r}, section 1.1 requires {expected!r}"
                )
    print(f"  {len(EXPECTED_EVENT_NAMES)} events matched in every target")

    # --- 3. acronym tokens -------------------------------------------------
    declared_acronyms = contract["casing"]["acronym_tokens"]
    assertions += 1
    if declared_acronyms != EXPECTED_ACRONYM_TOKENS:
        mismatches.append(
            f"casing.acronym_tokens is {declared_acronyms}, section 1.1 lists "
            f"{EXPECTED_ACRONYM_TOKENS}"
        )
    print(
        f"asserting the rendering of all {len(EXPECTED_ACRONYM_TOKENS)} acronym tokens "
        f"in both positions in {len(TARGET_ORDER)} targets"
    )
    for token in EXPECTED_ACRONYM_TOKENS:
        rendered_row = []
        for target_name in TARGET_ORDER:
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
        f"asserting the escape of the {len(KEYWORD_COLLISIONS_TO_WATCH)} keyword "
        f"collisions 1.1 names, plus the field name 'default'"
    )
    for word in KEYWORD_COLLISIONS_TO_WATCH + ["default"]:
        rendered_row = []
        for target_name in TARGET_ORDER:
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
    for target_name in TARGET_ORDER:
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
    for target_name in TARGET_ORDER:
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
        print(
            f"\nCASING TABLE MISMATCH: {len(mismatches)} of {assertions} assertions "
            f"failed",
            file=sys.stderr,
        )
        for mismatch in mismatches:
            print(f"  {mismatch}", file=sys.stderr)
        return 1

    print(
        f"all {assertions} casing assertions matched section 1.1: "
        f"{len(EXPECTED_OPERATION_NAMES)} operations and {len(EXPECTED_EVENT_NAMES)} "
        f"events in {len(TARGET_ORDER)} targets, {len(EXPECTED_ACRONYM_TOKENS)} acronym "
        f"tokens in both positions, {len(KEYWORD_COLLISIONS_TO_WATCH) + 1} keyword "
        f"collisions"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
