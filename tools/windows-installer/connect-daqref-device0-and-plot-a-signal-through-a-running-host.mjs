// Drives ONE running quackoscope host over the wire protocol and prints the
// concrete evidence that it can do the job the installed app exists to do:
//
//   handshake -> list_loaded_modules -> scan_available_devices
//   -> connect_device daqref://device0 -> get_component_tree
//   -> subscribe_signal -> decoded binary sample frames with real values
//   -> list_function_block_types -> add_function_block (if any type is offered)
//
// It also asks Windows which DLL images the host process currently has mapped
// and prints every one whose path lies inside a directory the caller names as
// off limits. That is the check that the installed app is not silently reaching
// back into a developer's openDAQ build tree.
//
//   node tools/windows-installer/connect-daqref-device0-and-plot-a-signal-through-a-running-host.mjs \
//        --url ws://127.0.0.1:8061/ws --host-pid 18156 \
//        --forbidden-directory C:/Users/opendaq/Projects/openDAQ
//
// Exit code 0 when the device connected, a signal streamed real samples and no
// mapped DLL came from a forbidden directory. Exit code 1 otherwise.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// WHY THIS IS AN ABSOLUTE PATH AND NOT THE BARE NAME "powershell.exe"
// This script's last act asks Windows which DLL images the host process has
// mapped, and Windows PowerShell is how it asks. Spawning it as "powershell.exe"
// makes that answer depend on PATH, and this script is deliberately run with a
// scrubbed PATH - that is the whole point of the forbidden-directory check, which
// exists to prove the installed app is not reaching back into a developer's
// openDAQ build tree. With PATH scrubbed, execFileSync("powershell.exe") throws
// ENOENT and the run exits 1 AFTER every protocol check has already passed,
// reporting a missing interpreter as if the host had failed the wire contract.
// %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe is where Windows
// puts it and does not move, so resolving it there makes the check independent
// of PATH entirely.
const WINDOWS_POWERSHELL_ABSOLUTE_PATH = join(
  process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const PORTS_HELD_BY_THE_LIVE_DEMO_AND_OTHER_WORK = [7788, 7789, 7791];

function parseArguments(argv) {
  const options = {
    url: null,
    hostProcessId: null,
    forbiddenDirectories: [],
    connectionString: "daqref://device0",
    pixelColumns: 512,
    frameWaitMs: 8000,
    requestTimeoutMs: 15000,
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const nextValue = (name) => {
      if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
      return argv[++i];
    };
    if (argument === "--url") options.url = nextValue("--url");
    else if (argument === "--host-pid") options.hostProcessId = Number(nextValue("--host-pid"));
    else if (argument === "--forbidden-directory") options.forbiddenDirectories.push(nextValue("--forbidden-directory"));
    else if (argument === "--connection-string") options.connectionString = nextValue("--connection-string");
    else if (argument === "--pixel-columns") options.pixelColumns = Number(nextValue("--pixel-columns"));
    else if (argument === "--frame-wait-ms") options.frameWaitMs = Number(nextValue("--frame-wait-ms"));
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.url === null) throw new Error("--url is required, for example --url ws://127.0.0.1:8061/ws");
  const port = Number(new URL(options.url).port);
  if (PORTS_HELD_BY_THE_LIVE_DEMO_AND_OTHER_WORK.includes(port)) {
    throw new Error(
      `--url ${options.url} names port ${port}, which is held by a host this machine is already running; ` +
        `point this script at a port of its own`,
    );
  }
  return options;
}

/** Decodes the 17-byte-header binary sample frame the contract defines. */
function decodeSampleFrame(bytes) {
  const HEADER_BYTES = 17;
  if (bytes.length < HEADER_BYTES) return { wellFormed: false, byteLength: bytes.length };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const subscriptionId = view.getUint32(0, true);
  const domainStart = view.getBigUint64(4, true);
  const sampleCount = view.getUint32(12, true);
  const encoding = view.getUint8(16);
  const valuesPerSample = encoding === 1 ? 2 : 1; // 1 = min/max decimated pairs
  const values = Array.from(new Float64Array(new Uint8Array(bytes.slice(HEADER_BYTES)).buffer));
  return {
    wellFormed: values.length === sampleCount * valuesPerSample,
    byteLength: bytes.length,
    subscriptionId,
    domainStart,
    sampleCount,
    encoding,
    valuesPerSample,
    values,
  };
}

class HostSession {
  constructor(url, requestTimeoutMs) {
    this.url = url;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.binaryFrames = [];
    this.pendingResolvers = new Map();
    this.nextCorrelationId = 1;
  }

  async openAndReadHandshake() {
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    return await new Promise((resolve, reject) => {
      const giveUp = setTimeout(
        () => reject(new Error(`nothing arrived within ${this.requestTimeoutMs} ms of ${this.url} opening`)),
        this.requestTimeoutMs,
      );
      socket.addEventListener("error", () => {
        clearTimeout(giveUp);
        reject(new Error(`the WebSocket connection to ${this.url} failed; nothing is listening there`));
      });
      socket.addEventListener("message", (messageEvent) => {
        if (typeof messageEvent.data !== "string") {
          this.binaryFrames.push(decodeSampleFrame(new Uint8Array(messageEvent.data)));
          return;
        }
        const parsed = JSON.parse(messageEvent.data);
        if ("id" in parsed && ("result" in parsed || "error" in parsed)) {
          const resolver = this.pendingResolvers.get(parsed.id);
          if (resolver) {
            this.pendingResolvers.delete(parsed.id);
            resolver(parsed);
          }
          return;
        }
        if ("protocol_version" in parsed) {
          clearTimeout(giveUp);
          resolve(parsed);
        }
      });
    });
  }

  async call(method, params) {
    const correlationId = this.nextCorrelationId++;
    const answered = new Promise((resolve, reject) => {
      this.pendingResolvers.set(correlationId, resolve);
      setTimeout(() => {
        if (this.pendingResolvers.delete(correlationId))
          reject(new Error(`no response to ${method} (id ${correlationId}) within ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
    });
    this.socket.send(JSON.stringify({ id: correlationId, method, params }));
    const envelope = await answered;
    if ("error" in envelope)
      throw new Error(`${method} answered error ${envelope.error.code}: ${envelope.error.message ?? ""}`);
    return envelope.result;
  }

  close() {
    if (this.socket && this.socket.readyState <= 1) this.socket.close(1000, "evidence run finished");
  }
}

/** Every DLL image the given process currently has mapped, as absolute paths. */
function mappedDllImagesOfProcess(processId) {
  if (!existsSync(WINDOWS_POWERSHELL_ABSOLUTE_PATH)) {
    throw new Error(
      `${WINDOWS_POWERSHELL_ABSOLUTE_PATH} does not exist, so this script cannot ask Windows which DLL images ` +
        `process ${processId} has mapped and cannot decide whether the installed app reaches back into a ` +
        `forbidden directory. SystemRoot is ${process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "(unset)"}. ` +
        `Every wire-protocol check above this point already passed; only the mapped-image check could not run.`,
    );
  }
  const script =
    `$p = Get-Process -Id ${processId} -ErrorAction Stop; ` +
    `$p.Modules | ForEach-Object { $_.FileName }`;
  console.log(
    `asking ${WINDOWS_POWERSHELL_ABSOLUTE_PATH} (absolute, so a scrubbed PATH cannot break it) which images ` +
      `process ${processId} has mapped`,
  );
  const stdout = execFileSync(
    WINDOWS_POWERSHELL_ABSOLUTE_PATH,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function collectSignalsFromTree(nodes) {
  const signals = [];
  const walk = (list) => {
    for (const node of list ?? []) {
      if (node.kind === "signal") signals.push(node);
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(nodes);
  return signals;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  console.log(`connecting to ${options.url}`);
  const session = new HostSession(options.url, options.requestTimeoutMs);
  const handshake = await session.openAndReadHandshake();
  console.log(
    `handshake: implementation ${handshake.implementation.name} ${handshake.implementation.version}, ` +
      `protocol ${handshake.protocol_version}, sdk ${handshake.sdk.version} @ ${handshake.sdk.commit}`,
  );
  console.log(`handshake capabilities: ${handshake.capabilities.join(", ")}`);

  const loadedModules = await session.call("list_loaded_modules", {});
  console.log(`list_loaded_modules returned ${loadedModules.length} module(s):`);
  for (const loadedModule of loadedModules) {
    console.log(`  ${JSON.stringify(loadedModule)}`);
  }

  const discovered = await session.call("scan_available_devices", {});
  console.log(`scan_available_devices returned ${discovered.length} device(s):`);
  for (const device of discovered) {
    console.log(`  ${device.connection_string}  name=${device.name}  manufacturer=${device.manufacturer ?? ""}`);
  }

  console.log(`connect_device connection_string=${options.connectionString}`);
  const deviceNode = await session.call("connect_device", { connection_string: options.connectionString });
  console.log(`connect_device returned node id ${deviceNode.id}, name "${deviceNode.name}", kind ${deviceNode.kind}`);

  const tree = await session.call("get_component_tree", { root_id: deviceNode.id });
  const signals = collectSignalsFromTree(tree);
  console.log(`get_component_tree under ${deviceNode.id} yielded ${signals.length} signal(s); first five:`);
  for (const signal of signals.slice(0, 5)) console.log(`  ${signal.id}  "${signal.name}"`);
  if (signals.length === 0) throw new Error(`${options.connectionString} exposed no signals, so nothing can be plotted`);

  const signalToPlot =
    signals.find((signal) => /AI|Analog|Sine|Value/i.test(signal.name) && !/Time/i.test(signal.name)) ?? signals[0];
  console.log(`subscribe_signal signal_id=${signalToPlot.id} pixel_columns=${options.pixelColumns}`);
  const subscriptionId = await session.call("subscribe_signal", {
    signal_id: signalToPlot.id,
    pixel_columns: options.pixelColumns,
  });
  console.log(`subscribe_signal returned subscription id ${subscriptionId}`);

  const framesBefore = session.binaryFrames.length;
  const waitStartedAt = Date.now();
  while (session.binaryFrames.length - framesBefore < 3 && Date.now() - waitStartedAt < options.frameWaitMs) {
    await sleep(50);
  }
  const frames = session.binaryFrames.slice(framesBefore);
  console.log(`${frames.length} binary sample frame(s) arrived in ${Date.now() - waitStartedAt} ms`);
  let totalSamples = 0;
  let smallestValue = Number.POSITIVE_INFINITY;
  let largestValue = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    totalSamples += frame.sampleCount;
    for (const value of frame.values) {
      if (value < smallestValue) smallestValue = value;
      if (value > largestValue) largestValue = value;
    }
  }
  if (frames.length > 0) {
    const first = frames[0];
    console.log(
      `  frame 1: ${first.byteLength} bytes, subscription ${first.subscriptionId}, domain_start ${first.domainStart}, ` +
        `sample_count ${first.sampleCount}, encoding ${first.encoding}, ${first.valuesPerSample} value(s) per sample`,
    );
    console.log(`  frame 1 first eight values: ${first.values.slice(0, 8).map((v) => v.toFixed(6)).join(", ")}`);
    console.log(
      `  across ${frames.length} frame(s): ${totalSamples} samples, values from ${smallestValue.toFixed(6)} to ${largestValue.toFixed(6)}`,
    );
  }
  await session.call("unsubscribe_signal", { subscription_id: subscriptionId });
  console.log(`unsubscribe_signal ${subscriptionId} accepted`);

  const functionBlockTypes = await session.call("list_function_block_types", {});
  console.log(
    `list_function_block_types returned ${functionBlockTypes.length} type(s): ` +
      (functionBlockTypes.length ? functionBlockTypes.join(", ") : "(none)"),
  );
  let addedFunctionBlockId = null;
  if (functionBlockTypes.length > 0) {
    const typeToAdd = functionBlockTypes.includes("RefFBModuleStatistics")
      ? "RefFBModuleStatistics"
      : functionBlockTypes[0];
    const added = await session.call("add_function_block", { parent_id: deviceNode.id, type_id: typeToAdd });
    addedFunctionBlockId = added.id;
    console.log(`add_function_block type_id=${typeToAdd} returned node id ${added.id}, name "${added.name}"`);
    await session.call("remove_function_block", { node_id: added.id });
    console.log(`remove_function_block ${added.id} accepted`);
  }

  session.close();

  let forbiddenImages = [];
  if (options.hostProcessId !== null) {
    const mapped = mappedDllImagesOfProcess(options.hostProcessId);
    console.log(`process ${options.hostProcessId} has ${mapped.length} image(s) mapped`);
    const outsideWindows = mapped.filter((path) => !/^[A-Za-z]:\\Windows\\/i.test(path));
    console.log(`  ${outsideWindows.length} of them live outside C:\\Windows:`);
    for (const path of outsideWindows) console.log(`    ${path}`);
    const normalise = (path) => path.replace(/\\/g, "/").toLowerCase();
    for (const forbidden of options.forbiddenDirectories) {
      const prefix = normalise(forbidden).replace(/\/+$/, "") + "/";
      const hits = mapped.filter((path) => normalise(path).startsWith(prefix));
      if (hits.length === 0) {
        console.log(`  none of the ${mapped.length} mapped images comes from ${forbidden}`);
      } else {
        console.log(`  ${hits.length} mapped image(s) come from ${forbidden}, which they must not:`);
        for (const path of hits) console.log(`    ${path}`);
        forbiddenImages = forbiddenImages.concat(hits);
      }
    }
  }

  const streamedRealSamples = totalSamples > 0 && largestValue > smallestValue;
  console.log("");
  console.log(`connect_device ${options.connectionString}                 -> node ${deviceNode.id}`);
  console.log(`signal ${signalToPlot.id} streamed ${totalSamples} sample(s) -> ${streamedRealSamples ? "a plottable, varying signal" : "NO usable samples"}`);
  console.log(`images mapped from a forbidden directory                    -> ${forbiddenImages.length}`);
  if (!streamedRealSamples || forbiddenImages.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `${options.connectionString} connected and signal ${signalToPlot.id} plotted ${totalSamples} samples using only images outside every forbidden directory`,
  );
}

main().catch((failure) => {
  console.error(`failed: ${failure.message}`);
  process.exitCode = 1;
});
