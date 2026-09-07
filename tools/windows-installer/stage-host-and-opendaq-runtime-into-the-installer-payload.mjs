// Builds the payload that the Windows installer ships alongside the Tauri shell,
// so that a machine which has never seen openDAQ can run quackoscope.
//
// It writes src-tauri/bundled-host-and-opendaq-runtime/, which tauri.conf.json
// declares as a bundle resource. The installed layout is:
//
//   <install dir>\quackoscope.exe                       the Tauri shell
//   <install dir>\host-and-opendaq-runtime\
//       quackoscope-host-cpp.exe                        the host the shell spawns
//       manifest.json                                   module_path "modules", app relative
//       opendaq-64-3.dll daqcoreobjects-64-3.dll        openDAQ runtime, loader dependencies
//       daqcoretypes-64-3.dll                           of the host executable
//       msvcp140.dll vcruntime140.dll vcruntime140_1.dll the MSVC C++ runtime the host and the
//                                                       openDAQ DLLs import by name
//       modules\ref_device_module-64-3.module.dll       daqref:// devices
//       modules\ref_fb_module-64-3.module.dll           the function block types the UI can add
//       dist\                                           the SPA the host serves on 127.0.0.1:7788
//       openDAQ-LICENSE.txt openDAQ-NOTICE.txt          Apache-2.0 attribution for the DLLs above
//
// The module set is deliberately two of the fourteen *.module.dll files in the
// openDAQ build tree. Which two is not guesswork: run
//   node tools/windows-installer/connect-daqref-device0-and-plot-a-signal-through-a-running-host.mjs
// against the staged payload and it prints the modules the host actually loaded,
// the devices daqref offered, the samples that streamed and the function block
// types that became addable.
//
// The manifest this script writes carries the SAME commit and sdk_version as the
// repository manifest, and the script refuses to write it unless the openDAQ DLLs
// it just copied report that version in their own Win32 version resource. The
// shipped manifest therefore describes the binaries that are actually in the box.
//
//   node tools/windows-installer/stage-host-and-opendaq-runtime-into-the-installer-payload.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const payloadDirectory = resolve(repositoryRoot, "src-tauri", "bundled-host-and-opendaq-runtime");

const HOST_EXECUTABLE_NAME = "quackoscope-host-cpp.exe";
const OPENDAQ_RUNTIME_DLLS = ["opendaq-64-3.dll", "daqcoreobjects-64-3.dll", "daqcoretypes-64-3.dll"];
const OPENDAQ_MODULE_DLLS = [
  { file: "ref_device_module-64-3.module.dll", why: "provides the daqref:// device type the app connects to" },
  { file: "ref_fb_module-64-3.module.dll", why: "provides the twelve function block types the UI can add" },
];
const MSVC_RUNTIME_DLLS = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

function fail(message) {
  console.error(`stage-host-and-opendaq-runtime-into-the-installer-payload: ${message}`);
  process.exit(1);
}

function megabytes(byteCount) {
  return `${(byteCount / (1024 * 1024)).toFixed(2)} MB`;
}

function totalBytesUnder(directory) {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? totalBytesUnder(path) : statSync(path).size;
  }
  return total;
}

