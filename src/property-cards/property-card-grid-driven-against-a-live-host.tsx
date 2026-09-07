import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TransportClient,
  hostSocketUrl,
  WireError,
  type CallLogEntry,
  type LinkStatus,
  type Node,
} from "../transport";
import { HostSessionProvider } from "../session/host-capability-context";
import {
  hostProcessNameOf,
  readHandshakeMessage,
  type HandshakeReading,
} from "../session/host-handshake";
import {
  InspectorModeControls,
  QuackInspectorProvider,
} from "../inspect/QuackInspector";
import { CardQuackStripPondProvider } from "../card-grid/CardQuackStrip";
import { PropertyCardGrid } from "./PropertyCardGrid";

/**
 * The property card grid, driven against a real host over a real socket.
 *
 * src/main.tsx renders App, and App.tsx belongs to another lane right now, so
 * the property card grid gets a second root rather than an edit to that file.
 * This page is the smallest thing that can put §2.2's grid in front of a live
 * `quackoscope-host-mock`: one socket, one handshake, one component list, one
 * grid — and the pond readout that proves the slider's commit model.
 *
 * The pond readout is not decoration. The user's ruling says "a drag must NOT
 * write per pixel", and the only honest way to show that is to count the
 * `set_property_value` calls the transport actually made and print the literal
 * number beside the drag that made them. Every call the socket carried is listed
 * with its parameters, so a drag across the whole track either shows one line or
 * it shows the defect.
 */

const CONNECTION_STRING_THE_MOCK_HOST_ACCEPTS = "daqref://device0";

