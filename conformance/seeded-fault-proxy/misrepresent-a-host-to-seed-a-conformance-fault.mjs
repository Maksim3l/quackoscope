// Sits between the conformance suite and a real host and misrepresents that
// host on purpose, so the harness can be shown catching what it claims to catch.
//
// Every byte still comes from a real, running host. The only thing this proxy
// changes is what the host SAYS about itself, and - optionally - one operation's
// answer. The suite on the other side has no way to tell the difference, which
// is the point: if it classifies the seeded fault correctly, it classifies a
// genuine one correctly too.
//
//   node conformance/seeded-fault-proxy/misrepresent-a-host-to-seed-a-conformance-fault.mjs \
//     --upstream ws://127.0.0.1:7814/ws --port 7816 \
//     --declare every-baseline-capability --break-method set_property_value --break-as refuse-with-internal
//
// --declare
//   as-upstream-sent-it       leave the capability list alone
//   every-baseline-capability claim all 8 baseline capabilities and declare no
//                             gaps. The upstream host does not serve them all,
//                             so the suite must report failure class (b).
//   no-capability-at-all      claim nothing and declare all 8 as gaps, with a
//                             reason. The upstream host DOES serve most of
//                             them, which is under-claiming: the suite must
//                             report warnings and still pass.
//
// --break-method <wire method>  and  --break-as
//   refuse-with-internal      answer that method with error code "internal",
//                             which is outside the subset the contract declares
//                             for every operation except scan_available_devices
//   strip-a-required-field    delete the "property_ids" key from every Node in
//                             the answer, breaking contract types.Node
//
// --misreport-sdk-commit-as <commit>
//   Rewrite the handshake's sdk.commit to <commit>, leaving sdk.version and
//   everything else exactly as the upstream host sent it. The host on the other
//   end really did load the manifest's openDAQ; the consumer is told it loaded
//   another one. This is how the sdk.commit gate in
//   ../decide-whether-hosts-share-the-manifest-opendaq-build.mjs is shown
//   refusing a genuine version disagreement between two real SDK hosts.
//
// --port-range <first>-<last>
//   The only ports this proxy may listen on. Which ports are free is a fact
//   about the machine and the moment, not about this file, so the window moves.
//
// The capability baseline and the gap kinds are read from contract/contract.yaml;
// nothing here hand-writes a capability id.

import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readWireContract } from "../contract/read-wire-contract-yaml.mjs";
import {
  ClientFrameReader,
  encodeBinaryFrame,
  encodeCloseFrame,
  encodePongFrame,
  encodeTextFrame,
  writeUpgradeResponse,
} from "./websocket-server-frame-codec.mjs";

const proxyDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(proxyDirectory, "..", "..");

const DEFAULT_FIRST_PORT_THIS_PROXY_MAY_BIND = 7811;
const DEFAULT_LAST_PORT_THIS_PROXY_MAY_BIND = 7830;

const DECLARE_MODES = ["as-upstream-sent-it", "every-baseline-capability", "no-capability-at-all"];
const BREAK_MODES = ["refuse-with-internal", "strip-a-required-field"];

