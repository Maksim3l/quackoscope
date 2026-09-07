import snippetBundle from "../../generated/snippets.json";
import type { OperationId } from "../ui/op";

/**
 * The static snippet bundle: the openDAQ calls behind every operation, keyed by
 * capability id, extracted from the host sources at build time by
 * tools/snippet-extractor/extract-opendaq-snippets-from-host-sources.mjs.
 *
 * It is imported, not fetched. Nothing here touches the WebSocket, so the quack
 * gesture keeps working with the host down — that is the point of shipping the
 * bundle as frontend data instead of asking the running host for it.
 */

/** The flock: the language columns the inspect panel shows side by side. */
export const FLOCK_LANGUAGES = ["cpp", "csharp", "python", "rust"] as const;
export type FlockLanguage = (typeof FLOCK_LANGUAGES)[number];

/** Printed in the UI so a reader can go look at the file the snippets came from. */
export const SNIPPET_BUNDLE_PATH = "generated/snippets.json";

/**
 * Which column is the language of the host that actually executes.
 *
 * This used to be the constant "cpp", which was a lie against any other host.
 * It is now derived, per session, from the handshake's implementation.name using
 * the contract's own frozen pattern — contract/contract.yaml, implementation_names:
 *
 *     pattern: quackoscope-host-<lang>
 *     values:  quackoscope-host-cpp, -python, -csharp, -rust, -mock
 *
 * This is the ONE place in the app that looks at implementation.name at all, and
 * what it produces is a label: which snippet column gets a "running host" tag.
 * No request is sent or withheld because of it, no capability is granted or
 * denied by it, and nothing downstream branches on the result — behaviour comes
 * from the computed capability standings in src/session/ and from nothing else.
 * The contract's display_only rule is kept because this stays display.
 *
 * A host whose language has no column in the flock — quackoscope-host-mock is
 * one — returns null, and the flock then tags no column at all rather than
 * tagging the wrong one.
 */
export const HOST_PROCESS_NAME_PREFIX = "quackoscope-host-";

export function flockLanguageTaggedAsTheRunningHost(
  implementationName: string | null,
): FlockLanguage | null {
  if (implementationName === null) return null;
  if (!implementationName.startsWith(HOST_PROCESS_NAME_PREFIX)) return null;
  const language = implementationName.slice(HOST_PROCESS_NAME_PREFIX.length);
  return (FLOCK_LANGUAGES as readonly string[]).includes(language)
    ? (language as FlockLanguage)
    : null;
}

/** Why no column carries the tag, said in words rather than left blank. */
export function describeWhyNoColumnIsTheRunningHost(
  implementationName: string | null,
): string {
  if (implementationName === null) {
    return "No host has identified itself on this session yet.";
  }
  return (
    `The running host is ${implementationName}; there is no ` +
    `"${implementationName.replace(HOST_PROCESS_NAME_PREFIX, "")}" column here, ` +
    `only ${FLOCK_LANGUAGES.join(", ")}.`
  );
}

/** Key the extractor writes for an operation that makes no openDAQ call at all. */
const NO_OPENDAQ_CALL_KEY = "no_opendaq_call";

export type FlockEntry =
  /** The bundle carries openDAQ calls for this operation, per language. */
  | {
      state: "opendaq-calls";
      /** null for a language whose host does not exist yet: an empty column, not an error. */
      snippetByLanguage: Record<FlockLanguage, string | null>;
    }
  /** The operation is real but reaches no SDK, e.g. reopening the WebSocket. */
  | { state: "no-opendaq-call"; reason: string }
  /** Nothing in the bundle answers to this id at all. */
  | { state: "absent-from-bundle" };

const bundleByOperationId = snippetBundle as Record<
  string,
  Record<string, string> | undefined
>;

/** Every operation id the bundle carries, in the order the extractor sorted them. */
export const OPERATION_IDS_IN_BUNDLE: string[] = Object.keys(bundleByOperationId);

export function flockForOperation(
  operationId: OperationId | string,
): FlockEntry {
  const entry = bundleByOperationId[operationId];
  if (entry === undefined) return { state: "absent-from-bundle" };

  const noOpenDaqCallReason = entry[NO_OPENDAQ_CALL_KEY];
  if (typeof noOpenDaqCallReason === "string") {
    return { state: "no-opendaq-call", reason: noOpenDaqCallReason };
  }

  const snippetByLanguage = {} as Record<FlockLanguage, string | null>;
  for (const language of FLOCK_LANGUAGES) {
    const snippet = entry[language];
    snippetByLanguage[language] = typeof snippet === "string" ? snippet : null;
  }
  return { state: "opendaq-calls", snippetByLanguage };
}

/** "71 lines of cpp", for the column header. */
export function describeSnippetSize(snippet: string, language: FlockLanguage): string {
  return `${snippet.split("\n").length} lines of ${language}`;
}
