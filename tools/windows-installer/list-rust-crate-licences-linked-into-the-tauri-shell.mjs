// Writes tools/windows-installer/rust-crate-licences-linked-into-the-tauri-shell.json:
// every Rust crate that ends up inside src-tauri's release binary quackoscope.exe,
// with the SPDX expression the crate itself declares and the licence files its
// published source carries.
//
//   node tools/windows-installer/list-rust-crate-licences-linked-into-the-tauri-shell.mjs
//
// WHY THIS IS GENERATED AND NOT TYPED
// quackoscope.exe is the Tauri shell, and it statically links a few hundred Rust
// crates. Nobody is going to keep that list correct by hand, and the last time
// this repository trusted a hand-maintained copy of a dependency list the build
// broke for weeks. So the list is produced from `cargo metadata`, which reads the
// same Cargo.lock cargo builds from, and the file it writes records the SHA-256
// of that Cargo.lock. stage-host-and-opendaq-runtime-into-the-installer-payload.mjs
// recomputes that hash and REFUSES TO STAGE when it disagrees, naming both hashes
// and this command - so a changed dependency tree cannot ship under a stale list.
//
// WHICH CRATES COUNT
// The resolve graph cargo produces for x86_64-pc-windows-msvc, walked from the
// root package through normal and build dependencies. Dev-only edges are skipped:
// a crate reached only as a dev-dependency is not in the shipped binary.
//
// EXIT CODE: 0 when the list was written. 1 when cargo could not be run, when the
// metadata is not shaped as expected, or when a crate declares no licence at all -
// which is the one case that must stop the installer rather than be papered over.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tauriCrateDirectory = join(repositoryRoot, "src-tauri");
const cargoLockPath = join(tauriCrateDirectory, "Cargo.lock");
const outputPath = join(
  repositoryRoot,
  "tools",
  "windows-installer",
  "rust-crate-licences-linked-into-the-tauri-shell.json",
);

const TARGET_TRIPLE = "x86_64-pc-windows-msvc";
const LICENCE_FILE_NAME_PREFIXES = ["LICENSE", "LICENCE", "COPYING", "UNLICENSE", "NOTICE"];

function fail(message) {
  console.error(`list-rust-crate-licences-linked-into-the-tauri-shell: ${message}`);
  process.exit(1);
}

export function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** cargo, by absolute path where possible, so a scrubbed PATH does not decide this. */
function cargoExecutable() {
  const home = process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo");
  const candidate = join(home, "bin", "cargo.exe");
  if (existsSync(candidate)) return candidate;
  return "cargo";
}

