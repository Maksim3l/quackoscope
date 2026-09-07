import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TransportClient,
  WireError,
  hostSocketUrl,
  type CallLogEntry,
  type LinkStatus,
  type Node,
} from "./transport";
import { CardQuackStripPondProvider } from "./card-grid/CardQuackStrip";
import { ComponentIconSprite } from "./component-tree/component-icon-sprite";
import { ChooseWhichViewTheLeftPaneShows } from "./component-tree/ChooseWhichViewTheLeftPaneShows";
import { ComponentTree } from "./component-tree/ComponentTree";
import {
  DEFAULT_TREE_VIEW_PRESET_ID,
  treeViewPreset,
  viewReplacesTheTreeWithTheModuleCardGrid,
  type TreeViewPresetId,
} from "./component-tree/tree-view-presets";
import type { WireCallOutcome } from "./component-tree/menu-groups-per-node-kind";
import type { OperationModeListing } from "./component-tree/TreeRowActionMenu";
import { SelectedComponentHeaderBar } from "./component-tree/SelectedComponentHeaderBar";
import { ConnectionScreen } from "./components/ConnectionScreen";
import { DiscoveredDeviceCardGrid } from "./discovery-and-function-block-card-grids/DiscoveredDeviceCardGrid";
import { FunctionBlockTypeCardGrid } from "./discovery-and-function-block-card-grids/FunctionBlockTypeCardGrid";
import {
  InspectorModeControls,
  QuackInspectorProvider,
  useShowTheseEntriesInThePond,
} from "./inspect/QuackInspector";
import type { LoadedModuleOnACard } from "./loaded-modules-card-grid/identity-of-a-module-whose-id-the-host-left-empty";
import { useOneModuleListingForBothPanes } from "./loaded-modules-card-grid/keep-one-module-listing-for-the-grid-and-the-detail-pane";
import { LoadedModuleCardGrid } from "./loaded-modules-card-grid/LoadedModuleCardGrid";
import { LoadedModuleDetailPanel } from "./loaded-modules-card-grid/LoadedModuleDetailPanel";
import { PropertyCardGrid } from "./property-cards/PropertyCardGrid";
import { DataDescriptorCardGrid } from "./signal-and-input-port-card-grids/DataDescriptorCardGrid";
import { InputPortCardGrid } from "./signal-and-input-port-card-grids/InputPortCardGrid";
import { SignalCardGrid } from "./signal-and-input-port-card-grids/SignalCardGrid";
import { ConnectedHostButton } from "./session/ConnectedHostButtonAndPanel";
import {
  configuredBackends,
  describeWhatSwitchingBackendDoes,
  readAddedBackendUrlsFromBrowserStorage,
  readChosenBackendUrlFromBrowserStorage,
  writeAddedBackendUrlsToBrowserStorage,
  writeChosenBackendUrlToBrowserStorage,
} from "./session/backend-choices";
import {
  readBackendNamesSeenFromBrowserStorage,
  writeBackendNamesSeenToBrowserStorage,
  type BackendNamesSeen,
} from "./session/backend-display-name";
import { CapabilityGapNotice } from "./session/CapabilityGapNotice";
import {
  HostSessionProvider,
  useCapabilityStanding,
  useHostProcessName,
} from "./session/host-capability-context";
import {
  hostProcessNameOf,
  readHandshakeMessage,
  type HandshakeReading,
} from "./session/host-handshake";
import { OpButton } from "./ui/op";
import "./App.css";
import "./component-tree/component-tree.css";
import "./card-grid/card-grid.css";
import "./property-cards/property-cards.css";
import "./discovery-and-function-block-card-grids/discovery-and-function-block-card-grids.css";
import "./signal-and-input-port-card-grids/signal-and-input-port-card-grids.css";
import "./loaded-modules-card-grid/loaded-modules-card-grid.css";

/**
 * The app owns one socket at a time, opened against the CHOSEN backend.
 *
 * There is no constant naming a host anywhere in this file any more. What the
 * header says about the host comes from the handshake that host sent, and what
 * the controls are allowed to do comes from the gap list computed against the
 * contract baseline in src/session/. Switching backend replaces the client,
 * which is what makes the switch a full reconnect rather than a handover.
 */
