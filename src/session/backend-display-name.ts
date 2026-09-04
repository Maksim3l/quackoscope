/**
 * What a backend is CALLED in the selector, and where that name comes from.
 *
 * The user ruled that the selector lists backends by name, with the port to the
 * right and visually quieter:
 *
 *     C++         :7788
 *     Python      :7789
 *     Mock        :7791
 *
 * Three sources, in this order of authority:
 *
 *   1. the handshake that URL actually sent, shortened for display. This is the
 *      only source that is a fact about what answered rather than configuration.
 *   2. a label stored for that URL — either typed when the backend was added, or
 *      remembered from a handshake read earlier in this browser, so a backend
 *      that is currently down still renders by name instead of vanishing.
 *   3. the port, when nothing else is known. `port 7803` is not a language name
 *      and does not pretend to be one.
 *
 * THE ONE RULE THIS FILE MUST NOT BREAK. Settled decision: no BEHAVIOURAL branch
 * may read `implementation.name`. Nothing here decides what the app does — every
 * function returns a string to print. `shortDisplayNameForImplementation` maps
 * `quackoscope-host-cpp` to `C++` for the eye and for nothing else.
 */

export const BACKEND_NAMES_SEEN_STORAGE_KEY =
  "quackoscope.backend-names-seen-in-this-browser";

/**
 * The implementation name a host declares, shortened to the label a person
 * reads. Display formatting only.
 *
 * The suffix is what the host lane names its process after; anything this table
 * does not recognise is printed as the host sent it, because inventing a
 * shorter name for a host nobody has seen would be a guess.
 */
const DISPLAY_NAME_BY_IMPLEMENTATION_SUFFIX: readonly {
  suffix: string;
  displayName: string;
}[] = [
  { suffix: "cpp", displayName: "C++" },
  { suffix: "python", displayName: "Python" },
  { suffix: "csharp", displayName: "C#" },
  { suffix: "dotnet", displayName: "C#" },
  { suffix: "rust", displayName: "Rust" },
  { suffix: "ts", displayName: "Mock" },
  { suffix: "mock", displayName: "Mock" },
];

export function shortDisplayNameForImplementation(
  implementationName: string,
): string {
  const trimmed = implementationName.trim();
  if (trimmed.length === 0) return trimmed;
  const lowered = trimmed.toLowerCase();
  for (const row of DISPLAY_NAME_BY_IMPLEMENTATION_SUFFIX) {
    if (lowered.endsWith(`-${row.suffix}`) || lowered === row.suffix) {
      return row.displayName;
    }
  }
  return trimmed;
}

/** `ws://127.0.0.1:7788/ws` -> `:7788`. The quiet half of the row. */
export function portTextOfBackendUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.port.length > 0) return `:${parsed.port}`;
    return parsed.protocol === "wss:" ? ":443" : ":80";
  } catch {
    return "";
  }
}

/** The fallback name for a URL nothing has ever answered on. */
export function defaultNameFromPort(url: string): string {
  const port = portTextOfBackendUrl(url);
  return port.length === 0 ? url : `port ${port.slice(1)}`;
}

// --- names remembered across reloads ---------------------------------------

export type BackendNamesSeen = Readonly<Record<string, string>>;

export function readBackendNamesSeenFromBrowserStorage(): BackendNamesSeen {
  try {
    const stored = window.localStorage.getItem(BACKEND_NAMES_SEEN_STORAGE_KEY);
    if (stored === null) return {};
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const names: Record<string, string> = {};
    for (const [url, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof name === "string" && name.length > 0) names[url] = name;
    }
    return names;
  } catch {
    return {};
  }
}

export function writeBackendNamesSeenToBrowserStorage(
  names: BackendNamesSeen,
): void {
  try {
    window.localStorage.setItem(
      BACKEND_NAMES_SEEN_STORAGE_KEY,
      JSON.stringify(names),
    );
  } catch {
    /* storage denied: names last for this page load only */
  }
}

export type BackendNameSource =
  /** The handshake this session read from that URL. */
  | "this session's handshake"
  /** A handshake read from that URL earlier in this browser. */
  | "a handshake read here earlier"
  /** Configuration: which host binds this port by default. */
  | "the shipped default for this port"
  /** Nothing has answered; the port is all there is. */
  | "the port, because nothing has answered here yet";

export interface BackendDisplayName {
  name: string;
  portText: string;
  source: BackendNameSource;
}

/**
 * The name and the port for one row, and which of the three sources supplied
 * the name — printed in the row's title so the label is never mysterious.
 */
export function displayNameForBackend({
  url,
  implementationNameFromThisSessionsHandshake,
  nameSeenEarlier,
  shippedDefaultName,
}: {
  url: string;
  implementationNameFromThisSessionsHandshake: string | null;
  nameSeenEarlier: string | null;
  shippedDefaultName: string | null;
}): BackendDisplayName {
  const portText = portTextOfBackendUrl(url);
  if (implementationNameFromThisSessionsHandshake !== null) {
    return {
      name: shortDisplayNameForImplementation(
        implementationNameFromThisSessionsHandshake,
      ),
      portText,
      source: "this session's handshake",
    };
  }
  if (nameSeenEarlier !== null) {
    return {
      name: shortDisplayNameForImplementation(nameSeenEarlier),
      portText,
      source: "a handshake read here earlier",
    };
  }
  if (shippedDefaultName !== null) {
    return {
      name: shippedDefaultName,
      portText,
      source: "the shipped default for this port",
    };
  }
  return {
    name: defaultNameFromPort(url),
    portText,
    source: "the port, because nothing has answered here yet",
  };
}
