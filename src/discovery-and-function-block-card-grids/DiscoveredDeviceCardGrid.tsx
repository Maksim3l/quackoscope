import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceInfo } from "../transport";
import { Card } from "../card-grid/Card";
import { CardGrid } from "../card-grid/CardGrid";
import type { CardCall } from "../card-grid/CardQuackStrip";
import type { CardGridField } from "../card-grid/card-grid-model";
import { copyTextToClipboard } from "../inspect/copy-text-to-clipboard";
import type { CallLogEntry, Node, TransportClient } from "../transport";
import {
  connectDevice,
  scanAvailableDevices,
} from "./send-a-contract-row-and-decode-what-the-host-answered";
import {
  CONNECT_DEVICE,
  DEVICE_CONNECT,
  DEVICE_SCAN,
  SCAN_AVAILABLE_DEVICES,
} from "./wire-methods-and-capability-ids-these-grids-name";
import {
  gappedCardStateMark,
  GapOneLinerInPlaceOfTheMetaLine,
  TheCallThatWouldHavePopulatedThisGridCard,
  useGapOnThisCapability,
} from "./a-gapped-card-teaches-more-than-a-working-one";
import {
  cardStateMarksForDraftCallOutcome,
  describeSendFailure,
  DraftCallCommit,
  NEVER_SENT,
  quackStripLineForDraftedCall,
  type DraftCallOutcome,
  type DraftedCall,
} from "./the-draft-card-is-the-call-preview";

/**
 * §2.5 of the design specification, D1 + T6: the Add device dialog becomes a
 * discovery grid in the detail pane.
 *
 * The reference is a 700 x 400 modal with a three-column table
 * `Name | Location | Connection string`, a `Connection string:` entry below it,
 * an `Add with config…` button, an `Add` button, a `Keep open after adding`
 * checkbox and a right-click `Device Info` window. Here:
 *
 *   one card per discovered device            the table's rows
 *   the typed connection-string card, pinned  the entry, promoted to a peer
 *   connect_device on the card                the Add button, named for the call
 *   the card's back                           the Device Info window (D10, §2.8)
 *   the grid, which never closes              `Keep open after adding`, deleted
 *
 * `--card-min-wide` 360 px, so three columns in a full-width detail pane at
 * 1500 px, per §2.0's table.
 *
 * The contract is the boundary. `scan_available_devices` returns
 * `array of DeviceInfo`, and DeviceInfo is `connection_string`, `name`,
 * `serial` — three fields. The reference's Location column has no field on this
 * wire, and `connect_device` takes `connection_string` only, so §2.6's
 * configuration board has no row to send. Both absences are printed on the
 * cards rather than papered over.
 */

const DEVICE_GLYPH = "▣";

/** What one card's connect button will send, given one discovered device. */
function connectDraftFor(connectionString: string): DraftedCall {
  return {
    wireMethod: CONNECT_DEVICE,
    capability: DEVICE_CONNECT,
    params: { connection_string: connectionString },
    refusalBeforeSending:
      connectionString.trim().length === 0
        ? "type a connection string first — connect_device's connection_string is required and the contract's error set answers an empty one with invalid_value"
        : "",
  };
}

/** §3.2's `×n`: this card's calls, not every connect_device on the session. */
function pondEntryNamesThisConnectionString(
  connectionString: string,
): (entry: CallLogEntry) => boolean {
  return (entry) => {
    const params = entry.params as Record<string, unknown> | null;
    return (
      typeof params === "object" &&
      params !== null &&
      params.connection_string === connectionString
    );
  };
}

type ScanReading =
  | { state: "not-started" }
  | { state: "scanning"; generation: number }
  | { state: "answered"; devices: DeviceInfo[]; atMs: number }
  | { state: "refused"; code: string; detail: string };

