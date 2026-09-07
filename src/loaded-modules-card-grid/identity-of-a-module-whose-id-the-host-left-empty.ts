import type { ModuleInfo } from "../transport";

/**
 * The card identity of one module, and the reference's own answer to a module
 * whose `IModuleInfo.id` is the empty string.
 *
 * This is not hypothetical. `quackoscope-host-cpp` on openDAQ 3.41.0 answers
 * `list_loaded_modules` with 17 modules, and three of them are named
 * `MockModule`: one has the id `mock_dep` and TWO have the id `""`. Two cards
 * keyed on `""` would be one React key used twice and one `data-card-id` shared
 * by two elements.
 *
 * gui_demo.py hits the same wall in `tree_update` and answers it like this:
 *
 *     mod_id = str(info.id)
 *     if not mod_id:
 *         mod_id = f'__module_{len(self.modules_map)}__'
 *
 * — a positional identity, generated only when the host sent no id. That is
 * what `cardId` below is. It is an identity for the DOM and for React, never
 * something drawn on the card: a module that sent no id has none printed, and
 * `idAsSent` is null so nothing invents one.
 */
export interface LoadedModuleOnACard {
  module: ModuleInfo;
  /** Unique across the answer. The host's own id where it sent one. */
  cardId: string;
  /** The host's id, or null when the host sent the empty string. */
  idAsSent: string | null;
  /** 0-based position in the host's own answer, which is what the fallback is built from. */
  position: number;
}

export function shapeModulesIntoCards(
  modules: readonly ModuleInfo[],
): LoadedModuleOnACard[] {
  const taken = new Set<string>();
  return modules.map((module, position) => {
    const idAsSent = module.id.length === 0 ? null : module.id;
    let cardId = idAsSent ?? `__module_${position}__`;
    // A host may also repeat a non-empty id. The same positional suffix keeps
    // those apart, for the same reason and without hiding that it happened.
    while (taken.has(cardId)) cardId = `${cardId}__${position}`;
    taken.add(cardId);
    return { module, cardId, idAsSent, position };
  });
}
