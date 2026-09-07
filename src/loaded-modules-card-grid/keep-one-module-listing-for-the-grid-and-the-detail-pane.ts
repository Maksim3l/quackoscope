import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModuleInfo, TransportClient } from "../transport";
import {
  describeSendFailure,
  LIST_LOADED_MODULES,
  listLoadedModules,
} from "./ask-the-host-for-its-loaded-modules";
import {
  LOAD_MODULE_FROM_HOST_PATH,
  loadModuleFromHostPath,
  type ModuleLoadOutcome,
} from "./load-a-module-from-a-path-on-the-hosts-own-filesystem";
import {
  shapeModulesIntoCards,
  type LoadedModuleOnACard,
} from "./identity-of-a-module-whose-id-the-host-left-empty";

/**
 * ONE reading of `list_loaded_modules` for the two panes that draw it.
 *
 * The Modules view puts the grid of module cards in the LEFT pane and the
 * component types of the clicked module in the RIGHT one. Both are views of the
 * same answer, so both read this: two components each holding their own copy
 * would be two answers that can disagree, and the card a reader clicked on the
 * left could then detail a module the right pane no longer has.
 *
 * The listing is not fetched until the Modules view is actually chosen. It is a
 * wire call, and a view nobody opened has asked the host nothing.
 *
 * WHY THE LAST ANSWER SURVIVES A RE-READ. `modulesAsLastAnswered` keeps whatever
 * came back last while a new `list_loaded_modules` is in flight, instead of the
 * surface emptying and refilling. It is not a cosmetic preference: the grid is
 * re-read immediately after a module is loaded, and a grid that unmounts between
 * the two takes the load card — and the sentence naming the module that was just
 * loaded — down with it. What is on screen during a re-read is the previous
 * answer, and the state line says so rather than letting it pass for the new one.
 */

export interface LoadedModuleListing {
  /** Null until the first answer. The PREVIOUS answer while a re-read is in flight. */
  modulesAsLastAnswered: readonly ModuleInfo[] | null;
  /** That answer shaped into cards, with the positional id fallback applied. */
  cards: readonly LoadedModuleOnACard[];
  /** True from the moment `list_loaded_modules` is sent until it answers. */
  callIsInFlight: boolean;
  /** The host's refusal of the most recent `list_loaded_modules`, or null. */
  refusal: { code: string; detail: string } | null;
  /** False until this session has sent `list_loaded_modules` even once. */
  theCallHasBeenSent: boolean;
  /** One `list_loaded_modules`, replacing every card with what comes back. */
  reread: () => Promise<void>;
  /**
   * One `load_module_from_host_path`, followed by a `list_loaded_modules` so the
   * grid is the host's own answer rather than this page's arithmetic on it. The
   * `ModuleInfo` the load answered with is on the outcome.
   */
  loadFromAPathOnTheHost: (hostPath: string) => Promise<ModuleLoadOutcome>;
}

export function useOneModuleListingForBothPanes(
  client: TransportClient,
  /** False while the Modules view is not on screen: nothing is asked then. */
  theModulesViewIsOnScreen: boolean,
  /** False when the host gaps module.read: `list_loaded_modules` is never sent. */
  theHostServesTheListing: boolean,
): LoadedModuleListing {
  const [modulesAsLastAnswered, setModulesAsLastAnswered] = useState<
    readonly ModuleInfo[] | null
  >(null);
  const [callIsInFlight, setCallIsInFlight] = useState(false);
  const [refusal, setRefusal] = useState<{
    code: string;
    detail: string;
  } | null>(null);
  const [theCallHasBeenSent, setTheCallHasBeenSent] = useState(false);
  const generation = useRef(0);

  const reread = useCallback(async (): Promise<void> => {
    const thisGeneration = ++generation.current;
    setTheCallHasBeenSent(true);
    setCallIsInFlight(true);
    try {
      const modules = await listLoadedModules(client);
      if (thisGeneration !== generation.current) return;
      setModulesAsLastAnswered(modules);
      setRefusal(null);
    } catch (error) {
      if (thisGeneration !== generation.current) return;
      setRefusal(describeSendFailure(error));
    } finally {
      if (thisGeneration === generation.current) setCallIsInFlight(false);
    }
  }, [client]);

  useEffect(() => {
    if (!theModulesViewIsOnScreen) return;
    if (!theHostServesTheListing) return;
    void reread();
  }, [theModulesViewIsOnScreen, theHostServesTheListing, reread]);

  const loadFromAPathOnTheHost = useCallback(
    async (hostPath: string): Promise<ModuleLoadOutcome> => {
      const call = `${LOAD_MODULE_FROM_HOST_PATH} { host_path: ${JSON.stringify(hostPath)} }`;
      try {
        const loaded = await loadModuleFromHostPath(client, hostPath);
        // openDAQ answers OPENDAQ_IGNORED when the SAME path is loaded twice and
        // hands back the module it already holds, so a success here is not
        // necessarily a module the list did not have. Re-listing is what settles
        // which, and it is the host's answer that ends up on screen either way.
        if (theHostServesTheListing) await reread();
        return { call, loaded, errorCode: null, detail: "" };
      } catch (error) {
        const { code, detail } = describeSendFailure(error);
        return { call, loaded: null, errorCode: code, detail };
      }
    },
    [client, reread, theHostServesTheListing],
  );

  const cards = useMemo(
    () =>
      modulesAsLastAnswered === null
        ? []
        : shapeModulesIntoCards(modulesAsLastAnswered),
    [modulesAsLastAnswered],
  );

  return {
    modulesAsLastAnswered,
    cards,
    callIsInFlight,
    refusal,
    theCallHasBeenSent,
    reread,
    loadFromAPathOnTheHost,
  };
}

/** The state of the one call that fills this pane, as a sentence. */
export function describeTheListingState(listing: LoadedModuleListing): string {
  const answered = listing.modulesAsLastAnswered;
  if (listing.callIsInFlight) {
    return (
      `${LIST_LOADED_MODULES} sent, waiting` +
      (answered === null
        ? ""
        : ` — the ${answered.length} module${answered.length === 1 ? "" : "s"} below ` +
          `${answered.length === 1 ? "is" : "are"} what the previous answer held`)
    );
  }
  if (listing.refusal !== null) {
    return `${LIST_LOADED_MODULES} was refused ${listing.refusal.code}`;
  }
  if (answered === null) {
    return `${LIST_LOADED_MODULES} has not been sent yet`;
  }
  const types = answered.reduce(
    (total, module) => total + module.component_types.length,
    0,
  );
  return (
    `${LIST_LOADED_MODULES} answered with ${answered.length} module` +
    `${answered.length === 1 ? "" : "s"} offering ${types} component type` +
    `${types === 1 ? "" : "s"}`
  );
}