function readCargoMetadata() {
  const cargo = cargoExecutable();
  console.log(`running: ${cargo} metadata --format-version 1 --filter-platform ${TARGET_TRIPLE}`);
  console.log(`  in: ${tauriCrateDirectory}`);
  let stdout;
  try {
    stdout = execFileSync(cargo, ["metadata", "--format-version", "1", "--filter-platform", TARGET_TRIPLE], {
      cwd: tauriCrateDirectory,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    fail(
      `could not run ${cargo}: ${error.message}\n` +
        `Rust's toolchain has to be on this machine to say what quackoscope.exe links. Install it, or run this ` +
        `from a shell where cargo resolves.`,
    );
  }
  return JSON.parse(stdout);
}

const metadata = readCargoMetadata();
const packagesById = new Map(metadata.packages.map((p) => [p.id, p]));
const nodesById = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
const rootId = metadata.resolve.root;
if (!rootId) fail(`cargo metadata reported no root package for ${tauriCrateDirectory}`);

const reached = new Set();
const pending = [rootId];
while (pending.length > 0) {
  const id = pending.pop();
  if (reached.has(id)) continue;
  reached.add(id);
  for (const dependency of nodesById.get(id)?.deps ?? []) {
    const kinds = new Set(dependency.dep_kinds.map((k) => k.kind));
    // kind null is a normal dependency, "build" is a build script dependency;
    // both put code in the binary or in the thing that produced it. A crate
    // reached ONLY as a dev-dependency is not in the shipped binary.
    if (kinds.size === 1 && kinds.has("dev")) continue;
    pending.push(dependency.pkg);
  }
}
reached.delete(rootId);

console.log(`${reached.size} crates in the ${TARGET_TRIPLE} resolve graph, dev-only edges excluded`);

const crates = [];
const cratesDeclaringNoLicence = [];
let licenceFilesFound = 0;
let licenceBytesFound = 0;

for (const id of [...reached].sort()) {
  const packageInfo = packagesById.get(id);
  const crateDirectory = dirname(packageInfo.manifest_path);
  const licenceFiles = [];
  if (existsSync(crateDirectory)) {
    for (const entry of readdirSync(crateDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const upper = entry.name.toUpperCase();
      if (!LICENCE_FILE_NAME_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
      const size = statSync(join(crateDirectory, entry.name)).size;
      licenceFiles.push({ name: entry.name, bytes: size });
      licenceFilesFound += 1;
      licenceBytesFound += size;
    }
  }
  const spdx = packageInfo.license ?? (packageInfo.license_file ? `see ${packageInfo.license_file}` : null);
  if (!spdx) cratesDeclaringNoLicence.push(`${packageInfo.name} ${packageInfo.version}`);
  crates.push({
    name: packageInfo.name,
    version: packageInfo.version,
    spdx,
    repository: packageInfo.repository ?? null,
    authors: packageInfo.authors ?? [],
    crate_source_directory: crateDirectory.replace(/\\/g, "/"),
    licence_files: licenceFiles.sort((a, b) => a.name.localeCompare(b.name)),
  });
}

if (cratesDeclaringNoLicence.length > 0) {
  fail(
    `${cratesDeclaringNoLicence.length} crate(s) in quackoscope.exe declare neither a license nor a license-file ` +
      `in their own Cargo.toml, so their terms cannot be stated:\n  ${cratesDeclaringNoLicence.join("\n  ")}\n` +
      `Drop the dependency that pulls them in rather than shipping code whose licence nobody can name.`,
  );
}

const cratesWithNoLicenceFileOnDisk = crates.filter((c) => c.licence_files.length === 0);
const licenceExpressionCounts = {};
for (const crate of crates) licenceExpressionCounts[crate.spdx] = (licenceExpressionCounts[crate.spdx] ?? 0) + 1;

const document = {
  what_this_file_is:
    "Every Rust crate inside src-tauri's release binary quackoscope.exe, with the SPDX expression the crate " +
    "declares in its own Cargo.toml and the licence files its published source carries.",
  generated_by: "node tools/windows-installer/list-rust-crate-licences-linked-into-the-tauri-shell.mjs",
  do_not_edit_by_hand:
    "Regenerate it with the command above. stage-host-and-opendaq-runtime-into-the-installer-payload.mjs " +
    "checks cargo_lock_sha256 against src-tauri/Cargo.lock and refuses to stage when they disagree.",
  target_triple: TARGET_TRIPLE,
  dependency_kinds_walked: ["normal", "build"],
  cargo_lock_path: "src-tauri/Cargo.lock",
  cargo_lock_sha256: sha256OfFile(cargoLockPath),
  crate_count: crates.length,
  licence_expression_counts: Object.fromEntries(
    Object.entries(licenceExpressionCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  ),
  crates_publishing_no_licence_file: cratesWithNoLicenceFileOnDisk.map((c) => `${c.name} ${c.version} (${c.spdx})`),
  crates,
};

writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

console.log(`licence expressions across those ${crates.length} crates:`);
for (const [expression, count] of Object.entries(document.licence_expression_counts)) {
  console.log(`  ${String(count).padStart(4)}  ${expression}`);
}
console.log(
  `${licenceFilesFound} licence files totalling ${licenceBytesFound} bytes found in the unpacked crate sources`,
);
console.log(
  `${cratesWithNoLicenceFileOnDisk.length} crate(s) publish no licence file with their source, so only the SPDX ` +
    `expression they declare is available for them: ${cratesWithNoLicenceFileOnDisk.map((c) => `${c.name} ${c.version} (${c.spdx})`).join(", ")}`,
);
console.log(
  `wrote ${outputPath}: ${crates.length} crates, Cargo.lock sha256 ${document.cargo_lock_sha256}, ` +
    `${statSync(outputPath).size} bytes`,
);