function parseArguments(argv) {
  const options = {
    upstream: null,
    port: null,
    address: "127.0.0.1",
    declare: "as-upstream-sent-it",
    breakMethod: null,
    breakAs: "refuse-with-internal",
    misreportSdkCommitAs: null,
    lowestPortAllowed: DEFAULT_FIRST_PORT_THIS_PROXY_MAY_BIND,
    highestPortAllowed: DEFAULT_LAST_PORT_THIS_PROXY_MAY_BIND,
    contractPath: resolve(repositoryRoot, "contract", "contract.yaml"),
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const nextValue = (name) => {
      if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
      return argv[++i];
    };
    if (argument === "--upstream") options.upstream = nextValue("--upstream");
    else if (argument === "--port") options.port = Number(nextValue("--port"));
    else if (argument === "--address") options.address = nextValue("--address");
    else if (argument === "--declare") options.declare = nextValue("--declare");
    else if (argument === "--break-method") options.breakMethod = nextValue("--break-method");
    else if (argument === "--break-as") options.breakAs = nextValue("--break-as");
    else if (argument === "--misreport-sdk-commit-as") options.misreportSdkCommitAs = nextValue("--misreport-sdk-commit-as");
    else if (argument === "--port-range") {
      const spelling = nextValue("--port-range");
      const bounds = /^(\d+)-(\d+)$/.exec(spelling.trim());
      if (!bounds) {
        throw new Error(`--port-range was given "${spelling}"; it takes two port numbers joined by a hyphen, for example --port-range ${DEFAULT_FIRST_PORT_THIS_PROXY_MAY_BIND}-${DEFAULT_LAST_PORT_THIS_PROXY_MAY_BIND}`);
      }
      options.lowestPortAllowed = Number(bounds[1]);
      options.highestPortAllowed = Number(bounds[2]);
      if (options.lowestPortAllowed < 1 || options.highestPortAllowed > 65535) {
        throw new Error(`--port-range ${options.lowestPortAllowed}-${options.highestPortAllowed} leaves the TCP port numbers 1-65535`);
      }
      if (options.highestPortAllowed < options.lowestPortAllowed) {
        throw new Error(`--port-range ${options.lowestPortAllowed}-${options.highestPortAllowed} ends below where it starts`);
      }
    }
    else if (argument === "--contract") options.contractPath = resolve(process.cwd(), nextValue("--contract"));
    else if (argument === "--help" || argument === "-h") return null;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.upstream === null) throw new Error("--upstream is required, for example --upstream ws://127.0.0.1:7814/ws");
  if (options.port === null) throw new Error("--port is required");
  if (!Number.isInteger(options.port) || options.port < options.lowestPortAllowed || options.port > options.highestPortAllowed) {
    throw new Error(
      `--port ${options.port} is outside ${options.lowestPortAllowed}-${options.highestPortAllowed}, the window this proxy may listen in. Refusing to listen there. Move the window with --port-range <first>-<last> if those ports are yours to bind.`,
    );
  }
  if (options.misreportSdkCommitAs !== null && options.misreportSdkCommitAs.trim() === "") {
    throw new Error("--misreport-sdk-commit-as was given an empty commit; give it the commit string the consumer should be told");
  }
  if (!DECLARE_MODES.includes(options.declare)) {
    throw new Error(`--declare ${JSON.stringify(options.declare)} is not one of ${DECLARE_MODES.join(", ")}`);
  }
  if (options.breakMethod !== null && !BREAK_MODES.includes(options.breakAs)) {
    throw new Error(`--break-as ${JSON.stringify(options.breakAs)} is not one of ${BREAK_MODES.join(", ")}`);
  }
  return options;
}

function rewriteHandshake(handshakeText, options, contract) {
  const handshake = JSON.parse(handshakeText);
  const before = {
    capabilities: handshake.capabilities,
    gapCapabilities: (handshake.gaps ?? []).map((gap) => gap.capability),
    sdkVersion: handshake.sdk?.version ?? "(absent)",
    sdkCommit: handshake.sdk?.commit ?? "(absent)",
  };

  if (options.misreportSdkCommitAs !== null) {
    // sdk.version is left exactly as the upstream host sent it, so the seeded
    // fault is a commit disagreement and nothing else.
    handshake.sdk = { ...(handshake.sdk ?? {}), commit: options.misreportSdkCommitAs };
  }

  if (options.declare === "every-baseline-capability") {
    handshake.capabilities = [...contract.capabilityBaselineIds];
    handshake.gaps = [];
  } else if (options.declare === "no-capability-at-all") {
    handshake.capabilities = [];
    handshake.gaps = contract.capabilityBaselineIds.map((capability) => ({
      capability,
      kind: contract.gapKinds[1] ?? "host",
      reason:
        "seeded by conformance/seeded-fault-proxy: this proxy declares every baseline capability a gap, whatever the upstream host actually serves",
    }));
  }

  const after = {
    capabilities: handshake.capabilities,
    gapCapabilities: (handshake.gaps ?? []).map((gap) => gap.capability),
    sdkVersion: handshake.sdk?.version ?? "(absent)",
    sdkCommit: handshake.sdk?.commit ?? "(absent)",
  };
  return { text: JSON.stringify(handshake), before, after };
}

function breakOneResponse(response, options) {
  if (options.breakAs === "refuse-with-internal") {
    return {
      id: response.id,
      error: {
        code: "internal",
        detail: `seeded by conformance/seeded-fault-proxy: the upstream host answered ${options.breakMethod} correctly and this proxy replaced the answer with an "internal" refusal`,
      },
    };
  }
  // strip-a-required-field
  const stripped = JSON.parse(JSON.stringify(response));
  const stripFrom = (value) => {
    if (Array.isArray(value)) value.forEach(stripFrom);
    else if (value !== null && typeof value === "object") {
      if ("property_ids" in value) delete value.property_ids;
      Object.values(value).forEach(stripFrom);
    }
  };
  stripFrom(stripped.result);
  return stripped;
}