export default function App() {
  const urlOfTheHostThatServedThisPage = useMemo(() => hostSocketUrl(), []);

  const [addedBackendUrls, setAddedBackendUrls] = useState<string[]>(() =>
    readAddedBackendUrlsFromBrowserStorage(),
  );
  const [backendUrl, setBackendUrl] = useState<string>(() =>
    readChosenBackendUrlFromBrowserStorage(urlOfTheHostThatServedThisPage),
  );
  const backends = useMemo(
    () => configuredBackends(urlOfTheHostThatServedThisPage, addedBackendUrls),
    [urlOfTheHostThatServedThisPage, addedBackendUrls],
  );

  // A new URL is a new client. Everything the previous session held — the
  // socket, the pending calls, the pond, the handshake — belongs to the old
  // client and goes with it.
  const client = useMemo(() => new TransportClient(backendUrl), [backendUrl]);

  const [link, setLink] = useState<LinkStatus>(() => client.getStatus());
  const [pond, setPond] = useState<readonly CallLogEntry[]>(() => client.getPond());
  const [handshakeReading, setHandshakeReading] =
    useState<HandshakeReading | null>(null);
  const [strayNonEnvelopeMessageCount, setStrayNonEnvelopeMessageCount] =
    useState(0);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  // Which implementation name each backend URL has ever reported. The selector
  // lists backends by NAME, so a backend whose host is down has to keep the name
  // the last handshake from it gave rather than falling back to its port.
  const [backendNamesSeen, setBackendNamesSeen] = useState<BackendNamesSeen>(() =>
    readBackendNamesSeenFromBrowserStorage(),
  );
  const nonEnvelopeMessagesSeen = useRef(0);

  // Socket lifecycle. Re-runs whenever the chosen backend changes, because the
  // client changed with it.
  useEffect(() => {
    setLink(client.getStatus());
    setPond(client.getPond());
    setHandshakeReading(null);
    setStrayNonEnvelopeMessageCount(0);
    nonEnvelopeMessagesSeen.current = 0;

    const offStatus = client.onStatus(setLink);
    const offPond = client.onPond(setPond);
    // The handshake: the first server text message that is neither a result nor
    // an event. The transport used to drop this shape, so a host that greeted
    // the app was ignored.
    const offGreeting = client.onNonEnvelopeServerMessage((message) => {
      nonEnvelopeMessagesSeen.current += 1;
      if (nonEnvelopeMessagesSeen.current === 1) {
        const reading = readHandshakeMessage(
          message.raw,
          message.text,
          message.ordinalInSession,
        );
        setHandshakeReading(reading);
        if (reading.read) {
          const reported = reading.handshake.implementation.name;
          setBackendNamesSeen((seen) => {
            if (seen[backendUrl] === reported) return seen;
            const next = { ...seen, [backendUrl]: reported };
            writeBackendNamesSeenToBrowserStorage(next);
            return next;
          });
        }
      } else {
        setStrayNonEnvelopeMessageCount((count) => count + 1);
      }
    });

    client.connect();
    return () => {
      offStatus();
      offPond();
      offGreeting();
      client.close("view torn down");
    };
  }, [client, backendUrl]);

  // A handshake describes a LIVE session and nothing else. The moment the link
  // leaves "open" — the host was killed, the socket dropped, the watchdog gave
  // up — the handshake that host sent describes nothing, so it goes, exactly as
  // LinkState's own comment on "closed" requires: "The session is invalid; state
  // must be cleared." Without this the header went on printing a dead host's
  // implementation name, version and openDAQ version over a socket that was
  // gone, while the body of the page offered a reconnect.
  useEffect(() => {
    if (link.state === "open") return;
    setHandshakeReading(null);
    setStrayNonEnvelopeMessageCount(0);
    nonEnvelopeMessagesSeen.current = 0;
  }, [link.state]);

  // Watchdog: a WebSocket handshake that never settles must not leave the UI
  // sitting on "connecting" forever. A hung spinner is a defect, and a chosen
  // backend with nothing listening must land on the reconnect screen like any
  // other dead socket.
  useEffect(() => {
    if (link.state !== "connecting") return;
    const t = setTimeout(() => {
      client.close(`no answer from ${backendUrl} within 6 s`);
    }, 6000);
    return () => clearTimeout(t);
  }, [client, backendUrl, link.state]);

  const switchToBackend = useCallback(
    (url: string) => {
      if (url === backendUrl) return;
      setSwitchNotice(describeWhatSwitchingBackendDoes(backendUrl, url));
      writeChosenBackendUrlToBrowserStorage(url);
      setBackendUrl(url);
    },
    [backendUrl],
  );

  const addBackendUrl = useCallback((url: string) => {
    setAddedBackendUrls((urls) => {
      const next = urls.includes(url) ? urls : [...urls, url];
      writeAddedBackendUrlsToBrowserStorage(next);
      return next;
    });
  }, []);

  const removeBackendUrl = useCallback((url: string) => {
    setAddedBackendUrls((urls) => {
      const next = urls.filter((each) => each !== url);
      writeAddedBackendUrlsToBrowserStorage(next);
      return next;
    });
  }, []);

  const reconnect = useCallback(() => {
    client.clearPond();
    setSwitchNotice(null);
    client.connect();
  }, [client]);

  const hostProcessName = hostProcessNameOf(handshakeReading);

  return (
    <HostSessionProvider
      backendUrl={backendUrl}
      socketState={link.state}
      handshakeReading={handshakeReading}
      strayNonEnvelopeMessageCount={strayNonEnvelopeMessageCount}
    >
      {/* The inspect layer wraps the whole app: it publishes showQuack, which a
          card's quack strip calls directly, and it owns the badge layer and the
          drawer, both of which are fixed-position and belong to no pane. */}
      <QuackInspectorProvider
        pond={pond}
        hostProcessName={hostProcessName}
        socketUrl={backendUrl}
      >
        <div className="app">
          {/* §1.5's 33 icon symbols, defined once for the whole page. Nothing
              is rendered here: every <ComponentIcon> is a <use> into this. */}
          <ComponentIconSprite />
          {/* The top bar carries five things, and each one answers a question a
              reader has continuously: what is this (the brand), which host am I
              looking at and is it answering (the host button, which also says
              how many things that host cannot do, and only while some cannot),
              how much has this session asked it (the call count), and am I in
              inspector mode. Everything else the bar used to print — the host's
              process name and version, the openDAQ version and commit, the
              "gaps 1/11" chip, the socket pill, the separate backend button —
              is behind the host button now. */}
          <header className="topbar">
            <span className="brand">quackoscope</span>
            <ConnectedHostButton
              backends={backends}
              chosenUrl={backendUrl}
              link={link}
              namesSeen={backendNamesSeen}
              onChoose={switchToBackend}
              onAdd={addBackendUrl}
              onRemove={removeBackendUrl}
            />
            <span className="spacer" />
            <InspectorModeControls />
          </header>

          {switchNotice !== null && (
            <div className="banner" role="status">
              {switchNotice}
            </div>
          )}

          {link.state !== "open" ? (
            <LinkDown link={link} backendUrl={backendUrl} onReconnect={reconnect} />
          ) : (
            <DeviceWorkspace client={client} pond={pond} />
          )}
        </div>
      </QuackInspectorProvider>
    </HostSessionProvider>
  );
}