// Spawned by absolute path, not as the bare name "powershell.exe", so that a
// scrubbed PATH cannot turn "which version are these DLLs" into a spawn ENOENT.
const WINDOWS_POWERSHELL_ABSOLUTE_PATH = join(
  process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

/** The FileVersion recorded in a Windows binary's own version resource. */
function fileVersionOf(path) {
  if (!existsSync(WINDOWS_POWERSHELL_ABSOLUTE_PATH))
    fail(
      `${WINDOWS_POWERSHELL_ABSOLUTE_PATH} does not exist, so the FileVersion of ${path} cannot be read and this ` +
        `script cannot prove the bundled DLLs are the version the manifest claims. SystemRoot is ` +
        `${process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "(unset)"}.`,
    );
  const stdout = execFileSync(
    WINDOWS_POWERSHELL_ABSOLUTE_PATH,
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${path}').VersionInfo.FileVersion`],
    { encoding: "utf8" },
  );
  return stdout.trim();
}

/** The newest Microsoft.VC*.CRT redistributable directory installed by Visual Studio. */
function newestVisualStudioCppRuntimeDirectory() {
  const visualStudioRoots = [
    "C:/Program Files/Microsoft Visual Studio/18/Community",
    "C:/Program Files/Microsoft Visual Studio/18/Professional",
    "C:/Program Files/Microsoft Visual Studio/18/Enterprise",
    "C:/Program Files/Microsoft Visual Studio/2022/Community",
    "C:/Program Files/Microsoft Visual Studio/2022/Professional",
    "C:/Program Files/Microsoft Visual Studio/2022/Enterprise",
  ];
  const candidates = [];
  for (const root of visualStudioRoots) {
    const redistRoot = join(root, "VC", "Redist", "MSVC");
    if (!existsSync(redistRoot)) continue;
    for (const version of readdirSync(redistRoot)) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
      for (const crtDirectory of readdirSync(join(redistRoot, version, "x64"), { withFileTypes: true })) {
        if (!crtDirectory.isDirectory() || !/^Microsoft\.VC\d+\.CRT$/.test(crtDirectory.name)) continue;
        candidates.push({ version, path: join(redistRoot, version, "x64", crtDirectory.name) });
      }
    }
  }
  if (candidates.length === 0)
    fail(
      `no Microsoft.VC*.CRT redistributable directory under any of:\n  ${visualStudioRoots.join("\n  ")}\n` +
        `The host and the openDAQ DLLs import MSVCP140.dll and VCRUNTIME140.dll by name, so a machine ` +
        `without the Visual C++ redistributable needs them in the box.`,
    );
  candidates.sort((a, b) =>
    a.version.localeCompare(b.version, undefined, { numeric: true, sensitivity: "base" }),
  );
  return candidates[candidates.length - 1].path;
}

function copyFileIntoPayload(sourcePath, destinationPath, note) {
  if (!existsSync(sourcePath)) fail(`missing input file: ${sourcePath}  (${note})`);
  mkdirSync(dirname(destinationPath), { recursive: true });
  cpSync(sourcePath, destinationPath);
  const size = statSync(destinationPath).size;
  console.log(`  ${basename(destinationPath).padEnd(38)} ${megabytes(size).padStart(9)}  <- ${sourcePath}`);
  return size;
}

// --- 1. what the repository manifest says the SDK is ------------------------

const repositoryManifestPath = join(repositoryRoot, "manifest.json");
if (!existsSync(repositoryManifestPath))
  fail(
    `no manifest at ${repositoryManifestPath}. Generate it with:\n` +
      `  python tools/sdk-build/resolve_sdk.py <commit>`,
  );
const repositoryManifest = JSON.parse(readFileSync(repositoryManifestPath, "utf8"));

console.log(`reading manifest: ${repositoryManifestPath}`);
console.log(`  commit      = ${repositoryManifest.commit}`);
console.log(`  sdk_version = ${repositoryManifest.sdk_version}`);
console.log(`  module_path = ${repositoryManifest.module_path}`);
console.log(`  log_level   = ${repositoryManifest.log_level}`);

const openDaqBinaryDirectory = resolve(repositoryManifest.module_path);
if (!existsSync(openDaqBinaryDirectory))
  fail(`manifest module_path ${openDaqBinaryDirectory} does not exist, so there is nothing to bundle`);

const hostExecutableSource = join(repositoryRoot, "hosts", "cpp", "build", "Release", HOST_EXECUTABLE_NAME);
if (!existsSync(hostExecutableSource))
  fail(
    `no host executable at ${hostExecutableSource}. Build it with:\n` +
      `  cmake --build hosts/cpp/build --config Release`,
  );

const spaDistributionDirectory = join(repositoryRoot, "dist");
if (!existsSync(join(spaDistributionDirectory, "index.html")))
  fail(
    `no built SPA at ${join(spaDistributionDirectory, "index.html")}. Build it with:\n  pnpm build`,
  );

// This script is tauri.conf.json's beforeBuildCommand, and it does NOT run
// `pnpm build` -- it copies whatever dist/ already holds. So it says out loud
// when dist/ is older than the sources vite compiles into it.
function newestModificationTimeUnder(directory) {
  let newest = { path: null, milliseconds: 0 };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const deeper = newestModificationTimeUnder(path);
      if (deeper.milliseconds > newest.milliseconds) newest = deeper;
    } else {
      const milliseconds = statSync(path).mtimeMs;
      if (milliseconds > newest.milliseconds) newest = { path, milliseconds };
    }
  }
  return newest;
}
const newestBuiltFile = newestModificationTimeUnder(spaDistributionDirectory);
const newestSourceFile = newestModificationTimeUnder(join(repositoryRoot, "src"));
console.log(`  newest file in dist: ${newestBuiltFile.path}  ${new Date(newestBuiltFile.milliseconds).toISOString()}`);
console.log(`  newest file in src : ${newestSourceFile.path}  ${new Date(newestSourceFile.milliseconds).toISOString()}`);
if (newestSourceFile.milliseconds > newestBuiltFile.milliseconds) {
  console.log(
    `  src is NEWER than dist by ${Math.round((newestSourceFile.milliseconds - newestBuiltFile.milliseconds) / 1000)} s, ` +
      `so the SPA about to be bundled predates the sources. Run "pnpm build" and stage again if that is not what you want.`,
  );
} else {
  console.log(`  dist is at least as new as src, so the SPA about to be bundled is built from these sources`);
}

