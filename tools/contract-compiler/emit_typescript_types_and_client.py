"""Generator for the TypeScript target: wire types plus a typed transport
client, the only two things the frontend is allowed to import.

NAMING BASIS. contract.yaml casing.targets has five entries: wire, cpp, csharp,
python and rust. TypeScript is not among them, so this generator invents no
casing rule for it: every wire-derived name it emits (the method names, the
event keys, the record fields, the enum members) is the frozen snake_case wire
name verbatim. Only the client's own plumbing, which has no wire counterpart
(the constructor, onEvent, onBinaryFrame, close), is written in ordinary
lowerCamelCase TypeScript. See the generator report: the missing TypeScript row
in casing 1.1 is the one naming question this file answers by fiat.
"""

from __future__ import annotations

from contract_loader import snake_case_wire_name

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

PRIMITIVE_TYPESCRIPT_TYPES = {
    "string": "string",
    "int": "number",
    "float": "number",
    "number": "number",
    "bool": "boolean",
    "any": "unknown",
    "void": "void",
    "object": "Record<string, unknown>",
    "uint8": "number",
    "uint32": "number",
    "uint64": "bigint",
    "float64": "number",
    "binary_frame": "BinarySampleFrame",
}


def enum_type_name(record_name: str, field_name: str) -> str:
    """<Record><Field in PascalCase>, e.g. Node.kind -> NodeKind. A single rule
    with no special cases, applied to every inline enum in contract.types."""
    pascal_field = "".join(token.capitalize() for token in field_name.split("_"))
    if pascal_field.startswith(record_name):
        return pascal_field
    return record_name + pascal_field


def typescript_type_of(field: dict, record_name: str, field_name: str) -> str:
    declared = field["type"]
    if declared == "enum":
        return enum_type_name(record_name, field_name)
    if declared == "array":
        item = field["items"]
        inner = PRIMITIVE_TYPESCRIPT_TYPES.get(item, item)
        return f"{inner}[]"
    if declared in PRIMITIVE_TYPESCRIPT_TYPES:
        return PRIMITIVE_TYPESCRIPT_TYPES[declared]
    return declared


def presence_suffix(presence: str) -> tuple[str, str]:
    """Returns (key_suffix, type_suffix) for a field's presence.

    required      key always present, never null
    nullable      key always present, may be null
    optional      key may be absent, not null when present
    optional_null key may be absent and may be null when present
    """
    if presence == "required":
        return "", ""
    if presence == "nullable":
        return "", " | null"
    if presence == "optional":
        return "?", ""
    if presence == "optional_null":
        return "?", " | null"
    raise ValueError(f"unknown presence {presence!r}")


def generate(contract: dict) -> dict[str, str]:
    return {
        "contract-types.ts": _generate_types(contract),
        "contract-client.ts": _generate_client(contract),
    }


