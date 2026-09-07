"""Generator for the Python target: the wire records as dataclasses plus the
handler protocol a Python host satisfies.

Names come from casing.targets.python: snake_case join, get prefix kept,
reserved words escaped with suffix_underscore. Because python's join is
snake_case and the wire join is snake_case, every operation name is identical to
its wire name; the one place the two diverge is the record field "id", which
casing.targets.python.reserved_words lists, so it is emitted as "id_" and the
generated from_wire/to_wire carry the "id" <-> "id_" mapping explicitly.

The async convention (async_def) is NOT applied here:
casing.async_style_applies_to scopes async_style to generated CLIENT call
symbols, and a handler is the server side of the same operation.
"""

from __future__ import annotations

from contract_loader import snake_case_wire_name
from name_casing import build_symbol_name, field_symbol_name

GENERATED_BANNER_LINES = [
    '"""GENERATED FILE. Do not edit by hand.',
    "",
    "Produced by tools/contract-compiler from contract/contract.yaml, which is the",
    "single source of truth for the Quackoscope wire contract. Regenerate with:",
    "",
    "    python tools/contract-compiler/compile_contract_to_generated_targets.py",
    '"""',
]

PRIMITIVE_PYTHON_TYPES = {
    "string": "str",
    "int": "int",
    "float": "float",
    "number": "float",
    "bool": "bool",
    "any": "Any",
    "void": "None",
    "object": "dict[str, Any]",
    "uint8": "int",
    "uint32": "int",
    "uint64": "int",
    "float64": "float",
    "binary_frame": "BinarySampleFrame",
}


def enum_type_name(record_name: str, field_name: str) -> str:
    pascal_field = "".join(token.capitalize() for token in field_name.split("_"))
    if pascal_field.startswith(record_name):
        return pascal_field
    return record_name + pascal_field


def python_type_of(field: dict, record_name: str, field_name: str) -> str:
    declared = field["type"]
    if declared == "enum":
        return enum_type_name(record_name, field_name)
    if declared == "array":
        inner = PRIMITIVE_PYTHON_TYPES.get(field["items"], field["items"])
        return f"list[{inner}]"
    return PRIMITIVE_PYTHON_TYPES.get(declared, declared)


def annotate_for_presence(rendered_type: str, presence: str) -> str:
    if presence == "required":
        return rendered_type
    return f"{rendered_type} | None"


def nested_record_of(field: dict, record_names: set[str]) -> tuple[str, bool] | None:
    """Returns (record name, is_array) when a field holds another contract
    record, otherwise None.

    A record inside a record needs from_wire/to_wire to recurse, or the
    dataclass would hold raw dicts while its annotation claims the record type.
    types.ModuleInfo.component_types is the first field in the contract to do
    this; every earlier field held a primitive or an array of primitives, which
    is why the two conversions used to be plain assignments.
    """
    if field["type"] in record_names:
        return field["type"], False
    if field["type"] == "array" and field.get("items") in record_names:
        return field["items"], True
    return None


def generate(contract: dict) -> dict[str, str]:
    return {
        "contract_types.py": _generate_types(contract),
        "wire_operation_handler.py": _generate_handler_protocol(contract),
    }


