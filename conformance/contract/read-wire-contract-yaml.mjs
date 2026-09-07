// Reads contract/contract.yaml and hands back the parts of the wire contract the
// conformance sweeps assert against.
//
// contract/contract.yaml is the single source of truth. This module parses it
// directly rather than reading generated/wire/capability-baseline.json, so a
// generator that drifts from the contract cannot make a nonconformant host look
// conformant. Nothing in conformance/ hand-writes a capability id, a wire method
// name, an error code or a handshake field name: every one of them is read out
// of the YAML at run time.
//
// The parser below covers the YAML subset contract.yaml actually uses:
// block mappings, block sequences, flow mappings, flow sequences, folded block
// scalars (">-"), quoted and plain scalars, and "#" comments. It is deliberately
// not a general YAML implementation; it refuses, loudly and with the offending
// line number and line text, anything it does not understand.

import { readFileSync } from "node:fs";

// --------------------------------------------------------------------------
// scalar parsing
// --------------------------------------------------------------------------

function parseScalarText(text, lineNumber, lineText) {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'") {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    const [value, consumed] = parseFlowCollection(trimmed, 0, lineNumber, lineText);
    const rest = trimmed.slice(consumed).trim();
    if (rest !== "") {
      throw new Error(
        `contract.yaml line ${lineNumber}: trailing text ${JSON.stringify(rest)} after a flow collection.\n  line: ${lineText}`,
      );
    }
    return value;
  }
  return trimmed;
}

/** Parses a flow collection starting at text[start], which must be "{" or "[". */
function parseFlowCollection(text, start, lineNumber, lineText) {
  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";
  const isMapping = opener === "{";
  const container = isMapping ? {} : [];
  let i = start + 1;

  for (;;) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (i >= text.length) {
      throw new Error(
        `contract.yaml line ${lineNumber}: flow collection opened with "${opener}" is never closed with "${closer}".\n  line: ${lineText}`,
      );
    }
    if (text[i] === closer) return [container, i + 1 - start];

    if (isMapping) {
      const keyStart = i;
      while (i < text.length && text[i] !== ":") i++;
      if (i >= text.length) {
        throw new Error(
          `contract.yaml line ${lineNumber}: flow mapping entry starting at column ${keyStart} has no ":".\n  line: ${lineText}`,
        );
      }
      const key = text.slice(keyStart, i).trim();
      i++; // the ":"
      while (i < text.length && text[i] === " ") i++;
      const [value, consumed] = parseFlowValue(text, i, closer, lineNumber, lineText);
      container[key] = value;
      i += consumed;
    } else {
      const [value, consumed] = parseFlowValue(text, i, closer, lineNumber, lineText);
      container.push(value);
      i += consumed;
    }
  }
}

function parseFlowValue(text, start, closer, lineNumber, lineText) {
  if (text[start] === "{" || text[start] === "[") {
    return parseFlowCollection(text, start, lineNumber, lineText);
  }
  if (text[start] === '"' || text[start] === "'") {
    const quote = text[start];
    let i = start + 1;
    while (i < text.length && text[i] !== quote) i++;
    return [text.slice(start + 1, i), i + 1 - start];
  }
  let i = start;
  while (i < text.length && text[i] !== "," && text[i] !== closer && text[i] !== "}" && text[i] !== "]") i++;
  const raw = text.slice(start, i);
  return [parseScalarText(raw, lineNumber, lineText), i - start];
}

/** Strips a "#" comment that is not inside a quoted scalar or a flow collection. */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

// --------------------------------------------------------------------------
// block parsing
// --------------------------------------------------------------------------

function readSourceLines(yamlText) {
  const lines = [];
  yamlText.split(/\r?\n/).forEach((rawLine, index) => {
    const withoutComment = stripComment(rawLine);
    if (withoutComment.trim() === "") return;
    lines.push({
      indent: withoutComment.length - withoutComment.trimStart().length,
      text: withoutComment.trimEnd(),
      content: withoutComment.trim(),
      lineNumber: index + 1,
      rawLine,
    });
  });
  return lines;
}

function parseBlock(lines, cursor, blockIndent) {
  if (cursor.at >= lines.length) return null;
  return lines[cursor.at].content.startsWith("- ") || lines[cursor.at].content === "-"
    ? parseBlockSequence(lines, cursor, blockIndent)
    : parseBlockMapping(lines, cursor, blockIndent);
}

