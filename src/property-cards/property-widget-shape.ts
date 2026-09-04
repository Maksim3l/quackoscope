import type { PropertyDescriptor } from "../transport";

/**
 * Which widget a property card puts in its body, decided from the descriptor
 * and from nothing else.
 *
 * This is §2.2's widget table of
 * quackoscope-gui-design-specification-logger-added-look-with-card-grids-replacing-dialogs-and-tables.md
 * with the user's two rulings applied on top of it, and it is a pure function so
 * the decision can be read, tested and printed without rendering anything:
 *
 *   the specification says   bool -> checkbox
 *   the user ruled           bool -> SWITCH
 *
 *   the specification says   int/float -> number input with min/max
 *   the user ruled           int/float with BOTH a min and a max -> a SLIDER
 *                            with the number still directly editable, one value
 *                            in two views, the default marked on the track and
 *                            suggested_values as snap points. Min-only, max-only
 *                            or neither stays a plain number field.
 *
 * Everything else is the specification's table unchanged, restricted to the six
 * value types src/transport/types.ts actually declares. The table's list, dict,
 * enumeration, procedure and function rows have no `PropertyValueType` to key
 * off in the M1 contract, so they are not reachable from a descriptor and are
 * not invented here; a container arriving as the VALUE of a struct property is
 * handled by shape rather than by type, in container-shape-of-a-property-value.ts.
 */

export type PropertyWidgetShape =
  /** bool. The user's ruling: a switch, not a checkbox. Commits immediately. */
  | { kind: "switch" }
  /**
   * int or float with both `min` and `max`. Slider + number field over one
   * value, per the user's ruling. The track's scale is decided separately, per
   * descriptor, in slider-track-scale.ts.
   */
  | { kind: "bounded-number-on-a-slider"; min: number; max: number }
  /** int or float missing a min, a max, or both. The specification's plain number input. */
  | { kind: "number-without-both-bounds" }
  /** selection with more than one option. */
  | { kind: "selection-list"; options: readonly string[] }
  /**
   * §1.8 and §2.2: "selection with exactly 1 option -> read-only text (the
   * reference greys these; keep that)". The card is in the read-only state as
   * surely as if read_only were true, and says so.
   */
  | { kind: "selection-with-one-option-is-read-only"; onlyOption: string }
  /**
   * string with a non-empty `suggested_values`. §2.2: "text input + <datalist> —
   * editable, which is what the reference's Editable.TCombobox is".
   */
  | { kind: "text-with-suggested-values"; suggestions: readonly string[] }
  | { kind: "text" }
  /**
   * struct. §2.2: "the card body becomes a definition list of the fields, each
   * field inline-editable". §2.14 adds that the whole container is written back
   * with one set_property_value, which is why the rows commit the container and
   * not the row.
   */
  | { kind: "container-rows" };

/** Numbers among `suggested_values`, in order, ignoring anything that is not one. */
export function numericSuggestedValues(
  descriptor: PropertyDescriptor,
): number[] {
  return (descriptor.suggested_values ?? []).filter(
    (each): each is number => typeof each === "number" && Number.isFinite(each),
  );
}

/** `suggested_values` as the strings a `<datalist>` offers. */
export function suggestedValuesAsStrings(
  descriptor: PropertyDescriptor,
): string[] {
  return (descriptor.suggested_values ?? []).map((each) =>
    typeof each === "string" ? each : JSON.stringify(each),
  );
}

export function decidePropertyWidgetShape(
  descriptor: PropertyDescriptor,
): PropertyWidgetShape {
  switch (descriptor.value_type) {
    case "bool":
      return { kind: "switch" };

    case "int":
    case "float":
      // The user's ruling, and the whole reason this branch exists: BOTH bounds
      // or no slider. A half-bounded range has no track to draw — there is no
      // right-hand end for the handle to travel to.
      if (
        descriptor.min !== null &&
        descriptor.max !== null &&
        Number.isFinite(descriptor.min) &&
        Number.isFinite(descriptor.max) &&
        descriptor.max > descriptor.min
      ) {
        return {
          kind: "bounded-number-on-a-slider",
          min: descriptor.min,
          max: descriptor.max,
        };
      }
      return { kind: "number-without-both-bounds" };

    case "selection": {
      const options = descriptor.selection_values ?? [];
      if (options.length === 1) {
        return {
          kind: "selection-with-one-option-is-read-only",
          onlyOption: options[0],
        };
      }
      return { kind: "selection-list", options };
    }

    case "string": {
      const suggestions = suggestedValuesAsStrings(descriptor);
      return suggestions.length > 0
        ? { kind: "text-with-suggested-values", suggestions }
        : { kind: "text" };
    }

    case "struct":
      return { kind: "container-rows" };
  }
}