// --- 2. lay the payload out fresh -------------------------------------------

console.log("");
console.log(`staging the installer payload into: ${payloadDirectory}`);
rmSync(payloadDirectory, { recursive: true, force: true });
mkdirSync(join(payloadDirectory, "modules"), { recursive: true });

console.log("host executable:");
copyFileIntoPayload(hostExecutableSource, join(payloadDirectory, HOST_EXECUTABLE_NAME), "the host the shell spawns");

console.log(`openDAQ runtime DLLs the host imports by name, from ${openDaqBinaryDirectory}:`);
const copiedOpenDaqRuntimeDlls = [];
for (const dll of OPENDAQ_RUNTIME_DLLS) {
  copyFileIntoPayload(join(openDaqBinaryDirectory, dll), join(payloadDirectory, dll), "openDAQ runtime");
  copiedOpenDaqRuntimeDlls.push(join(payloadDirectory, dll));
}

console.log(`openDAQ module DLLs, ${OPENDAQ_MODULE_DLLS.length} of the ${readdirSync(openDaqBinaryDirectory).filter((n) => n.endsWith(".module.dll")).length} in ${openDaqBinaryDirectory}:`);
for (const { file, why } of OPENDAQ_MODULE_DLLS) {
  copyFileIntoPayload(join(openDaqBinaryDirectory, file), join(payloadDirectory, "modules", file), why);
  console.log(`  ${" ".repeat(38)}           ${why}`);
}

const cppRuntimeDirectory = newestVisualStudioCppRuntimeDirectory();
console.log(`MSVC C++ runtime DLLs, from ${cppRuntimeDirectory}:`);
for (const dll of MSVC_RUNTIME_DLLS) {
  copyFileIntoPayload(join(cppRuntimeDirectory, dll), join(payloadDirectory, dll), "MSVC C++ runtime");
}

console.log(`SPA the host serves, from ${spaDistributionDirectory}:`);
cpSync(spaDistributionDirectory, join(payloadDirectory, "dist"), { recursive: true });
console.log(`  dist${" ".repeat(34)} ${megabytes(totalBytesUnder(join(payloadDirectory, "dist"))).padStart(9)}  <- ${spaDistributionDirectory}`);

// --- 2b. attribution for EVERYTHING inside the bundled binaries -------------
//
// Not just openDAQ. The five openDAQ binaries and quackoscope-host-cpp.exe carry
// third-party code compiled INTO them: modules/ref_fb_module-64-3.module.dll
// statically links kissfft (BSD-3-Clause) and SFML 3.0.2 with FreeType, and both
// of those licences require a credit line in a binary redistribution's
// documentation. A NOTICE that names only openDAQ under Apache-2.0 leaves this
// installer redistributing code it does not credit.
//
// tools/windows-installer/third-party-code-linked-into-the-bundled-binaries.json
// is the inventory: what is in the box, under which licence, and the exact file
// the SPDX identifier or licence text was read from. This section reads it,
// copies every licence text into the payload, and writes openDAQ-NOTICE.txt from
// it. checkEveryLinkerInputIsAttributed() below then re-reads the openDAQ build
// tree's own linker logs and refuses to ship a binary that consumed a library
// nothing in the inventory claims.
const openDaqCheckoutRoot = resolve(openDaqBinaryDirectory, "..", "..", "..", "..", "..", "..");
const openDaqBuildRoot = resolve(openDaqBinaryDirectory, "..", "..");
const licenceRoots = { opendaq_source: openDaqCheckoutRoot, opendaq_build: openDaqBuildRoot };

const licenceInventoryPath = join(
  repositoryRoot,
  "tools",
  "windows-installer",
  "third-party-code-linked-into-the-bundled-binaries.json",
);
if (!existsSync(licenceInventoryPath))
  fail(
    `no licence inventory at ${licenceInventoryPath}. Without it this script cannot say what the bundled binaries ` +
      `link, and it will not ship binaries whose attribution it cannot state.`,
  );