def _generate_types(contract: dict) -> str:
    target = contract["casing"]["targets"]["python"]
    lines: list[str] = list(GENERATED_BANNER_LINES)
    lines.append("")
    lines.append("from __future__ import annotations")
    lines.append("")
    lines.append("from dataclasses import dataclass")
    lines.append("from enum import Enum")
    lines.append("from typing import Any")
    lines.append("")
    lines.append(
        f'PROTOCOL_VERSION = "{contract["contract"]["protocol_version"]}"'
    )
    lines.append("")
    lines.append("")

    # --- error codes -------------------------------------------------------
    lines.append("class WireErrorCode(str, Enum):")
    lines.append('    """The closed error code set of contract 1.2. A native exception')
    lines.append("    maps into one of these; the native message rides along in")
    lines.append('    WireError.detail, which is display and logs only."""')
    lines.append("")
    for value in contract["error_codes"]["values"]:
        member = build_symbol_name(
            value.split("_"), "enum_member", target, is_operation=False
        )
        lines.append(f'    {member} = "{value}"')
    lines.append("")
    lines.append("")
    lines.append("@dataclass(frozen=True, slots=True)")
    lines.append("class WireError:")
    lines.append("    code: WireErrorCode")
    lines.append("    detail: str")
    lines.append("")
    lines.append("")
    lines.append("class WireCallFailed(Exception):")
    lines.append('    """Raised by a handler method to produce an error envelope. Any')
    lines.append("    other exception escaping a handler becomes")
    lines.append(
        f"    WireErrorCode."
        + build_symbol_name(
            contract["error_policy"]["unmapped_native_error_becomes"].split("_"),
            "enum_member",
            target,
            is_operation=False,
        )
        + '."""'
    )
    lines.append("")
    lines.append("    def __init__(self, code: WireErrorCode, detail: str) -> None:")
    lines.append('        super().__init__(f"{code.value}: {detail}")')
    lines.append("        self.error = WireError(code=code, detail=detail)")
    lines.append("")
    lines.append("")

    # --- enums from records ------------------------------------------------
    for record_name, record in contract["types"].items():
        for field_name, field in record["fields"].items():
            if field["type"] != "enum":
                continue
            name = enum_type_name(record_name, field_name)
            lines.append(f"class {name}(str, Enum):")
            lines.append(f'    """contract 1.3 types.{record_name}.{field_name}"""')
            lines.append("")
            for value in field["values"]:
                member = build_symbol_name(
                    value.split("_"), "enum_member", target, is_operation=False
                )
                lines.append(f'    {member} = "{value}"')
            lines.append("")
            lines.append("")

    # --- records -----------------------------------------------------------
    record_names = set(contract["types"].keys())
    for record_name, record in contract["types"].items():
        field_members: list[tuple[str, str, dict]] = []
        for field_name, field in record["fields"].items():
            member = field_symbol_name(field_name, target)
            field_members.append((field_name, member, field))

        lines.append("@dataclass(frozen=True, slots=True)")
        lines.append(f"class {record_name}:")
        lines.append(f'    """contract 1.3 types.{record_name}"""')
        lines.append("")
        for field_name, member, field in field_members:
            rendered = annotate_for_presence(
                python_type_of(field, record_name, field_name), field["presence"]
            )
            lines.append(f"    {member}: {rendered}")
        lines.append("")
        lines.append("    WIRE_KEYS = {")
        for field_name, member, _field in field_members:
            lines.append(f'        "{member}": "{field_name}",')
        lines.append("    }")
        lines.append("")
        lines.append("    @classmethod")
        lines.append(f'    def from_wire(cls, payload: dict[str, Any]) -> "{record_name}":')
        lines.append(f"        return cls(")
        for field_name, member, field in field_members:
            reader = f'payload["{field_name}"]'
            if field["presence"] in ("optional", "optional_null"):
                reader = f'payload.get("{field_name}")'
            if field["type"] == "enum":
                enum_name = enum_type_name(record_name, field_name)
                if field["presence"] == "required":
                    reader = f"{enum_name}({reader})"
                else:
                    reader = (
                        f"None if {reader} is None else {enum_name}({reader})"
                    )
            nested = nested_record_of(field, record_names)
            if nested is not None:
                nested_name, is_array = nested
                converted = (
                    f"[{nested_name}.from_wire(item) for item in {reader}]"
                    if is_array
                    else f"{nested_name}.from_wire({reader})"
                )
                if field["presence"] == "required":
                    reader = converted
                else:
                    reader = f"None if {reader} is None else {converted}"
            lines.append(f"            {member}={reader},")
        lines.append("        )")
        lines.append("")
        lines.append("    def to_wire(self) -> dict[str, Any]:")
        lines.append("        return {")
        for field_name, member, field in field_members:
            writer = f"self.{member}"
            if field["type"] == "enum":
                if field["presence"] == "required":
                    writer = f"{writer}.value"
                else:
                    writer = f"None if {writer} is None else {writer}.value"
            nested = nested_record_of(field, record_names)
            if nested is not None:
                _nested_name, is_array = nested
                converted = (
                    f"[item.to_wire() for item in {writer}]"
                    if is_array
                    else f"{writer}.to_wire()"
                )
                if field["presence"] == "required":
                    writer = converted
                else:
                    writer = f"None if {writer} is None else {converted}"
            lines.append(f'            "{field_name}": {writer},')
        lines.append("        }")
        lines.append("")
        lines.append("")

    # --- capabilities, method names, event names ---------------------------
    lines.append("#: Baseline capability ids of contract 4. A host declares the subset it")
    lines.append("#: implements; the gap list is this baseline minus that subset.")
    lines.append("BASELINE_CAPABILITY_IDS: tuple[str, ...] = (")
    for capability in contract["capabilities"]:
        lines.append(f'    "{capability["id"]}",')
    lines.append(")")
    lines.append("")
    lines.append("#: The closed operation table of contract 1.4. A public host method")
    lines.append("#: whose wire name is absent from this tuple violates")
    lines.append("#: lints.no_undeclared_public_method.")
    lines.append("WIRE_METHOD_NAMES: tuple[str, ...] = (")
    for operation in contract["operations"]:
        lines.append(f'    "{snake_case_wire_name(operation["tokens"])}",')
    lines.append(")")
    lines.append("")
    lines.append("#: Server-push events of contract 1.5. Events carry no id field.")
    lines.append("WIRE_EVENT_NAMES: tuple[str, ...] = (")
    for event in contract["events"]["items"]:
        lines.append(f'    "{snake_case_wire_name(event["tokens"])}",')
    lines.append(")")
    lines.append("")
    lines.append("")

    # --- binary frame ------------------------------------------------------
    frame = contract["binary_frame"]
    lines.append("class BinaryFrameEncoding(int, Enum):")
    lines.append(
        f'    """contract 1.9 binary_frame.encodings, {frame["byte_order"]}."""'
    )
    lines.append("")
    for encoding in frame["encodings"]:
        member = build_symbol_name(
            encoding["name"].split("_"), "enum_member", target, is_operation=False
        )
        lines.append(f'    {member} = {encoding["value"]}')
    lines.append("")
    lines.append("")
    lines.append(f"BINARY_FRAME_HEADER_BYTES = {frame['header_bytes']}")
    lines.append(f"BINARY_FRAME_PAYLOAD_OFFSET = {frame['payload_offset']}")
    lines.append("")
    lines.append("")
    lines.append("@dataclass(frozen=True, slots=True)")
    lines.append("class BinaryFrameHeader:")
    lines.append(
        f'    """{frame["header_bytes"]} bytes, {frame["byte_order"]}. The payload'
    )
    lines.append(
        f"    offset is {frame['payload_offset']}, which is not 8-byte aligned, so a"
    )
    lines.append('    reader must copy the payload out rather than view it in place."""')
    lines.append("")
    for header_field in frame["header"]:
        member = field_symbol_name(header_field["name"], target)
        rendered = (
            "BinaryFrameEncoding"
            if header_field["name"] == "encoding"
            else PRIMITIVE_PYTHON_TYPES[header_field["type"]]
        )
        lines.append(
            f"    {member}: {rendered}  # offset {header_field['offset']}, "
            f"{header_field['size']} bytes, {header_field['type']}"
        )
    lines.append("")
    lines.append("")
    lines.append("@dataclass(frozen=True, slots=True)")
    lines.append("class BinarySampleFrame:")
    lines.append("    header: BinaryFrameHeader")
    lines.append("    values: list[float]")
    lines.append("")
    lines.append("")

    # --- handshake ---------------------------------------------------------
    limits = contract["handshake"]["fields"]["limits"]["fields"]
    lines.append("@dataclass(frozen=True, slots=True)")
    lines.append("class WireHandshake:")
    lines.append('    """contract 1.6, the first message the server sends."""')
    lines.append("")
    lines.append("    protocol_version: str")
    lines.append("    #: DISPLAY ONLY. No behavioural branch may read this.")
    lines.append("    implementation_name: str")
    lines.append("    implementation_version: str")
    lines.append("    sdk_version: str")
    lines.append("    sdk_commit: str")
    lines.append("    capabilities: list[str]")
    lines.append("    gaps: list[Gap]")
    lines.append(
        f"    max_subscriptions: int = {limits['max_subscriptions']['default']}"
    )
    lines.append(f"    max_frame_bytes: int = {limits['max_frame_bytes']['default']}")
    lines.append("")
    lines.append("    def to_wire(self) -> dict[str, Any]:")
    lines.append("        return {")
    lines.append('            "protocol_version": self.protocol_version,')
    lines.append('            "implementation": {')
    lines.append('                "name": self.implementation_name,')
    lines.append('                "version": self.implementation_version,')
    lines.append("            },")
    lines.append('            "sdk": {')
    lines.append('                "version": self.sdk_version,')
    lines.append('                "commit": self.sdk_commit,')
    lines.append("            },")
    lines.append('            "capabilities": list(self.capabilities),')
    lines.append('            "gaps": [gap.to_wire() for gap in self.gaps],')
    lines.append('            "limits": {')
    lines.append('                "max_subscriptions": self.max_subscriptions,')
    lines.append('                "max_frame_bytes": self.max_frame_bytes,')
    lines.append("            },")
    lines.append("        }")
    lines.append("")

    return "\n".join(lines) + "\n"