/**
 * Everything that needs a device. It lives below the handshake provider so it
 * can consult the computed capability standings before it asks a host for
 * anything the host already said it will not do.
 */
function DeviceWorkspace({
  client,
  pond,
}: {
  client: TransportClient;
  pond: readonly CallLogEntry[];
}) {
  const [device, setDevice] = useState<Node | null>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [leftPaneViewId, setLeftPaneViewId] = useState<TreeViewPresetId>(
    DEFAULT_TREE_VIEW_PRESET_ID,
  );
  const [selection, setSelection] = useState<LeftPaneSelection | null>(null);
  const [detailBoard, setDetailBoard] = useState<DetailBoard>("properties");
  const showTheseEntriesInThePond = useShowTheseEntriesInThePond();
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [deviceNotice, setDeviceNotice] = useState<string | null>(null);

  const treeStanding = useCapabilityStanding("tree.read");
  const treeIsGapped =
    treeStanding !== null && !treeStanding.served && treeStanding.gap !== null;
  const moduleReadStanding = useCapabilityStanding("module.read");
  const moduleReadIsGapped =
    moduleReadStanding !== null && !moduleReadStanding.served;
  const hostProcessName = useHostProcessName();

  const theLeftPaneIsTheModuleGrid =
    viewReplacesTheTreeWithTheModuleCardGrid(leftPaneViewId);

  // The Modules view's one listing, read by the grid on the left and by the
  // detail panel on the right. Nothing is sent until that view is chosen, and
  // nothing is sent at all against a host that gaps module.read.
  const moduleListing = useOneModuleListingForBothPanes(
    client,
    theLeftPaneIsTheModuleGrid,
    !moduleReadIsGapped,
  );

  // A new client means a new session: nothing from the previous host survives.
  useEffect(() => {
    setDevice(null);
    setNodes([]);
    setSelection(null);
    setConnectBusy(false);
    setConnectError(null);
    setDeviceNotice(null);
    setDetailBoard("properties");
    setLeftPaneViewId(DEFAULT_TREE_VIEW_PRESET_ID);
  }, [client]);

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
        setSelection((s) =>
          s !== null &&
          s.selectedInTheLeftPane === "component" &&
          s.nodeId === node_id
            ? null
            : s,
        );
      }),
      client.on("device_disconnected", ({ node_id, reason }) => {
        setDeviceNotice(`Device ${node_id} disconnected: ${reason}`);
        setDevice(null);
        setNodes([]);
        setSelection(null);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);

  /**
   * Re-reads the whole tree after a card added something to it.
   *
   * The host emits `component_added` for every node it creates, and the listener
   * above folds those in — but a device connected through the discovery grid
   * brings a subtree with it, and re-reading is the one call that is guaranteed
   * to describe all of it. `get_component_tree` is tree.read, so when that
   * capability is a gap the call is not made at all and the reason is printed
   * instead: an `unsupported` error would hide the reason the host gave.
   */
  const rereadComponentTree = useCallback(async () => {
    if (treeIsGapped) {
      setDeviceNotice(
        `The component tree was not re-read: tree.read is a gap on ${hostProcessName}, ` +
          `so get_component_tree was never sent.`,
      );
      return;
    }
    try {
      setNodes(await client.call("get_component_tree", {}));
    } catch (e) {
      setDeviceNotice(
        `get_component_tree failed after the tree changed: ` +
          (e instanceof WireError ? `${e.code}: ${e.detail}` : String(e)),
      );
    }
  }, [client, treeIsGapped, hostProcessName]);

  const connectDevice = useCallback(
    async (connectionString: string) => {
      setConnectBusy(true);
      setConnectError(null);
      setDeviceNotice(null);
      try {
        const dev = await client.call("connect_device", {
          connection_string: connectionString,
        });
        // get_component_tree is tree.read. When that capability is a gap the
        // call is not made at all: the handshake already said it would be
        // refused, and an `unsupported` error would hide the reason the host
        // gave for the gap.
        if (!treeIsGapped) {
          setNodes(await client.call("get_component_tree", {}));
        } else {
          setNodes([]);
          setDeviceNotice(
            `Connected ${dev.id}, but the component tree was not read: ` +
              `tree.read is a gap on ${hostProcessName}.`,
          );
        }
        setDevice(dev);
        setSelection({ selectedInTheLeftPane: "component", nodeId: dev.id });
      } catch (e) {
        setConnectError(
          e instanceof WireError ? `${e.code}: ${e.detail}` : String(e),
        );
      } finally {
        setConnectBusy(false);
      }
    },
    [client, treeIsGapped, hostProcessName],
  );

  /**
   * The two destructive row actions of decision D7's menu. Both are already in
   * the contract's operation table and both are served by the running C++ host;
   * neither is sent without the inline confirm strip in TreeRowActionMenu, per
   * §D16's "no message boxes, named buttons".
   *
   * Neither call is followed by an optimistic edit of the tree: the host emits
   * `component_removed` / `device_disconnected` for what it actually did, and
   * the listeners above fold that in. What is printed here is what the wire
   * answered, never what the click intended.
   */
  const removeFunctionBlock = useCallback(
    async (nodeId: string) => {
      try {
        await client.call("remove_function_block", { node_id: nodeId });
        setDeviceNotice(
          `remove_function_block { node_id: "${nodeId}" } returned without error. ` +
            `The tree updates from the component_removed event the host emits.`,
        );
      } catch (e) {
        setDeviceNotice(
          `remove_function_block { node_id: "${nodeId}" } failed: ` +
            (e instanceof WireError ? `${e.code}: ${e.detail}` : String(e)),
        );
      }
    },
    [client],
  );

  const disconnectDevice = useCallback(
    async (nodeId: string) => {
      try {
        await client.call("disconnect_device", { node_id: nodeId });
        setDeviceNotice(
          `disconnect_device { node_id: "${nodeId}" } returned without error. ` +
            `Re-reading the component tree.`,
        );
        void rereadComponentTree();
      } catch (e) {
        setDeviceNotice(
          `disconnect_device { node_id: "${nodeId}" } failed: ` +
            (e instanceof WireError ? `${e.code}: ${e.detail}` : String(e)),
        );
      }
    },
    [client, rereadComponentTree],
  );

  /**
   * The four device-row calls the tree's menu sends, each answering with what
   * the HOST said rather than with what the click intended.
   *
   * None of the four has an event behind it: contract/contract.yaml pushes
   * nothing for a lock, an unlock or an operation mode change, so the tree is
   * re-read after each one and the new Node state — locked, operation_mode —
   * arrives on the rows that carry it.
   */
  const outcomeOf = useCallback(
    (call: string, error: unknown): WireCallOutcome => ({
      call,
      refused: true,
      errorCode: error instanceof WireError ? error.code : "internal",
      detail: error instanceof WireError ? error.detail : String(error),
    }),
    [],
  );

  const lockDevice = useCallback(
    async (nodeId: string): Promise<WireCallOutcome> => {
      const call = `lock_device { node_id: "${nodeId}" }`;
      try {
        await client.call("lock_device", { node_id: nodeId });
        await rereadComponentTree();
        return {
          call,
          refused: false,
          errorCode: null,
          detail:
            `The lock is held by this session. Every row under ${nodeId} now reports Node.locked true; ` +
            `the tree was re-read to pick that up, because this contract pushes no event for a lock.`,
        };
      } catch (e) {
        return outcomeOf(call, e);
      }
    },
    [client, rereadComponentTree, outcomeOf],
  );

  const unlockDevice = useCallback(
    async (nodeId: string, force: boolean): Promise<WireCallOutcome> => {
      const call = `unlock_device { node_id: "${nodeId}"${force ? ", force: true" : ""} }`;
      try {
        await client.call(
          "unlock_device",
          force ? { node_id: nodeId, force: true } : { node_id: nodeId },
        );
        await rereadComponentTree();
        return {
          call,
          refused: false,
          errorCode: null,
          detail: `${nodeId} and every row under it report Node.locked false. The tree was re-read to pick that up.`,
        };
      } catch (e) {
        return outcomeOf(call, e);
      }
    },
    [client, rereadComponentTree, outcomeOf],
  );

  const listDeviceOperationModes = useCallback(
    async (nodeId: string): Promise<OperationModeListing> => {
      const call = `get_device_operation_modes { node_id: "${nodeId}" }`;
      try {
        const modes = await client.call("get_device_operation_modes", {
          node_id: nodeId,
        });
        return { call, modes, refusal: null };
      } catch (e) {
        return {
          call,
          modes: null,
          refusal:
            e instanceof WireError ? `${e.code}: ${e.detail}` : String(e),
        };
      }
    },
    [client],
  );

  const setDeviceOperationMode = useCallback(
    async (nodeId: string, mode: string): Promise<WireCallOutcome> => {
      const call = `set_device_operation_mode { node_id: "${nodeId}", mode: "${mode}" }`;
      try {
        await client.call("set_device_operation_mode", {
          node_id: nodeId,
          mode,
        });
        await rereadComponentTree();
        return {
          call,
          refused: false,
          errorCode: null,
          detail: `${nodeId} reports Node.operation_mode "${mode}" after the re-read.`,
        };
      } catch (e) {
        return outcomeOf(call, e);
      }
    },
    [client, rereadComponentTree, outcomeOf],
  );

  // ONE selection for the whole workspace, and the right pane is a function of
  // it. The left pane's content changes with the view — the component tree for
  // five of the six, the module card grid for the sixth — and what it has
  // selected changes with it, so the selection carries WHICH KIND of thing was
  // picked rather than being two ids that can both be set at once.
  const selectedComponent = useMemo(
    () =>
      selection !== null && selection.selectedInTheLeftPane === "component"
        ? (nodes.find((n) => n.id === selection.nodeId) ?? null)
        : null,
    [nodes, selection],
  );
  const selectedModule = useMemo(
    () =>
      selection !== null && selection.selectedInTheLeftPane === "module"
        ? (moduleListing.cards.find(
            (card) => card.cardId === selection.moduleCardId,
          ) ?? null)
        : null,
    [moduleListing.cards, selection],
  );

  // Selecting another component always lands on its properties: a board that
  // belonged to the previous node would be answering a question nobody asked.
  const selectComponent = useCallback((id: string) => {
    setSelection({ selectedInTheLeftPane: "component", nodeId: id });
    setDetailBoard("properties");
  }, []);

  const selectModule = useCallback((entry: LoadedModuleOnACard) => {
    setSelection({
      selectedInTheLeftPane: "module",
      moduleCardId: entry.cardId,
    });
  }, []);

  // The tree menu's two add items: the ADD SURFACE is the card grid the design
  // specification puts in the detail pane, so the item selects the row it was
  // opened on and puts that board on screen for it.
  const openBoardOnNode = useCallback(
    (board: DetailBoard) => (nodeId: string) => {
      setSelection({ selectedInTheLeftPane: "component", nodeId });
      setDetailBoard(board);
    },
    [],
  );

  return (
    // The pond the card quack strips count against is this session's own pond,
    // so a card's count is the number of calls that card actually made, and
    // clicking it narrows the pond pane to exactly those.
    <CardQuackStripPondProvider
      pond={{
        entries: pond,
        showTheseEntriesInThePond: showTheseEntriesInThePond ?? undefined,
      }}
    >
      {deviceNotice !== null && (
        <div className="banner" role="status">
          {deviceNotice}
        </div>
      )}

      {device === null ? (
        <ConnectionScreen
          busy={connectBusy}
          error={connectError}
          onConnect={(cs) => void connectDevice(cs)}
        />
      ) : (
        <main
          className="workspace"
          data-left-pane={theLeftPaneIsTheModuleGrid ? "modules" : "components"}
        >
          <section
            className="pane pane--tree"
            aria-label={`the left pane, ${treeViewPreset(leftPaneViewId).label}`}
          >
            {/* The six views of decision D11, as one dropdown over whichever
                content the left pane is holding, and the re-read for the one
                call that filled it. */}
            <ChooseWhichViewTheLeftPaneShows
              viewId={leftPaneViewId}
              onChoose={setLeftPaneViewId}
              paneLevelReread={
                theLeftPaneIsTheModuleGrid
                  ? {
                      wireMethod: "list_loaded_modules",
                      capability: "module.read",
                      describesWhatItDoes:
                        "sends list_loaded_modules again and replaces every module card with what comes back",
                      onReread: moduleListing.reread,
                    }
                  : {
                      wireMethod: "get_component_tree",
                      capability: "tree.read",
                      describesWhatItDoes:
                        "sends get_component_tree again and replaces every row with what comes back",
                      onReread: () => void rereadComponentTree(),
                    }
              }
            />

            {theLeftPaneIsTheModuleGrid ? (
              <LoadedModuleCardGrid
                listing={moduleListing}
                selectedModuleCardId={selectedModule?.cardId ?? null}
                onSelectModule={selectModule}
              />
            ) : treeIsGapped ? (
              <div className="pad">
                <CapabilityGapNotice
                  standing={treeStanding}
                  hostProcessName={hostProcessName}
                  whatIsBlocked={`The component tree of ${device.name} was never read, so there is nothing to list here.`}
                />
              </div>
            ) : (
              <ComponentTree
                nodes={nodes}
                presetId={leftPaneViewId}
                selectedId={selectedComponent?.id ?? null}
                onSelect={selectComponent}
                onOpenAddDeviceBoard={openBoardOnNode("discovered-devices")}
                onOpenAddFunctionBlockBoard={openBoardOnNode(
                  "function-block-types",
                )}
                onRemoveFunctionBlock={(id) => void removeFunctionBlock(id)}
                onDisconnectDevice={(id) => void disconnectDevice(id)}
                onLockDevice={lockDevice}
                onUnlockDevice={unlockDevice}
                onListDeviceOperationModes={listDeviceOperationModes}
                onSetDeviceOperationMode={setDeviceOperationMode}
              />
            )}
          </section>

          {/* The right pane details whatever the left pane has selected, and the
              left pane's view decides which kind of thing that is: a module
              while the module grid is holding it, a component otherwise. */}
          <section className="pane pane--detail">
            {theLeftPaneIsTheModuleGrid ? (
              selectedModule === null ? (
                <p className="muted pad">
                  Select a module on the left to see the device, function block,
                  server and streaming types it offers.
                </p>
              ) : (
                <LoadedModuleDetailPanel
                  key={`module-detail:${selectedModule.cardId}`}
                  entry={selectedModule}
                />
              )
            ) : selectedComponent === null ? (
              <p className="muted pad">Select a component.</p>
            ) : (
              <>
                <SelectedComponentHeaderBar node={selectedComponent} />

                <DetailBoardChooser
                  selected={selectedComponent}
                  board={detailBoard}
                  onChoose={setDetailBoard}
                />

                {/* Every board is keyed by node id so selecting another
                    component gets a fresh grid and a fresh plot rather than
                    reusing the previous node's state: without the grid key, a
                    set_property_value still in flight for the previous node
                    resolves into the new node's grid and paints the wrong
                    component's descriptors. The keys carry a per-child prefix
                    because these are siblings in one list, and two siblings
                    sharing a key make React mis-reconcile them. */}
                {detailBoard === "properties" && (
                  <PropertiesAndTheRightStack
                    key={`properties-and-right-stack:${selectedComponent.id}`}
                    client={client}
                    nodes={nodes}
                    selected={selectedComponent}
                  />
                )}
                {detailBoard === "discovered-devices" && (
                  <DiscoveredDeviceCardGrid
                    key={`discovery:${selectedComponent.id}`}
                    client={client}
                    onDeviceConnected={(node, connectionString) => {
                      setDeviceNotice(
                        `connect_device answered with node ${node.id} (${node.name}, kind ${node.kind}) ` +
                          `for ${connectionString}. Re-reading the component tree.`,
                      );
                      void rereadComponentTree();
                    }}
                  />
                )}
                {detailBoard === "function-block-types" && (
                  <FunctionBlockTypeCardGrid
                    key={`function-block-types:${selectedComponent.id}`}
                    client={client}
                    parentNodeId={selectedComponent.id}
                    parentNodeName={selectedComponent.name}
                  />
                )}
              </>
            )}
          </section>
        </main>
      )}
    </CardQuackStripPondProvider>
  );
}