def _generate_types(contract: dict) -> str:
    lines: list[str] = list(GENERATED_BANNER_LINES)
    lines.append("")
    lines.append(
        "// Wire types. Every field name is the snake_case wire key verbatim, so a"
    )
    lines.append("// parsed JSON envelope is assignable to these shapes with no renaming.")
    lines.append("")

    # --- error codes -------------------------------------------------------
    error_values = contract["error_codes"]["values"]
    lines.append("/** The closed error code set of contract 1.2. A host emitting")
    lines.append(" *  anything else is defective. Frontend logic branches on this and")
    lines.append(" *  never on WireError.detail. */")
    lines.append("export type WireErrorCode =")
    for value in error_values:
        lines.append(f'  | "{value}";' if value == error_values[-1] else f'  | "{value}"')
    lines.append("")
    lines.append("export const WIRE_ERROR_CODES: readonly WireErrorCode[] = [")
    for value in error_values:
        lines.append(f'  "{value}",')
    lines.append("];")
    lines.append("")
    lines.append("export interface WireError {")
    lines.append("  code: WireErrorCode;")
    lines.append("  /** Native exception text. Display and logs only; never parsed. */")
    lines.append("  detail: string;")
    lines.append("}")
    lines.append("")

    # --- enums extracted from records --------------------------------------
    lines.append("// Inline enums of contract 1.3, one exported union per enum field.")
    lines.append("")
    for record_name, record in contract["types"].items():
        for field_name, field in record["fields"].items():
            if field["type"] != "enum":
                continue
            name = enum_type_name(record_name, field_name)
            values = field["values"]
            lines.append(f"export type {name} =")
            for value in values:
                terminator = ";" if value == values[-1] else ""
                lines.append(f'  | "{value}"{terminator}')
            lines.append("")

    # --- records -----------------------------------------------------------
    for record_name, record in contract["types"].items():
        lines.append(f"export interface {record_name} {{")
        for field_name, field in record["fields"].items():
            if field.get("content") == "opendaq_eval_value_source":
                lines.append(
                    "  /** openDAQ EvalValue source string. Display only; never"
                )
                lines.append("   *  interpreted client-side. */")
            key_suffix, type_suffix = presence_suffix(field["presence"])
            rendered = typescript_type_of(field, record_name, field_name)
            lines.append(f"  {field_name}{key_suffix}: {rendered}{type_suffix};")
        lines.append("}")
        lines.append("")

    # --- capabilities ------------------------------------------------------
    capability_ids = [capability["id"] for capability in contract["capabilities"]]
    lines.append("/** Baseline capability ids of contract 4. A host declares the subset")
    lines.append(" *  it implements; the gap list is this baseline minus that subset. */")
    lines.append("export type CapabilityId =")
    for capability_id in capability_ids:
        terminator = ";" if capability_id == capability_ids[-1] else ""
        lines.append(f'  | "{capability_id}"{terminator}')
    lines.append("")
    lines.append("export const BASELINE_CAPABILITY_IDS: readonly CapabilityId[] = [")
    for capability_id in capability_ids:
        lines.append(f'  "{capability_id}",')
    lines.append("];")
    lines.append("")

    # --- wire method and event names --------------------------------------
    wire_methods = [snake_case_wire_name(op["tokens"]) for op in contract["operations"]]
    lines.append("/** The closed operation table of contract 1.4. A method name outside")
    lines.append(" *  this union must not exist on any host. */")
    lines.append("export type WireMethodName =")
    for method in wire_methods:
        terminator = ";" if method == wire_methods[-1] else ""
        lines.append(f'  | "{method}"{terminator}')
    lines.append("")
    lines.append("export const WIRE_METHOD_NAMES: readonly WireMethodName[] = [")
    for method in wire_methods:
        lines.append(f'  "{method}",')
    lines.append("];")
    lines.append("")

    event_names = [snake_case_wire_name(ev["tokens"]) for ev in contract["events"]["items"]]
    lines.append("/** Server-push events of contract 1.5. Events carry no id field and")
    lines.append(" *  are never correlated to a request. */")
    lines.append("export interface WireEventPayloads {")
    for event in contract["events"]["items"]:
        event_name = snake_case_wire_name(event["tokens"])
        lines.append(f"  {event_name}: {{")
        for payload_field in event["payload"]:
            key_suffix, type_suffix = presence_suffix(payload_field["presence"])
            rendered = PRIMITIVE_TYPESCRIPT_TYPES.get(
                payload_field["type"], payload_field["type"]
            )
            lines.append(
                f"    {payload_field['name']}{key_suffix}: {rendered}{type_suffix};"
            )
        lines.append("  };")
    lines.append("}")
    lines.append("")
    lines.append("export type WireEventName = keyof WireEventPayloads;")
    lines.append("")
    lines.append("export const WIRE_EVENT_NAMES: readonly WireEventName[] = [")
    for event_name in event_names:
        lines.append(f'  "{event_name}",')
    lines.append("];")
    lines.append("")

    # --- envelopes ---------------------------------------------------------
    lines.append("// Wire envelopes of contract 1.7.")
    lines.append("")
    lines.append("export interface WireRequestEnvelope {")
    lines.append("  id: number;")
    lines.append("  method: WireMethodName;")
    lines.append("  params: Record<string, unknown>;")
    lines.append("}")
    lines.append("")
    lines.append("export interface WireResultEnvelope {")
    lines.append("  id: number;")
    lines.append("  result: unknown;")
    lines.append("}")
    lines.append("")
    lines.append("export interface WireErrorEnvelope {")
    lines.append("  id: number;")
    lines.append("  error: WireError;")
    lines.append("}")
    lines.append("")
    lines.append("export interface WireEventEnvelope<K extends WireEventName = WireEventName> {")
    lines.append("  event: K;")
    lines.append("  payload: WireEventPayloads[K];")
    lines.append("}")
    lines.append("")
    lines.append(
        "export type WireServerMessage ="
    )
    lines.append("  | WireResultEnvelope")
    lines.append("  | WireErrorEnvelope")
    lines.append("  | WireEventEnvelope;")
    lines.append("")

    # --- handshake ---------------------------------------------------------
    handshake = contract["handshake"]
    lines.append("/** The first message the server sends, before any request is answered. */")
    lines.append("export interface WireHandshake {")
    lines.append(
        f'  protocol_version: "{handshake["fields"]["protocol_version"]["const"]}";'
    )
    lines.append("  implementation: {")
    lines.append("    /** DISPLAY ONLY. No behavioural branch may read this. */")
    lines.append("    name: string;")
    lines.append("    version: string;")
    lines.append("  };")
    lines.append("  sdk: {")
    lines.append("    version: string;")
    lines.append("    commit: string;")
    lines.append("  };")
    lines.append("  capabilities: CapabilityId[];")
    lines.append("  gaps: Gap[];")
    lines.append("  limits: {")
    lines.append("    max_subscriptions: number;")
    lines.append("    max_frame_bytes: number;")
    lines.append("  };")
    lines.append("}")
    lines.append("")
    limits = handshake["fields"]["limits"]["fields"]
    lines.append("export const HANDSHAKE_LIMIT_DEFAULTS = {")
    lines.append(f'  max_subscriptions: {limits["max_subscriptions"]["default"]},')
    lines.append(f'  max_frame_bytes: {limits["max_frame_bytes"]["default"]},')
    lines.append("} as const;")
    lines.append("")
    lines.append(
        f'export const PROTOCOL_VERSION = "{contract["contract"]["protocol_version"]}";'
    )
    lines.append("")

    # --- binary frames -----------------------------------------------------
    frame = contract["binary_frame"]
    lines.append("// Binary sample frames of contract 1.9. Little-endian, "
                 f"{frame['header_bytes']}-byte header.")
    lines.append("")
    encodings = frame["encodings"]
    lines.append("export type BinaryFrameEncodingName =")
    for encoding in encodings:
        terminator = ";" if encoding is encodings[-1] else ""
        lines.append(f'  | "{encoding["name"]}"{terminator}')
    lines.append("")
    lines.append("export const BINARY_FRAME_ENCODINGS: Readonly<")
    lines.append("  Record<number, BinaryFrameEncodingName>")
    lines.append("> = {")
    for encoding in encodings:
        lines.append(f'  {encoding["value"]}: "{encoding["name"]}",')
    lines.append("};")
    lines.append("")
    lines.append(f"export const BINARY_FRAME_HEADER_BYTES = {frame['header_bytes']};")
    lines.append("")
    lines.append("export interface BinarySampleFrame {")
    for header_field in frame["header"]:
        rendered = PRIMITIVE_TYPESCRIPT_TYPES[header_field["type"]]
        lines.append(
            f"  /** offset {header_field['offset']}, {header_field['size']} bytes, "
            f"{header_field['type']} */"
        )
        if header_field["name"] == "encoding":
            lines.append("  encoding: number;")
            lines.append("  encoding_name: BinaryFrameEncodingName;")
        else:
            lines.append(f"  {header_field['name']}: {rendered};")
    lines.append("  /** float64 payload, copied out of the received buffer because the")
    lines.append(
        f"   *  {frame['payload_offset']}-byte payload offset is not 8-byte aligned. */"
    )
    lines.append("  values: Float64Array;")
    lines.append("}")
    lines.append("")

    return "\n".join(lines) + "\n"


