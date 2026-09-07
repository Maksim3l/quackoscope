"""Generator for the C++ target: the wire records and the handler interface a
C++ host implements.

Names come from casing.targets.cpp: camelCase join, get prefix kept, acronym
table applied by token position, reserved words escaped with suffix_underscore.
The async convention (callback_or_future) is NOT applied here:
casing.async_style_applies_to says async_style applies to every generated CLIENT
call symbol, and a handler is the server side of the same operation.

Enum member names use the target's join, because contract.yaml declares exactly
one join per target and no separate rule for enum members.
"""

from __future__ import annotations

from contract_loader import snake_case_wire_name
from name_casing import build_symbol_name, field_symbol_name

GENERATED_BANNER_LINES = [
    "// GENERATED FILE. Do not edit by hand.",
    "//",
    "// Produced by tools/contract-compiler from contract/contract.yaml, which is",
    "// the single source of truth for the Quackoscope wire contract. Regenerate",
    "// with:",
    "//",
    "//   python tools/contract-compiler/compile_contract_to_generated_targets.py",
    "//",
]

PRIMITIVE_CPP_TYPES = {
    "string": "std::string",
    "int": "std::int64_t",
    "float": "double",
    "number": "double",
    "bool": "bool",
    "any": "AnyValue",
    "void": "void",
    "object": "AnyValue",
    "uint8": "std::uint8_t",
    "uint32": "std::uint32_t",
    "uint64": "std::uint64_t",
    "float64": "double",
    "binary_frame": "BinarySampleFrame",
}


def enum_type_name(record_name: str, field_name: str) -> str:
    pascal_field = "".join(token.capitalize() for token in field_name.split("_"))
    if pascal_field.startswith(record_name):
        return pascal_field
    return record_name + pascal_field


def cpp_type_of(field: dict, record_name: str, field_name: str) -> str:
    declared = field["type"]
    if declared == "enum":
        return enum_type_name(record_name, field_name)
    if declared == "array":
        inner = PRIMITIVE_CPP_TYPES.get(field["items"], field["items"])
        return f"std::vector<{inner}>"
    return PRIMITIVE_CPP_TYPES.get(declared, declared)


def wrap_for_presence(rendered_type: str, presence: str) -> str:
    """required is the bare type. nullable (key always present, may be null) and
    optional (key may be absent) both become std::optional in C++; the
    difference is a serialisation rule, recorded per field as a comment."""
    if presence == "required":
        return rendered_type
    return f"std::optional<{rendered_type}>"


def generate(contract: dict) -> dict[str, str]:
    return {"quackoscope-contract.hpp": _generate_header(contract)}