async function misrepresentAHostToSeedAConformanceFault() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (failure) {
    console.error(`quackoscope seeded-fault proxy: ${failure.message}`);
    return 2;
  }
  if (options === null) {
    console.log(
      `misrepresent-a-host-to-seed-a-conformance-fault.mjs --upstream ws://<host>:<port>/ws --port <${DEFAULT_FIRST_PORT_THIS_PROXY_MAY_BIND}-${DEFAULT_LAST_PORT_THIS_PROXY_MAY_BIND}> [--port-range <first>-<last>] [--declare ${DECLARE_MODES.join("|")}] [--break-method <wire method> --break-as ${BREAK_MODES.join("|")}] [--misreport-sdk-commit-as <commit>]`,
    );
    console.log(
      `  --misreport-sdk-commit-as <commit>  rewrite the handshake's sdk.commit to <commit> and leave sdk.version alone, so a host that really did load the manifest's openDAQ tells the consumer it loaded another one`,
    );
    console.log(
      `  --port-range <first>-<last>         the only ports this proxy may listen on. Default ${DEFAULT_FIRST_PORT_THIS_PROXY_MAY_BIND}-${DEFAULT_LAST_PORT_THIS_PROXY_MAY_BIND}.`,
    );
    return 0;
  }

  const contract = readWireContract(options.contractPath);
  if (options.breakMethod !== null && !contract.operationsByWireMethod.has(options.breakMethod)) {
    console.error(
      `quackoscope seeded-fault proxy: --break-method ${JSON.stringify(options.breakMethod)} is not a wire method of ${options.contractPath}; it declares ${[...contract.operationsByWireMethod.keys()].join(", ")}`,
    );
    return 2;
  }

  console.log("quackoscope seeded-fault proxy");
  console.log(`  listening on      ws://${options.address}:${options.port}/ws  (allowed window ${options.lowestPortAllowed}-${options.highestPortAllowed})`);
  console.log(`  forwarding to     ${options.upstream}`);
  console.log(`  contract          ${options.contractPath} (${contract.capabilityBaselineIds.length} baseline capabilities)`);
  console.log(`  --declare         ${options.declare}`);
  console.log(
    `  sdk.commit        ${options.misreportSdkCommitAs === null ? "(forwarded exactly as the upstream host reported it)" : `MISREPORTED as ${options.misreportSdkCommitAs}; sdk.version is forwarded untouched`}`,
  );
  console.log(
    `  --break-method    ${options.breakMethod === null ? "(none: every operation's answer is forwarded untouched)" : `${options.breakMethod}, broken as ${options.breakAs}`}`,
  );

  const httpServer = createServer((request, response) => {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end(
      `quackoscope seeded-fault proxy serves only the WebSocket at /ws; ${request.method} ${request.url} is not that.\n`,
    );
  });

  let connectionCount = 0;

  httpServer.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (request.url !== "/ws" || typeof key !== "string") {
      socket.write(`HTTP/1.1 400 Bad Request\r\n\r\nthe proxy upgrades only /ws with a Sec-WebSocket-Key; got ${request.url}\r\n`);
      socket.destroy();
      return;
    }
    const connectionId = ++connectionCount;
    writeUpgradeResponse(socket, key);
    console.log(`[proxy] connection ${connectionId} upgraded from ${socket.remoteAddress}:${socket.remotePort}; dialling ${options.upstream}`);

    const upstream = new WebSocket(options.upstream);
    upstream.binaryType = "arraybuffer";
    const queuedToUpstream = [];
    let upstreamIsOpen = false;
    let handshakeSeen = false;
    const correlationIdsOfTheBrokenMethod = new Set();
    let brokenCount = 0;

    const sendToClient = (buffer) => {
      if (!socket.destroyed) socket.write(buffer);
    };

    upstream.addEventListener("open", () => {
      upstreamIsOpen = true;
      for (const queued of queuedToUpstream) upstream.send(queued);
      queuedToUpstream.length = 0;
    });

    upstream.addEventListener("message", (messageEvent) => {
      if (typeof messageEvent.data !== "string") {
        sendToClient(encodeBinaryFrame(Buffer.from(new Uint8Array(messageEvent.data))));
        return;
      }
      let text = messageEvent.data;

      if (!handshakeSeen) {
        handshakeSeen = true;
        if (options.declare !== "as-upstream-sent-it" || options.misreportSdkCommitAs !== null) {
          try {
            const rewritten = rewriteHandshake(text, options, contract);
            console.log(
              `[proxy] connection ${connectionId} handshake rewritten (--declare ${options.declare}${options.misreportSdkCommitAs === null ? "" : `, --misreport-sdk-commit-as ${options.misreportSdkCommitAs}`}):\n` +
                `        upstream said capabilities [${before(rewritten).capabilities.join(", ") || "(none)"}], gaps [${before(rewritten).gapCapabilities.join(", ") || "(none)"}], sdk.version "${before(rewritten).sdkVersion}", sdk.commit "${before(rewritten).sdkCommit}"\n` +
                `        proxy says     capabilities [${rewritten.after.capabilities.join(", ") || "(none)"}], gaps [${rewritten.after.gapCapabilities.join(", ") || "(none)"}], sdk.version "${rewritten.after.sdkVersion}", sdk.commit "${rewritten.after.sdkCommit}"`,
            );
            text = rewritten.text;
          } catch (failure) {
            console.error(`[proxy] connection ${connectionId}: could not rewrite the upstream handshake ${JSON.stringify(text).slice(0, 200)}: ${failure.message}`);
          }
        } else {
          console.log(`[proxy] connection ${connectionId} handshake forwarded untouched, ${text.length} bytes`);
        }
        sendToClient(encodeTextFrame(text));
        return;
      }

      if (options.breakMethod !== null) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && "id" in parsed && correlationIdsOfTheBrokenMethod.has(parsed.id)) {
            const broken = breakOneResponse(parsed, options);
            brokenCount++;
            console.log(
              `[proxy] connection ${connectionId} broke answer id ${parsed.id} for ${options.breakMethod} (${options.breakAs}); ` +
                `upstream sent ${text.slice(0, 120)} -> proxy sends ${JSON.stringify(broken).slice(0, 120)}`,
            );
            sendToClient(encodeTextFrame(JSON.stringify(broken)));
            return;
          }
        } catch {
          // not JSON: forward it as it came
        }
      }
      sendToClient(encodeTextFrame(text));
    });

    upstream.addEventListener("close", (closeEvent) => {
      console.log(
        `[proxy] connection ${connectionId}: upstream ${options.upstream} closed with code ${closeEvent.code}; ${brokenCount} answer(s) were broken on this connection`,
      );
      sendToClient(encodeCloseFrame(1000, "upstream closed"));
      socket.end();
    });
    upstream.addEventListener("error", () => {
      console.error(`[proxy] connection ${connectionId}: the upstream connection to ${options.upstream} failed`);
      sendToClient(encodeCloseFrame(1011, "upstream failed"));
      socket.end();
    });

    const reader = new ClientFrameReader({
      onMessage: (message) => {
        if (message.kind === "binary") {
          if (upstreamIsOpen) upstream.send(message.bytes);
          else queuedToUpstream.push(message.bytes);
          return;
        }
        if (options.breakMethod !== null) {
          try {
            const parsed = JSON.parse(message.text);
            if (parsed && parsed.method === options.breakMethod && "id" in parsed) {
              correlationIdsOfTheBrokenMethod.add(parsed.id);
            }
          } catch {
            // not JSON: forward it as it came
          }
        }
        if (upstreamIsOpen) upstream.send(message.text);
        else queuedToUpstream.push(message.text);
      },
      onControl: (control) => {
        if (control.kind === "ping") sendToClient(encodePongFrame(control.payload));
        else if (control.kind === "close") {
          console.log(`[proxy] connection ${connectionId}: the client sent a close frame; closing the upstream too`);
          upstream.close();
          sendToClient(encodeCloseFrame(1000, "client closed"));
          socket.end();
        }
      },
      onProtocolFailure: (reason) => {
        console.error(`[proxy] connection ${connectionId}: ${reason}`);
        socket.destroy();
      },
    });

    socket.on("data", (chunk) => reader.absorb(chunk));
    socket.on("close", () => {
      console.log(`[proxy] connection ${connectionId} closed by the client; ${brokenCount} answer(s) were broken on it`);
      if (upstream.readyState <= 1) upstream.close();
    });
    socket.on("error", () => {
      if (upstream.readyState <= 1) upstream.close();
    });
  });

  await new Promise((resolveListening, rejectListening) => {
    httpServer.once("error", rejectListening);
    httpServer.listen(options.port, options.address, resolveListening);
  });
  console.log(`[proxy] listening on ws://${options.address}:${options.port}/ws, forwarding to ${options.upstream}`);
  return 0;
}

// Keeps the rewrite log readable without recomputing the "before" twice.
function before(rewritten) {
  return rewritten.before;
}

const exitCode = await misrepresentAHostToSeedAConformanceFault();
if (exitCode !== 0) process.exit(exitCode);