export function DiscoveredDeviceCardGrid({
  client,
  onDeviceConnected,
}: {
  client: TransportClient;
  /** The Node connect_device returned, handed up so the tree can show it. */
  onDeviceConnected?: (node: Node, connectionString: string) => void;
}) {
  const scanGap = useGapOnThisCapability(DEVICE_SCAN);
  const [reading, setReading] = useState<ScanReading>({ state: "not-started" });
  const generation = useRef(0);

  const runOneScan = useCallback(() => {
    const thisGeneration = ++generation.current;
    setReading({ state: "scanning", generation: thisGeneration });
    scanAvailableDevices(client).then(
      (devices) => {
        // §2.5: "Results arriving from a superseded scan are dropped by
        // generation, exactly as the reference does with after(0, …)."
        if (thisGeneration !== generation.current) {
          console.log(
            `[discovery] dropped the answer to scan_available_devices generation ${thisGeneration} ` +
              `(${devices.length} devices) because generation ${generation.current} was started after it`,
          );
          return;
        }
        setReading({ state: "answered", devices, atMs: Date.now() });
      },
      (error: unknown) => {
        if (thisGeneration !== generation.current) return;
        const failure = describeSendFailure(error);
        setReading({ state: "refused", ...failure });
      },
    );
  }, [client]);

  // The scan runs when the surface opens, and only when the host serves it.
  // A gapped capability is never sent: the gap gate disables controls, and a
  // surface that fired the call anyway would be going around it.
  useEffect(() => {
    if (scanGap !== null) return;
    runOneScan();
  }, [scanGap, runOneScan]);

  if (scanGap !== null) {
    return (
      <section className="discovery-surface">
        <DiscoverySurfaceHeading
          reading={reading}
          scanIsGapped
          onRescan={runOneScan}
        />
        <TheCallThatWouldHavePopulatedThisGridCard
          standing={scanGap.standing}
          hostProcessName={scanGap.hostProcessName}
          capability={DEVICE_SCAN}
          wireMethod={SCAN_AVAILABLE_DEVICES}
          whatIsBlocked="Discovering devices on the network. No device card can appear on this surface."
          whatTheGridWouldHaveHeld="one card per discovered device, each carrying that device's connection string and its own connect_device button"
        />
        <p className="discovery-typed-string-still-works">
          A typed connection string is not discovery, so the card below is still
          live: <code className="mono">connect_device</code> is a different
          capability, and §2.5 promotes the reference&apos;s{" "}
          <code className="mono">Connection string:</code> entry to a peer of a
          discovered device precisely because discovery does not find everything.
        </p>
        <TypedConnectionStringCard
          client={client}
          onDeviceConnected={onDeviceConnected}
        />
      </section>
    );
  }

  if (reading.state === "refused") {
    return (
      <section className="discovery-surface">
        <DiscoverySurfaceHeading reading={reading} onRescan={runOneScan} />
        <ScanRefusedCard
          code={reading.code}
          detail={reading.detail}
          onRescan={runOneScan}
        />
        <TypedConnectionStringCard
          client={client}
          onDeviceConnected={onDeviceConnected}
        />
      </section>
    );
  }

  if (reading.state !== "answered") {
    return (
      <section className="discovery-surface">
        <DiscoverySurfaceHeading reading={reading} onRescan={runOneScan} />
        <TypedConnectionStringCard
          client={client}
          onDeviceConnected={onDeviceConnected}
        />
      </section>
    );
  }

  return (
    <section className="discovery-surface">
      <DiscoverySurfaceHeading reading={reading} onRescan={runOneScan} />
      <CardGrid<DeviceInfo>
        gridId="discovered-devices"
        entityNounSingular="discovered device"
        entityNounPlural="discovered devices"
        items={reading.devices}
        factsOf={(device) => ({
          id: device.connection_string,
          title: device.name,
          states: [],
          hiddenByDescriptor: false,
        })}
        fields={DISCOVERED_DEVICE_FIELDS}
        cardMinWidth="wide"
        hostOrderLabel="scan order"
        operationIdsOf={() => [
          DEVICE_CONNECT,
        ]}
        titleColumnLabel="Device name"
        populatedBy={{
          wireMethod: SCAN_AVAILABLE_DEVICES,
        }}
        pinnedFirst={
          <TypedConnectionStringCard
            client={client}
            onDeviceConnected={onDeviceConnected}
          />
        }
        renderCard={(device, view) => (
          <DiscoveredDeviceCard
            key={device.connection_string}
            device={device}
            client={client}
            expandedColumnSpan={view.expandedColumnSpan}
            onDeviceConnected={onDeviceConnected}
          />
        )}
      />
    </section>
  );
}