def _generate_header(contract: dict) -> str:
    target = contract["casing"]["targets"]["cpp"]
    lines: list[str] = list(GENERATED_BANNER_LINES)
    lines.append("")
    lines.append("#pragma once")
    lines.append("")
    lines.append("#include <cstdint>")
    lines.append("#include <optional>")
    lines.append("#include <stdexcept>")
    lines.append("#include <string>")
    lines.append("#include <string_view>")
    lines.append("#include <vector>")
    lines.append("")
    lines.append("#include <nlohmann/json.hpp>")
    lines.append("")
    lines.append("namespace quackoscope::contract")
    lines.append("{")
    lines.append("")
    lines.append("/// The contract's `any`: an arbitrary JSON value.")
    lines.append("using AnyValue = ::nlohmann::json;")
    lines.append("")
    lines.append(
        f'inline constexpr std::string_view PROTOCOL_VERSION = '
        f'"{contract["contract"]["protocol_version"]}";'
    )
    lines.append("")

    # --- error codes -------------------------------------------------------
    error_values = contract["error_codes"]["values"]
    lines.append("/// The closed error code set of contract 1.2. A native exception maps")
    lines.append("/// into one of these; the native message rides along in "
                 "WireError::detail.")
    lines.append("enum class WireErrorCode")
    lines.append("{")
    for value in error_values:
        member = build_symbol_name(value.split("_"), "enum_member", target, is_operation=False)
        lines.append(f"    {member},  // wire: \"{value}\"")
    lines.append("};")
    lines.append("")
    lines.append("inline constexpr std::string_view wireName(WireErrorCode code)")
    lines.append("{")
    lines.append("    switch (code)")
    lines.append("    {")
    for value in error_values:
        member = build_symbol_name(value.split("_"), "enum_member", target, is_operation=False)
        lines.append(f'        case WireErrorCode::{member}: return "{value}";')
    lines.append("    }")
    lines.append(f'    return "{contract["error_policy"]["unmapped_native_error_becomes"]}";')
    lines.append("}")
    lines.append("")
    lines.append("struct WireError")
    lines.append("{")
    lines.append("    WireErrorCode code;")
    lines.append("    /// Display and logs only. Never parsed by any client.")
    lines.append("    std::string detail;")
    lines.append("};")
    lines.append("")
    lines.append("/// Thrown by a handler method to produce an error envelope. Any other")
    lines.append("/// exception escaping a handler becomes WireErrorCode::"
                 + build_symbol_name(
                     contract["error_policy"]["unmapped_native_error_becomes"].split("_"),
                     "enum_member", target, is_operation=False)
                 + ".")
    lines.append("class WireCallFailed : public std::runtime_error")
    lines.append("{")
    lines.append("public:")
    lines.append("    WireCallFailed(WireErrorCode code, std::string detail)")
    lines.append("        : std::runtime_error(detail)")
    lines.append("        , error{code, std::move(detail)}")
    lines.append("    {")
    lines.append("    }")
    lines.append("")
    lines.append("    WireError error;")
    lines.append("};")
    lines.append("")

    # --- enums from records ------------------------------------------------
    for record_name, record in contract["types"].items():
        for field_name, field in record["fields"].items():
            if field["type"] != "enum":
                continue
            name = enum_type_name(record_name, field_name)
            lines.append(f"/// contract 1.3 types.{record_name}.{field_name}")
            lines.append(f"enum class {name}")
            lines.append("{")
            for value in field["values"]:
                member = build_symbol_name(
                    value.split("_"), "enum_member", target, is_operation=False
                )
                lines.append(f'    {member},  // wire: "{value}"')
            lines.append("};")
            lines.append("")
            lines.append(f"inline constexpr std::string_view wireName({name} value)")
            lines.append("{")
            lines.append("    switch (value)")
            lines.append("    {")
            for value in field["values"]:
                member = build_symbol_name(
                    value.split("_"), "enum_member", target, is_operation=False
                )
                lines.append(f'        case {name}::{member}: return "{value}";')
            lines.append("    }")
            lines.append('    return "";')
            lines.append("}")
            lines.append("")

    # --- records -----------------------------------------------------------
    for record_name, record in contract["types"].items():
        lines.append(f"/// contract 1.3 types.{record_name}")
        lines.append(f"struct {record_name}")
        lines.append("{")
        for field_name, field in record["fields"].items():
            member = field_symbol_name(field_name, target)
            rendered = wrap_for_presence(
                cpp_type_of(field, record_name, field_name), field["presence"]
            )
            note = f'wire key "{field_name}", presence {field["presence"]}'
            if field.get("content") == "opendaq_eval_value_source":
                note += "; openDAQ EvalValue source, display only, never interpreted"
            lines.append(f"    {rendered} {member};  // {note}")
        lines.append("};")
        lines.append("")

    # --- capabilities and method names -------------------------------------
    capability_ids = [capability["id"] for capability in contract["capabilities"]]
    lines.append("/// Baseline capability ids of contract 4. A host declares the subset it")
    lines.append("/// implements; the gap list is this baseline minus that subset.")
    lines.append(
        f"inline constexpr std::string_view BASELINE_CAPABILITY_IDS[{len(capability_ids)}] ="
    )
    lines.append("{")
    for capability_id in capability_ids:
        lines.append(f'    "{capability_id}",')
    lines.append("};")
    lines.append("")

    wire_methods = [snake_case_wire_name(op["tokens"]) for op in contract["operations"]]
    lines.append("/// The closed operation table of contract 1.4. lints."
                 "host_covers_every_operation")
    lines.append("/// and lints.no_undeclared_public_method are both checked against this")
    lines.append("/// array.")
    lines.append(
        f"inline constexpr std::string_view WIRE_METHOD_NAMES[{len(wire_methods)}] ="
    )
    lines.append("{")
    for method in wire_methods:
        lines.append(f'    "{method}",')
    lines.append("};")
    lines.append("")

    event_names = [snake_case_wire_name(ev["tokens"]) for ev in contract["events"]["items"]]
    lines.append("/// Server-push events of contract 1.5. Events carry no id field.")
    lines.append(
        f"inline constexpr std::string_view WIRE_EVENT_NAMES[{len(event_names)}] ="
    )
    lines.append("{")
    for event_name in event_names:
        lines.append(f'    "{event_name}",')
    lines.append("};")
    lines.append("")

    # --- binary frame ------------------------------------------------------
    frame = contract["binary_frame"]
    lines.append(
        f"/// Binary sample frames of contract 1.9. {frame['byte_order']}, "
        f"{frame['header_bytes']}-byte header."
    )
    lines.append("enum class BinaryFrameEncoding : std::uint8_t")
    lines.append("{")
    for encoding in frame["encodings"]:
        member = build_symbol_name(
            encoding["name"].split("_"), "enum_member", target, is_operation=False
        )
        lines.append(
            f'    {member} = {encoding["value"]},  // wire: "{encoding["name"]}", '
            f'{encoding["payload_value_count"]} {encoding["payload_value_type"]} values'
        )
    lines.append("};")
    lines.append("")
    lines.append(
        f"inline constexpr std::size_t BINARY_FRAME_HEADER_BYTES = {frame['header_bytes']};"
    )
    lines.append(
        f"inline constexpr std::size_t BINARY_FRAME_PAYLOAD_OFFSET = "
        f"{frame['payload_offset']};"
    )
    lines.append("")
    lines.append("/// Header field offsets, little-endian, as written on the wire. The")
    lines.append(
        f"/// payload offset is {frame['payload_offset']}, which is not 8-byte aligned, "
        f"so a reader"
    )
    lines.append("/// must copy the payload out rather than view it in place.")
    lines.append("struct BinaryFrameHeader")
    lines.append("{")
    for header_field in frame["header"]:
        member = field_symbol_name(header_field["name"], target)
        rendered = PRIMITIVE_CPP_TYPES[header_field["type"]]
        if header_field["name"] == "encoding":
            rendered = "BinaryFrameEncoding"
        lines.append(
            f"    {rendered} {member};  // offset {header_field['offset']}, "
            f"{header_field['size']} bytes, {header_field['type']}"
        )
    lines.append("};")
    lines.append("")
    lines.append("struct BinarySampleFrame")
    lines.append("{")
    lines.append("    BinaryFrameHeader header;")
    lines.append("    std::vector<double> values;")
    lines.append("};")
    lines.append("")

    # --- handshake ---------------------------------------------------------
    lines.append("/// contract 1.6, the first message the server sends.")
    lines.append("struct WireHandshake")
    lines.append("{")
    lines.append('    std::string protocolVersion;  // wire key "protocol_version", '
                 'const "1.0"')
    lines.append("    /// DISPLAY ONLY. No behavioural branch may read implementationName.")
    lines.append('    std::string implementationName;  // wire key "implementation.name"')
    lines.append('    std::string implementationVersion;  // wire key '
                 '"implementation.version"')
    lines.append('    std::string sdkVersion;  // wire key "sdk.version"')
    lines.append('    std::string sdkCommit;  // wire key "sdk.commit"')
    lines.append('    std::vector<std::string> capabilities;  // wire key "capabilities"')
    lines.append('    std::vector<Gap> gaps;  // wire key "gaps"')
    limits = contract["handshake"]["fields"]["limits"]["fields"]
    lines.append(
        f'    std::int64_t maxSubscriptions = {limits["max_subscriptions"]["default"]};'
        f'  // wire key "limits.max_subscriptions"'
    )
    lines.append(
        f'    std::int64_t maxFrameBytes = {limits["max_frame_bytes"]["default"]};'
        f'  // wire key "limits.max_frame_bytes"'
    )
    lines.append("};")
    lines.append("")

    # --- handler interface -------------------------------------------------
    lines.append("/// The handler interface. A C++ host implements every method of this")
    lines.append("/// class; lints.host_covers_every_operation is what a missing override")
    lines.append("/// costs, and because every method here is pure virtual, a missing")
    lines.append("/// handler is a compile error rather than a runtime surprise.")
    lines.append("///")
    lines.append("/// Methods are synchronous: casing.async_style_applies_to scopes the")
    lines.append("/// async convention to generated CLIENT call symbols, and this is the")
    lines.append("/// server side of the same operations.")
    lines.append("class WireOperationHandler")
    lines.append("{")
    lines.append("public:")
    lines.append("    virtual ~WireOperationHandler() = default;")
    lines.append("")
    for operation in contract["operations"]:
        wire_name = snake_case_wire_name(operation["tokens"])
        symbol = build_symbol_name(
            operation["tokens"], operation["kind"], target, is_operation=False
        )
        returns = operation["returns"]
        if returns["type"] == "array":
            inner = PRIMITIVE_CPP_TYPES.get(returns["items"], returns["items"])
            return_type = f"std::vector<{inner}>"
        else:
            return_type = PRIMITIVE_CPP_TYPES.get(returns["type"], returns["type"])
        parameters = []
        for parameter in operation["params"]:
            rendered = PRIMITIVE_CPP_TYPES.get(parameter["type"], parameter["type"])
            rendered = wrap_for_presence(rendered, parameter["presence"])
            by_value = rendered in ("bool", "double", "std::int64_t")
            declaration = rendered if by_value else f"const {rendered}&"
            parameters.append(f"{declaration} {field_symbol_name(parameter['name'], target)}")
        lines.append(
            f'    /// wire method "{wire_name}", capability {operation["capability"]}, '
            f'kind {operation["kind"]}.'
        )
        lines.append(
            f"    /// Declared errors: {', '.join(operation['errors'])}."
            f" Signal one by throwing WireCallFailed."
        )
        if returns["type"] == "binary_frame":
            lines.append("    ///")
            lines.append("    /// UNSPECIFIED IN contract.yaml: this operation returns a binary")
            lines.append("    /// frame, but envelopes.result carries a JSON result and")
            lines.append("    /// binary_frame.header has no correlation id, so a binary")
            lines.append("    /// response cannot be matched to its request id. See the")
            lines.append("    /// contract-compiler report.")
        lines.append(f"    virtual {return_type} {symbol}({', '.join(parameters)}) = 0;")
        lines.append("")
    lines.pop()
    lines.append("};")
    lines.append("")

    # --- event sink --------------------------------------------------------
    lines.append("/// Server push. A host calls these to emit the events of contract 1.5.")
    lines.append("class WireEventSink")
    lines.append("{")
    lines.append("public:")
    lines.append("    virtual ~WireEventSink() = default;")
    lines.append("")
    for event in contract["events"]["items"]:
        wire_name = snake_case_wire_name(event["tokens"])
        symbol = build_symbol_name(event["tokens"], "event", target, is_operation=False)
        parameters = []
        for payload_field in event["payload"]:
            rendered = PRIMITIVE_CPP_TYPES.get(
                payload_field["type"], payload_field["type"]
            )
            rendered = wrap_for_presence(rendered, payload_field["presence"])
            parameters.append(
                f"const {rendered}& {field_symbol_name(payload_field['name'], target)}"
            )
        lines.append(f'    /// wire event "{wire_name}"')
        lines.append(f"    virtual void {symbol}({', '.join(parameters)}) = 0;")
        lines.append("")
    lines.pop()
    lines.append("};")
    lines.append("")
    lines.append("}  // namespace quackoscope::contract")
    lines.append("")

    return "\n".join(lines) + "\n"
