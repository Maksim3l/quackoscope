import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TransportClient,
  WireError,
  hostSocketUrl,
  type LinkStatus,
  type Node,
} from "./transport";
import { ComponentTree } from "./components/ComponentTree";
import { ConnectionScreen } from "./components/ConnectionScreen";
import { PropertyGrid } from "./components/PropertyGrid";
import { SignalPlot } from "./components/SignalPlot";
import { OpButton } from "./ui/op";
import "./App.css";

/** Display only. The frontend never learns which host implementation answers. */
const HOST_PROCESS_NAME = "quackoscope-host-cpp";

export default function App() {
  const [client] = useState(() => new TransportClient(hostSocketUrl()));
  const [link, setLink] = useState<LinkStatus>(() => client.getStatus());
  const [pondSize, setPondSize] = useState(0);

  const [device, setDevice] = useState<Node | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Socket lifecycle.
  useEffect(() => {
    const offStatus = client.onStatus(setLink);
    const offPond = client.onPond((p) => setPondSize(p.length));
    client.connect();
    return () => {
      offStatus();
      offPond();
      client.close("view torn down");
    };
  }, [client]);

  // A dropped socket invalidates the session: clear everything. No spinner is
  // left running, because the connection screen is gated on link state, not on
  // an in-flight promise.
  useEffect(() => {
    if (link.state === "closed" || link.state === "connecting") {
      setDevice(null);
      setNodes([]);
      setSelectedId(null);
      setConnectBusy(false);
      setConnectError(null);
    }
  }, [link.state]);

  // Watchdog: a WebSocket handshake that never settles must not leave the UI
  // sitting on "connecting" forever. A hung spinner is a defect.
  useEffect(() => {
    if (link.state !== "connecting") return;
    const t = setTimeout(() => {
      client.close(`no answer from ${hostSocketUrl()} within 6 s`);
    }, 6000);
    return () => clearTimeout(t);
  }, [client, link.state]);

  // Server-pushed component and device events.
  useEffect(() => {
    const offs = [
      client.on("component_added", ({ node }) => {
        setNodes((ns) =>
          ns.some((n) => n.id === node.id)
            ? ns.map((n) => (n.id === node.id ? node : n))
            : [...ns, node],
        );
      }),
      client.on("component_removed", ({ node_id }) => {
        setNodes((ns) => ns.filter((n) => n.id !== node_id));
        setSelectedId((s) => (s === node_id ? null : s));
      }),
      client.on("device_disconnected", ({ node_id, reason }) => {
        setNotice(`Device ${node_id} disconnected: ${reason}`);
        setDevice(null);
        setNodes([]);
        setSelectedId(null);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);

  const connectDevice = useCallback(
    async (connectionString: string) => {
      setConnectBusy(true);
      setConnectError(null);
      setNotice(null);
      try {
        const dev = await client.call("connect_device", {
          connection_string: connectionString,
        });
        const tree = await client.call("get_component_tree", {});
        setDevice(dev);
        setNodes(tree);
        setSelectedId(dev.id);
      } catch (e) {
        setConnectError(
          e instanceof WireError ? `${e.code}: ${e.detail}` : String(e),
        );
      } finally {
        setConnectBusy(false);
      }
    },
    [client],
  );

  const reconnect = useCallback(() => {
    client.clearPond();
    setNotice(null);
    client.connect();
  }, [client]);

  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">quackoscope</span>
        <span className="muted mono">{HOST_PROCESS_NAME}</span>
        <span className="muted mono">{hostSocketUrl()}</span>
        <span className="spacer" />
        <span className="muted mono" title="pond: the running call log">
          pond {pondSize}
        </span>
        <span className={`pill pill--${link.state}`}>{link.state}</span>
      </header>

      {notice !== null && (
        <div className="banner" role="status">
          {notice}
        </div>
      )}

      {link.state !== "open" ? (
        <LinkDown link={link} onReconnect={reconnect} />
      ) : device === null ? (
        <ConnectionScreen
          busy={connectBusy}
          error={connectError}
          onConnect={(cs) => void connectDevice(cs)}
        />
      ) : (
        <main className="workspace">
          <section className="pane pane--tree">
            <h3>Components</h3>
            <ComponentTree
              nodes={nodes}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </section>

          <section className="pane pane--detail">
            {selected === null ? (
              <p className="muted pad">Select a component.</p>
            ) : (
              <>
                <h3>
                  {selected.name}{" "}
                  <span className="muted mono">{selected.id}</span>
                </h3>
                {/* Both children are keyed by node id so selecting another
                    component gets a fresh grid and a fresh plot rather than
                    reusing the previous node's state: without the grid key, a
                    set_property_value still in flight for the previous node
                    resolves into the new node's grid and paints the wrong
                    component's descriptors. The keys carry a per-child prefix
                    because these are siblings in one list, and two siblings
                    sharing a key make React mis-reconcile them. */}
                <PropertyGrid
                  key={`grid:${selected.id}`}
                  client={client}
                  node={selected}
                />
                {selected.kind === "signal" && (
                  <SignalPlot
                    key={`plot:${selected.id}`}
                    client={client}
                    signal={selected}
                  />
                )}
              </>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

function LinkDown({
  link,
  onReconnect,
}: {
  link: LinkStatus;
  onReconnect: () => void;
}) {
  const connecting = link.state === "connecting";
  return (
    <div className="screen screen--centered">
      <div className="card">
        <h2>{connecting ? "Reaching the host…" : "Cannot reach host"}</h2>
        <p className="muted">
          {connecting
            ? `Opening ${hostSocketUrl()}.`
            : (link.reason ?? "The host socket is not open.")}
        </p>
        <p className="muted">
          The session is cleared whenever the socket drops. Start{" "}
          <code>{HOST_PROCESS_NAME}</code> and reconnect.
        </p>
        <OpButton
          op={["session.reconnect"]}
          onClick={onReconnect}
          disabled={connecting}
        >
          {connecting ? "Connecting…" : "Reconnect"}
        </OpButton>
      </div>
    </div>
  );
}