def _generate_handler_protocol(contract: dict) -> str:
    target = contract["casing"]["targets"]["python"]
    lines: list[str] = list(GENERATED_BANNER_LINES)
    lines.append("")
    lines.append("from __future__ import annotations")
    lines.append("")
    lines.append("from typing import Any, Protocol, runtime_checkable")
    lines.append("")
    lines.append("from contract_types import (")
    for name in sorted(contract["types"].keys()) + ["BinarySampleFrame"]:
        lines.append(f"    {name},")
    lines.append(")")
    lines.append("")
    lines.append("")

    lines.append("@runtime_checkable")
    lines.append("class WireOperationHandler(Protocol):")
    lines.append('    """The handler protocol. A Python host satisfies every method of')
    lines.append("    this protocol; a missing method is what")
    lines.append("    lints.host_covers_every_operation costs, and a public method whose")
    lines.append("    wire name is absent from WIRE_METHOD_NAMES is what")
    lines.append("    lints.no_undeclared_public_method costs.")
    lines.append("")
    lines.append("    Methods are synchronous: casing.async_style_applies_to scopes the")
    lines.append("    async convention to generated CLIENT call symbols, and this is the")
    lines.append('    server side of the same operations."""')
    lines.append("")

    for operation in contract["operations"]:
        wire_name = snake_case_wire_name(operation["tokens"])
        symbol = build_symbol_name(
            operation["tokens"], operation["kind"], target, is_operation=False
        )
        returns = operation["returns"]
        if returns["type"] == "array":
            inner = PRIMITIVE_PYTHON_TYPES.get(returns["items"], returns["items"])
            return_type = f"list[{inner}]"
        else:
            return_type = PRIMITIVE_PYTHON_TYPES.get(returns["type"], returns["type"])
        parameters = ["self"]
        for parameter in operation["params"]:
            rendered = PRIMITIVE_PYTHON_TYPES.get(parameter["type"], parameter["type"])
            member = field_symbol_name(parameter["name"], target)
            if parameter["presence"] in ("optional", "optional_null"):
                parameters.append(f"{member}: {rendered} | None = None")
            else:
                parameters.append(f"{member}: {rendered}")
        lines.append(f"    def {symbol}({', '.join(parameters)}) -> {return_type}:")
        lines.append(
            f'        """wire method "{wire_name}", capability '
            f'{operation["capability"]}, kind {operation["kind"]}.'
        )
        lines.append("")
        lines.append(
            f"        Declared errors: {', '.join(operation['errors'])}. Signal one by"
        )
        lines.append("        raising WireCallFailed.")
        if returns["type"] == "binary_frame":
            lines.append("")
            lines.append("        UNSPECIFIED IN contract.yaml: this operation returns a")
            lines.append("        binary frame, but envelopes.result carries a JSON result")
            lines.append("        and binary_frame.header has no correlation id, so a")
            lines.append("        binary response cannot be matched to its request id. See")
            lines.append("        the contract-compiler report.")
        lines.append('        """')
        lines.append("        ...")
        lines.append("")

    lines.append("")
    lines.append("@runtime_checkable")
    lines.append("class WireEventSink(Protocol):")
    lines.append('    """Server push. A host calls these to emit the events of')
    lines.append('    contract 1.5. Events carry no id field."""')
    lines.append("")
    for event in contract["events"]["items"]:
        wire_name = snake_case_wire_name(event["tokens"])
        symbol = build_symbol_name(event["tokens"], "event", target, is_operation=False)
        parameters = ["self"]
        for payload_field in event["payload"]:
            rendered = PRIMITIVE_PYTHON_TYPES.get(
                payload_field["type"], payload_field["type"]
            )
            member = field_symbol_name(payload_field["name"], target)
            parameters.append(f"{member}: {rendered}")
        lines.append(f"    def {symbol}({', '.join(parameters)}) -> None:")
        lines.append(f'        """wire event "{wire_name}\\""""')
        lines.append("        ...")
        lines.append("")

    return "\n".join(lines) + "\n"