/**
 * §2.5's "While scanning" line, and the rescan control.
 *
 * The reference shows one placeholder row `Searching for devices…` and sets a
 * watch cursor. §2.5 asks for "skeleton cards plus a literal count line,
 * `scanning… 3 devices found so far`, and the count updates". The count cannot
 * update on this wire and the line says why instead of pretending:
 * `scan_available_devices` is one request that answers once with the whole
 * array, so there is no partial count to print. The moment the contract grows a
 * per-device event the sentence becomes the running count §2.5 asks for.
 */
function DiscoverySurfaceHeading({
  reading,
  scanIsGapped = false,
  onRescan,
}: {
  reading: ScanReading;
  scanIsGapped?: boolean;
  onRescan: () => void;
}) {
  return (
    <header className="discovery-heading">
      <h3>Discovery</h3>
      <span className="discovery-scan-state">
        {scanIsGapped
          ? `scan_available_devices was never sent: device.scan is a gap on this host`
          : reading.state === "not-started"
            ? "scan_available_devices has not been sent yet"
            : reading.state === "scanning"
              ? `scanning… scan_available_devices generation ${reading.generation} is in flight; ` +
                "it answers once with the whole array, so there is no partial count to print"
              : reading.state === "refused"
                ? `scan_available_devices was refused with ${reading.code}`
                : `scan_available_devices answered with ${reading.devices.length} ` +
                  `device${reading.devices.length === 1 ? "" : "s"} at ${new Date(reading.atMs).toLocaleTimeString()}`}
      </span>
      <button
        type="button"
        className="discovery-rescan mono"
        data-op={DEVICE_SCAN}
        disabled={scanIsGapped || reading.state === "scanning"}
        title={
          scanIsGapped
            ? "device.scan is a gap on this host; the scan card below carries the host's own reason"
            : "send scan_available_devices again; any answer still in flight from the previous generation is dropped"
        }
        onClick={onRescan}
      >
        scan_available_devices
      </button>
    </header>
  );
}

/** §2.5: "Error: on that card … the wire code and detail verbatim." */
function ScanRefusedCard({
  code,
  detail,
  onRescan,
}: {
  code: string;
  detail: string;
  onRescan: () => void;
}) {
  return (
    <Card
      cardId="scan-available-devices-refused"
      glyph="⚠"
      title={SCAN_AVAILABLE_DEVICES}
      states={[
        {
          state: "rejected",
          words: `${code}: ${detail}`,
        },
      ]}
      operationIds={[DEVICE_SCAN]}
      calls={[
        { wireMethod: SCAN_AVAILABLE_DEVICES },
      ]}
    >
      <p>
        The host declares <code className="mono">device.scan</code> as served and
        then refused the call. That is the §4C case — declared in the operation
        table, unimplemented in the running host — and the two sentences above
        are the wire code and the host&apos;s own detail, printed verbatim.
      </p>
      <button type="button" className="mono" onClick={onRescan}>
        scan_available_devices
      </button>
    </Card>
  );
}

const DISCOVERED_DEVICE_FIELDS: readonly CardGridField<DeviceInfo>[] = [
  {
    id: "connection_string",
    label: "Connection string",
    valueOf: (device) => device.connection_string,
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: "serial",
    label: "Serial",
    valueOf: (device) => device.serial ?? "null",
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: "name",
    label: "Name",
    valueOf: (device) => device.name,
    onCardFaceByDefault: false,
    searchedByFilter: true,
  },
];

/**
 * One discovered device.
 *
 * The face carries the device glyph, the name, the connection string in mono
 * with a copy control, and the one commit control §2.0 allows a creating grid:
 * a button labelled `connect_device`, sitting with the parameter value it will
 * send (§3.5).
 */
