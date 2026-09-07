/**
 * The shape of a container property's VALUE, and the edits that can be made to
 * it without ever leaving the card.
 *
 * §2.14 of
 * quackoscope-gui-design-specification-logger-added-look-with-card-grids-replacing-dialogs-and-tables.md
 * deletes the reference's *Edit container property* dialog outright — "do not
 * port it at all" — and puts container editing in the property card's body.
 * §2.2's table says how each container reads:
 *
 *   struct   a definition list of the fields, each field inline-editable
 *   list     an ordered list of item rows, each inline-editable, each with
 *            add-above / add-below / remove; an *add* row at the end
 *   dict     as list, with the KEY editable too; a rename that collides refuses
 *            with `key "x" already exists`, and a renamed entry moves to the end
 *            because a dict set on an absent key appends
 *
 * The M1 wire contract has one container value type, `struct`, so which of the
 * three a property is cannot be read off `value_type`. It is read off the value
 * the host sent: an array is a list, an object is a struct or a dict, anything
 * else is not a container at all. That is a decision about data rather than
 * about a name, and it is made here so the widget never has to guess.
 *
 * Every edit below returns a WHOLE NEW container. §2.14: "The whole container is
 * written back with one `set_property_value`, whose `value` is already typed
 * `any`." Nothing here mutates its input, so a rejected write leaves the value
 * on screen exactly as the host last reported it.
 */

export type ContainerShape =
  | { kind: "list"; items: readonly unknown[] }
  | { kind: "object"; entries: readonly { key: string; value: unknown }[] }
  | { kind: "not-a-container"; value: unknown };

export function containerShapeOfPropertyValue(value: unknown): ContainerShape {
  if (Array.isArray(value)) return { kind: "list", items: value };
  if (typeof value === "object" && value !== null) {
    return {
      kind: "object",
      entries: Object.entries(value as Record<string, unknown>).map(
        ([key, each]) => ({ key, value: each }),
      ),
    };
  }
  return { kind: "not-a-container", value };
}

/** "3 fields" / "5 items" / "a string, not a container" — printed on the card. */
export function describeContainerShape(shape: ContainerShape): string {
  switch (shape.kind) {
    case "list":
      return `${shape.items.length} item${shape.items.length === 1 ? "" : "s"}, editable inline; the whole list goes back in one set_property_value`;
    case "object":
      return `${shape.entries.length} field${shape.entries.length === 1 ? "" : "s"}, editable inline; the whole struct goes back in one set_property_value`;
    case "not-a-container":
      return `the host sent ${typeof shape.value === "object" ? "null" : typeof shape.value} for a struct property, which has no fields to list`;
  }
}

/**
 * What one row of a container holds, and therefore which inline widget it gets.
 *
 * A row's type comes from its own value, not from the property descriptor: a
 * struct's fields have no descriptors on the M1 wire, so the value is the only
 * evidence there is. That is stated on the card rather than hidden, because a
 * field the host sent as `null` genuinely has no known type and guessing one
 * would be inventing a fact about the device.
 */
export type ContainerRowValueKind =
  | "boolean"
  | "number"
  | "string"
  | "nested-container"
  | "null";

export function containerRowValueKind(value: unknown): ContainerRowValueKind {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return "nested-container";
}

// --- the edits, each returning a whole new container ------------------------

export function listWithItemReplaced(
  items: readonly unknown[],
  index: number,
  value: unknown,
): unknown[] {
  return items.map((each, i) => (i === index ? value : each));
}

export function listWithItemInsertedAt(
  items: readonly unknown[],
  index: number,
  value: unknown,
): unknown[] {
  const next = [...items];
  next.splice(index, 0, value);
  return next;
}

export function listWithItemRemoved(
  items: readonly unknown[],
  index: number,
): unknown[] {
  return items.filter((_, i) => i !== index);
}

export function objectWithFieldReplaced(
  entries: readonly { key: string; value: unknown }[],
  key: string,
  value: unknown,
): Record<string, unknown> {
  return Object.fromEntries(
    entries.map((entry) => [entry.key, entry.key === key ? value : entry.value]),
  );
}

export function objectWithFieldRemoved(
  entries: readonly { key: string; value: unknown }[],
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(
    entries.filter((entry) => entry.key !== key).map((e) => [e.key, e.value]),
  );
}

