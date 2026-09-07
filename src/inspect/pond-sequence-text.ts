import type { CallLogEntry } from "../transport";
import { capabilityIdsForWireMethod } from "./capability-ids-for-wire-method";
import {
  flockForOperation,
  SNIPPET_BUNDLE_PATH,
  type FlockLanguage,
} from "./snippet-bundle";

/**
 * Turns the pond — the call log, called CALLS on screen — into the pasteable
 * sequence of openDAQ calls the session actually made, in the order it made them.
 *
 * A session repeats operations constantly (one grid load is one
 * get_property_descriptors and a get_property_value per property, all of them
 * property.read), and property.read's snippet is 84 lines. Printing those 84
 * lines fifteen times would bury the sequence, so an operation prints its calls
 * at its first appearance and later repeats name the step that printed them.
 * Every call still appears, in order: nothing is dropped, only re-quoted.
 */

const PARAMS_CHARACTER_LIMIT = 160;

function paramsOneLine(params: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(params) ?? String(params);
  } catch {
    text = String(params);
  }
  return text.length > PARAMS_CHARACTER_LIMIT
    ? `${text.slice(0, PARAMS_CHARACTER_LIMIT - 3)}...`
    : text;
}

function outcomeOf(entry: CallLogEntry): string {
  if (entry.ok === null) return "still in flight";
  if (entry.ok) return `ok in ${entry.durationMs ?? "?"} ms`;
  const failure = entry.error;
  return failure === null
    ? `failed in ${entry.durationMs ?? "?"} ms`
    : `failed in ${entry.durationMs ?? "?"} ms with ${failure.code}: ${failure.detail}`;
}

export function buildPondSequenceText({
  pond,
  language,
  hostProcessName,
  socketUrl,
  capturedAt,
}: {
  pond: readonly CallLogEntry[];
  /**
   * The snippet column to paste: the language of the host that answered these
   * calls, taken from the session's handshake. null when the running host has no
   * column in the bundle — quackoscope-host-mock, say — and then no openDAQ
   * calls are printed, because pasting another language's calls would claim this
   * session made calls it did not.
   */
  language: FlockLanguage | null;
  hostProcessName: string;
  socketUrl: string;
  capturedAt: Date;
}): string {
  const lines: string[] = [];
  const stepThatPrinted = new Map<string, number>();
  let withSnippet = 0;

  pond.forEach((entry, index) => {
    const step = index + 1;
    const operationIds = capabilityIdsForWireMethod(entry.method);
    const header =
      operationIds.length === 0
        ? `// ---- ${step}. ${entry.method} - no capability id maps to this wire method - ${outcomeOf(entry)}`
        : `// ---- ${step}. ${operationIds.join(", ")} - ${entry.method} ${paramsOneLine(entry.params)} - ${outcomeOf(entry)}`;
    lines.push(header);

    if (language === null && operationIds.length > 0) {
      lines.push(
        `// ${SNIPPET_BUNDLE_PATH} has no column for the language of ${hostProcessName}, so no openDAQ calls are printed for this step.`,
      );
      lines.push("");
      return;
    }

    for (const operationId of operationIds) {
      if (language === null) break;
      const alreadyPrinted = stepThatPrinted.get(operationId);
      if (alreadyPrinted !== undefined) {
        lines.push(
          `// the same openDAQ calls as step ${alreadyPrinted}, not repeated here.`,
        );
        continue;
      }
      const flock = flockForOperation(operationId);
      if (flock.state === "no-opendaq-call") {
        lines.push(`// ${flock.reason}`);
        stepThatPrinted.set(operationId, step);
        continue;
      }
      if (flock.state === "absent-from-bundle") {
        lines.push(
          `// ${SNIPPET_BUNDLE_PATH} carries no entry for "${operationId}".`,
        );
        continue;
      }
      const snippet = flock.snippetByLanguage[language];
      if (snippet === null) {
        lines.push(
          `// ${SNIPPET_BUNDLE_PATH} carries no ${language} snippet for "${operationId}".`,
        );
        continue;
      }
      lines.push(snippet);
      stepThatPrinted.set(operationId, step);
      withSnippet += 1;
    }
    lines.push("");
  });

  const preamble = [
    `// quackoscope call log: the openDAQ calls this session performed, in order.`,
    language === null
      ? `// ${pond.length} wire calls. ${SNIPPET_BUNDLE_PATH} has no column for the language of ${hostProcessName}, so no openDAQ calls are printed.`
      : `// ${pond.length} wire calls, ${withSnippet} of them printing ${language} calls from ${SNIPPET_BUNDLE_PATH}.`,
    `// host process ${hostProcessName} on ${socketUrl}, copied ${capturedAt.toISOString()}.`,
    `// An operation prints its openDAQ calls once, at its first appearance; later`,
    `// repeats name the step that printed them.`,
    "",
  ];

  if (pond.length === 0) {
    return [
      ...preamble.slice(0, 3),
      "// No calls yet: this session has not called the host.",
      "",
    ].join("\n");
  }

  return [...preamble, ...lines].join("\n");
}
