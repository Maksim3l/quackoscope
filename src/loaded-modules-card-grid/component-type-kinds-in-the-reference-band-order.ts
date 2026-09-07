import type { ComponentTypeInfo } from "../transport";
import type { ComponentIconName } from "../component-tree/component-icon-sprite";

/**
 * The four `ComponentTypeInfo.kind` values, in the order the reference's
 * `_draw_module_type_columns` inserts its four sections, with the glyph and the
 * words each one is drawn with here.
 *
 * The order is not alphabetical and is not this file's choice: gui_demo.py
 * builds `sections` as Device Types, Function Block Types, Server Types,
 * Streaming Types, and the bands below keep that sequence so a reader who knows
 * the reference finds them where they were.
 *
 * `connection_string_prefix` is nullable on every type in contract/contract.yaml
 * and carries a value only on device and streaming types, because openDAQ reads
 * it off IDeviceType and IStreamingType and no other component type has it.
 * `kindCarriesAConnectionStringPrefix` is that fact, so a card can tell a
 * function block type with no prefix (there is no such field) apart from a
 * device type whose host sent null (the field exists and is empty).
 */
export interface ComponentTypeKindPresentation {
  kind: ComponentTypeInfo["kind"];
  /** On the type card's chip and in the band heading. The wire's own word, spaced. */
  words: string;
  /** The band heading of §2.16: `Device types (3)`. */
  bandHeading: string;
  /** §1.5's sprite. `streaming` has no glyph of its own; `link` is the connection. */
  glyph: ComponentIconName;
  kindCarriesAConnectionStringPrefix: boolean;
}

export const COMPONENT_TYPE_KINDS_IN_THE_REFERENCE_BAND_ORDER: readonly ComponentTypeKindPresentation[] =
  [
    {
      kind: "device",
      words: "device",
      bandHeading: "Device types",
      glyph: "device",
      kindCarriesAConnectionStringPrefix: true,
    },
    {
      kind: "function_block",
      words: "function block",
      bandHeading: "Function block types",
      glyph: "function_block",
      kindCarriesAConnectionStringPrefix: false,
    },
    {
      kind: "server",
      words: "server",
      bandHeading: "Server types",
      glyph: "server",
      kindCarriesAConnectionStringPrefix: false,
    },
    {
      kind: "streaming",
      words: "streaming",
      bandHeading: "Streaming types",
      // The sprite of §1.5 has no `streaming` symbol: its per-kind glyphs come
      // from the reference's icon set, and the reference draws no streaming
      // type anywhere. `link` is the one that says "a connection to somewhere
      // else", which is what a streaming type is and what its
      // connection_string_prefix opens.
      glyph: "link",
      kindCarriesAConnectionStringPrefix: true,
    },
  ];

export function presentationOfComponentTypeKind(
  kind: ComponentTypeInfo["kind"],
): ComponentTypeKindPresentation {
  const found = COMPONENT_TYPE_KINDS_IN_THE_REFERENCE_BAND_ORDER.find(
    (each) => each.kind === kind,
  );
  if (found === undefined) {
    throw new Error(
      `ComponentTypeInfo.kind "${kind}" is outside the closed set ` +
        COMPONENT_TYPE_KINDS_IN_THE_REFERENCE_BAND_ORDER.map(
          (each) => each.kind,
        ).join(", ") +
        " that contract/contract.yaml declares",
    );
  }
  return found;
}

/** `1 device · 3 function block`, one term per kind that is actually offered. */
export function countTypesByKind(
  componentTypes: readonly ComponentTypeInfo[],
): { presentation: ComponentTypeKindPresentation; count: number }[] {
  return COMPONENT_TYPE_KINDS_IN_THE_REFERENCE_BAND_ORDER.map(
    (presentation) => ({
      presentation,
      count: componentTypes.filter((type) => type.kind === presentation.kind)
        .length,
    }),
  );
}
