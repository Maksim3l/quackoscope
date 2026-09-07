import { CardQuackStrip } from "../card-grid/CardQuackStrip";
import { ComponentIcon } from "../component-tree/component-icon-sprite";
import type { ModuleInfo } from "../transport";
import { LIST_LOADED_MODULES } from "./ask-the-host-for-its-loaded-modules";
import { ComponentTypeCard } from "./ComponentTypeCard";
import {
  COMPONENT_TYPE_KINDS_IN_THE_REFERENCE_BAND_ORDER,
  countTypesByKind,
} from "./component-type-kinds-in-the-reference-band-order";
import type { LoadedModuleOnACard } from "./identity-of-a-module-whose-id-the-host-left-empty";

/**
 * The RIGHT pane of the Modules view: everything the reference's Modules tab
 * draws about the one module its tree has selected.
 *
 * The reference builds this in two pieces — `_draw_module_header` puts the
 * module's name, id and version in a header block, and `_draw_module_type_columns`
 * puts four counted sections under it, `Device Types (n)`, `Function Block Types
 * (n)`, `Server Types (n)`, `Streaming Types (n)`, with `_draw_module_type_detail`
 * drawing the one type its sash-halved panel has selected. Both pieces are here,
 * in that order and in that band order.
 *
 * ONE DIFFERENCE from the reference, the same one §2.16 already took: the
 * reference shows ONE type at a time on the right of a sash forced to exactly
 * half, and here every type of the module is on screen at once, one card each.
 * That is what cards buy on this surface, and it removes the second selection —
 * the module the left pane picked is the only thing selected in this view.
 *
 * `N/A` is the reference's word for a value openDAQ gave it as None. Nothing
 * here writes it: `ModuleInfo.version`, `ComponentTypeInfo.description` and
 * `connection_string_prefix` are nullable on the wire, and null means the host
 * reported nothing — a string invented in its place would be this page speaking
 * for the host.
 */
export function LoadedModuleDetailPanel({
  entry,
}: {
  entry: LoadedModuleOnACard;
}) {
  const { module, idAsSent } = entry;
  const counts = countTypesByKind(module.component_types);
  const offered = counts.filter((each) => each.count > 0);

  return (
    <section
      className="module-detail"
      aria-label={`what ${module.name} offers`}
    >
      <header className="module-detail-header">
        <ComponentIcon name="load_module" className="module-detail-glyph" />
        <h3 className="module-detail-name">{module.name}</h3>
        {module.version !== null && (
          <span className="module-detail-version mono">{module.version}</span>
        )}
      </header>

      <dl className="module-detail-facts">
        {idAsSent !== null && (
          <>
            <dt>id</dt>
            <dd className="mono">{idAsSent}</dd>
          </>
        )}
        <dt>component types</dt>
        <dd>
          {module.component_types.length}
          {offered.length > 0 && (
            <ul className="module-card-kind-counts">
              {offered.map(({ presentation, count }) => (
                <li key={presentation.kind} className="module-card-kind-count">
                  <ComponentIcon name={presentation.glyph} />
                  <span className="mono">{count}</span>
                  <span>{presentation.words}</span>
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>

      <ComponentTypeBands module={module} moduleCardId={entry.cardId} />

      {/* §3.2. Every fact on this panel arrived on the one call the left pane
          made; clicking another module card sends nothing. */}
      <CardQuackStrip
        cardTitle={`${module.name}, its component types`}
        calls={[{ wireMethod: LIST_LOADED_MODULES }]}
      />
    </section>
  );
}

/**
 * The reference's four sections, in `_draw_module_type_columns`'s own order. A
 * band with no types still prints, with its `(0)`, because the reference inserts
 * all four whether or not the dictionary behind one holds anything — "this
 * module offers no server types" is a fact about the module.
 */
function ComponentTypeBands({
  module,
  moduleCardId,
}: {
  module: ModuleInfo;
  moduleCardId: string;
}) {
  return (
    <div className="module-type-bands">
      {COMPONENT_TYPE_KINDS_IN_THE_REFERENCE_BAND_ORDER.map((presentation) => {
        const types = module.component_types.filter(
          (type) => type.kind === presentation.kind,
        );
        return (
          <section
            key={presentation.kind}
            className="module-type-band"
            data-component-type-kind={presentation.kind}
            data-component-type-count={types.length}
          >
            {/* No glyph on the heading. Every card under it already leads with
                that kind's glyph AND spells the kind out on a chip; a third copy
                on the band heading would be the same fact three times. */}
            <h4 className="module-type-band-heading">
              {presentation.bandHeading} ({types.length})
            </h4>
            {types.length > 0 && (
              <div className="card-grid card-grid--narrow module-type-grid">
                {types.map((componentType) => (
                  <ComponentTypeCard
                    key={componentType.id}
                    componentType={componentType}
                    moduleCardId={moduleCardId}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
