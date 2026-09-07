import { useEffect, useRef, useState } from "react";
import type { CallLogEntry } from "../transport";
import { capabilityIdsForWireMethod } from "./capability-ids-for-wire-method";
import { copyTextToClipboard } from "./copy-text-to-clipboard";
import { useHostImplementationName } from "../session/host-capability-context";
import { buildPondSequenceText } from "./pond-sequence-text";
import { flockLanguageTaggedAsTheRunningHost } from "./snippet-bundle";
import type { QuackedControl } from "./quack-gesture";

/**
 * The call log — "the pond" in this app's code, and only in its code. On screen
 * it is CALLS: the calls this session has made to the host, oldest first,
 * exactly as the transport recorded them. Copy hands the sequence over as
 * pasteable openDAQ code.
 *
 * This renders the transport's own pond (TransportClient.getPond); it is not a
 * second log kept alongside it.
 */
export function PondPanel({
  pond,
  hostProcessName,
  socketUrl,
  onQuack,
  showingOnly,
  onShowEveryEntry,
}: {
  pond: readonly CallLogEntry[];
  hostProcessName: string;
  socketUrl: string;
  onQuack: (quacked: QuackedControl) => void;
  /**
   * §3.4, card → pond: a card's `×n` narrows this list to its own calls. The
   * full pond is never discarded — it is still what the copy control hands over,
   * and the header says both counts, so a filtered view can never be mistaken
   * for a session that made fewer calls than it did.
   */
  showingOnly?: { entries: readonly CallLogEntry[]; describedAs: string } | null;
  onShowEveryEntry?: () => void;
}) {
  const [copyReport, setCopyReport] = useState<string | null>(null);
  const newestEntryRef = useRef<HTMLLIElement | null>(null);
  // The language of the host that answered these calls, per this session's
  // handshake — not a constant, and null when the flock has no column for it.
  const runningHostLanguage = flockLanguageTaggedAsTheRunningHost(
    useHostImplementationName(),
  );

  // What is listed: the filtered set when a card named one, otherwise the whole
  // pond. Matched by seq against the live pond so a filtered list keeps growing
  // and keeps its outcomes current as those same calls settle.
  const filteredSeqs =
    showingOnly == null ? null : new Set(showingOnly.entries.map((e) => e.seq));
  const listed =
    filteredSeqs === null ? pond : pond.filter((e) => filteredSeqs.has(e.seq));

  useEffect(() => {
    newestEntryRef.current?.scrollIntoView({ block: "nearest" });
  }, [pond.length]);

  const copyPondSequence = () => {
    const text = buildPondSequenceText({
      pond,
      language: runningHostLanguage,
      hostProcessName,
      socketUrl,
      capturedAt: new Date(),
    });
    void copyTextToClipboard(text).then((outcome) =>
      setCopyReport(
        outcome.copied
          ? `copied ${text.length} characters covering ${pond.length} calls, ` +
            (runningHostLanguage === null
              ? `with no openDAQ calls because the snippet bundle has no column for ${hostProcessName}`
              : `as ${runningHostLanguage}`) +
            ", to the clipboard"
          : `could not copy the ${text.length} characters: ${outcome.error}`,
      ),
    );
  };

  return (
    <div className="pond-panel">
      <header className="pond-head">
        <h3>calls</h3>
        <span className="muted">
          {pond.length} calls this session made to {hostProcessName} on{" "}
          {socketUrl}, oldest first
        </span>
        {showingOnly != null && (
          <p className="pond-filter" role="status">
            <span>
              showing {listed.length} of those {pond.length}: {showingOnly.describedAs}
            </span>
            <button
              className="chrome-button"
              data-quack-chrome=""
              onClick={onShowEveryEntry}
            >
              show all {pond.length}
            </button>
          </p>
        )}
        <button
          className="pond-copy"
          data-quack-chrome=""
          disabled={pond.length === 0}
          title={`copy all ${pond.length} calls, in order, as the openDAQ code that performs them`}
          onClick={copyPondSequence}
        >
          Copy these {pond.length} calls as openDAQ code
        </button>
        {copyReport !== null && <p className="pond-copy-report">{copyReport}</p>}
      </header>

      {listed.length === 0 ? (
        <p className="muted pad">
          {showingOnly != null
            ? `None of this session's ${pond.length} calls to ${socketUrl} match ${showingOnly.describedAs}.`
            : `No calls yet: this session has not called ${socketUrl}.`}
        </p>
      ) : (
        <ol className="pond-list">
          {listed.map((entry, index) => {
            const operationIds = capabilityIdsForWireMethod(entry.method);
            return (
              <li
                key={entry.seq}
                ref={index === listed.length - 1 ? newestEntryRef : null}
              >
                <button
                  className="pond-entry"
                  data-quack-chrome=""
                  title={`quack ${entry.method}: ${operationIds.join(", ") || "makes no openDAQ call"}`}
                  onClick={() =>
                    onQuack({
                      operationIds: operationIds,
                      controlDescription: `call ${entry.seq}: ${entry.method}`,
                      gesture: "the call log",
                    })
                  }
                >
                  <span className="pond-seq mono">{entry.seq}</span>
                  <span className="pond-method mono">{entry.method}</span>
                  <span className="pond-operation mono">
                    {operationIds.join(", ") || "—"}
                  </span>
                  <span className={`pond-outcome pond-outcome--${entry.ok === null ? "pending" : entry.ok ? "ok" : "failed"}`}>
                    {entry.ok === null
                      ? "in flight"
                      : entry.ok
                        ? `ok ${entry.durationMs} ms`
                        : `${entry.error?.code ?? "failed"} ${entry.durationMs} ms`}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
