import { Card } from "../card-grid/Card";
import { ComponentIcon } from "../component-tree/component-icon-sprite";
import type { ComponentTypeInfo } from "../transport";
import {
  LIST_LOADED_MODULES,
  MODULE_READ,
} from "./ask-the-host-for-its-loaded-modules";
import { presentationOfComponentTypeKind } from "./component-type-kinds-in-the-reference-band-order";

/**
 * §2.16's nested type card, `--card-min-narrow` 260 px:
 *
 *     name (14 px 600) · description (muted, clamped) · `ID` · `Prefix` for
 *     device and streaming types
 *
 * which is the reference's `_draw_module_type_detail` — name in bold, the
 * description in grey below it, then an `ID` row and, for a type that casts to
 * IDeviceType or IStreamingType, a `Prefix` row.
 *
 * TWO DIFFERENCES FROM THE REFERENCE, both deliberate.
 *
 * The reference prints `N/A` where a value is None (`str(value) if value else
 * "N/A"`). Here a null renders as nothing at all: `description` and
 * `connection_string_prefix` are nullable in contract/contract.yaml, null means
 * the host did not report it, and `N/A` is a string this app would be inventing
 * on the host's behalf.
 *
 * The reference shows one type at a time, on the right of a sash forced to
 * exactly half; here every type of a module is on screen at once, which is the
 * whole of what cards buy on this surface.
 *
 * `create_default_config()` — the read-only property grid §2.16 asks for when a
 * type carries one — has no field on this wire. ComponentTypeInfo is five
 * fields, all of them above.
 */
export function ComponentTypeCard({
  componentType,
  moduleCardId,
}: {
  componentType: ComponentTypeInfo;
  /**
   * Disambiguates two modules offering a type of the same id, in the DOM.
   * openDAQ 3.41.0 does that twice over: `OpenDAQNativeStreamingClientModule`
   * and `OpenDAQWebsocketClientModule` each publish a device type and a
   * streaming type under one id, and `OpenDAQNativeStreaming` is the id of a
   * device type, a streaming type and a server type in three different modules.
   */
  moduleCardId: string;
}) {
  const presentation = presentationOfComponentTypeKind(componentType.kind);
  const prefix = componentType.connection_string_prefix;

  return (
    <Card
      cardId={`component-type:${moduleCardId}:${componentType.kind}:${componentType.id}`}
      glyph={<ComponentIcon name={presentation.glyph} />}
      title={componentType.name}
      titleTooltip={componentType.id}
      headerChips={[{ label: presentation.words, tone: "value-type" }]}
      description={componentType.description}
      metaFacts={[
        componentType.id,
        ...(prefix === null ? [] : [`prefix ${prefix}`]),
      ]}
      operationIds={[MODULE_READ]}
      calls={[{ wireMethod: LIST_LOADED_MODULES }]}
    />
  );
}