function parseBlockSequence(lines, cursor, blockIndent) {
  const sequence = [];
  while (cursor.at < lines.length) {
    const line = lines[cursor.at];
    if (line.indent < blockIndent) break;
    if (line.indent > blockIndent) {
      throw new Error(
        `contract.yaml line ${line.lineNumber}: expected a sequence entry at indent ${blockIndent}, found indent ${line.indent}.\n  line: ${line.rawLine}`,
      );
    }
    if (!line.content.startsWith("-")) break;

    const afterDash = line.content.slice(1).trim();
    const entryIndent = blockIndent + (line.content.length - line.content.slice(1).trimStart().length);
    cursor.at++;

    if (afterDash === "") {
      sequence.push(parseBlock(lines, cursor, indentOfNext(lines, cursor, blockIndent)));
      continue;
    }
    if (afterDash.startsWith("{") || afterDash.startsWith("[")) {
      sequence.push(parseScalarText(afterDash, line.lineNumber, line.rawLine));
      continue;
    }
    const colon = findMappingColon(afterDash);
    if (colon === -1) {
      sequence.push(parseScalarText(afterDash, line.lineNumber, line.rawLine));
      continue;
    }
    // An inline "- key: value" opens a mapping whose remaining keys are indented
    // to the column the key itself starts at.
    const mapping = {};
    consumeMappingEntry(mapping, afterDash, colon, lines, cursor, entryIndent, line);
    while (cursor.at < lines.length && lines[cursor.at].indent === entryIndent && !lines[cursor.at].content.startsWith("- ")) {
      const nextLine = lines[cursor.at];
      const nextColon = findMappingColon(nextLine.content);
      if (nextColon === -1) break;
      cursor.at++;
      consumeMappingEntry(mapping, nextLine.content, nextColon, lines, cursor, entryIndent, nextLine);
    }
    sequence.push(mapping);
  }
  return sequence;
}

function indentOfNext(lines, cursor, minimumIndent) {
  if (cursor.at >= lines.length) return minimumIndent + 2;
  return lines[cursor.at].indent;
}

function findMappingColon(content) {
  let inSingle = false;
  let inDouble = false;
  let flowDepth = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === "{" || c === "[") flowDepth++;
      else if (c === "}" || c === "]") flowDepth--;
      else if (c === ":" && flowDepth === 0 && (i + 1 === content.length || content[i + 1] === " ")) return i;
    }
  }
  return -1;
}

