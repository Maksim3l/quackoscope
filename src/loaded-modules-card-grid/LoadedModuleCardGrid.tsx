import { Card } from "../card-grid/Card";
import { CardGrid } from "../card-grid/CardGrid";
import { CardQuackStrip } from "../card-grid/CardQuackStrip";
import type {
  CardGridField,
  CardGridItemFacts,
} from "../card-grid/card-grid-model";
import {
  TheCallThatWouldHavePopulatedThisGridCard,
  useGapOnThisCapability,
} from "../discovery-and-function-block-card-grids/a-gapped-card-teaches-more-than-a-working-one";
import {
  LIST_LOADED_MODULES,
  MODULE_READ,
} from "./ask-the-host-for-its-loaded-modules";
import { LoadAModuleFromAPathOnTheHostCard } from "./LoadAModuleFromAPathOnTheHostCard";
import { LoadedModuleCard } from "./LoadedModuleCard";
import type { LoadedModuleOnACard } from "./identity-of-a-module-whose-id-the-host-left-empty";
import {
  describeTheListingState,
  type LoadedModuleListing,
} from "./keep-one-module-listing-for-the-grid-and-the-detail-pane";
import { presentationOfComponentTypeKind } from "./component-type-kinds-in-the-reference-band-order";

/**
 * §2.16 — the reference's Modules tab as a card grid, IN THE LEFT PANE.
 *
 * The reference splits its Modules pane in half with a sash forced to exactly
 * 50 % on `<Map>`: a tree of modules on the left, a detail panel for the one
 * selected type on the right. This is that left half, with a card where the
 * reference has a tree row; `LoadedModuleDetailPanel` is the right half, and
 * clicking a card here is what fills it.
 *
 * One call fills the whole surface. `list_loaded_modules` takes no parameters
 * and answers with `array of ModuleInfo`, component types included, so switching
 * between modules sends nothing — which is what the quack strip at the foot of
 * the pane states. The one control here that DOES send something is the add card
 * at the top, and it is a different operation under a different capability:
 * `load_module_from_host_path`, `module.load`. `list_loaded_modules` lists what
 * IS loaded; loading one more is not the same operation and is not drawn as one.
 */

const LOADED_MODULES_GRID_ID = "loaded-modules";

const MODULE_FIELDS: readonly CardGridField<LoadedModuleOnACard>[] = [
  {
    id: "name",
    label: "name",
    valueOf: ({ module }) => module.name,
    // Off the face by default: the card's title IS the module name and the rows
    // renderer's first column is `Module name`, so a `name` column beside it
    // would print the same string twice on every row. It stays a declared field
    // because that is what makes "sort by name" an option in the grid bar, and
    // the filter searches the title whether or not this field is on the face.
    onCardFaceByDefault: false,
    searchedByFilter: true,
  },
  {
    id: "id",
    label: "id",
    // The empty string where the host sent no id, never the positional
    // `__module_N__` stand-in the DOM is keyed on.
    valueOf: ({ idAsSent }) => idAsSent ?? "",
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: "version",
    label: "version",
    // A module with no version info contributes an empty string, which sorts
    // together and matches no filter — rather than a word this page invented for
    // the absence.
    valueOf: ({ module }) => module.version ?? "",
    onCardFaceByDefault: true,
    searchedByFilter: true,
  },
  {
    id: "type-count",
    label: "component types",
    valueOf: ({ module }) => String(module.component_types.length),
    compare: (a, b) =>
      a.module.component_types.length - b.module.component_types.length,
    // Off the face by default and available from the chooser: the kind-count
    // line on the card face already carries this number, split by kind —
    // `1 device · 2 function block` says everything `3 component types` says
    // and more, on the line the card was going to draw anyway.
    onCardFaceByDefault: false,
    searchedByFilter: false,
  },
  {
    id: "type-kinds",
    label: "type kinds",
    valueOf: ({ module }) =>
      [...new Set(module.component_types.map((type) => type.kind))]
        .map((kind) => presentationOfComponentTypeKind(kind).words)
        .join(", "),
    onCardFaceByDefault: false,
    searchedByFilter: true,
  },
  {
    id: "type-names",
    label: "type names",
    valueOf: ({ module }) =>
      module.component_types.map((type) => type.name).join(", "),
    onCardFaceByDefault: false,
    searchedByFilter: true,
  },
  {
    id: "connection-string-prefixes",
    label: "connection string prefixes",
    valueOf: ({ module }) =>
      module.component_types
        .map((type) => type.connection_string_prefix)
        .filter((prefix): prefix is string => prefix !== null)
        .join(", "),
    onCardFaceByDefault: false,
    searchedByFilter: true,
  },
];

