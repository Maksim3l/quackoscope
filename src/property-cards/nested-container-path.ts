/**
 * Where inside a container property's value an inline row sits, and how to put a
 * new value back at that place.
 *
 * §2.2's nesting rule is a rule about depth, so depth has to be a value the code
 * can carry:
 *
 *   "an object property's card holds a nested grid at --card-min-narrow with ONE
 *    nested level and then a breadcrumb (Config › Streaming › Timeouts →) that
 *    navigates the grid rather than nesting a third time. Three levels of nested
 *    card is unreadable; the reference's tree handles depth better and this is
 *    the one place §1.1's principle strains. Say so in the UI: the breadcrumb is
 *    labelled, not implied."
 *
 * A path is the list of keys and indices from the property's own value down to
 * one row. The empty path is the property's value itself. Every write still goes
 * out as ONE `set_property_value` carrying the WHOLE root container (§2.14), so
 * these functions rebuild the root rather than editing in place — which also
 * means a refused write leaves the value on screen exactly as the host last
 * reported it.
 */

export type ContainerPathSegment = string | number;
export type ContainerPath = readonly ContainerPathSegment[];

export function valueAtContainerPath(
  root: unknown,
  path: ContainerPath,
): unknown {
  let here: unknown = root;
  for (const segment of path) {
    if (here === null || typeof here !== "object") return undefined;
    here = Array.isArray(here)
      ? here[Number(segment)]
      : (here as Record<string, unknown>)[String(segment)];
  }
  return here;
}

/**
 * The whole root container, with one place inside it replaced. Nothing is
 * mutated: every level along the path is copied.
 */
export function rootContainerWithValueAt(
  root: unknown,
  path: ContainerPath,
  value: unknown,
): unknown {
  if (path.length === 0) return value;
  const [segment, ...rest] = path;
  if (Array.isArray(root)) {
    const index = Number(segment);
    return root.map((each, i) =>
      i === index ? rootContainerWithValueAt(each, rest, value) : each,
    );
  }
  if (root !== null && typeof root === "object") {
    const held = root as Record<string, unknown>;
    const key = String(segment);
    return Object.fromEntries(
      Object.entries(held).map(([eachKey, eachValue]) => [
        eachKey,
        eachKey === key
          ? rootContainerWithValueAt(eachValue, rest, value)
          : eachValue,
      ]),
    );
  }
  // The path runs past the end of the data. Rebuilding an object here would
  // invent structure the host never sent, so the root is returned untouched and
  // the caller's write is a no-op it can see.
  return root;
}

/** `Trigger condition › thresholds › 0` — §2.2's breadcrumb, labelled, not implied. */
export function describeContainerPath(
  propertyName: string,
  path: ContainerPath,
): string {
  return [propertyName, ...path.map(String)].join(" › ");
}

/** How deep a row is. 0 is the property card's own body. */
export function containerDepth(path: ContainerPath): number {
  return path.length;
}

/**
 * §2.2's limit: one nested level inside the card, and the third goes to the
 * breadcrumb. A row at depth 0 whose value is a container renders that container
 * inline (depth 1); a row at depth 1 whose value is a container does not.
 */
export const DEEPEST_LEVEL_RENDERED_INSIDE_A_CARD = 1;
