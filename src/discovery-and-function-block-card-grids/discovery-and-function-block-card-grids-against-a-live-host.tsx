import { useEffect, useMemo, useRef, useState } from "react";
import { CardQuackStripPondProvider } from "../card-grid/CardQuackStrip";
import { QuackInspectorProvider } from "../inspect/QuackInspector";
import {
  HostSessionProvider,
  useHostSession,
} from "../session/host-capability-context";
import {
  describeSdk,
  hostProcessNameOf,
  readHandshakeMessage,
  type HandshakeReading,
} from "../session/host-handshake";
import {
  TransportClient,
  type CallLogEntry,
  type LinkStatus,
  type Node,
} from "../transport";
import { DiscoveredDeviceCardGrid } from "./DiscoveredDeviceCardGrid";
import { FunctionBlockTypeCardGrid } from "./FunctionBlockTypeCardGrid";
import { OPERATION_TABLE_ROWS_THESE_GRIDS_NAME } from "./wire-methods-and-capability-ids-these-grids-name";
import "../card-grid/card-grid.css";
import "./discovery-and-function-block-card-grids.css";

/**
 * The two creating grids of §2.5 and §2.7, driven against a real host over a
 * real socket.
 *
 * A second entry point rather than a change to src/App.tsx, which another lane
 * owns this wave. Nothing here is synthetic: the device cards come from
 * whatever `scan_available_devices` answers, the type cards from whatever
 * `list_function_block_types` answers, and the gap states from the handshake the
 * host actually sent. Point it at a host with `?ws=`:
 *
 *   http://127.0.0.1:7833/?ws=ws://127.0.0.1:7833/ws
 *
 * With no `?ws=` it opens a socket against the origin that served the page,
 * which is what the built SPA does in production.
 */

/** The contract rows these two grids name, printed so a reader can check them. */
const operationTableRowsThisPageDrives = OPERATION_TABLE_ROWS_THESE_GRIDS_NAME.map(
  (row) => `${row.wireMethod} -> ${row.capability}`,
);

function socketUrlForThisPage(): string {
  const asked = new URLSearchParams(window.location.search).get("ws");
  if (asked !== null && asked.length > 0) return asked;
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
}

export function DiscoveryAndFunctionBlockCardGridsAgainstALiveHost() {
  const backendUrl = useMemo(() => socketUrlForThisPage(), []);
  const client = useMemo(() => new TransportClient(backendUrl), [backendUrl]);

  const [link, setLink] = useState<LinkStatus>(() => client.getStatus());
  const [pond, setPond] = useState<readonly CallLogEntry[]>(() => client.getPond());
  const [handshakeReading, setHandshakeReading] =
    useState<HandshakeReading | null>(null);
  const [strayNonEnvelopeMessageCount, setStrayNonEnvelopeMessageCount] =
    useState(0);
  const nonEnvelopeMessagesSeen = useRef(0);

  const [connected, setConnected] = useState<{
    node: Node;
    connectionString: string;
  } | null>(null);

  useEffect(() => {
    const offStatus = client.onStatus(setLink);
    const offPond = client.onPond(setPond);
    const offGreeting = client.onNonEnvelopeServerMessage((message) => {
      nonEnvelopeMessagesSeen.current += 1;
      if (nonEnvelopeMessagesSeen.current === 1) {
        setHandshakeReading(
          readHandshakeMessage(message.raw, message.text, message.ordinalInSession),
        );
      } else {
        setStrayNonEnvelopeMessageCount((count) => count + 1);
      }
    });
    client.connect();
    return () => {
      offStatus();
      offPond();
      offGreeting();
      client.close("the discovery and function block card grids page was torn down");
    };
  }, [client]);

  return (
    <HostSessionProvider
      backendUrl={backendUrl}
      socketState={link.state}
      handshakeReading={handshakeReading}
      strayNonEnvelopeMessageCount={strayNonEnvelopeMessageCount}
    >
      <QuackInspectorProvider
        pond={pond}
        hostProcessName={hostProcessNameOf(handshakeReading)}
        socketUrl={backendUrl}
      >
      <CardQuackStripPondProvider pond={{ entries: pond }}>
        <div className="app">
          <PageHeader
            backendUrl={backendUrl}
            link={link}
            handshakeReading={handshakeReading}
            operationTableRows={operationTableRowsThisPageDrives}
          />

          <main className="pane">
            {link.state !== "open" ? (
              <p className="muted">
                The socket to {backendUrl} is {link.state}
                {link.reason === null ? "" : `: ${link.reason}`}. Both grids ask
                the host what it can do before they draw anything, so nothing is
                drawn until the handshake arrives — a grid that guessed would be
                inventing gaps.
              </p>
            ) : (
              <>
                <DiscoveredDeviceCardGrid
                  client={client}
                  onDeviceConnected={(node, connectionString) =>
                    setConnected({ node, connectionString })
                  }
                />

                <hr className="page-rule" />

                <FunctionBlockTypeCardGrid
                  client={client}
                  parentNodeId={connected?.node.id ?? ""}
                  parentNodeName={
                    connected === null
                      ? "no device connected on this session yet"
                      : `${connected.node.name}, connected from ${connected.connectionString}`
                  }
                />
              </>
            )}
          </main>

        </div>
      </CardQuackStripPondProvider>
      </QuackInspectorProvider>
    </HostSessionProvider>
  );
}

function PageHeader({
  backendUrl,
  link,
  handshakeReading,
  operationTableRows,
}: {
  backendUrl: string;
  link: LinkStatus;
  handshakeReading: HandshakeReading | null;
  operationTableRows: readonly string[];
}) {
  return (
    <header className="topbar">
      <strong>Discovery and function block type card grids</strong>
      <span className="muted mono">{backendUrl}</span>
      <span className="muted">
        socket {link.state}
        {link.reason === null ? "" : ` (${link.reason})`}
      </span>
      <span className="spacer" />
      <HandshakeSummary handshakeReading={handshakeReading} />
      <details className="page-registration-report">
        <summary className="muted">
          {operationTableRows.length} contract operation rows these grids name
        </summary>
        <ul>
          {operationTableRows.map((line) => (
            <li key={line} className="muted">
              {line}
            </li>
          ))}
        </ul>
      </details>
    </header>
  );
}

function HandshakeSummary({
  handshakeReading,
}: {
  handshakeReading: HandshakeReading | null;
}) {
  const session = useHostSession();
  if (handshakeReading === null) {
    return <span className="muted">no handshake read yet</span>;
  }
  if (!handshakeReading.read) {
    return (
      <span className="muted">
        the first server message was not a handshake: {handshakeReading.refusal}
      </span>
    );
  }
  const reading = session?.capabilityReading ?? null;
  return (
    <span className="muted">
      {handshakeReading.handshake.implementation.name}{" "}
      {handshakeReading.handshake.implementation.version} · sdk{" "}
      {describeSdk(handshakeReading.handshake)} ·{" "}
      {reading === null
        ? "capability standings not computed"
        : `${reading.servedCapabilityIds.length} served, ${reading.gappedCapabilityIds.length} gapped: ${reading.gappedCapabilityIds.join(", ")}`}
    </span>
  );
}