export interface KeyRenameOutcome {
  /** null when the rename was refused; `refusal` says why, in the words §2.2 fixes. */
  container: Record<string, unknown> | null;
  refusal: string | null;
}

/**
 * §2.2's dict rule, implemented exactly as written: "a rename that collides
 * refuses with `key "x" already exists`, and a renamed entry moves to the end
 * because a dict set on an absent key appends — the reference's own note, and it
 * stays true".
 */
export function objectWithKeyRenamed(
  entries: readonly { key: string; value: unknown }[],
  fromKey: string,
  toKey: string,
): KeyRenameOutcome {
  if (toKey === fromKey) {
    return {
      container: Object.fromEntries(entries.map((e) => [e.key, e.value])),
      refusal: null,
    };
  }
  if (toKey.length === 0) {
    return { container: null, refusal: "a key cannot be the empty string" };
  }
  if (entries.some((entry) => entry.key === toKey)) {
    return { container: null, refusal: `key "${toKey}" already exists` };
  }
  const renamed = entries.find((entry) => entry.key === fromKey);
  if (renamed === undefined) {
    return {
      container: null,
      refusal: `key "${fromKey}" is not in this container any more`,
    };
  }
  const kept = entries.filter((entry) => entry.key !== fromKey);
  return {
    container: Object.fromEntries([
      ...kept.map((e) => [e.key, e.value] as const),
      // Appended, not put back where it was: setting a dict on an absent key
      // appends, so a rename that pretended to keep its position would be
      // showing the reader something the device would not do.
      [toKey, renamed.value] as const,
    ]),
    refusal: null,
  };
}

export function objectWithFieldAdded(
  entries: readonly { key: string; value: unknown }[],
  key: string,
  value: unknown,
): KeyRenameOutcome {
  if (key.length === 0) {
    return { container: null, refusal: "a key cannot be the empty string" };
  }
  if (entries.some((entry) => entry.key === key)) {
    return { container: null, refusal: `key "${key}" already exists` };
  }
  return {
    container: Object.fromEntries([
      ...entries.map((e) => [e.key, e.value] as const),
      [key, value] as const,
    ]),
    refusal: null,
  };
}

/**
 * Text typed into a container row, parsed to the value that goes on the wire.
 *
 * §2.13's rule, which applies to every text a reader types and not only to
 * callable arguments: "Do not port the argument coercion. The reference coerces
 * each entry by CoreType and for ctList uses eval() on user text. Parse
 * strictly — JSON for a list, Number() with a NaN check for numerics — and
 * refuse with a sentence naming the expected shape."
 *
 * So: nothing arriving as text is executed, a number that does not parse is
 * refused by name, and a nested container is parsed as JSON and by no other
 * means.
 */
export interface ParsedRowText {
  value: unknown;
  refusal: string | null;
}

export function parseContainerRowText(
  kind: ContainerRowValueKind,
  text: string,
): ParsedRowText {
  switch (kind) {
    case "number": {
      const parsed = Number(text);
      if (text.trim().length === 0 || Number.isNaN(parsed)) {
        return {
          value: null,
          refusal: `"${text}" is not a number; this row holds a number, so type digits with an optional sign, decimal point or exponent`,
        };
      }
      return { value: parsed, refusal: null };
    }
    case "boolean":
      // Booleans are switches, never text; this branch exists so the function is
      // total and says so if it is ever reached.
      return {
        value: text === "true",
        refusal:
          "a boolean row is a switch, not a text field — nothing should be parsing text into it",
      };
    case "string":
      return { value: text, refusal: null };
    case "null":
      return { value: text.length === 0 ? null : text, refusal: null };
    case "nested-container": {
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null) {
          return {
            value: null,
            refusal: `this row holds a nested container, so it is parsed as JSON and must be an object or an array; "${text}" parsed to ${typeof parsed}`,
          };
        }
        return { value: parsed, refusal: null };
      } catch (e) {
        return {
          value: null,
          refusal: `this row holds a nested container and is parsed as JSON — never evaluated: ${
            e instanceof Error ? e.message : String(e)
          }`,
        };
      }
    }
  }
}

/** The text an inline row shows for a value. Round-trips through parseContainerRowText. */
export function containerRowText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
