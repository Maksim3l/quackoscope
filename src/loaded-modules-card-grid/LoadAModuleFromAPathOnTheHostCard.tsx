import { useState } from "react";
import { Card } from "../card-grid/Card";
import { ComponentIcon } from "../component-tree/component-icon-sprite";
import {
  DraftCallCommit,
  NEVER_SENT,
  cardStateMarksForDraftCallOutcome,
  quackStripLineForDraftedCall,
  type DraftCallOutcome,
  type DraftedCall,
} from "../discovery-and-function-block-card-grids/the-draft-card-is-the-call-preview";
import {
  GapOneLinerInPlaceOfTheMetaLine,
  gappedCardStateMark,
  useGapOnThisCapability,
} from "../discovery-and-function-block-card-grids/a-gapped-card-teaches-more-than-a-working-one";
import { useHostProcessName } from "../session/host-capability-context";
import {
  LOAD_MODULE_FROM_HOST_PATH,
  MODULE_LOAD,
  whyThisPathCannotBeSentYet,
  type ModuleLoadOutcome,
} from "./load-a-module-from-a-path-on-the-hosts-own-filesystem";

/**
 * The card that loads a module the host has not loaded — pinned first in the
 * module grid, the way §2.5 pins the typed connection string first in the
 * discovery grid. Card grids are the app's ADD surfaces, and this is the add on
 * this one.
 *
 * It is a PATH FIELD and not a file picker, and the card says which machine the
 * path is read on in the field's own label, not in a footnote: a browser file
 * input would hand back a path on the machine the reader is sitting at, and the
 * host process — which may be on another machine entirely — is what opens it.
 *
 * Nothing here fills the field with a guess. The host's module directory is the
 * manifest's `module_path` on the host side and the handshake carries no such
 * field, so this page has no value to offer and offers none rather than one it
 * made up.
 */
export function LoadAModuleFromAPathOnTheHostCard({
  onLoad,
}: {
  onLoad: (hostPath: string) => Promise<ModuleLoadOutcome>;
}) {
  const [typed, setTyped] = useState("");
  const [outcome, setOutcome] = useState<DraftCallOutcome>(NEVER_SENT);
  const hostProcessName = useHostProcessName();
  const loadGap = useGapOnThisCapability(MODULE_LOAD);

  const draft: DraftedCall = {
    wireMethod: LOAD_MODULE_FROM_HOST_PATH,
    capability: MODULE_LOAD,
    params: { host_path: typed },
    refusalBeforeSending: whyThisPathCannotBeSentYet(typed),
  };

  return (
    <Card
      cardId="load-module-from-host-path"
      glyph={<ComponentIcon name="load_module" />}
      title="Load a module the host has not loaded"
      titleTooltip={`${LOAD_MODULE_FROM_HOST_PATH} — the grid beside this card lists what IS loaded; this loads one more`}
      metaFacts={[
        `host_path is read on ${hostProcessName}'s own filesystem, not on this machine`,
        "the file extension is the one the host's platform requires; a wrong one is refused invalid_value with openDAQ's own message, which names it",
      ]}
      metaLineReplacement={
        loadGap === null ? undefined : (
          <GapOneLinerInPlaceOfTheMetaLine
            standing={loadGap.standing}
            hostProcessName={loadGap.hostProcessName}
          />
        )
      }
      states={[
        ...(loadGap === null
          ? []
          : [gappedCardStateMark(loadGap.standing, loadGap.hostProcessName)]),
        ...cardStateMarksForDraftCallOutcome(outcome),
      ]}
      operationIds={[MODULE_LOAD]}
      calls={[quackStripLineForDraftedCall(draft)]}
    >
      <DraftCallCommit
        call={draft}
        outcome={outcome}
        discard={
          typed.length === 0
            ? undefined
            : {
                label:
                  "clear the path — nothing has been sent, so there is nothing to undo",
                onDiscard: () => {
                  setTyped("");
                  setOutcome(NEVER_SENT);
                },
              }
        }
        onSend={(sent) => {
          setOutcome({ state: "sending" });
          void onLoad(sent.params.host_path as string).then((answer) => {
            if (answer.loaded === null) {
              setOutcome({
                state: "refused",
                code: answer.errorCode ?? "internal",
                detail: answer.detail,
              });
              return;
            }
            const module = answer.loaded;
            setOutcome({
              state: "answered",
              sentence:
                `${LOAD_MODULE_FROM_HOST_PATH} answered with module ` +
                `${module.name}${module.id.length > 0 ? ` (id ${module.id})` : ""}` +
                `${module.version === null ? "" : `, version ${module.version}`}` +
                `, offering ${module.component_types.length} component type` +
                `${module.component_types.length === 1 ? "" : "s"}. ` +
                `${hostProcessName} can answer scan_available_devices and ` +
                `list_function_block_types differently from this point on, because ` +
                `a loaded module is what publishes those types.`,
            });
          });
        }}
      >
        <label className="load-module-path-label">
          <span className="muted">
            host_path — a path on {hostProcessName}&apos;s own filesystem
          </span>
          <input
            type="text"
            className="mono load-module-path-input"
            value={typed}
            placeholder="the path the host process will open"
            data-op={MODULE_LOAD}
            aria-label={`host_path for ${LOAD_MODULE_FROM_HOST_PATH}, resolved on ${hostProcessName}'s filesystem`}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      </DraftCallCommit>
    </Card>
  );
}