function consumeMappingEntry(mapping, content, colon, lines, cursor, keyIndent, line) {
  const key = content.slice(0, colon).trim().replace(/^["']|["']$/g, "");
  const inlineValue = content.slice(colon + 1).trim();

  if (inlineValue === ">-" || inlineValue === ">" || inlineValue === "|" || inlineValue === "|-") {
    mapping[key] = readFoldedScalar(lines, cursor, keyIndent, inlineValue);
    return;
  }
  if (inlineValue !== "") {
    mapping[key] = parseScalarText(inlineValue, line.lineNumber, line.rawLine);
    return;
  }
  if (cursor.at < lines.length && lines[cursor.at].indent > keyIndent) {
    mapping[key] = parseBlock(lines, cursor, lines[cursor.at].indent);
    return;
  }
  if (cursor.at < lines.length && lines[cursor.at].indent === keyIndent && lines[cursor.at].content.startsWith("- ")) {
    mapping[key] = parseBlockSequence(lines, cursor, keyIndent);
    return;
  }
  mapping[key] = null;
}

function readFoldedScalar(lines, cursor, keyIndent, style) {
  const pieces = [];
  while (cursor.at < lines.length && lines[cursor.at].indent > keyIndent) {
    pieces.push(lines[cursor.at].content);
    cursor.at++;
  }
  return style.startsWith("|") ? pieces.join("\n") : pieces.join(" ");
}

function parseBlockMapping(lines, cursor, blockIndent) {
  const mapping = {};
  while (cursor.at < lines.length) {
    const line = lines[cursor.at];
    if (line.indent < blockIndent) break;
    if (line.indent > blockIndent) {
      throw new Error(
        `contract.yaml line ${line.lineNumber}: expected a mapping key at indent ${blockIndent}, found indent ${line.indent}.\n  line: ${line.rawLine}`,
      );
    }
    if (line.content.startsWith("- ")) break;
    const colon = findMappingColon(line.content);
    if (colon === -1) {
      throw new Error(
        `contract.yaml line ${line.lineNumber}: mapping line has no ":" this parser can find.\n  line: ${line.rawLine}`,
      );
    }
    cursor.at++;
    consumeMappingEntry(mapping, line.content, colon, lines, cursor, blockIndent, line);
  }
  return mapping;
}

export function parseContractYaml(yamlText) {
  const lines = readSourceLines(yamlText);
  const cursor = { at: 0 };
  const document = parseBlockMapping(lines, cursor, 0);
  if (cursor.at !== lines.length) {
    const line = lines[cursor.at];
    throw new Error(
      `contract.yaml line ${line.lineNumber}: parsing stopped here with ${lines.length - cursor.at} line(s) unread.\n  line: ${line.rawLine}`,
    );
  }
  return document;
}

// --------------------------------------------------------------------------
// the shaped view the sweeps use
// --------------------------------------------------------------------------

function joinTokensSnakeCase(tokens) {
  return tokens.join("_");
}

function demandKey(document, path) {
  let node = document;
  for (const segment of path) {
    if (node === null || typeof node !== "object" || !(segment in node)) {
      throw new Error(`contract.yaml does not contain ${path.join(".")}; conformance/ cannot proceed without it`);
    }
    node = node[segment];
  }
  return node;
}

/**
 * Reads contract/contract.yaml and returns the shaped view the sweeps assert
 * against. Every list in the returned object comes out of the file; none of it
 * is written down in conformance/.
 */
export function readWireContract(contractYamlPath) {
  const yamlText = readFileSync(contractYamlPath, "utf8");
  const document = parseContractYaml(yamlText);

  const capabilityRows = demandKey(document, ["capabilities"]);
  const operationRows = demandKey(document, ["operations"]);
  const eventRows = demandKey(document, ["events", "items"]);

  const operations = operationRows.map((row) => ({
    wireMethod: joinTokensSnakeCase(row.tokens),
    tokens: row.tokens,
    kind: row.kind,
    capability: row.capability,
    params: row.params ?? [],
    returns: row.returns,
    errors: row.errors ?? [],
  }));

  const capabilities = capabilityRows.map((row) => ({
    id: row.id,
    wireMethods: row.operations.map(joinTokensSnakeCase),
  }));

  const operationsByWireMethod = new Map(operations.map((operation) => [operation.wireMethod, operation]));
  const capabilityIds = capabilities.map((capability) => capability.id);

  // The two views of the capability/operation mapping must agree; contract.yaml
  // lints.capability_operation_lists_agree says so, and if they disagree the
  // conformance verdicts would be computed against the wrong side.
  for (const capability of capabilities) {
    for (const wireMethod of capability.wireMethods) {
      const operation = operationsByWireMethod.get(wireMethod);
      if (!operation) {
        throw new Error(
          `contract.yaml capability "${capability.id}" lists wire method "${wireMethod}", which is not in the operations table`,
        );
      }
      if (operation.capability !== capability.id) {
        throw new Error(
          `contract.yaml disagrees with itself: capability "${capability.id}" claims "${wireMethod}", but that operation declares capability "${operation.capability}"`,
        );
      }
    }
  }
  for (const operation of operations) {
    if (!capabilityIds.includes(operation.capability)) {
      throw new Error(
        `contract.yaml operation "${operation.wireMethod}" declares capability "${operation.capability}", which is not one of ${capabilityIds.join(", ")}`,
      );
    }
  }

  const errorCodes = demandKey(document, ["error_codes", "values"]);
  for (const operation of operations) {
    for (const code of operation.errors) {
      if (!errorCodes.includes(code)) {
        throw new Error(
          `contract.yaml operation "${operation.wireMethod}" declares error code "${code}", which is not in the closed set ${errorCodes.join(", ")}`,
        );
      }
    }
  }

  return {
    contractName: demandKey(document, ["contract", "name"]),
    protocolVersion: String(demandKey(document, ["contract", "protocol_version"])),
    capabilityBaselineIds: capabilityIds,
    capabilities,
    operations,
    operationsByWireMethod,
    errorCodesClosed: demandKey(document, ["error_codes", "closed"]) === true,
    errorCodes,
    errorShapeFields: Object.keys(demandKey(document, ["error_shape", "fields"])),
    types: demandKey(document, ["types"]),
    events: eventRows.map((row) => ({
      eventName: joinTokensSnakeCase(row.tokens),
      payload: row.payload,
    })),
    eventsCarryIdField: demandKey(document, ["events", "carries_id_field"]) === true,
    handshake: demandKey(document, ["handshake"]),
    gapKinds: Object.keys(demandKey(document, ["gap_generation", "kinds"])),
    gapComputedAs: demandKey(document, ["gap_generation", "computed_as"]),
    hostMayDeclareGapList: demandKey(document, ["gap_generation", "host_may_declare_gap_list"]) === true,
    implementationNames: demandKey(document, ["implementation_names", "values"]),
    implementationNameDisplayOnly: demandKey(document, ["implementation_names", "display_only"]) === true,
    binaryFrame: demandKey(document, ["binary_frame"]),
    envelopes: demandKey(document, ["envelopes"]),
    subscriptionIdEncoding: demandKey(document, ["subscription_id_encoding"]),
    rawDocument: document,
  };
}
