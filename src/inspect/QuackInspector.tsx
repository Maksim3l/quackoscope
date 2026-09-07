import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { CallLogEntry } from "../transport";
import { FlockForOperation } from "./FlockColumns";
import { PondPanel } from "./PondPanel";
import { QuackBadgeLayer } from "./QuackBadgeLayer";
import { QuackRequestContext } from "./quack-request-context";
import {
  describeQuackChord,
  MODIFIER_KEY_NAMES,
  readInspectorModeFromBrowserStorage,
  readQuackChordFromBrowserStorage,
  useQuackGesture,
  writeInspectorModeToBrowserStorage,
  writeQuackChordToBrowserStorage,
  type ModifierKeyName,
  type QuackChord,
  type QuackedControl,
} from "./quack-gesture";

/**
 * The inspect layer: the quack gesture, the flock of language columns it opens,
 * and the pond beside them.
 *
 * It reads generated/snippets.json, which is built into this page, and it holds
 * no socket of its own. Quacking therefore works with the host down — that is
 * the whole reason the snippets are static frontend data instead of something
 * the running host answers for.
 *
 * NAMING. On screen the mode is INSPECTOR MODE and the call log is CALLS — both
 * ruled by the user, who asked "wtf is pond that makes no sense as a word". In
 * the code the log is still the pond, the language columns are still the flock
 * and the gesture is still a quack: that is the vocabulary of the thing itself,
 * and it is the user-facing strings that changed, not the types.
 *
 * SHAPE. `QuackInspectorProvider` wraps the whole app because two things need to
 * reach across it:
 *   - `showQuack` is published through QuackRequestContext, so a card's quack
 *     strip — which is `data-quack-chrome` and therefore never a quack target
 *     itself — can open the flock for one named operation by calling it. That
 *     replaced a workaround that dispatched synthetic middle clicks on zero-size
 *     anchors, and both the anchors and their module are gone.
 *   - the drawer and the badge layer are fixed-position and belong to no pane.
 * `InspectorModeControls` is the pair of header buttons, and reads the same
 * state out of the provider.
 */

interface InspectorState {
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  inspectorModeOn: boolean;
  toggleInspectorMode: () => void;
  pondEntryCount: number;
}

const NO_INSPECTOR: InspectorState = {
  drawerOpen: false,
  setDrawerOpen: () => {},
  inspectorModeOn: false,
  toggleInspectorMode: () => {},
  pondEntryCount: 0,
};

const InspectorStateContext = createContext<InspectorState>(NO_INSPECTOR);

/** Which pond entries the pond pane is showing, and why it is showing those. */
export interface PondFilter {
  entries: readonly CallLogEntry[];
  describedAs: string;
}

/**
 * §3.4, card → pond: a card's `×n` narrows the pond pane to that card's own
 * calls. Published separately from `showQuack` because it is a different
 * question — "which calls did THIS card make", not "what would this control
 * call" — and because a surface can wire one without the other. A tree with no
 * provider gets a no-op, and a card must then print its count as text rather
 * than as a button that does nothing.
 */
const PondFilterContext = createContext<
  ((entries: readonly CallLogEntry[], describedAs: string) => void) | null
>(null);

export function useShowTheseEntriesInThePond():
  | ((entries: readonly CallLogEntry[], describedAs: string) => void)
  | null {
  return useContext(PondFilterContext);
}

