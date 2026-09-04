// Builds generated/snippets.json out of the quack-snippet regions marked in the
// host sources, so the inspect panel can show the openDAQ calls behind a control
// without any snippet ever being hand-written.
//
// MARKER SYNTAX (a plain line comment, so it carries over unchanged to the
// Python `#` host and the C#/Rust `//` hosts):
//
//     // quack-snippet capability=<id>[,<id>...] [uses=<name>,...] [step=<n>]
//     ...the SDK calls...
//     // quack-snippet end
//
//     // quack-snippet shared=<name> [uses=<name>,...] [step=<n>]
//     ...the SDK calls...
//     // quack-snippet end
//
// capability= names one or more operation ids from the contract's closed set.
// shared= names a mechanism several operations lean on, written down once.
// uses= pulls shared regions into the emitted snippet, depth first and
// de-duplicated, ahead of the operation's own regions. step= orders the regions
// of one operation when the source file defines them in another order; regions
// sort by (step, line number) with step defaulting to 0.
//
// The emitted snippet's language comes from the source file's extension, so a
// region marked in a .py host source lands under "python" with no extra wiring.
//
// EXIT CODE: 0 only when every operation id the frontend puts in an `op` prop
// resolves to a non-empty, closed, resolvable set of regions. Any failure
// prints the offending id and file and exits 1 without writing the bundle.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Section 1.4 of the contract: the closed set of operation capability ids.
const CONTRACT_CAPABILITY_IDS = [
  "device.scan",
  "device.connect",
  "tree.read",
  "property.read",
  "property.write",
  "function_block.add",
  "streaming.decimated",
  "streaming.raw",
];

// Operation ids the frontend declares that make no openDAQ call at all. They
// are not gaps and not missing snippets, so the bundle carries the reason and
// the inspect panel renders it instead of an empty flock column.
const OPERATIONS_WITH_NO_OPENDAQ_CALL = {
  "session.reconnect": "no openDAQ call - client-side session action",
};

const HOST_SOURCE_ROOT = join(REPOSITORY_ROOT, "hosts");
const FRONTEND_SOURCE_ROOT = join(REPOSITORY_ROOT, "src");
const BUNDLE_PATH = join(REPOSITORY_ROOT, "generated", "snippets.json");

const LANGUAGE_BY_FILE_EXTENSION = {
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".h": "cpp",
  ".cs": "csharp",
  ".py": "python",
  ".rs": "rust",
};

// Build trees carry compiler-probe sources that look exactly like host sources.
const DIRECTORIES_NEVER_SCANNED = new Set(["target", "bin", "obj", "node_modules", "__pycache__", "CMakeFiles", ".git"]);

function isNeverScanned(directoryName) {
  return DIRECTORIES_NEVER_SCANNED.has(directoryName) || directoryName.startsWith("build");
}

const MARKER_LINE = /^[ \t]*(?:\/\/|#|--)[ \t]*quack-snippet\b[ \t]*(.*?)[ \t]*$/;
const MARKER_FIELD = /^(capability|shared|uses|step)=(.+)$/;

const failures = [];

function fail(message) {
  failures.push(message);
}

function repoRelative(absolutePath) {
  return relative(REPOSITORY_ROOT, absolutePath).split("\\").join("/");
}

function listSourceFiles(root, extensions) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!isNeverScanned(entry.name)) pending.push(full);
      } else if (extensions.has(extname(entry.name))) {
        found.push(full);
      }
    }
  }
  return found.sort();
}

// --- reading the marked regions out of the host sources --------------------

function parseMarkerFields(remainder, location) {
  const fields = { capability: [], shared: null, uses: [], step: 0 };
  for (const token of remainder.split(/[ \t]+/).filter(Boolean)) {
    const match = MARKER_FIELD.exec(token);
    if (!match) {
      fail(`${location}: quack-snippet marker holds "${token}", which is not one of capability=, shared=, uses= or step=`);
      continue;
    }
    const [, key, value] = match;
    if (key === "capability") fields.capability = value.split(",").filter(Boolean);
    else if (key === "shared") fields.shared = value;
    else if (key === "uses") fields.uses = value.split(",").filter(Boolean);
    else if (key === "step") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed)) fail(`${location}: quack-snippet step="${value}" is not an integer`);
      else fields.step = parsed;
    }
  }
  return fields;
}