export function DiscoveredDeviceCard({
  device,
  client,
  expandedColumnSpan,
  onDeviceConnected,
}: {
  device: DeviceInfo;
  client: TransportClient;
  expandedColumnSpan: number;
  onDeviceConnected?: (node: Node, connectionString: string) => void;
}) {
  const [outcome, setOutcome] = useState<DraftCallOutcome>(NEVER_SENT);
  const connectGap = useGapOnThisCapability(DEVICE_CONNECT);
  const draft = connectDraftFor(device.connection_string);

  const call: CardCall = {
    ...quackStripLineForDraftedCall(draft),
    pondEntryIsThisCards: pondEntryNamesThisConnectionString(
      device.connection_string,
    ),
  };

  return (
    <Card
      cardId={device.connection_string}
      glyph={DEVICE_GLYPH}
      title={device.name}
      titleTooltip={device.connection_string}
      headerChips={
        device.serial === null
          ? []
          : [{ label: device.serial, tone: "plain", title: "DeviceInfo.serial" }]
      }
      metaFacts={[
        `scan order entry for ${device.connection_string}`,
        `serial ${device.serial ?? "null"}`,
      ]}
      metaLineReplacement={
        connectGap === null ? undefined : (
          <GapOneLinerInPlaceOfTheMetaLine
            standing={connectGap.standing}
            hostProcessName={connectGap.hostProcessName}
          />
        )
      }
      states={[
        ...(connectGap === null
          ? []
          : [
              gappedCardStateMark(
                connectGap.standing,
                connectGap.hostProcessName,
              ),
            ]),
        ...cardStateMarksForDraftCallOutcome(outcome),
      ]}
      operationIds={[DEVICE_CONNECT]}
      calls={[call]}
      expandedColumnSpan={expandedColumnSpan}
      back={{
        reveals: "the 3 DeviceInfo fields the contract carries",
        operationIds: [DEVICE_SCAN],
        content: <DeviceInfoBack device={device} />,
      }}
    >
      <ConnectionStringWithCopy connectionString={device.connection_string} />

      <DraftCallCommit
        call={draft}
        outcome={outcome}
        onSend={(sent) => {
          setOutcome({ state: "sending" });
          connectDevice(client, sent.params.connection_string as string).then(
            (node) => {
              setOutcome({
                state: "answered",
                sentence: `connect_device answered with node ${node.id} (${node.name}, kind ${node.kind})`,
              });
              onDeviceConnected?.(node, sent.params.connection_string as string);
            },
            (error: unknown) => setOutcome({ state: "refused", ...describeSendFailure(error) }),
          );
        }}
      />

      <ConfigureIsBlockedByTheContract />
    </Card>
  );
}

/** The connection string, mono and middle-truncated by CSS, with a copy control. */
function ConnectionStringWithCopy({
  connectionString,
}: {
  connectionString: string;
}) {
  const [copyReport, setCopyReport] = useState<string | null>(null);
  return (
    <div className="discovery-connection-string">
      <code className="mono" title={connectionString}>
        {connectionString}
      </code>
      <button
        type="button"
        className="discovery-copy"
        data-quack-chrome=""
        title={`copy ${connectionString}`}
        onClick={(event) => {
          event.stopPropagation();
          void copyTextToClipboard(connectionString).then((result) =>
            setCopyReport(
              result.copied
                ? `copied ${connectionString.length} characters: ${connectionString}`
                : `could not copy: ${result.error}`,
            ),
          );
        }}
      >
        copy
      </button>
      {copyReport !== null && (
        <span className="discovery-copy-report muted">{copyReport}</span>
      )}
    </div>
  );
}

/**
 * §2.8's third use of the card's back: D10, the reference's 600 x 800
 * `Device {name} info` modal, rendered as the definition list of the record the
 * grid already has. No contract row is needed for it and none is proposed.
 */
function DeviceInfoBack({ device }: { device: DeviceInfo }) {
  return (
    <>
      <dl>
        <dt>connection_string</dt>
        <dd className="mono">{device.connection_string}</dd>
        <dt>name</dt>
        <dd>{device.name}</dd>
        <dt>serial</dt>
        <dd className="mono">{device.serial ?? "null"}</dd>
      </dl>
      <p className="muted">
        Three fields, because contract/contract.yaml gives DeviceInfo three:
        connection_string (required), name (required), serial (nullable). The
        reference&apos;s Add-device table has a <strong>Location</strong> column
        and this wire has no field for it, so the column is absent rather than
        blank. A Location needs a contract edit to DeviceInfo, which is an
        operation-table change and not frontend work.
      </p>
    </>
  );
}