export function QuackInspectorProvider({
  pond,
  hostProcessName,
  socketUrl,
  children,
}: {
  pond: readonly CallLogEntry[];
  hostProcessName: string;
  socketUrl: string;
  children: ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [quacked, setQuacked] = useState<QuackedControl | null>(null);
  const [shownOperationId, setShownOperationId] = useState<string | null>(null);
  const [pondFilter, setPondFilter] = useState<PondFilter | null>(null);
  const [chord, setChord] = useState<QuackChord>(() =>
    readQuackChordFromBrowserStorage(),
  );
  const [inspectorModeOn, setInspectorModeOn] = useState<boolean>(() =>
    readInspectorModeFromBrowserStorage(),
  );

  const showQuack = useCallback((next: QuackedControl) => {
    setQuacked(next);
    setShownOperationId(next.operationIds[0] ?? null);
    setDrawerOpen(true);
  }, []);

  useQuackGesture({ chord, inspectorModeOn, onQuack: showQuack });

  // Inspector mode outlines every quackable control. The class goes on <body>
  // because the controls are all over the tree and none of them knows about
  // the inspect layer.
  useEffect(() => {
    document.body.classList.toggle("inspector-mode-on", inspectorModeOn);
    return () => document.body.classList.remove("inspector-mode-on");
  }, [inspectorModeOn]);

  // The drawer is fixed to the bottom of the viewport, so the app has to give
  // up that much height while it is open or the drawer sits on top of the
  // workspace it is explaining.
  useEffect(() => {
    document.body.classList.toggle("quack-drawer-open", drawerOpen);
    return () => document.body.classList.remove("quack-drawer-open");
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [drawerOpen]);

  // A pond filter is about the calls on screen right now. When the session's
  // pond is replaced — a reconnect, a backend switch — the filtered set it named
  // no longer exists, so it is dropped rather than left showing stale entries.
  useEffect(() => {
    setPondFilter(null);
  }, [socketUrl]);

  /**
   * The mode and the drawer are ONE state in the "off" direction, per the user's
   * ruling: turning inspector mode off dismisses the drawer as well, because
   * with the badges gone nothing is driving the panel. The other direction is
   * not symmetric on purpose — middle click and the chord open the drawer with
   * the mode off, and closing the drawer turns nothing else off.
   */
  const toggleInspectorMode = useCallback(() => {
    setInspectorModeOn((on) => {
      const next = !on;
      writeInspectorModeToBrowserStorage(next);
      setDrawerOpen(next);
      return next;
    });
  }, []);

  /** A card's `×n`: narrow the pond pane to that card's calls, and open it. */
  const showTheseEntriesInThePond = useCallback(
    (entries: readonly CallLogEntry[], describedAs: string) => {
      setPondFilter({ entries, describedAs });
      setDrawerOpen(true);
    },
    [],
  );

  const toggleChordModifier = (modifier: ModifierKeyName) => {
    const next: QuackChord = chord.includes(modifier)
      ? chord.filter((held) => held !== modifier)
      : MODIFIER_KEY_NAMES.filter(
          (name) => name === modifier || chord.includes(name),
        );
    setChord(next);
    writeQuackChordToBrowserStorage(next);
  };

  const inspectorState = useMemo<InspectorState>(
    () => ({
      drawerOpen,
      setDrawerOpen,
      inspectorModeOn,
      toggleInspectorMode,
      pondEntryCount: pond.length,
    }),
    [drawerOpen, inspectorModeOn, toggleInspectorMode, pond.length],
  );

  return (
    <InspectorStateContext.Provider value={inspectorState}>
      <QuackRequestContext.Provider value={showQuack}>
        <PondFilterContext.Provider value={showTheseEntriesInThePond}>
          {children}
        </PondFilterContext.Provider>

        {inspectorModeOn && <QuackBadgeLayer onQuack={showQuack} />}

        {drawerOpen && (
          <aside
            className="quack-drawer"
            data-quack-chrome=""
            role="dialog"
            aria-label="quack: the openDAQ calls behind this control"
          >
            <div className="quack-pane quack-pane--flock">
              <header className="quack-head">
                <h2>quack</h2>
                <span className="muted">
                  the openDAQ calls behind this control
                </span>
                <span className="spacer" />
                <button
                  className="chrome-button"
                  data-quack-chrome=""
                  onClick={() => setDrawerOpen(false)}
                >
                  close
                </button>
              </header>

              {quacked === null ? (
                <QuackGestureHelp
                  chord={chord}
                  inspectorModeOn={inspectorModeOn}
                />
              ) : (
                <>
                  <p className="quack-subject">
                    quacked <strong>{quacked.controlDescription}</strong> via{" "}
                    {quacked.gesture}
                    {quacked.operationIds.length > 0
                      ? `, which declares ${quacked.operationIds.join(", ")}`
                      : ", which declares no operation id"}
                  </p>
                  {quacked.operationIds.length > 1 && (
                    <div className="quack-operation-tabs">
                      {quacked.operationIds.map((operationId) => (
                        <button
                          key={operationId}
                          className={
                            "chrome-button mono" +
                            (operationId === shownOperationId
                              ? " chrome-button--on"
                              : "")
                          }
                          data-quack-chrome=""
                          onClick={() => setShownOperationId(operationId)}
                        >
                          {operationId}
                        </button>
                      ))}
                    </div>
                  )}
                  {shownOperationId === null ? (
                    <p className="muted pad">
                      This control makes no openDAQ call.
                    </p>
                  ) : (
                    <FlockForOperation operationId={shownOperationId} />
                  )}
                </>
              )}
            </div>

            <div className="quack-pane quack-pane--pond">
              <PondPanel
                pond={pond}
                hostProcessName={hostProcessName}
                socketUrl={socketUrl}
                onQuack={showQuack}
                showingOnly={pondFilter}
                onShowEveryEntry={() => setPondFilter(null)}
              />
              <QuackGestureSettings
                chord={chord}
                inspectorModeOn={inspectorModeOn}
                onToggleChordModifier={toggleChordModifier}
                onToggleInspectorMode={toggleInspectorMode}
              />
            </div>
          </aside>
        )}
      </QuackRequestContext.Provider>
    </InspectorStateContext.Provider>
  );
}

/** The two header buttons. Everything they toggle lives in the provider. */
export function InspectorModeControls() {
  const inspector = useContext(InspectorStateContext);
  return (
    <>
      <button
        className="chrome-button mono"
        data-quack-chrome=""
        title={`the ${inspector.pondEntryCount} calls this session has made to the host, oldest first — opens the call log below`}
        aria-expanded={inspector.drawerOpen}
        onClick={() => inspector.setDrawerOpen(!inspector.drawerOpen)}
      >
        calls {inspector.pondEntryCount}
      </button>
      <button
        className={
          "chrome-button mono" +
          (inspector.inspectorModeOn ? " chrome-button--on" : "")
        }
        data-quack-chrome=""
        aria-pressed={inspector.inspectorModeOn}
        title="inspector mode: badge every quackable control and turn a tap into a quack. Turning it off closes the panel below."
        onClick={inspector.toggleInspectorMode}
      >
        inspector mode {inspector.inspectorModeOn ? "on" : "off"}
      </button>
    </>
  );
}

function QuackGestureHelp({
  chord,
  inspectorModeOn,
}: {
  chord: QuackChord;
  inspectorModeOn: boolean;
}) {
  return (
    <div className="quack-help">
      <p>Nothing quacked yet. Three ways to quack a control:</p>
      <ul>
        <li>
          <strong>middle click</strong> it
        </li>
        <li>
          <strong>{describeQuackChord(chord)}</strong> — the chord, set below
        </li>
        <li>
          <strong>inspector mode</strong>, currently{" "}
          {inspectorModeOn ? "on" : "off"} — then a plain tap quacks
        </li>
      </ul>
    </div>
  );
}

function QuackGestureSettings({
  chord,
  inspectorModeOn,
  onToggleChordModifier,
  onToggleInspectorMode,
}: {
  chord: QuackChord;
  inspectorModeOn: boolean;
  onToggleChordModifier: (modifier: ModifierKeyName) => void;
  onToggleInspectorMode: () => void;
}) {
  return (
    <div className="quack-gesture-settings">
      <h3>the quack gesture</h3>
      <p className="muted">
        middle click, or {describeQuackChord(chord)}.
      </p>
      <div className="quack-chord-choices">
        {MODIFIER_KEY_NAMES.map((modifier) => (
          <label key={modifier} className="mono" data-quack-chrome="">
            <input
              type="checkbox"
              data-quack-chrome=""
              checked={chord.includes(modifier)}
              onChange={() => onToggleChordModifier(modifier)}
            />
            {modifier}
          </label>
        ))}
      </div>
      <button
        className={"chrome-button" + (inspectorModeOn ? " chrome-button--on" : "")}
        data-quack-chrome=""
        aria-pressed={inspectorModeOn}
        onClick={onToggleInspectorMode}
      >
        inspector mode {inspectorModeOn ? "on" : "off"}
      </button>
    </div>
  );
}
