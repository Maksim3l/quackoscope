import type { PropertyDescriptor } from "../transport";

/**
 * The client-side pre-check, and the only one the contract allows.
 *
 * A value may be refused here for exactly three reasons: it is below `min`, it
 * is above `max`, or it is not a member of `selection_values`. Everything else
 * is the host's job, comes back as `invalid_value`, and is shown with the
 * host's own `detail` verbatim. `validator` and `coercer` are EvalValue source
 * strings, displayed and never interpreted client-side.
 *
 * There is deliberately no device-specific or property-name-specific knowledge
 * here: the descriptor is the only input.
 *
 * This lived in src/components/PropertyField.tsx, the widget of the flat
 * property row grid the card grid replaced. It moved out on its own before that
 * grid was deleted, because it is not about rows.
 */

export type PrecheckResult = string | null;

export function precheck(
  d: PropertyDescriptor,
  value: unknown,
): PrecheckResult {
  if (d.value_type === "int" || d.value_type === "float") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return "not a number";
    }
    if (d.min !== null && value < d.min) return `below minimum ${d.min}`;
    if (d.max !== null && value > d.max) return `above maximum ${d.max}`;
  }
  if (d.value_type === "selection" && d.selection_values !== null) {
    if (typeof value === "number") {
      if (
        !Number.isInteger(value) ||
        value < 0 ||
        value >= d.selection_values.length
      ) {
        return `not a valid selection index (0..${d.selection_values.length - 1})`;
      }
    } else if (typeof value === "string") {
      if (!d.selection_values.includes(value)) {
        return "not a member of selection_values";
      }
    }
  }
  return null;
}
