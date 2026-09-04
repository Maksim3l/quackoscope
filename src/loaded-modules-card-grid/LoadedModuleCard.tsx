import { Card } from "../card-grid/Card";
import type { CardFaceView } from "../card-grid/card-grid-model";
import { ComponentIcon } from "../component-tree/component-icon-sprite";
import type { LoadedModuleOnACard } from "./identity-of-a-module-whose-id-the-host-left-empty";
import {
  LIST_LOADED_MODULES,
  MODULE_READ,
} from "./ask-the-host-for-its-loaded-modules";
import { countTypesByKind } from "./component-type-kinds-in-the-reference-band-order";

/**
 * §2.16's module card, in the LEFT pane. One card per loaded module, and
 * clicking it details that module on the right.
 *
 * Face — the reference's `_draw_module_header` compressed onto three lines:
 *
 *     [module] Quackoscope mock synthetic component module        0.1.0
 *              mock_synthetic_component_module
 *              [dev] 1 device  [fb] 3 function block
 *     🦆 list_loaded_modules · module.read  ×1
 *
 * The reference draws `ID` and `Version` as two labelled rows and prints `N/A`
 * when there is no version info. Here the version is the header's value cell and
 * a null version draws nothing: `ModuleInfo.version` is nullable in
 * contract/contract.yaml, and null means the module carries no version info —
 * writing `N/A` there would be this page inventing a value the host did not send.
 *
 * The card no longer expands. The reference's four counted sections of component
 * types are the RIGHT pane now (`LoadedModuleDetailPanel`), where the module the
 * reader clicked is detailed — which is the relationship a component row and its
 * property grid already have, and which leaves one selection in this view rather
 * than a selection plus an expansion.
 */
export function LoadedModuleCard({
  entry,
  view,
  selected,
  onSelect,
}: {
  entry: LoadedModuleOnACard;
  view: CardFaceView;
  selected: boolean;
  onSelect: () => void;
}) {
  const { module, cardId, idAsSent } = entry;
  const offered = countTypesByKind(module.component_types).filter(
    (each) => each.count > 0,
  );

  return (
    <Card
      cardId={cardId}
      glyph={<ComponentIcon name="load_module" />}
      title={module.name}
      titleTooltip={idAsSent ?? undefined}
      headerValue={
        module.version === null ? undefined : (
          <span className="module-card-version mono">{module.version}</span>
        )
      }
      metaFacts={[
        // A host that sent the empty string for IModuleInfo.id has printed
        // nothing here. gui_demo.py's `__module_N__` stand-in is a dictionary
        // key, not a label, and it stays out of the card face.
        ...(view.fieldIsOnTheCardFace("id") && idAsSent !== null
          ? [idAsSent]
          : []),
        ...(view.fieldIsOnTheCardFace("type-count")
          ? [
              `${module.component_types.length} component type${module.component_types.length === 1 ? "" : "s"}`,
            ]
          : []),
      ]}
      operationIds={[MODULE_READ]}
      calls={[{ wireMethod: LIST_LOADED_MODULES }]}
      selected={selected}
      onSelect={onSelect}
    >
      {offered.length > 0 && (
        <ul className="module-card-kind-counts" aria-label="component types offered">
          {offered.map(({ presentation, count }) => (
            <li key={presentation.kind} className="module-card-kind-count">
              <ComponentIcon name={presentation.glyph} />
              <span className="mono">{count}</span>
              <span>{presentation.words}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