/**
 * What the LEFT pane has selected — one value, one kind, never two ids that can
 * both be set.
 *
 * The left pane holds the component tree under five of the six views and the
 * module card grid under the sixth, so the thing a reader picks there is a
 * component or a module depending on the view. The right pane details exactly
 * this, which is why it is one state and not one per pane: a right pane driven
 * by two independent selections could detail a component while the left pane is
 * showing modules.
 */
type LeftPaneSelection =
  | { selectedInTheLeftPane: "component"; nodeId: string }
  | { selectedInTheLeftPane: "module"; moduleCardId: string };

/**
 * Which board the detail pane is showing for the selected COMPONENT.
 *
 * Sections 2.5 and 2.7 of the design specification put discovery and
 * function-block types in the detail pane rather than in a modal, so they are
 * boards beside the properties rather than dialogs over them. The pane keeps one
 * board on screen at a time: they are three answers to three different questions
 * about the same component.
 *
 * Modules used to be a fourth member here, which is what put the module cards on
 * the right while the component tree stayed on the left. It is not a board about
 * a component and never was — a module belongs to the instance's module manager,
 * not to a node — so it is a LEFT PANE VIEW now, and the right pane details the
 * module that view has selected.
 */
type DetailBoard =
  | "properties"
  | "discovered-devices"
  | "function-block-types";

