import { useState } from "react";
import type { LinkStatus } from "../transport";
import {
  describeWhatSwitchingBackendDoes,
  readBackendUrlTypedByTheUser,
  type ConfiguredBackend,
} from "./backend-choices";
import {
  displayNameForBackend,
  type BackendNamesSeen,
} from "./backend-display-name";
import { useHostSession } from "./host-capability-context";

/**
 * The list of hosts this app can talk to, and the way to add another.
 *
 * This is a SECTION of the host panel, not a control of its own. It used to be a
 * top-bar button with its own panel beside the handshake panel — two panels and
 * two buttons for one subject, with the host's name printed in both. The button
 * is gone; the list lives inside the one host panel now.
 *
 * PRESENTATION, as the user ruled it. Each row is the backend's NAME, big, with
 * its port to the right, dimmed and smaller:
 *
 *     C++         :7788
 *     Python      :7789
 *     Mock        :7791
 *
 * The name comes from that URL's own handshake where one has been read — this
 * session's, or one remembered in this browser from an earlier one — shortened
 * for display by src/session/backend-display-name.ts. That is formatting, not a
 * behavioural branch on `implementation.name`, which stays forbidden. A URL
 * nothing has ever answered on falls back to the shipped default's name for that
 * port, and then to the port itself. Every row prints which of the three
 * supplied its name.
 *
 * An entry whose host is not answering still renders, by name, marked
 * unreachable. It never disappears and it never hangs: only the CHOSEN backend
 * has a socket, and the app's watchdog closes a socket that has not settled in
 * six seconds, so an unreachable choice lands on the reconnect screen.
 */

const SOURCE_LABEL: Record<ConfiguredBackend["source"], string> = {
  "serves-this-page": "serves this page",
  "shipped-default": "shipped default",
  "added-in-this-browser": "added here",
};

export function ChooseWhichHostToTalkTo({
  backends,
  chosenUrl,
  link,
  namesSeen,
  onChoose,
  onAdd,
  onRemove,
  onChosen,
}: {
  backends: readonly ConfiguredBackend[];
  chosenUrl: string;
  link: LinkStatus;
  /** URL -> the implementation name a handshake from it reported, ever. */
  namesSeen: BackendNamesSeen;
  onChoose: (url: string) => void;
  onAdd: (url: string) => void;
  onRemove: (url: string) => void;
  /** Called after a switch, so the panel holding this section can close. */
  onChosen: () => void;
}) {
  const [typedUrl, setTypedUrl] = useState("");
  const [addRefusal, setAddRefusal] = useState<string | null>(null);
  const session = useHostSession();

  const handshake =
    session?.handshakeReading !== null && session?.handshakeReading?.read
      ? session.handshakeReading.handshake
      : null;

  const nameFor = (backend: ConfiguredBackend) =>
    displayNameForBackend({
      url: backend.url,
      implementationNameFromThisSessionsHandshake:
        backend.url === chosenUrl && handshake !== null
          ? handshake.implementation.name
          : null,
      nameSeenEarlier: namesSeen[backend.url] ?? null,
      shippedDefaultName: backend.defaultDisplayName,
    });

  const submitTypedUrl = () => {
    const reading = readBackendUrlTypedByTheUser(typedUrl);
    if (!reading.accepted) {
      setAddRefusal(reading.refusal);
      return;
    }
    if (backends.some((backend) => backend.url === reading.url)) {
      setAddRefusal(`${reading.url} is already in the list`);
      return;
    }
    setAddRefusal(null);
    setTypedUrl("");
    onAdd(reading.url);
  };

  return (
    <section className="host-panel-section">
      <h3>talk to a different host</h3>

      <p className="backend-switch-warning" role="note">
        {describeWhatSwitchingBackendDoes(chosenUrl, "another URL")}
      </p>

      <ul className="backend-rows">
        {backends.map((backend) => {
          const current = backend.url === chosenUrl;
          const displayed = nameFor(backend);
          // Reachability is only ever known for the URL with the socket.
          // A row that is not the chosen one is not claimed to be up or
          // down — it is simply not connected right now.
          const unreachable = current && link.state !== "open";
          return (
            <li
              key={backend.url}
              className={"backend-row" + (current ? " backend-row--current" : "")}
            >
              <button
                className="backend-choose"
                data-quack-chrome=""
                disabled={current}
                title={
                  `named "${displayed.name}" from ${displayed.source}. ` +
                  (current
                    ? `already connected to ${backend.url}`
                    : describeWhatSwitchingBackendDoes(chosenUrl, backend.url))
                }
                onClick={() => {
                  onChoose(backend.url);
                  onChosen();
                }}
              >
                <span className="backend-name-and-port">
                  <span className="backend-name">{displayed.name}</span>
                  <span className="backend-port">{displayed.portText}</span>
                  {unreachable && (
                    <span className="backend-unreachable">
                      unreachable — socket {link.state}
                    </span>
                  )}
                </span>
                <span className="mono backend-url">{backend.url}</span>
                <span className="muted backend-source">
                  {SOURCE_LABEL[backend.source]} — {backend.note}
                </span>
                <span className="muted backend-source">
                  name from {displayed.source}
                </span>
                {current && (
                  <span className="backend-current-note">
                    current
                    {handshake === null
                      ? `, link ${link.state}, no handshake read`
                      : `, ${handshake.implementation.name} ${handshake.implementation.version} answered here`}
                  </span>
                )}
              </button>
              {backend.source === "added-in-this-browser" && (
                <button
                  className="chrome-button backend-remove"
                  data-quack-chrome=""
                  disabled={current}
                  title={
                    current
                      ? "this is the host in use; switch away before removing it"
                      : `remove ${backend.url} from the list in this browser`
                  }
                  onClick={() => onRemove(backend.url)}
                >
                  remove
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <form
        className="backend-add"
        onSubmit={(event) => {
          event.preventDefault();
          submitTypedUrl();
        }}
      >
        <label className="muted" htmlFor="backend-url-to-add">
          add a host URL — remembered in this browser. It is listed by its port
          until a handshake from it says what it is.
        </label>
        <div className="row">
          <input
            id="backend-url-to-add"
            className="grow mono"
            data-quack-chrome=""
            placeholder="ws://127.0.0.1:7803/ws"
            spellCheck={false}
            value={typedUrl}
            onChange={(event) => {
              setTypedUrl(event.currentTarget.value);
              setAddRefusal(null);
            }}
          />
          <button className="chrome-button" data-quack-chrome="" type="submit">
            add
          </button>
        </div>
        {addRefusal !== null && (
          <p className="error" role="alert">
            {addRefusal}
          </p>
        )}
      </form>

      <p className="backend-scope muted">
        This app cannot start or stop a host process.
      </p>
    </section>
  );
}
