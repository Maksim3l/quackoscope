/**
 * Which backend the app talks to, and how that choice survives a reload.
 *
 * Scope, stated plainly because the control's honesty depends on it: this app
 * has no way to start or stop a process. It cannot launch quackoscope-host-cpp
 * and it cannot launch quackoscope-host-python. What it can do is hold a list of
 * host URLs and open its one WebSocket against the chosen one. Switching is
 * therefore a full reconnect, not a handover.
 *
 * The entries below are CONFIGURATION — where a host of a given language is
 * expected to listen. None of them is a claim about what is actually listening
 * there. The only thing that says what answered is the handshake, and the header
 * prints that.
 *
 * Persistence mirrors src/inspect/quack-gesture.ts: one localStorage key per
 * thing remembered, every read and write wrapped, and a browser with storage
 * denied still works — it just forgets the choice.
 */

export const CHOSEN_BACKEND_URL_STORAGE_KEY = "quackoscope.backend-url";
export const ADDED_BACKEND_URLS_STORAGE_KEY =
  "quackoscope.backend-urls-added-in-this-browser";

export type BackendSource =
  /** The host that served this page: same origin, so it is always reachable if the page loaded. */
  | "serves-this-page"
  /** Shipped in the app: where a host of that language listens by default. */
  | "shipped-default"
  /** Typed into the selector in this browser. */
  | "added-in-this-browser";

export interface ConfiguredBackend {
  url: string;
  source: BackendSource;
  /** What is expected at this URL, as configuration. Never a claim about what answered. */
  note: string;
  /**
   * The name to print for this entry before anything has ever answered on it.
   * Configuration, like `note`: it says which host binds this port by default,
   * not what is listening. A handshake, once one is read, overrides it — see
   * src/session/backend-display-name.ts.
   */
  defaultDisplayName: string | null;
}

/**
 * The shipped defaults. Ports come from the host lanes: hosts/cpp binds 7788,
 * hosts/python binds 7789 and hosts/mock-ts binds 7791 unless started with
 * another --port.
 */
export const SHIPPED_DEFAULT_BACKENDS: readonly ConfiguredBackend[] = [
  {
    url: "ws://127.0.0.1:7788/ws",
    source: "shipped-default",
    note: "the port quackoscope-host-cpp binds unless started with another --port",
    defaultDisplayName: "C++",
  },
  {
    url: "ws://127.0.0.1:7789/ws",
    source: "shipped-default",
    note: "the port quackoscope-host-python binds unless started with another --port",
    defaultDisplayName: "Python",
  },
  {
    url: "ws://127.0.0.1:7791/ws",
    source: "shipped-default",
    note: "the port hosts/mock-ts binds unless started with another --port",
    defaultDisplayName: "Mock",
  },
];

/**
 * The full list: the host that served this page first (when it is not already a
 * shipped default), then the shipped defaults, then whatever was added here.
 */
export function configuredBackends(
  urlOfTheHostThatServedThisPage: string,
  addedUrls: readonly string[],
): ConfiguredBackend[] {
  const backends: ConfiguredBackend[] = [];
  const seen = new Set<string>();

  const push = (backend: ConfiguredBackend) => {
    if (seen.has(backend.url)) return;
    seen.add(backend.url);
    backends.push(backend);
  };

  push({
    url: urlOfTheHostThatServedThisPage,
    source: "serves-this-page",
    note: "the host that served this page, so this is the same origin the SPA came from",
    // No default name: which host served the page is exactly what the handshake
    // is about to say, and guessing from the port would be wrong the moment a
    // host is started on another one.
    defaultDisplayName: null,
  });
  for (const shipped of SHIPPED_DEFAULT_BACKENDS) push(shipped);
  for (const url of addedUrls) {
    push({
      url,
      source: "added-in-this-browser",
      note: "added in this browser and remembered in localStorage",
      defaultDisplayName: null,
    });
  }
  return backends;
}

export type BackendUrlReading =
  | { accepted: true; url: string }
  | { accepted: false; refusal: string };

/**
 * Accepts only what a WebSocket can actually be opened against, and says why
 * when it refuses, quoting the text it was given.
 */
export function readBackendUrlTypedByTheUser(typed: string): BackendUrlReading {
  const text = typed.trim();
  if (text.length === 0) {
    return { accepted: false, refusal: "nothing was typed, so there is no URL to add" };
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return {
      accepted: false,
      refusal: `"${text}" is not a URL; a backend URL looks like ws://127.0.0.1:7788/ws`,
    };
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return {
      accepted: false,
      refusal:
        `"${text}" uses the "${parsed.protocol}" scheme; a WebSocket can only be opened ` +
        `over ws: or wss:`,
    };
  }
  if (parsed.hostname.length === 0) {
    return { accepted: false, refusal: `"${text}" names no host` };
  }
  return { accepted: true, url: parsed.toString() };
}

export function readAddedBackendUrlsFromBrowserStorage(): string[] {
  try {
    const stored = window.localStorage.getItem(ADDED_BACKEND_URLS_STORAGE_KEY);
    if (stored === null) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((url): url is string => typeof url === "string");
  } catch {
    return [];
  }
}

export function writeAddedBackendUrlsToBrowserStorage(urls: readonly string[]): void {
  try {
    window.localStorage.setItem(
      ADDED_BACKEND_URLS_STORAGE_KEY,
      JSON.stringify(urls),
    );
  } catch {
    /* storage denied: the list lasts for this page load only */
  }
}

/**
 * The backend chosen last time this browser ran the app. Falls back to the host
 * that served the page, which is the one URL guaranteed to have answered at
 * least once.
 */
export function readChosenBackendUrlFromBrowserStorage(
  urlOfTheHostThatServedThisPage: string,
): string {
  try {
    const stored = window.localStorage.getItem(CHOSEN_BACKEND_URL_STORAGE_KEY);
    if (stored === null) return urlOfTheHostThatServedThisPage;
    const reading = readBackendUrlTypedByTheUser(stored);
    return reading.accepted ? reading.url : urlOfTheHostThatServedThisPage;
  } catch {
    return urlOfTheHostThatServedThisPage;
  }
}

export function writeChosenBackendUrlToBrowserStorage(url: string): void {
  try {
    window.localStorage.setItem(CHOSEN_BACKEND_URL_STORAGE_KEY, url);
  } catch {
    /* storage denied: the choice lasts for this page load only */
  }
}

/** The sentence the UI prints before and after a switch. Switching is never partial. */
export function describeWhatSwitchingBackendDoes(
  fromUrl: string,
  toUrl: string,
): string {
  return (
    `Switching from ${fromUrl} to ${toUrl} is a full reconnect: the socket to ` +
    `${fromUrl} is closed, the device connected through it is NOT carried over, ` +
    `the component tree, the selected component and the call log are cleared, and the ` +
    `handshake is read again from ${toUrl}.`
  );
}