const DETAIL_BOARD_LABEL: Record<DetailBoard, string> = {
  properties: "Properties",
  "discovered-devices": "Add device",
  "function-block-types": "Add function block",
};

const DETAIL_BOARD_TITLE: Record<DetailBoard, string> = {
  properties:
    "the component's properties, one card each — get_property_descriptors and get_property_value",
  "discovered-devices":
    "the devices scan_available_devices finds, one card each, with connect_device on the card",
  "function-block-types":
    "the types list_function_block_types names, one card each, with add_function_block on the card",
};

function DetailBoardChooser({
  selected,
  board,
  onChoose,
}: {
  selected: Node;
  board: DetailBoard;
  onChoose: (board: DetailBoard) => void;
}) {
  // scan_available_devices is an instance-level call and connect_device attaches
  // a device to the instance, so the discovery board belongs on a device.
  // add_function_block takes a parent_id, and openDAQ accepts a device or a
  // folder as that parent.
  const boards: DetailBoard[] = ["properties"];
  if (selected.kind === "device") boards.push("discovered-devices");
  // The reference's menu_add_items: "a function block only takes nested
  // function blocks, a device also takes devices". A channel is an
  // IFunctionBlock in openDAQ, so it takes them too; openDAQ also accepts a
  // folder as add_function_block's parent_id.
  if (
    selected.kind === "device" ||
    selected.kind === "folder" ||
    selected.kind === "function_block" ||
    selected.kind === "channel"
  ) {
    boards.push("function-block-types");
  }
  if (boards.length === 1) return null;

  return (
    <nav className="detail-boards" aria-label="what to show for this component">
      {boards.map((each) => (
        <button
          key={each}
          className={
            "chrome-button" + (each === board ? " chrome-button--on" : "")
          }
          data-quack-chrome=""
          aria-pressed={each === board}
          title={DETAIL_BOARD_TITLE[each]}
          onClick={() => onChoose(each)}
        >
          {DETAIL_BOARD_LABEL[each]}
        </button>
      ))}
    </nav>
  );
}