export function LoadedModuleCardGrid({
  listing,
  selectedModuleCardId,
  onSelectModule,
}: {
  listing: LoadedModuleListing;
  selectedModuleCardId: string | null;
  onSelectModule: (entry: LoadedModuleOnACard) => void;
}) {
  const moduleReadGap = useGapOnThisCapability(MODULE_READ);

  return (
    <section className="loaded-modules-surface" aria-label="loaded modules">
      <p className="loaded-modules-state" role="status">
        {moduleReadGap === null ? describeTheListingState(listing) : ""}
      </p>

      {/* The add on this surface, and it is rendered HERE rather than as the
          grid's `pinnedFirst` for one concrete reason: a successful load is
          followed immediately by a re-read, and anything mounted inside the grid
          goes off screen for as long as that call is in flight — taking the
          typed path and the sentence naming the module that was just loaded with
          it. This position is outside every branch below, so the card is mounted
          once for the life of the view and its outcome stays readable.

          module.load is a capability of its own, so a host that will not
          enumerate its modules may still load one, and a host that gaps both
          says so twice, once per capability, in its own words. */}
      <div className="loaded-modules-add-card">
        <LoadAModuleFromAPathOnTheHostCard
          onLoad={listing.loadFromAPathOnTheHost}
        />
      </div>

      {moduleReadGap !== null ? (
        <TheCallThatWouldHavePopulatedThisGridCard
          standing={moduleReadGap.standing}
          hostProcessName={moduleReadGap.hostProcessName}
          capability={MODULE_READ}
          wireMethod={LIST_LOADED_MODULES}
          whatIsBlocked={`Listing the modules ${moduleReadGap.hostProcessName} has loaded, and the device, function block, server and streaming types each one offers.`}
          whatTheGridWouldHaveHeld="one card per loaded module, each opening that module's component types on the right"
        />
      ) : (
        <>
          {listing.refusal !== null && (
            <Card
              cardId="list-loaded-modules-refused"
              glyph="⚠"
              title={LIST_LOADED_MODULES}
              states={[
                {
                  state: "rejected",
                  words: `${listing.refusal.code}: ${listing.refusal.detail}`,
                },
              ]}
              operationIds={[MODULE_READ]}
              calls={[{ wireMethod: LIST_LOADED_MODULES }]}
            >
              <p>
                The host declares <code className="mono">module.read</code> as
                served and then refused the call. The code and the host&apos;s
                own detail are printed above, verbatim.
              </p>
            </Card>
          )}

          {listing.modulesAsLastAnswered === null ? (
            <p className="muted">{describeTheListingState(listing)}</p>
          ) : (
            <CardGrid
              gridId={LOADED_MODULES_GRID_ID}
              entityNounSingular="module"
              entityNounPlural="modules"
              items={listing.cards}
              factsOf={factsOfModule}
              fields={MODULE_FIELDS}
              cardMinWidth="narrow"
              hostOrderLabel="module manager order"
              titleColumnLabel="Module name"
              operationIdsOf={() => [MODULE_READ]}
              populatedBy={{ wireMethod: LIST_LOADED_MODULES }}
              selectedCardId={selectedModuleCardId}
              onSelect={onSelectModule}
              renderCard={(entry, view) => (
                <LoadedModuleCard
                  key={entry.cardId}
                  entry={entry}
                  view={view}
                  selected={entry.cardId === selectedModuleCardId}
                  onSelect={() => onSelectModule(entry)}
                />
              )}
            />
          )}
        </>
      )}

      {/* §3.2, and the same shape the tree pane uses: every card on this
          surface is here because of ONE call, and this names it. */}
      <div className="loaded-modules-quack-strip-holder">
        <CardQuackStrip
          cardTitle="the loaded modules view"
          calls={[{ wireMethod: LIST_LOADED_MODULES }]}
        />
      </div>
    </section>
  );
}

function factsOfModule(entry: LoadedModuleOnACard): CardGridItemFacts {
  return {
    id: entry.cardId,
    title: entry.module.name,
    states: [],
    hiddenByDescriptor: false,
  };
}
