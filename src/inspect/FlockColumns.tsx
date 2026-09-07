import { useState } from "react";
import { useHostImplementationName } from "../session/host-capability-context";
import { copyTextToClipboard } from "./copy-text-to-clipboard";
import {
  describeSnippetSize,
  describeWhyNoColumnIsTheRunningHost,
  flockForOperation,
  flockLanguageTaggedAsTheRunningHost,
  FLOCK_LANGUAGES,
  type FlockLanguage,
} from "./snippet-bundle";

/**
 * The flock: all four language columns of one operation, side by side.
 *
 * The columns come from FLOCK_LANGUAGES, so a host written in another language
 * later is one more entry in that array plus the snippets its own source
 * carries — no layout work. A language the bundle has no snippet for renders as
 * an empty column that says which file it looked in; it is not an error, and it
 * is not a gap either — a gap is a capability the connected host does not serve,
 * which the handshake panel and the disabled controls report separately.
 *
 * Which column wears the "running host" tag follows the session's handshake. It
 * is no longer a constant, so connecting to quackoscope-host-python tags the
 * python column and connecting to a host with no column here tags none.
 */
export function FlockForOperation({ operationId }: { operationId: string }) {
  const flock = flockForOperation(operationId);
  const implementationName = useHostImplementationName();
  const runningHostLanguage = flockLanguageTaggedAsTheRunningHost(implementationName);

  if (flock.state === "no-opendaq-call") {
    return (
      <div className="flock-verdict flock-verdict--no-opendaq-call">
        <code>{operationId}</code>: {flock.reason}. Nothing reaches openDAQ.
      </div>
    );
  }

  if (flock.state === "absent-from-bundle") {
    return (
      <div className="flock-verdict flock-verdict--absent">
        No host source in this build shows the openDAQ calls for{" "}
        <code>{operationId}</code>.
      </div>
    );
  }

  return (
    <>
      {runningHostLanguage === null && (
        <p className="muted flock-running-host-note">
          {describeWhyNoColumnIsTheRunningHost(implementationName)}
        </p>
      )}
      <div className="flock-columns">
        {FLOCK_LANGUAGES.map((language) => (
          <FlockColumn
            key={language}
            operationId={operationId}
            language={language}
            snippet={flock.snippetByLanguage[language]}
            isRunningHost={language === runningHostLanguage}
          />
        ))}
      </div>
    </>
  );
}

function FlockColumn({
  operationId,
  language,
  snippet,
  isRunningHost,
}: {
  operationId: string;
  language: FlockLanguage;
  snippet: string | null;
  isRunningHost: boolean;
}) {
  const [copyReport, setCopyReport] = useState<string | null>(null);

  return (
    <section
      className={
        "flock-column" +
        (snippet === null ? " flock-column--empty" : "") +
        (isRunningHost ? " flock-column--running-host" : "")
      }
    >
      <header className="flock-column-head">
        <span className="flock-language mono">{language}</span>
        {isRunningHost && <span className="tag tag--running-host">running host</span>}
        <span className="spacer" />
        {snippet !== null && (
          <>
            <span className="muted">{describeSnippetSize(snippet, language)}</span>
            <button
              className="flock-copy"
              data-quack-chrome=""
              onClick={() => {
                void copyTextToClipboard(snippet).then((outcome) =>
                  setCopyReport(
                    outcome.copied
                      ? `copied ${snippet.length} characters of ${language} for ${operationId}`
                      : `could not copy: ${outcome.error}`,
                  ),
                );
              }}
            >
              copy
            </button>
          </>
        )}
      </header>
      {snippet === null ? (
        <p className="flock-empty-note">
          No {language} source in this build shows the openDAQ calls for{" "}
          {operationId}.
        </p>
      ) : (
        <pre className="flock-snippet mono">{snippet}</pre>
      )}
      {copyReport !== null && <p className="flock-copy-report">{copyReport}</p>}
    </section>
  );
}
