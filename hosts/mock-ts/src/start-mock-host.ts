// quackoscope-host-mock
//
// Wires the three layers together and nothing else:
//   synthetic device -> service layer -> transport layer.
//
// There is no openDAQ SDK in this process and no manifest to read: the device
// is synthesised, which is what lets the app run on a machine with no SDK and
// what makes this the only host that can be deployed to a serverless platform.
//
// Usage:
//   node src/start-mock-host.ts [--port <n>] [--address <ip>] [--dist <path>]

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

import { SyntheticReferenceDevice } from "./synthetic-device/synthetic-reference-device.ts";
import {
  HOST_IMPLEMENTATION_NAME,
  HOST_IMPLEMENTATION_VERSION,
  MAX_FRAME_BYTES,
  MAX_SUBSCRIPTIONS,
  PROTOCOL_VERSION,
  SessionHub,
  printHandshakeItWillSend,
} from "./service/session-hub.ts";
import { startWebSocketAndStaticFileServer } from "./transport/websocket-and-static-file-server.ts";

const hostSourceDirectory = dirname(fileURLToPath(import.meta.url));

interface StartOptions {
  address: string;
  port: number;
  distDirectory: string;
}

function parseArguments(argv: string[]): StartOptions | null {
  const options: StartOptions = {
    address: "127.0.0.1",
    port: 7791,
    distDirectory: resolve(hostSourceDirectory, "..", "..", "..", "dist"),
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const nextValue = (name: string): string => {
      if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
      return argv[++i];
    };
    if (argument === "--port") options.port = Number(nextValue("--port"));
    else if (argument === "--address") options.address = nextValue("--address");
    else if (argument === "--dist") options.distDirectory = resolve(process.cwd(), nextValue("--dist"));
    else if (argument === "--help" || argument === "-h") {
      console.log(`${HOST_IMPLEMENTATION_NAME} [--port <n>] [--address <ip>] [--dist <path>]`);
      return null;
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`--port must be an integer in [1, 65535]; got "${options.port}"`);
  }
  return options;
}

async function startMockHost(): Promise<number> {
  let options: StartOptions | null;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (e) {
    console.error(`${HOST_IMPLEMENTATION_NAME}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (options === null) return 0;

  const device = new SyntheticReferenceDevice();
  const hub = new SessionHub(device);

  console.log(`[host] ${HOST_IMPLEMENTATION_NAME} ${HOST_IMPLEMENTATION_VERSION}`);
  console.log(`[host] node        ${process.version} on ${process.platform}`);
  console.log(`[host] sdk         none: the device is synthetic, no openDAQ module is loaded`);
  console.log(`[host] device      ${device.getDeviceNode().id} "${device.getDeviceNode().name}", ${device.componentCount()} components`);
  for (const node of device.getComponentTree(device.getDeviceNode().id)) {
    console.log(
      `[host]   ${node.id.padEnd(50)} kind ${node.kind.padEnd(14)} active ${String(node.active).padEnd(5)} ` +
        `locked ${String(node.locked).padEnd(5)} component_status ${String(node.component_status).padEnd(7)} ` +
        `connection_status ${String(node.connection_status).padEnd(9)} operation_mode ${String(node.operation_mode).padEnd(9)} ` +
        `updating ${String(node.updating).padEnd(5)} recording ${node.recording}`,
    );
  }
  console.log(
    `[host] modes       device operation mode is "${device.currentOperationMode()}"; get_device_operation_modes offers ${device.describeOfferedOperationModes()}`,
  );
  console.log(`[host] modules     list_loaded_modules answers with ${device.describeLoadedModulesForTheLog()}`);
  console.log(`[host] attributes  get_component_attributes reports ${device.describeAttributeSurfaceForTheLog()}`);
  console.log(`[host] servers     list_server_types offers ${device.describeServerTypesForTheLog()}`);
  console.log(
    `[host]             the tree already carries ${device.describeServersForTheLog()}; every one of them binds no ` +
      "socket, so this process listens on exactly one port and it is the one below",
  );
  console.log(
    `[host] recorders   start_recording and stop_recording act on ${device.recorderNodeIds().length} row(s): ` +
      `${device.recorderNodeIds().join(", ") || "none"}. Those are the only rows reporting a non-null Node.recording; ` +
      "every other row reports null there, which is what tells a client to draw no Start/Stop control",
  );
  console.log(
    `[host] batches     ${device.nodeIdsInsideAnOpenBatch().length} component(s) are inside an open batched update at ` +
      `startup, holding ${device.heldPropertyWriteCount()} unapplied property write(s). Whether a session may end a ` +
      "batch it did not begin is open in contract/contract.yaml and this host does not answer it: the depth is kept " +
      "on the component, as openDAQ's own IPropertyObject keeps it",
  );
  console.log(`[host] dist        ${options.distDirectory}${existsSync(options.distDirectory) ? "" : "  (missing: the SPA will 404 until it is built; /ws still serves the contract)"}`);
  console.log(`[host] protocol    ${PROTOCOL_VERSION}, limits max_subscriptions ${MAX_SUBSCRIPTIONS}, max_frame_bytes ${MAX_FRAME_BYTES}`);
  printHandshakeItWillSend();

  try {
    await startWebSocketAndStaticFileServer({
      address: options.address,
      port: options.port,
      distDirectory: options.distDirectory,
      hub,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(
      `${HOST_IMPLEMENTATION_NAME}: could not listen on ${options.address}:${options.port}: ${reason}. Start it with --port <a free port>.`,
    );
    return 1;
  }

  console.log(
    `[host] listening on http://${options.address}:${options.port}  (websocket at ws://${options.address}:${options.port}/ws)`,
  );
  return 0;
}

const exitCode = await startMockHost();
if (exitCode !== 0) process.exit(exitCode);