export function PropertyCardGridDrivenAgainstALiveHost() {
  const socketUrl = useMemo(() => hostSocketUrl(), []);
  const client = useMemo(() => new TransportClient(socketUrl), [socketUrl]);

  const [link, setLink] = useState<LinkStatus>(() => client.getStatus());
  const [pond, setPond] = useState<readonly CallLogEntry[]>(() => client.getPond());
  const [handshakeReading, setHandshakeReading] =
    useState<HandshakeReading | null>(null);
  const [strayNonEnvelopeMessageCount, setStrayNonEnvelopeMessageCount] =
    useState(0);
  const nonEnvelopeMessagesSeen = useRef(0);

  const [nodes, setNodes] = useState<Node[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connectionReport, setConnectionReport] = useState<string>(
    `not connected yet: ${socketUrl}`,
  );

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
      client.close("the property card grid page was torn down");
    };
  }, [client]);

  const connectAndListComponents = useCallback(async () => {
    try {
      const device = await client.call("connect_device", {
        connection_string: CONNECTION_STRING_THE_MOCK_HOST_ACCEPTS,
      });
      const tree = await client.call("get_component_tree", {});
      setNodes(tree);
      setSelectedNodeId((current) => current ?? device.id);
      setConnectionReport(
        `connect_device("${CONNECTION_STRING_THE_MOCK_HOST_ACCEPTS}") answered with ${device.id} ` +
          `"${device.name}"; get_component_tree returned ${tree.length} components`,
      );
    } catch (e) {
      setConnectionReport(
        e instanceof WireError
          ? `connect_device("${CONNECTION_STRING_THE_MOCK_HOST_ACCEPTS}") was refused with ${e.code}: ${e.detail}`
          : `connect_device("${CONNECTION_STRING_THE_MOCK_HOST_ACCEPTS}") failed: ${String(e)}`,
      );
    }
  }, [client]);

  useEffect(() => {
    if (link.state !== "open") return;
    void connectAndListComponents();
  }, [link.state, connectAndListComponents]);

  useEffect(() => {
    const offAdded = client.on("component_added", ({ node }) => {
      setNodes((current) =>
        current.some((each) => each.id === node.id)
          ? current.map((each) => (each.id === node.id ? node : each))
          : [...current, node],
      );
    });
    const offRemoved = client.on("component_removed", ({ node_id }) => {
      setNodes((current) => current.filter((each) => each.id !== node_id));
      setSelectedNodeId((current) => (current === node_id ? null : current));
    });
    return () => {
      offAdded();
      offRemoved();
    };
  }, [client]);

  const selected = nodes.find((each) => each.id === selectedNodeId) ?? null;
  const hostProcessName = hostProcessNameOf(handshakeReading);

  const writeCalls = pond.filter((entry) => entry.method === "set_property_value");

  return (
    <HostSessionProvider
      backendUrl={socketUrl}
      socketState={link.state}
      handshakeReading={handshakeReading}
      strayNonEnvelopeMessageCount={strayNonEnvelopeMessageCount}
    >
      <QuackInspectorProvider
        pond={pond}
        hostProcessName={hostProcessName}
        socketUrl={socketUrl}
      >
      <CardQuackStripPondProvider pond={{ entries: pond }}>
        <div className="app">
          <header className="topbar">
            <span className="brand">quackoscope</span>
            <span className="muted mono">property card grid · §2.2 (T3)</span>
            <span className="muted mono">{socketUrl}</span>
            <span className="muted mono">host {hostProcessName}</span>
            <span className="spacer" />
            <InspectorModeControls />
            <span className={`pill pill--${link.state}`}>{link.state}</span>
          </header>

          <p className="banner mono">{connectionReport}</p>

          <main className="workspace">
            <section className="pane pane--tree">
              <h3>Components</h3>
              <ul className="tree">
                {nodes.map((node) => (
                  <li key={node.id}>
                    <button
                      type="button"
                      className={`tree-row ${node.id === selectedNodeId ? "tree-row--selected" : ""}`}
                      onClick={() => setSelectedNodeId(node.id)}
                      data-quack-chrome=""
                    >
                      <span className="tree-name">{node.name}</span>
                      <span className="tree-kind">{node.kind}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="pane pane--detail">
              {selected === null ? (
                <p className="muted pad">
                  No component selected. The list on the left is what{" "}
                  <code className="mono">get_component_tree</code> returned.
                </p>
              ) : (
                <>
                  <h3>
                    {selected.name} <span className="muted mono">{selected.id}</span>
                  </h3>
                  <PropertyCardGrid
                    key={`property-cards:${selected.id}`}
                    client={client}
                    node={selected}
                  />
                </>
              )}

              <SetPropertyValueCallsThisSession calls={writeCalls} />
            </section>
          </main>
        </div>
      </CardQuackStripPondProvider>
      </QuackInspectorProvider>
    </HostSessionProvider>
  );
}

/**
 * Every `set_property_value` this socket has carried, with the value each one
 * sent, newest last.
 *
 * This exists to make one claim checkable rather than asserted: dragging a
 * slider from one end of its track to the other adds exactly ONE line here. A
 * slider that wrote per pixel would add several hundred, and — per the user's
 * ruling — would walk straight into the known defect that wedges the C++ host
 * when a large value is written into a channel count.
 */
function SetPropertyValueCallsThisSession({
  calls,
}: {
  calls: readonly CallLogEntry[];
}) {
  return (
    <section className="write-call-log">
      <h3>
        set_property_value calls on this socket this session: {calls.length}
      </h3>
      {calls.length === 0 ? (
        <p className="muted mono">
          none yet — nothing on any card has been committed, and a drag in
          progress must not add one
        </p>
      ) : (
        <ol className="write-call-log-list mono">
          {calls.map((entry) => (
            <li key={entry.seq}>
              <span className="write-call-log-seq">#{entry.seq}</span>{" "}
              {describeWriteCall(entry)}{" "}
              <span className="muted">
                {entry.ok === null
                  ? "in flight"
                  : entry.ok
                    ? `ok in ${entry.durationMs ?? "?"} ms`
                    : `${entry.error?.code}: ${entry.error?.detail}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function describeWriteCall(entry: CallLogEntry): string {
  const params = entry.params;
  if (typeof params !== "object" || params === null) return JSON.stringify(params);
  const held = params as Record<string, unknown>;
  return `${String(held.node_id)}.${String(held.property_id)} = ${JSON.stringify(held.value)}`;
}