/**
 * §1.3's BlockView body: the property grid on the left, and the right-hand
 * stack the reference shows beside it.
 *
 * The proportions and the membership are the reference's own, read off
 * `block_view.py`:
 *
 *   device          properties · output signals · device domain
 *   function block  properties · input ports · output signals
 *   channel         properties · input ports · output signals
 *   signal          properties (read-only) · signal info · its descriptors
 *   anything else   properties at full width, which is what the reference does
 *                   with `relwidth=1.0`
 *
 * The uPlot chart used to hang below the property grid here, mounted by a
 * `SignalPlotOrItsGap` wrapper in this file. It has moved into §2.15's signal
 * card, expanded — which is where the design specification puts it, and which
 * means one signal cannot be plotted twice on one screen. The wrapper's job,
 * deciding between the plot and the capability gap so that
 * `src/components/SignalPlot.tsx` is never mounted for a host that does not
 * serve `streaming.decimated`, moved with it and is done in `SignalCard`.
 * SignalPlot itself is unchanged.
 */
function PropertiesAndTheRightStack({
  client,
  nodes,
  selected,
}: {
  client: TransportClient;
  nodes: readonly Node[];
  selected: Node;
}) {
  const hasSignalCards =
    selected.kind === "device" ||
    selected.kind === "function_block" ||
    selected.kind === "channel" ||
    selected.kind === "signal";
  // The reference builds InputPortsView only for an IFunctionBlock, and an
  // IChannel is one. A device has no input ports in the reference's own layout.
  const hasInputPortCards =
    selected.kind === "function_block" || selected.kind === "channel";
  const hasDescriptorCards =
    selected.kind === "signal" || selected.kind === "device";
  const hasARightStack = hasSignalCards || hasInputPortCards || hasDescriptorCards;

  return (
    <div
      className={
        "detail-body" + (hasARightStack ? "" : " detail-body--properties-only")
      }
    >
      <div className="detail-body-properties">
        <PropertyCardGrid
          key={`property-cards:${selected.id}`}
          client={client}
          node={selected}
        />
      </div>

      {hasARightStack && (
        <aside
          className="detail-right-stack"
          aria-label={`what ${selected.name} produces and consumes`}
        >
          {hasInputPortCards && (
            <InputPortCardGrid
              key={`input-ports:${selected.id}`}
              nodes={nodes}
              component={selected}
            />
          )}
          {hasSignalCards && (
            <SignalCardGrid
              key={`signals:${selected.id}`}
              client={client}
              nodes={nodes}
              component={selected}
            />
          )}
          {hasDescriptorCards && (
            <DataDescriptorCardGrid
              key={`descriptors:${selected.id}`}
              component={selected}
            />
          )}
        </aside>
      )}
    </div>
  );
}

function LinkDown({
  link,
  backendUrl,
  onReconnect,
}: {
  link: LinkStatus;
  backendUrl: string;
  onReconnect: () => void;
}) {
  const connecting = link.state === "connecting";
  return (
    <div className="screen screen--centered">
      <div className="card">
        <h2>{connecting ? "Reaching the host…" : "Cannot reach host"}</h2>
        <p className="muted">
          {connecting
            ? `Opening ${backendUrl}.`
            : (link.reason ?? "The host socket is not open.")}
        </p>
        <p className="muted">
          The session is cleared whenever the socket drops: no device, no
          component tree, no handshake. Start a host that listens on{" "}
          <code>{backendUrl}</code> and reconnect, or pick another host from the
          host button in the top bar — this app cannot start a host process
          itself.
        </p>
        <OpButton
          op={["session.reconnect"]}
          onClick={onReconnect}
          disabled={connecting}
        >
          {connecting ? "Connecting…" : `Reconnect to ${backendUrl}`}
        </OpButton>
      </div>
    </div>
  );
}