const licenceInventory = JSON.parse(readFileSync(licenceInventoryPath, "utf8"));

console.log("");
console.log(`third-party attribution, from the inventory: ${licenceInventoryPath}`);
console.log(`  openDAQ source checkout: ${openDaqCheckoutRoot}`);
console.log(`  openDAQ build tree     : ${openDaqBuildRoot}`);
console.log(`  ${licenceInventory.components.length} components claimed to be inside the bundled binaries`);

/** The licence text of one inventory component, read from the tree or from the entry itself. */
function licenceTextOf(component) {
  if (Array.isArray(component.licence_text_inline)) {
    return {
      text: `${component.licence_text_inline.join("\n")}\n`,
      readFrom: `${licenceInventoryPath} (licence_text_inline: ${component.licence_text_is_inline_because})`,
    };
  }
  const source = component.licence_text;
  if (!source) fail(`inventory entry "${component.name}" declares neither licence_text nor licence_text_inline`);
  const root = licenceRoots[source.root];
  if (!root) fail(`inventory entry "${component.name}" names licence root "${source.root}", which is not one of: ${Object.keys(licenceRoots).join(", ")}`);
  const absolutePath = join(root, source.path.split("/").join("\\"));
  if (!existsSync(absolutePath))
    fail(
      `the licence text for "${component.name}" was declared at ${absolutePath} and is not there. ` +
        `${component.name} is linked into ${component.linked_into.join(", ")}, and this script will not ship a ` +
        `binary whose licence text it cannot put in the box. Either point the inventory at the licence file in ` +
        `this openDAQ tree, or drop ${component.linked_into.join(" and ")} from OPENDAQ_MODULE_DLLS.`,
    );
  const whole = readFileSync(absolutePath, "utf8");
  if (Array.isArray(source.extract_lines)) {
    const [firstLine, lastLine] = source.extract_lines;
    const lines = whole.split(/\r?\n/).slice(firstLine - 1, lastLine);
    return { text: `${lines.join("\n")}\n`, readFrom: `${absolutePath} lines ${firstLine}-${lastLine}` };
  }
  if (typeof source.extract_from_line_containing === "string") {
    const marker = source.extract_from_line_containing.split("\n").pop();
    const lines = whole.split(/\r?\n/);
    const start = lines.findIndex((line) => line.includes(marker));
    if (start === -1)
      fail(
        `the licence text for "${component.name}" was to be extracted from ${absolutePath} starting at the line ` +
          `containing "${marker}", and no line in that ${lines.length}-line file contains it`,
      );
    return { text: `${lines.slice(start).join("\n")}\n`, readFrom: `${absolutePath} from line ${start + 1}` };
  }
  return { text: whole, readFrom: absolutePath };
}

const licenceDirectory = join(payloadDirectory, "third-party-licences");
mkdirSync(licenceDirectory, { recursive: true });

const noticeLines = [
  "THIRD-PARTY NOTICES FOR QUACKOSCOPE",
  "",
  `Generated by tools/windows-installer/stage-host-and-opendaq-runtime-into-the-installer-payload.mjs`,
  `from tools/windows-installer/third-party-code-linked-into-the-bundled-binaries.json`,
  `on ${new Date().toISOString()}.`,
  "",
  `The binaries this installer ships are openDAQ ${repositoryManifest.sdk_version} (commit`,
  `${repositoryManifest.commit}), quackoscope's own host executable, and the Tauri shell`,
  "quackoscope.exe. None of them stands alone: each has third-party code compiled or statically",
  "linked INTO it, and several of those licences require a credit line in the documentation of a",
  "binary redistribution. Every such credit line is reproduced below, and the full text of every",
  "licence is in third-party-licences/ beside this file.",
  "",
  "FILES THIS NOTICE COVERS",
  `  ..\\quackoscope.exe        (the Tauri shell, one directory up from this one)`,
  `  quackoscope-host-cpp.exe`,
  ...OPENDAQ_RUNTIME_DLLS.map((dll) => `  ${dll}`),
  ...OPENDAQ_MODULE_DLLS.map(({ file }) => `  modules/${file}`),
  "",
  "  msvcp140.dll, vcruntime140.dll and vcruntime140_1.dll are the Microsoft Visual C++",
  "  runtime, redistributed under the Visual Studio redistributable licence and not covered",
  "  by the open-source notices below.",
  "",
  "=".repeat(78),
  "REQUIRED CREDIT LINES",
  "=".repeat(78),
  "",
];