function dedent(bodyLines) {
  let smallestIndent = Infinity;
  for (const line of bodyLines) {
    if (line.trim() === "") continue;
    smallestIndent = Math.min(smallestIndent, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(smallestIndent)) smallestIndent = 0;
  return bodyLines.map((line) => (line.trim() === "" ? "" : line.slice(smallestIndent))).join("\n");
}

function parseRegionsInFile(absolutePath) {
  const shown = repoRelative(absolutePath);
  const language = LANGUAGE_BY_FILE_EXTENSION[extname(absolutePath)];
  const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
  const regions = [];
  let open = null;

  lines.forEach((line, index) => {
    const match = MARKER_LINE.exec(line);
    if (!match) {
      if (open) open.bodyLines.push(line);
      return;
    }
    const remainder = match[1];
    const location = `${shown}:${index + 1}`;

    if (remainder === "end") {
      if (!open) {
        fail(`${location}: "quack-snippet end" closes a region that was never opened`);
        return;
      }
      open.endLine = index + 1;
      open.text = dedent(open.bodyLines);
      open.lineCount = open.bodyLines.length;
      if (open.text.trim() === "") {
        fail(`${open.file}:${open.beginLine}: quack-snippet region for ${open.label} is empty - the marker is there but the openDAQ calls inside it are gone`);
      }
      regions.push(open);
      open = null;
      return;
    }

    if (open) {
      fail(`${location}: a quack-snippet region opens while ${open.label} opened at ${open.file}:${open.beginLine} is still unclosed`);
      return;
    }

    const fields = parseMarkerFields(remainder, location);
    if (fields.shared && fields.capability.length > 0) {
      fail(`${location}: quack-snippet marker names both shared=${fields.shared} and capability=${fields.capability.join(",")}; a region is one or the other`);
      return;
    }
    if (!fields.shared && fields.capability.length === 0) {
      fail(`${location}: quack-snippet marker names neither capability= nor shared=`);
      return;
    }
    for (const id of fields.capability) {
      if (!CONTRACT_CAPABILITY_IDS.includes(id)) {
        fail(`${location}: quack-snippet capability="${id}" is not one of the contract's capability ids (${CONTRACT_CAPABILITY_IDS.join(", ")})`);
      }
    }

    open = {
      file: shown,
      language,
      beginLine: index + 1,
      endLine: 0,
      capability: fields.capability,
      shared: fields.shared,
      uses: fields.uses,
      step: fields.step,
      bodyLines: [],
      text: "",
      lineCount: 0,
      label: fields.shared ? `shared=${fields.shared}` : `capability=${fields.capability.join(",")}`,
    };
  });

  if (open) {
    fail(`${open.file}:${open.beginLine}: quack-snippet region for ${open.label} is never closed - no "quack-snippet end" before the end of the file`);
  }
  return regions;
}

// --- reading the operation ids the frontend puts in `op` props -------------

function readOpPropIds(absolutePath) {
  const source = readFileSync(absolutePath, "utf8");
  const ids = [];
  const opening = /(?<![-\w])op=\{/g;
  let match;
  while ((match = opening.exec(source)) !== null) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    let quote = null;
    while (cursor < source.length && depth > 0) {
      const character = source[cursor];
      if (quote) {
        if (character === "\\") cursor += 1;
        else if (character === quote) quote = null;
      } else if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      cursor += 1;
    }
    // Only the literals inside the array literals count. `op` is written as an
    // array, sometimes chosen by a ternary whose condition carries string
    // literals of its own (node.kind === "signal"), and those are not op ids.
    const expression = source.slice(match.index + match[0].length, cursor - 1);
    let bracketDepth = 0;
    for (const token of expression.matchAll(/\[|\]|["'`][^"'`]*["'`]/g)) {
      if (token[0] === "[") bracketDepth += 1;
      else if (token[0] === "]") bracketDepth -= 1;
      else if (bracketDepth > 0) {
        const id = token[0].slice(1, -1);
        if (id.trim() !== "") ids.push(id);
      }
    }
  }
  return ids;
}

// --- composing one operation's snippet -------------------------------------

function byStepThenLine(a, b) {
  return a.step - b.step || a.beginLine - b.beginLine;
}

function collectRegionsForOperation(operationId, regionsByCapability, regionsBySharedName) {
  const own = (regionsByCapability.get(operationId) ?? []).slice().sort(byStepThenLine);
  const ordered = [];
  const alreadyPulledIn = new Set();

  function pullInShared(name, requestedBy, chain) {
    if (chain.includes(name)) {
      fail(`${requestedBy}: quack-snippet uses=${name} closes a cycle (${[...chain, name].join(" -> ")})`);
      return;
    }
    if (alreadyPulledIn.has(name)) return;
    const sharedRegions = regionsBySharedName.get(name);
    if (!sharedRegions) {
      fail(`${requestedBy}: quack-snippet uses=${name}, but no region declares shared=${name} in any host source`);
      alreadyPulledIn.add(name);
      return;
    }
    alreadyPulledIn.add(name);
    for (const region of sharedRegions.slice().sort(byStepThenLine)) {
      for (const nested of region.uses) {
        pullInShared(nested, `${region.file}:${region.beginLine}`, [...chain, name]);
      }
    }
    for (const region of sharedRegions.slice().sort(byStepThenLine)) ordered.push(region);
  }

  for (const region of own) {
    for (const name of region.uses) {
      pullInShared(name, `${region.file}:${region.beginLine}`, []);
    }
  }
  return [...ordered, ...own];
}

// --- the extraction itself --------------------------------------------------

console.log("extract-opendaq-snippets-from-host-sources");
console.log(`repository root:  ${REPOSITORY_ROOT}`);
console.log(`host sources:     ${HOST_SOURCE_ROOT}`);
console.log(`frontend sources: ${FRONTEND_SOURCE_ROOT}`);
console.log(`bundle written to: ${BUNDLE_PATH}`);
console.log("");

const hostSourceFiles = listSourceFiles(HOST_SOURCE_ROOT, new Set(Object.keys(LANGUAGE_BY_FILE_EXTENSION)));
console.log(`reading ${hostSourceFiles.length} host source files for quack-snippet markers:`);

const allRegions = [];
for (const file of hostSourceFiles) {
  const regions = parseRegionsInFile(file);
  allRegions.push(...regions);
  const lineTotal = readFileSync(file, "utf8").split(/\r?\n/).length;
  console.log(
    `  ${repoRelative(file).padEnd(46)} language ${LANGUAGE_BY_FILE_EXTENSION[extname(file)].padEnd(7)} ${String(lineTotal).padStart(4)} lines  ${String(regions.length).padStart(2)} regions`,
  );
}
console.log(`  -> ${allRegions.length} quack-snippet regions parsed`);
console.log("");

const regionsByCapability = new Map();
const regionsBySharedName = new Map();
for (const region of allRegions) {
  if (region.shared) {
    if (!regionsBySharedName.has(region.shared)) regionsBySharedName.set(region.shared, []);
    regionsBySharedName.get(region.shared).push(region);
  }
  for (const id of region.capability) {
    if (!regionsByCapability.has(id)) regionsByCapability.set(id, []);
    regionsByCapability.get(id).push(region);
  }
}

console.log(`${regionsBySharedName.size} shared regions declared:`);
for (const [name, regions] of [...regionsBySharedName].sort()) {
  for (const region of regions) {
    const uses = region.uses.length > 0 ? `uses ${region.uses.join(", ")}` : "uses nothing";
    console.log(`  ${name.padEnd(34)} ${`${region.file}:${region.beginLine}`.padEnd(48)} ${String(region.lineCount).padStart(3)} lines  ${uses}`);
  }
}
console.log("");

const frontendFiles = listSourceFiles(FRONTEND_SOURCE_ROOT, new Set([".tsx", ".ts"]));
const filesByOperationId = new Map();
console.log(`reading ${frontendFiles.length} frontend source files for op props:`);
for (const file of frontendFiles) {
  const ids = readOpPropIds(file);
  if (ids.length === 0) continue;
  console.log(`  ${repoRelative(file).padEnd(46)} op ids: ${[...new Set(ids)].sort().join(", ")}`);
  for (const id of ids) {
    if (!filesByOperationId.has(id)) filesByOperationId.set(id, new Set());
    filesByOperationId.get(id).add(repoRelative(file));
  }
}
const frontendOperationIds = [...filesByOperationId.keys()].sort();
console.log(`  -> ${frontendOperationIds.length} distinct operation ids used by the frontend: ${frontendOperationIds.join(", ")}`);
console.log("");

// Every operation id the frontend declares must resolve to something: regions,
// or an explicit "makes no openDAQ call" entry. Anything else is the deleted or
// never-written marker this script exists to catch.
for (const id of frontendOperationIds) {
  if (id in OPERATIONS_WITH_NO_OPENDAQ_CALL) continue;
  const where = [...filesByOperationId.get(id)].sort().join(", ");
  if (!CONTRACT_CAPABILITY_IDS.includes(id)) {
    fail(`operation id "${id}", used in ${where}, is not one of the contract's capability ids (${CONTRACT_CAPABILITY_IDS.join(", ")}) and no host source declares a region for it`);
  } else if (!regionsByCapability.has(id)) {
    fail(`capability id "${id}", used in ${where}, has no quack-snippet region in any host source under ${repoRelative(HOST_SOURCE_ROOT)}`);
  }
}

const emittedCapabilityIds = [...new Set([...regionsByCapability.keys()])].sort();
const bundle = {};

console.log(`composing snippets for ${emittedCapabilityIds.length} capability ids that have regions:`);
for (const id of emittedCapabilityIds) {
  const regions = collectRegionsForOperation(id, regionsByCapability, regionsBySharedName);
  const languages = [...new Set(regions.map((r) => r.language))];
  for (const language of languages) {
    const forLanguage = regions.filter((r) => r.language === language);
    const snippet = forLanguage.map((r) => r.text).join("\n\n");
    bundle[id] = { ...(bundle[id] ?? {}), [language]: snippet };
    console.log(`  ${id.padEnd(22)} ${language.padEnd(7)} ${String(snippet.split("\n").length).padStart(3)} lines from ${forLanguage.length} regions:`);
    for (const region of forLanguage) {
      const origin = region.shared ? `shared ${region.shared}` : `own step=${region.step}`;
      console.log(`      ${origin.padEnd(40)} ${`${region.file}:${region.beginLine}-${region.endLine}`.padEnd(48)} ${String(region.lineCount).padStart(3)} lines`);
    }
  }
}
for (const [id, reason] of Object.entries(OPERATIONS_WITH_NO_OPENDAQ_CALL)) {
  if (!filesByOperationId.has(id)) continue;
  bundle[id] = { no_opendaq_call: reason };
  console.log(`  ${id.padEnd(22)} ${"-".padEnd(7)} ${reason}`);
}
console.log("");

const sharedNamesReached = new Set();
for (const id of emittedCapabilityIds) {
  for (const region of collectRegionsForOperation(id, regionsByCapability, regionsBySharedName)) {
    if (region.shared) sharedNamesReached.add(region.shared);
  }
}
const sharedNamesNotReached = [...regionsBySharedName.keys()].filter((n) => !sharedNamesReached.has(n)).sort();
if (sharedNamesNotReached.length > 0) {
  console.log(`shared regions no capability id reaches, so nothing carries them into the bundle: ${sharedNamesNotReached.join(", ")}`);
}
const capabilityIdsWithoutRegions = CONTRACT_CAPABILITY_IDS.filter((id) => !regionsByCapability.has(id));
if (capabilityIdsWithoutRegions.length > 0) {
  console.log(`contract capability ids no host source implements yet, absent from the bundle: ${capabilityIdsWithoutRegions.join(", ")}`);
}
console.log("");

const distinctFailures = [...new Set(failures)];
if (distinctFailures.length > 0) {
  console.error(`${distinctFailures.length} quack-snippet failures; ${BUNDLE_PATH} was NOT written and still holds whatever it held before:`);
  for (const message of distinctFailures) console.error(`  ${message}`);
  process.exit(1);
}

mkdirSync(dirname(BUNDLE_PATH), { recursive: true });
const sortedBundle = {};
for (const id of Object.keys(bundle).sort()) sortedBundle[id] = bundle[id];
const serialised = `${JSON.stringify(sortedBundle, null, 2)}\n`;
writeFileSync(BUNDLE_PATH, serialised, "utf8");
console.log(
  `wrote ${BUNDLE_PATH}: ${Object.keys(bundle).length} keys (${Object.keys(bundle).sort().join(", ")}), ${statSync(BUNDLE_PATH).size} bytes`,
);