/**
 * §2.6's configure… action, present and refusing, with the reason.
 *
 * The design's own §2.6 says it: "Contract: blocked. `connect_device` takes
 * `connection_string` only; there is no `configuration` param." The action is
 * drawn because the reference has it and a reader looking for it should find
 * out what happened to it, not find nothing.
 */
function ConfigureIsBlockedByTheContract() {
  return (
    <p className="discovery-configure-blocked">
      <button
        type="button"
        className="discovery-configure"
        disabled
        title={
          "connect_device's only parameter in contract/contract.yaml is connection_string " +
          "(required, string); there is no configuration parameter, so no configured connect " +
          "can be sent from here."
        }
      >
        configure…
      </button>
      <span className="muted">
        blocked: <code className="mono">connect_device</code> takes{" "}
        <code className="mono">connection_string</code> only
      </span>
    </p>
  );
}

/**
 * §2.5: "Card 1 is always the manual connection card … so a typed connection
 * string is a peer of a discovered one rather than an afterthought below a
 * table. That is the reference's own `Connection string:` entry, promoted."
 *
 * It is the clearest instance of §3.5 in the app: every keystroke changes the
 * parameter line under the button, and the button is labelled with the call.
 */
export function TypedConnectionStringCard({
  client,
  onDeviceConnected,
}: {
  client: TransportClient;
  onDeviceConnected?: (node: Node, connectionString: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const [outcome, setOutcome] = useState<DraftCallOutcome>(NEVER_SENT);
  const connectGap = useGapOnThisCapability(DEVICE_CONNECT);
  const draft = connectDraftFor(typed);

  return (
    <Card
      cardId="typed-connection-string"
      glyph="⌨"
      title="Typed connection string"
      titleTooltip="a connection string typed by hand, sent with connect_device"
      metaFacts={[
        "discovery does not find everything: a device on another subnet, or one reached over a protocol the scan does not broadcast on, is typed",
      ]}
      metaLineReplacement={
        connectGap === null ? undefined : (
          <GapOneLinerInPlaceOfTheMetaLine
            standing={connectGap.standing}
            hostProcessName={connectGap.hostProcessName}
          />
        )
      }
      states={[
        ...(connectGap === null
          ? []
          : [
              gappedCardStateMark(
                connectGap.standing,
                connectGap.hostProcessName,
              ),
            ]),
        ...cardStateMarksForDraftCallOutcome(outcome),
      ]}
      operationIds={[DEVICE_CONNECT]}
      calls={[
        {
          ...quackStripLineForDraftedCall(draft),
          pondEntryIsThisCards: pondEntryNamesThisConnectionString(typed),
        },
      ]}
    >
      <DraftCallCommit
        call={draft}
        outcome={outcome}
        discard={
          typed.length === 0
            ? undefined
            : {
                label: "discard this draft — nothing has been sent, so there is nothing to undo",
                onDiscard: () => {
                  setTyped("");
                  setOutcome(NEVER_SENT);
                },
              }
        }
        onSend={(sent) => {
          setOutcome({ state: "sending" });
          connectDevice(client, sent.params.connection_string as string).then(
            (node) => {
              setOutcome({
                state: "answered",
                sentence: `connect_device answered with node ${node.id} (${node.name}, kind ${node.kind})`,
              });
              onDeviceConnected?.(node, sent.params.connection_string as string);
            },
            (error: unknown) => setOutcome({ state: "refused", ...describeSendFailure(error) }),
          );
        }}
      >
        <label className="discovery-typed-label">
          <span className="muted">connection_string</span>
          <input
            type="text"
            className="mono"
            value={typed}
            placeholder="daq.opcua://192.168.1.44:4840"
            data-op={DEVICE_CONNECT}
            aria-label="connection_string for connect_device"
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      </DraftCallCommit>
    </Card>
  );
}