const componentsRequiringCredit = licenceInventory.components.filter((component) => component.credit_line);
for (const component of componentsRequiringCredit) {
  noticeLines.push(`${component.name} (${component.spdx})`);
  noticeLines.push(`  ${component.credit_line}`);
  noticeLines.push("");
}

noticeLines.push("=".repeat(78));
noticeLines.push("EVERY THIRD-PARTY COMPONENT INSIDE THESE BINARIES");
noticeLines.push("=".repeat(78));
noticeLines.push("");

let licenceFilesWritten = 0;
for (const component of licenceInventory.components) {
  const version = component.version ?? String(repositoryManifest[String(component.version_from).replace("manifest.", "")] ?? "");
  const { text, readFrom } = licenceTextOf(component);
  const payloadRelative = component.licence_file_in_payload;
  const destination = join(payloadDirectory, payloadRelative.split("/").join("\\"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, text, "utf8");
  licenceFilesWritten += 1;

  console.log(
    `  ${component.name.padEnd(42)} ${String(version).padEnd(10)} ${String(component.spdx).padEnd(18)} ` +
      `${String(text.length).padStart(6)} bytes -> ${payloadRelative}`,
  );
  console.log(`      licence text read from: ${readFrom}`);
  console.log(`      inside: ${component.linked_into.join(", ")}`);

  noticeLines.push(`${component.name} ${version}`.trim());
  noticeLines.push(`  SPDX-License-Identifier: ${component.spdx}`);
  if (component.spdx_note) noticeLines.push(`  ${component.spdx_note}`);
  noticeLines.push(`  ${component.copyright}`);
  noticeLines.push(`  Inside: ${component.linked_into.join(", ")}`);
  noticeLines.push(`  How that was established: ${component.established_by}`);
  noticeLines.push(`  Licence text read from: ${readFrom}`);
  noticeLines.push(`  Full licence text: ${payloadRelative}`);
  if (component.credit_line) noticeLines.push(`  Required credit line: ${component.credit_line}`);
  noticeLines.push("");
}

// --- the Rust crates inside quackoscope.exe ---------------------------------
//
// The installer ships quackoscope.exe as well as the host and the openDAQ DLLs,
// and quackoscope.exe is the Tauri shell: a few hundred Rust crates statically
// linked into one executable. A notice that covered only the C++ side would leave
// the largest single binary in the box unattributed. The list is generated - see
// tools/windows-installer/list-rust-crate-licences-linked-into-the-tauri-shell.mjs
// - and carries the SHA-256 of the Cargo.lock it was generated from, which is
// checked here so a changed dependency tree cannot ship under a stale list.
const rustCrateInventoryPath = join(
  repositoryRoot,
  "tools",
  "windows-installer",
  "rust-crate-licences-linked-into-the-tauri-shell.json",
);
if (!existsSync(rustCrateInventoryPath))
  fail(
    `no Rust crate licence list at ${rustCrateInventoryPath}, so the licences of the crates inside ` +
      `quackoscope.exe cannot be stated. Generate it with:\n` +
      `  node tools/windows-installer/list-rust-crate-licences-linked-into-the-tauri-shell.mjs`,
  );
const rustCrateInventory = JSON.parse(readFileSync(rustCrateInventoryPath, "utf8"));
const cargoLockPath = join(repositoryRoot, "src-tauri", "Cargo.lock");
const cargoLockSha256 = createHash("sha256").update(readFileSync(cargoLockPath)).digest("hex");

console.log("");
console.log(`Rust crates inside quackoscope.exe, from: ${rustCrateInventoryPath}`);
console.log(`  ${cargoLockPath} sha256 now      ${cargoLockSha256}`);
console.log(`  the list was generated from sha256 ${rustCrateInventory.cargo_lock_sha256}`);
if (cargoLockSha256 !== rustCrateInventory.cargo_lock_sha256)
  fail(
    `${cargoLockPath} has changed since the Rust crate licence list was generated:\n` +
      `  Cargo.lock now         sha256 ${cargoLockSha256}\n` +
      `  the list was made from sha256 ${rustCrateInventory.cargo_lock_sha256}\n` +
      `The dependency tree inside quackoscope.exe is therefore not the one ${rustCrateInventoryPath} describes, ` +
      `and this script will not ship a binary whose contents its notice does not match. Regenerate with:\n` +
      `  node tools/windows-installer/list-rust-crate-licences-linked-into-the-tauri-shell.mjs`,
  );
console.log(`  the two agree, so the ${rustCrateInventory.crate_count} crates listed are the crates in the binary`);

const rustLicenceLines = [
  "LICENCES OF EVERY RUST CRATE INSIDE quackoscope.exe",
  "",
  `${rustCrateInventory.crate_count} crates, from the ${rustCrateInventory.target_triple} dependency graph of`,
  `src-tauri (normal and build dependencies; dev-only dependencies are not in the binary).`,
  `Generated by ${rustCrateInventory.generated_by}`,
  `from src-tauri/Cargo.lock sha256 ${rustCrateInventory.cargo_lock_sha256}.`,
  "",
  "Each crate below is followed by the SPDX expression it declares in its own Cargo.toml and",
  "the full text of every licence file its published source carries. Where a crate publishes",
  "no licence file, only the SPDX expression it declares is available and that is said so.",
  "",
];
let rustCratesWithText = 0;
let rustLicenceFilesCopied = 0;
for (const crate of rustCrateInventory.crates) {
  rustLicenceLines.push("=".repeat(78));
  rustLicenceLines.push(`${crate.name} ${crate.version}`);
  rustLicenceLines.push(`SPDX-License-Identifier: ${crate.spdx}`);
  if (crate.repository) rustLicenceLines.push(`Repository: ${crate.repository}`);
  if (crate.authors.length > 0) rustLicenceLines.push(`Authors: ${crate.authors.join(", ")}`);
  rustLicenceLines.push("=".repeat(78));
  if (crate.licence_files.length === 0) {
    rustLicenceLines.push(
      `${crate.name} ${crate.version} publishes no licence file with its source. Its terms are the SPDX ` +
        `expression above, ${crate.spdx}.`,
    );
    rustLicenceLines.push("");
    continue;
  }
  for (const licenceFile of crate.licence_files) {
    const absolute = join(crate.crate_source_directory.split("/").join("\\"), licenceFile.name);
    if (!existsSync(absolute))
      fail(
        `the licence file ${absolute} that ${crate.name} ${crate.version} publishes is not on this machine, so its ` +
          `text cannot go in the box. Regenerate the crate list after restoring the cargo registry cache:\n` +
          `  node tools/windows-installer/list-rust-crate-licences-linked-into-the-tauri-shell.mjs`,
      );
    rustLicenceLines.push(`--- ${crate.name} ${crate.version}: ${licenceFile.name} ---`);
    rustLicenceLines.push(readFileSync(absolute, "utf8").replace(/\r\n/g, "\n").trimEnd());
    rustLicenceLines.push("");
    rustLicenceFilesCopied += 1;
  }
  rustCratesWithText += 1;
}
const rustLicenceFileInPayload = "third-party-licences/rust-crates-inside-quackoscope-exe.txt";
const rustLicenceDestination = join(payloadDirectory, rustLicenceFileInPayload.split("/").join("\\"));
writeFileSync(rustLicenceDestination, `${rustLicenceLines.join("\n")}\n`, "utf8");
console.log(
  `  wrote ${rustLicenceFileInPayload}: ${rustCrateInventory.crate_count} crates, ` +
    `${rustLicenceFilesCopied} licence files reproduced in full from ${rustCratesWithText} crates, ` +
    `${rustCrateInventory.crates_publishing_no_licence_file.length} crates carrying only an SPDX expression, ` +
    `${statSync(rustLicenceDestination).size} bytes`,
);

noticeLines.push("=".repeat(78));
noticeLines.push("THE RUST CRATES INSIDE quackoscope.exe");
noticeLines.push("=".repeat(78));
noticeLines.push("");
noticeLines.push(
  `quackoscope.exe is the Tauri shell and statically links ${rustCrateInventory.crate_count} Rust crates, from the`,
);
noticeLines.push(
  `${rustCrateInventory.target_triple} dependency graph of src-tauri/Cargo.lock (sha256 ${rustCrateInventory.cargo_lock_sha256}).`,
);
noticeLines.push(`Every one of them declares its terms. The licence expressions across those crates are:`);
noticeLines.push("");
for (const [expression, count] of Object.entries(rustCrateInventory.licence_expression_counts)) {
  noticeLines.push(`  ${String(count).padStart(4)}  ${expression}`);
}
noticeLines.push("");
noticeLines.push(`The name, version, SPDX expression and full licence text of every one of those crates is in`);
noticeLines.push(`  ${rustLicenceFileInPayload}`);
noticeLines.push(
  `These ${rustCrateInventory.crates_publishing_no_licence_file.length} crates publish no licence file with their source, so only the expression they declare is`,
);
noticeLines.push("available for them:");
for (const crate of rustCrateInventory.crates_publishing_no_licence_file) noticeLines.push(`  ${crate}`);
noticeLines.push("");

writeFileSync(join(payloadDirectory, "openDAQ-NOTICE.txt"), `${noticeLines.join("\n")}\n`, "utf8");
console.log(
  `  wrote openDAQ-NOTICE.txt: ${licenceInventory.components.length} components, ` +
    `${componentsRequiringCredit.length} of them carrying a licence that requires a credit line ` +
    `(${componentsRequiringCredit.map((c) => `${c.name} ${c.spdx}`).join("; ")}), ` +
    `${licenceFilesWritten} full licence texts in third-party-licences/`,
);
// The Apache-2.0 licence text keeps its historic name, so nothing that already
// points at openDAQ-LICENSE.txt breaks.
copyFileIntoPayload(
  join(openDaqCheckoutRoot, "LICENSE"),
  join(payloadDirectory, "openDAQ-LICENSE.txt"),
  "Apache-2.0 licence text that must travel with redistributed openDAQ binaries",
);

// --- 2c. refuse to ship a binary that links something nothing attributes -----
//
// The inventory above is written by hand from what the build tree says. This
// re-reads what the build tree says, so the inventory cannot quietly fall behind
// an openDAQ that grew a dependency. MSBuild records every archive the linker
// consumed in link.read.1.tlog; for each bundled binary this finds that log,
// strips the Windows SDK and MSVC entries, and checks the rest against the
// linker_input_libraries the inventory claims.

/** The .lib files MSBuild recorded the linker consuming, minus the toolchain's own. */
function linkerInputLibrariesRecordedFor(binaryTargetName, searchRoot) {
  const wanted = `${binaryTargetName}.dir`;
  const found = [];
  const pending = [searchRoot];
  while (pending.length > 0 && found.length === 0) {
    let entries;
    try {
      entries = readdirSync(pending.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(entry.parentPath ?? entry.path, entry.name);
      if (entry.name === wanted) {
        const log = findFileNamed(path, "link.read.1.tlog");
        if (log) found.push(log);
      } else if (!/^(\.git|node_modules)$/.test(entry.name)) {
        pending.push(path);
      }
    }
  }
  if (found.length === 0) return null;
  const decoded = readFileSync(found[0], "utf16le");
  const libraries = new Set();
  for (const rawLine of decoded.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.toLowerCase().endsWith(".lib")) continue;
    if (licenceInventory.linker_input_libraries_that_need_no_entry.prefixes.some((prefix) => line.toUpperCase().startsWith(prefix.toUpperCase())))
      continue;
    libraries.add(basename(line).toLowerCase());
  }
  return { log: found[0], libraries: [...libraries].sort() };
}

function findFileNamed(directory, fileName) {
  const pending = [directory];
  while (pending.length > 0) {
    let entries;
    try {
      entries = readdirSync(pending.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(entry.parentPath ?? entry.path, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name === fileName) return path;
    }
  }
  return null;
}

const attributedLibraries = new Set(
  licenceInventory.components.flatMap((component) => (component.linker_input_libraries ?? []).map((lib) => lib.toLowerCase())),
);

console.log("");
console.log("checking every archive the linker consumed is claimed by the licence inventory:");
const bundledBinariesToCheck = [
  { target: "opendaq", shipped: "opendaq-64-3.dll", searchRoot: openDaqBuildRoot },
  { target: "daqcoreobjects", shipped: "daqcoreobjects-64-3.dll", searchRoot: openDaqBuildRoot },
  { target: "daqcoretypes", shipped: "daqcoretypes-64-3.dll", searchRoot: openDaqBuildRoot },
  { target: "ref_device_module", shipped: "modules/ref_device_module-64-3.module.dll", searchRoot: openDaqBuildRoot },
  { target: "ref_fb_module", shipped: "modules/ref_fb_module-64-3.module.dll", searchRoot: openDaqBuildRoot },
  { target: "quackoscope-host-cpp", shipped: HOST_EXECUTABLE_NAME, searchRoot: join(repositoryRoot, "hosts", "cpp", "build") },
];
const unattributed = [];
const unverifiable = [];
for (const { target, shipped, searchRoot } of bundledBinariesToCheck) {
  const recorded = linkerInputLibrariesRecordedFor(target, searchRoot);
  if (recorded === null) {
    unverifiable.push(shipped);
    console.log(
      `  ${shipped.padEnd(46)} NO link.read.1.tlog under ${searchRoot}, so what it links cannot be established here`,
    );
    continue;
  }
  const missing = recorded.libraries.filter((lib) => !attributedLibraries.has(lib));
  console.log(
    `  ${shipped.padEnd(46)} ${String(recorded.libraries.length).padStart(2)} non-toolchain archive(s), ` +
      `${missing.length} unattributed   ${recorded.log}`,
  );
  console.log(`      ${recorded.libraries.join(", ")}`);
  for (const lib of missing) unattributed.push({ shipped, lib });
}
if (unattributed.length > 0) {
  fail(
    `${unattributed.length} archive(s) are linked into a bundled binary and no entry of ${licenceInventoryPath} ` +
      `claims them:\n` +
      unattributed.map(({ shipped, lib }) => `  ${shipped} links ${lib}`).join("\n") +
      `\nAdd an entry naming that library's licence and the file the licence text was read from, or drop the ` +
      `binary from the bundle. Shipping it unattributed is not an option.`,
  );
}
if (unverifiable.length > 0) {
  console.log(
    `  ${unverifiable.length} bundled binary/binaries have no linker log in this tree, so their dependency set ` +
      `rests on the inventory alone: ${unverifiable.join(", ")}. If that set cannot be established, drop those ` +
      `files from the bundle rather than shipping them unattributed.`,
  );
} else {
  console.log(
    `  every archive linked into all ${bundledBinariesToCheck.length} bundled binaries is claimed by the inventory`,
  );
}

// --- 3. the manifest must describe the binaries that are actually in the box --

console.log("");
console.log(`checking that the copied openDAQ DLLs really are ${repositoryManifest.sdk_version}:`);
const versionExpectedInTheBinaries = String(repositoryManifest.sdk_version).replace(/_/g, ".");
let versionMismatches = 0;
for (const dllPath of [...copiedOpenDaqRuntimeDlls, ...OPENDAQ_MODULE_DLLS.map(({ file }) => join(payloadDirectory, "modules", file))]) {
  const fileVersion = fileVersionOf(dllPath);
  const agrees = fileVersion === versionExpectedInTheBinaries;
  console.log(
    `  ${basename(dllPath).padEnd(38)} FileVersion ${fileVersion} vs manifest ${versionExpectedInTheBinaries} -> ${agrees ? "MATCH" : "MISMATCH"}`,
  );
  if (!agrees) versionMismatches += 1;
}
if (versionMismatches > 0)
  fail(
    `${versionMismatches} bundled openDAQ DLL(s) do not report FileVersion ${versionExpectedInTheBinaries}. ` +
      `Refusing to ship a manifest that claims sdk_version ${repositoryManifest.sdk_version} over binaries that are ` +
      `something else. Rebuild openDAQ, or re-resolve manifest.json with tools/sdk-build/resolve_sdk.py.`,
  );

const bundledManifest = {
  commit: repositoryManifest.commit,
  sdk_version: repositoryManifest.sdk_version,
  mode: "bundled_with_the_windows_installer",
  module_path: "modules",
  log_level: repositoryManifest.log_level,
  bundled_module_dlls: OPENDAQ_MODULE_DLLS.map(({ file }) => `modules/${file}`),
  staged_from_build_dir: openDaqBinaryDirectory.replace(/\\/g, "/"),
  staged_at: new Date().toISOString(),
};
const bundledManifestPath = join(payloadDirectory, "manifest.json");
writeFileSync(bundledManifestPath, `${JSON.stringify(bundledManifest, null, 2)}\n`, "utf8");

console.log("");
console.log(`wrote app-relative manifest: ${bundledManifestPath}`);
console.log(`  module_path = ${bundledManifest.module_path}   (relative to the payload directory the shell sets as the host's working directory)`);
console.log(`  sdk_version = ${bundledManifest.sdk_version}`);
console.log(`  commit      = ${bundledManifest.commit}`);
console.log(`  log_level   = ${bundledManifest.log_level}`);
console.log(`  mode        = ${bundledManifest.mode}`);
console.log(
  `  staged_from_build_dir = ${bundledManifest.staged_from_build_dir}   (provenance only; nothing at run time reads it)`,
);

const payloadBytes = totalBytesUnder(payloadDirectory);
console.log("");
console.log(`installer payload staged: ${payloadDirectory} holds ${megabytes(payloadBytes)} across ${readdirSync(payloadDirectory).length} top-level entries`);