def _client_return_type(returns: dict) -> str:
    declared = returns["type"]
    if declared == "array":
        item = returns["items"]
        inner = PRIMITIVE_TYPESCRIPT_TYPES.get(item, item)
        return f"{inner}[]"
    return PRIMITIVE_TYPESCRIPT_TYPES.get(declared, declared)


def _generate_client(contract: dict) -> str:
    lines: list[str] = list(GENERATED_BANNER_LINES)
    lines.append("")
    lines.append("// The typed transport client. The frontend imports this and")
    lines.append("// contract-types.ts and nothing else; it never learns which host")
    lines.append("// implementation is on the other end of the socket.")
    lines.append("")

    # Only the records the method signatures actually mention are imported;
    # importing an unreferenced one would fail --noUnusedLocals. SignalDescriptor
    # is a record no operation returns, and ComponentTypeInfo is reached only
    # inside ModuleInfo, so neither ever appears here.
    record_names = set(contract["types"].keys())
    referenced_records: set[str] = set()
    for operation in contract["operations"]:
        returns = operation["returns"]
        for candidate in (returns["type"], returns.get("items")):
            if candidate in record_names:
                referenced_records.add(candidate)
        for parameter in operation["params"]:
            if parameter["type"] in record_names:
                referenced_records.add(parameter["type"])

    imported_types = sorted(
        referenced_records
        | {
            "BinaryFrameEncodingName",
            "BinarySampleFrame",
            "WireError",
            "WireErrorEnvelope",
            "WireEventEnvelope",
            "WireEventName",
            "WireEventPayloads",
            "WireHandshake",
            "WireMethodName",
            "WireRequestEnvelope",
            "WireResultEnvelope",
        }
    )
    lines.append("import type {")
    for name in imported_types:
        lines.append(f"  {name},")
    lines.append('} from "./contract-types";')
    lines.append("import {")
    lines.append("  BINARY_FRAME_ENCODINGS,")
    lines.append("  BINARY_FRAME_HEADER_BYTES,")
    lines.append('} from "./contract-types";')
    lines.append("")

    frame = contract["binary_frame"]
    lines.append("/** A wire error that arrived as an error envelope. `code` is the only")
    lines.append(" *  member client logic may branch on. */")
    lines.append("export class WireCallFailed extends Error {")
    lines.append("  readonly code: WireError[\"code\"];")
    lines.append("  readonly detail: string;")
    lines.append("")
    lines.append("  constructor(method: WireMethodName, error: WireError) {")
    lines.append("    super(`${method} failed with ${error.code}: ${error.detail}`);")
    lines.append('    this.name = "WireCallFailed";')
    lines.append("    this.code = error.code;")
    lines.append("    this.detail = error.detail;")
    lines.append("  }")
    lines.append("}")
    lines.append("")

    lines.append("/** Decodes one binary sample frame. Returns null for the two")
    lines.append(
        f" *  drop_frame conditions of contract 1.9: on_unknown_encoding "
        f"({frame['on_unknown_encoding']})"
    )
    lines.append(f" *  and on_truncated_frame ({frame['on_truncated_frame']}). */")
    lines.append(
        "export function decodeBinarySampleFrame(buffer: ArrayBuffer): BinarySampleFrame | null {"
    )
    lines.append("  if (buffer.byteLength < BINARY_FRAME_HEADER_BYTES) {")
    lines.append("    return null;")
    lines.append("  }")
    lines.append("  const view = new DataView(buffer);")
    for header_field in frame["header"]:
        name = header_field["name"]
        offset = header_field["offset"]
        reader = {
            "uint8": f"view.getUint8({offset})",
            "uint32": f"view.getUint32({offset}, true)",
            "uint64": f"view.getBigUint64({offset}, true)",
        }[header_field["type"]]
        lines.append(f"  const {name} = {reader};")
    lines.append("  const encoding_name: BinaryFrameEncodingName | undefined =")
    lines.append("    BINARY_FRAME_ENCODINGS[encoding];")
    lines.append("  if (encoding_name === undefined) {")
    lines.append("    return null;")
    lines.append("  }")
    value_count_by_encoding = {
        encoding["name"]: encoding["payload_value_count"] for encoding in frame["encodings"]
    }
    lines.append("  const value_count =")
    branches = sorted(value_count_by_encoding.items())
    for name, expression in branches[:-1]:
        rendered = expression.replace("sample_count", "sample_count")
        lines.append(f'    encoding_name === "{name}" ? {rendered} :')
    last_name, last_expression = branches[-1]
    lines.append(f"    {last_expression};")
    lines.append(
        f"  const payload_bytes = value_count * {8};  "
        f"// every encoding carries float64 values"
    )
    lines.append(
        f"  if (buffer.byteLength < BINARY_FRAME_HEADER_BYTES + payload_bytes) {{"
    )
    lines.append("    return null;")
    lines.append("  }")
    lines.append("  // The payload offset is not 8-byte aligned, so the bytes are copied")
    lines.append("  // out rather than viewed in place.")
    lines.append("  const values = new Float64Array(value_count);")
    lines.append("  for (let index = 0; index < value_count; index += 1) {")
    lines.append(
        f"    values[index] = view.getFloat64(BINARY_FRAME_HEADER_BYTES + index * 8, true);"
    )
    lines.append("  }")
    lines.append("  return {")
    for header_field in frame["header"]:
        lines.append(f"    {header_field['name']},")
    lines.append("    encoding_name,")
    lines.append("    values,")
    lines.append("  };")
    lines.append("}")
    lines.append("")

    lines.append("type PendingCall = {")
    lines.append("  method: WireMethodName;")
    lines.append("  resolve: (value: unknown) => void;")
    lines.append("  reject: (reason: unknown) => void;")
    lines.append("};")
    lines.append("")
    lines.append("export interface WireSocket {")
    lines.append("  send(payload: string): void;")
    lines.append("  addEventListener(")
    lines.append('    type: "message",')
    lines.append("    listener: (event: { data: unknown }) => void,")
    lines.append("  ): void;")
    lines.append("}")
    lines.append("")

    lines.append("export class QuackoscopeWireClient {")
    lines.append("  private readonly socket: WireSocket;")
    lines.append("  private readonly pending = new Map<number, PendingCall>();")
    lines.append("  private readonly eventListeners = new Map<")
    lines.append("    WireEventName,")
    lines.append("    ((payload: never) => void)[]")
    lines.append("  >();")
    lines.append("  private binaryFrameListener:")
    lines.append("    | ((frame: BinarySampleFrame) => void)")
    lines.append("    | null = null;")
    lines.append("  private handshakeListener: ((handshake: WireHandshake) => void) | null =")
    lines.append("    null;")
    lines.append("  private nextCorrelationId = 1;")
    lines.append("  private handshakeSeen = false;")
    lines.append("")
    lines.append("  constructor(socket: WireSocket) {")
    lines.append("    this.socket = socket;")
    lines.append('    this.socket.addEventListener("message", (event) => {')
    lines.append("      this.receive(event.data);")
    lines.append("    });")
    lines.append("  }")
    lines.append("")
    lines.append("  /** The handshake is the first server-to-client message and arrives")
    lines.append("   *  before any result. */")
    lines.append("  onHandshake(listener: (handshake: WireHandshake) => void): void {")
    lines.append("    this.handshakeListener = listener;")
    lines.append("  }")
    lines.append("")
    lines.append("  onEvent<K extends WireEventName>(")
    lines.append("    event: K,")
    lines.append("    listener: (payload: WireEventPayloads[K]) => void,")
    lines.append("  ): void {")
    lines.append("    const listeners = this.eventListeners.get(event) ?? [];")
    lines.append("    listeners.push(listener as (payload: never) => void);")
    lines.append("    this.eventListeners.set(event, listeners);")
    lines.append("  }")
    lines.append("")
    lines.append("  onBinaryFrame(listener: (frame: BinarySampleFrame) => void): void {")
    lines.append("    this.binaryFrameListener = listener;")
    lines.append("  }")
    lines.append("")

    # --- one method per wire method ---------------------------------------
    for operation in contract["operations"]:
        wire_name = snake_case_wire_name(operation["tokens"])
        return_type = _client_return_type(operation["returns"])
        parameters = []
        for parameter in operation["params"]:
            key_suffix, type_suffix = presence_suffix(parameter["presence"])
            rendered = PRIMITIVE_TYPESCRIPT_TYPES.get(
                parameter["type"], parameter["type"]
            )
            parameters.append(f"{parameter['name']}{key_suffix}: {rendered}{type_suffix}")
        signature_parameters = ", ".join(parameters)
        lines.append(
            f"  /** capability {operation['capability']}, kind {operation['kind']}. "
            f"Errors: {', '.join(operation['errors'])}. */"
        )
        if operation["returns"]["type"] == "binary_frame":
            lines.append("  //")
            lines.append("  // UNSPECIFIED IN contract.yaml: this operation declares")
            lines.append("  // returns: {type: binary_frame}, but envelopes.result carries a")
            lines.append("  // JSON result and binary_frame.header has no correlation id, so")
            lines.append("  // a binary response cannot be matched to its request id. The")
            lines.append("  // generated call follows envelopes.result, the only specified")
            lines.append("  // response path. See the contract-compiler report.")
        lines.append(
            f"  async {wire_name}({signature_parameters}): Promise<{return_type}> {{"
        )
        if operation["params"]:
            lines.append("    const params: Record<string, unknown> = {};")
            for parameter in operation["params"]:
                if parameter["presence"] in ("optional", "optional_null"):
                    lines.append(f"    if ({parameter['name']} !== undefined) {{")
                    lines.append(
                        f"      params[\"{parameter['name']}\"] = {parameter['name']};"
                    )
                    lines.append("    }")
                else:
                    lines.append(
                        f"    params[\"{parameter['name']}\"] = {parameter['name']};"
                    )
        else:
            lines.append("    const params: Record<string, unknown> = {};")
        if return_type == "void":
            lines.append(
                f'    await this.callAndAwaitResult("{wire_name}", params);'
            )
        else:
            lines.append(
                f'    return (await this.callAndAwaitResult("{wire_name}", params)) as {return_type};'
            )
        lines.append("  }")
        lines.append("")

    # --- plumbing ----------------------------------------------------------
    lines.append("  private callAndAwaitResult(")
    lines.append("    method: WireMethodName,")
    lines.append("    params: Record<string, unknown>,")
    lines.append("  ): Promise<unknown> {")
    lines.append("    const id = this.nextCorrelationId;")
    lines.append("    this.nextCorrelationId += 1;")
    lines.append("    const envelope: WireRequestEnvelope = { id, method, params };")
    lines.append("    return new Promise<unknown>((resolve, reject) => {")
    lines.append("      this.pending.set(id, { method, resolve, reject });")
    lines.append("      this.socket.send(JSON.stringify(envelope));")
    lines.append("    });")
    lines.append("  }")
    lines.append("")
    lines.append("  private receive(payload: unknown): void {")
    lines.append("    if (payload instanceof ArrayBuffer) {")
    lines.append("      const frame = decodeBinarySampleFrame(payload);")
    lines.append("      if (frame !== null && this.binaryFrameListener !== null) {")
    lines.append("        this.binaryFrameListener(frame);")
    lines.append("      }")
    lines.append("      return;")
    lines.append("    }")
    lines.append('    if (typeof payload !== "string") {')
    lines.append("      return;")
    lines.append("    }")
    lines.append("    const message = JSON.parse(payload) as Record<string, unknown>;")
    lines.append("    if (!this.handshakeSeen) {")
    lines.append("      this.handshakeSeen = true;")
    lines.append('      if ("protocol_version" in message) {')
    lines.append("        if (this.handshakeListener !== null) {")
    lines.append(
    "          this.handshakeListener(message as unknown as WireHandshake);"
    )
    lines.append("        }")
    lines.append("        return;")
    lines.append("      }")
    lines.append("    }")
    lines.append('    if ("event" in message) {')
    lines.append("      const envelope = message as unknown as WireEventEnvelope;")
    lines.append("      const listeners = this.eventListeners.get(envelope.event) ?? [];")
    lines.append("      for (const listener of listeners) {")
    lines.append("        listener(envelope.payload as never);")
    lines.append("      }")
    lines.append("      return;")
    lines.append("    }")
    lines.append('    const id = message["id"];')
    lines.append('    if (typeof id !== "number") {')
    lines.append("      return;")
    lines.append("    }")
    lines.append("    const call = this.pending.get(id);")
    lines.append("    if (call === undefined) {")
    lines.append("      return;")
    lines.append("    }")
    lines.append("    this.pending.delete(id);")
    lines.append('    if ("error" in message) {')
    lines.append("      const envelope = message as unknown as WireErrorEnvelope;")
    lines.append("      call.reject(new WireCallFailed(call.method, envelope.error));")
    lines.append("      return;")
    lines.append("    }")
    lines.append("    const envelope = message as unknown as WireResultEnvelope;")
    lines.append("    call.resolve(envelope.result);")
    lines.append("  }")
    lines.append("}")
    lines.append("")

    return "\n".join(lines) + "\n"
