import { useState } from "react";
import { OpButton, OpInput } from "../ui/op";
import {
  containerRowText,
  containerRowValueKind,
  containerShapeOfPropertyValue,
  describeContainerShape,
  listWithItemInsertedAt,
  listWithItemRemoved,
  objectWithFieldAdded,
  objectWithFieldRemoved,
  objectWithKeyRenamed,
  parseContainerRowText,
} from "./container-shape-of-a-property-value";
import {
  DEEPEST_LEVEL_RENDERED_INSIDE_A_CARD,
  describeContainerPath,
  rootContainerWithValueAt,
  valueAtContainerPath,
  type ContainerPath,
} from "./nested-container-path";
import {
  keystrokeCommitsTheDraft,
  keystrokeRevertsTheDraft,
} from "./property-draft";

/**
 * A container property, edited inline on its own card.
 *
 * §2.14 of the design specification is a single instruction — "D12 Edit
 * container property: do not port it at all" — and this component is what
 * replaces the dialog it deletes:
 *
 *   "Container editing lives in the property card body (§2.2). The whole
 *    container is written back with one `set_property_value`, whose `value` is
 *    already typed `any`."
 *
 * So there is no Listbox, no four buttons down the side, and no
 * `simpledialog.askstring` per add and per edit — two in sequence for a dict,
 * which is the interaction the reference's own branch spent 250 lines escaping.
 * Every row is editable where it sits, and every commit sends the WHOLE
 * container in one call.
 *
 * §2.2's three container rows are all served, chosen by the shape of the value
 * because the M1 wire contract has one container `value_type` and cannot tell
 * them apart by name:
 *
 *   an array   -> item rows with add-above / add-below / remove and an add row
 *   an object  -> field rows, each with an editable key, per §2.2's dict rule:
 *                 a colliding rename refuses with `key "x" already exists`, and
 *                 a renamed entry moves to the end because a dict set on an
 *                 absent key appends
 *
 * §2.2's nesting rule is enforced by `path`: one nested level renders inside the
 * card, and the level below that becomes a labelled breadcrumb that navigates
 * the grid instead of drawing a third nest.
 */

export function PropertyContainerRows({
  propertyName,
  propertyId,
  rootValue,
  path,
  disabled,
  onCommitWholeContainer,
  onNavigateIntoNestedContainer,
}: {
  propertyName: string;
  propertyId: string;
  /** The property's whole value, as the host reports it. */
  rootValue: unknown;
  /** Where this block of rows sits inside `rootValue`. Empty is the card's body. */
  path: ContainerPath;
  disabled: boolean;
  /** Sends the WHOLE new container in one set_property_value. */
  onCommitWholeContainer: (wholeContainer: unknown) => void;
  onNavigateIntoNestedContainer: (path: ContainerPath) => void;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const here = valueAtContainerPath(rootValue, path);
  const shape = containerShapeOfPropertyValue(here);

  const commitWith = (replacementForThisLevel: unknown) => {
    setRefusal(null);
    onCommitWholeContainer(
      rootContainerWithValueAt(rootValue, path, replacementForThisLevel),
    );
  };

  if (shape.kind === "not-a-container") {
    return (
      <p className="property-container-not-a-container mono muted">
        {describeContainerShape(shape)} — the host sent{" "}
        {JSON.stringify(here) ?? "undefined"} for {propertyId}
      </p>
    );
  }

  return (
    <div className="property-container">
      <p className="property-container-summary muted">
        {describeContainerShape(shape)}
      </p>

      {shape.kind === "list" ? (
        <ol className="property-container-list">
          {shape.items.map((item, index) => (
            <li className="property-container-row" key={`item:${index}`}>
              <span className="property-container-index mono">{index}</span>
              <ContainerRowValue
                rowLabel={`${propertyName} item ${index}`}
                value={item}
                path={[...path, index]}
                rootValue={rootValue}
                propertyName={propertyName}
                disabled={disabled}
                onCommitWholeContainer={onCommitWholeContainer}
                onNavigateIntoNestedContainer={onNavigateIntoNestedContainer}
              />
              <span className="property-container-row-actions">
                <OpButton
                  op={["property.write"]}
                  type="button"
                  className="property-container-action"
                  disabled={disabled}
                  title={`insert a new item above index ${index} and write the whole list back with one set_property_value`}
                  onClick={() =>
                    commitWith(
                      listWithItemInsertedAt(shape.items, index, blankLike(item)),
                    )
                  }
                >
                  add above
                </OpButton>
                <OpButton
                  op={["property.write"]}
                  type="button"
                  className="property-container-action"
                  disabled={disabled}
                  title={`insert a new item below index ${index} and write the whole list back with one set_property_value`}
                  onClick={() =>
                    commitWith(
                      listWithItemInsertedAt(
                        shape.items,
                        index + 1,
                        blankLike(item),
                      ),
                    )
                  }
                >
                  add below
                </OpButton>
                <OpButton
                  op={["property.write"]}
                  type="button"
                  className="property-container-action property-container-action--remove"
                  disabled={disabled}
                  title={`remove index ${index} and write the remaining ${shape.items.length - 1} items back with one set_property_value`}
                  onClick={() => commitWith(listWithItemRemoved(shape.items, index))}
                >
                  remove
                </OpButton>
              </span>
            </li>
          ))}
          <li className="property-container-row property-container-row--add">
            <OpButton
              op={["property.write"]}
              type="button"
              className="property-container-action"
              disabled={disabled}
              title={`append one item and write all ${shape.items.length + 1} back with one set_property_value`}
              onClick={() =>
                commitWith(
                  listWithItemInsertedAt(
                    shape.items,
                    shape.items.length,
                    blankLike(shape.items[shape.items.length - 1] ?? ""),
                  ),
                )
              }
            >
              add an item at the end
            </OpButton>
          </li>
        </ol>
      ) : (
        <dl className="property-container-fields">
          {shape.entries.map((entry) => (
            <ContainerFieldRow
              key={`field:${entry.key}`}
              entry={entry}
              entries={shape.entries}
              propertyName={propertyName}
              path={path}
              rootValue={rootValue}
              disabled={disabled}
              onCommitWholeContainer={onCommitWholeContainer}
              onNavigateIntoNestedContainer={onNavigateIntoNestedContainer}
              onRefusal={setRefusal}
              onCommitThisLevel={commitWith}
            />
          ))}
          <AddFieldRow
            entries={shape.entries}
            disabled={disabled}
            onRefusal={setRefusal}
            onCommitThisLevel={commitWith}
          />
        </dl>
      )}

      {refusal !== null && (
        <p className="property-container-refusal mono" role="alert">
          {refusal}
        </p>
      )}
    </div>
  );
}

function ContainerFieldRow({
  entry,
  entries,
  propertyName,
  path,
  rootValue,
  disabled,
  onCommitWholeContainer,
  onNavigateIntoNestedContainer,
  onRefusal,
  onCommitThisLevel,
}: {
  entry: { key: string; value: unknown };
  entries: readonly { key: string; value: unknown }[];
  propertyName: string;
  path: ContainerPath;
  rootValue: unknown;
  disabled: boolean;
  onCommitWholeContainer: (wholeContainer: unknown) => void;
  onNavigateIntoNestedContainer: (path: ContainerPath) => void;
  onRefusal: (refusal: string | null) => void;
  onCommitThisLevel: (replacementForThisLevel: unknown) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <div className="property-container-row">
      <dt className="property-container-key">
        {renaming === null ? (
          <>
            <span className="property-container-key-text mono">{entry.key}</span>
            <OpButton
              op={["property.write"]}
              type="button"
              className="property-container-action"
              disabled={disabled}
              title={`rename the key "${entry.key}"; a dict set on an absent key appends, so a renamed entry moves to the end`}
              onClick={() => setRenaming(entry.key)}
            >
              rename
            </OpButton>
          </>
        ) : (
          <OpInput
            op={["property.write"]}
            className="property-container-key-input mono"
            type="text"
            autoFocus
            disabled={disabled}
            value={renaming}
            aria-label={`rename the key ${entry.key}`}
            onChange={(e) => setRenaming(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (keystrokeRevertsTheDraft(e)) {
                e.preventDefault();
                setRenaming(null);
                onRefusal(null);
                return;
              }
              if (!keystrokeCommitsTheDraft(e)) return;
              e.preventDefault();
              const outcome = objectWithKeyRenamed(entries, entry.key, renaming);
              if (outcome.container === null) {
                onRefusal(outcome.refusal);
                return;
              }
              setRenaming(null);
              onCommitThisLevel(outcome.container);
            }}
          />
        )}
      </dt>
      <dd className="property-container-value">
        <ContainerRowValue
          rowLabel={`${propertyName} field ${entry.key}`}
          value={entry.value}
          path={[...path, entry.key]}
          rootValue={rootValue}
          propertyName={propertyName}
          disabled={disabled}
          onCommitWholeContainer={onCommitWholeContainer}
          onNavigateIntoNestedContainer={onNavigateIntoNestedContainer}
        />
        <OpButton
          op={["property.write"]}
          type="button"
          className="property-container-action property-container-action--remove"
          disabled={disabled}
          title={`drop the field "${entry.key}" and write the remaining ${entries.length - 1} back with one set_property_value`}
          onClick={() => onCommitThisLevel(objectWithFieldRemoved(entries, entry.key))}
        >
          remove
        </OpButton>
      </dd>
    </div>
  );
}

function AddFieldRow({
  entries,
  disabled,
  onRefusal,
  onCommitThisLevel,
}: {
  entries: readonly { key: string; value: unknown }[];
  disabled: boolean;
  onRefusal: (refusal: string | null) => void;
  onCommitThisLevel: (replacementForThisLevel: unknown) => void;
}) {
  const [newKey, setNewKey] = useState("");
  return (
    <div className="property-container-row property-container-row--add">
      <dt className="property-container-key">
        <OpInput
          op={["property.write"]}
          className="property-container-key-input mono"
          type="text"
          placeholder="new field name"
          disabled={disabled}
          value={newKey}
          title="Enter adds this field with an empty string and writes the whole container back in one set_property_value; then edit its value on the row it creates. There is no OK and no Cancel (§2.0)."
          aria-label="a new field's name; Enter adds it with an empty string and writes the whole container back"
          onChange={(e) => setNewKey(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (keystrokeRevertsTheDraft(e)) {
              e.preventDefault();
              setNewKey("");
              onRefusal(null);
              return;
            }
            if (!keystrokeCommitsTheDraft(e)) return;
            e.preventDefault();
            const outcome = objectWithFieldAdded(entries, newKey, "");
            if (outcome.container === null) {
              onRefusal(outcome.refusal);
              return;
            }
            setNewKey("");
            onCommitThisLevel(outcome.container);
          }}
        />
      </dt>
      {/* The rule this row follows is on the input's title rather than printed
          beside it: a nested container repeats this row at every level, and
          three copies of the same sentence in one 300 px card is noise. */}
      <dd className="property-container-value muted">Enter adds it</dd>
    </div>
  );
}

/**
 * One row's value: a switch for a boolean, an inline field for a scalar, one
 * nested level for a container, and a labelled breadcrumb below that.
 */
function ContainerRowValue({
  rowLabel,
  value,
  path,
  rootValue,
  propertyName,
  disabled,
  onCommitWholeContainer,
  onNavigateIntoNestedContainer,
}: {
  rowLabel: string;
  value: unknown;
  path: ContainerPath;
  rootValue: unknown;
  propertyName: string;
  disabled: boolean;
  onCommitWholeContainer: (wholeContainer: unknown) => void;
  onNavigateIntoNestedContainer: (path: ContainerPath) => void;
}) {
  const kind = containerRowValueKind(value);
  const [draftText, setDraftText] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const commitThisRow = (rowValue: unknown) => {
    setDraftText(null);
    setRefusal(null);
    onCommitWholeContainer(
      rootContainerWithValueAt(rootValue, path, rowValue),
    );
  };

  if (kind === "boolean") {
    const on = value === true;
    return (
      <OpButton
        op={["property.write"]}
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${rowLabel}: ${on ? "true" : "false"}`}
        className={`property-switch property-switch--inline ${on ? "property-switch--on" : "property-switch--off"}`}
        disabled={disabled}
        title="a boolean is a switch, not a checkbox (the user's ruling); flipping it writes the whole container back with one set_property_value"
        onClick={() => commitThisRow(!on)}
      >
        <span className="property-switch-track" aria-hidden="true">
          <span className="property-switch-knob" />
        </span>
        <span className="property-switch-word mono">{on ? "true" : "false"}</span>
      </OpButton>
    );
  }

  if (kind === "nested-container") {
    if (path.length <= DEEPEST_LEVEL_RENDERED_INSIDE_A_CARD) {
      return (
        <div className="property-container-nested">
          <PropertyContainerRows
            propertyName={propertyName}
            propertyId={rowLabel}
            rootValue={rootValue}
            path={path}
            disabled={disabled}
            onCommitWholeContainer={onCommitWholeContainer}
            onNavigateIntoNestedContainer={onNavigateIntoNestedContainer}
          />
        </div>
      );
    }
    // §2.2: "Three levels of nested card is unreadable... Say so in the UI: the
    // breadcrumb is labelled, not implied."
    return (
      <button
        type="button"
        className="property-container-breadcrumb mono"
        disabled={disabled}
        title={`this level is ${path.length} deep; §2.2 stops nesting cards after one level and navigates the grid instead`}
        onClick={() => onNavigateIntoNestedContainer(path)}
        data-quack-chrome=""
      >
        {describeContainerPath(propertyName, path)} →
      </button>
    );
  }

  const shown = draftText ?? containerRowText(value);
  return (
    <span className="property-container-scalar">
      <OpInput
        op={["property.write"]}
        className="property-container-scalar-input mono"
        type="text"
        disabled={disabled}
        value={shown}
        aria-label={`${rowLabel}, held as a ${kind}`}
        data-uncommitted={draftText !== null ? "true" : undefined}
        title={
          draftText !== null
            ? `uncommitted: the device still holds ${containerRowText(value)}. Enter commits the whole container, Escape reverts.`
            : `held as a ${kind}; Enter writes the WHOLE container back with one set_property_value`
        }
        onChange={(e) => setDraftText(e.currentTarget.value)}
        // §2.0's per-field commit model: "Enter commits, Escape reverts, ...
        // focus loss commits a text field." A row left edited and abandoned
        // must not sit there looking like device state.
        onBlur={() => {
          if (draftText === null) return;
          const parsed = parseContainerRowText(kind, draftText);
          if (parsed.refusal !== null) {
            setRefusal(parsed.refusal);
            return;
          }
          commitThisRow(parsed.value);
        }}
        onKeyDown={(e) => {
          if (keystrokeRevertsTheDraft(e)) {
            e.preventDefault();
            setDraftText(null);
            setRefusal(null);
            return;
          }
          if (!keystrokeCommitsTheDraft(e)) return;
          e.preventDefault();
          if (draftText === null) return;
          const parsed = parseContainerRowText(kind, draftText);
          if (parsed.refusal !== null) {
            setRefusal(parsed.refusal);
            return;
          }
          commitThisRow(parsed.value);
        }}
      />
      {refusal !== null && (
        <span className="property-container-refusal mono" role="alert">
          {refusal}
        </span>
      )}
    </span>
  );
}

/**
 * What a newly added item starts as: the same kind as the item it was added
 * beside, empty. Adding a row that guesses a type unlike its neighbours would be
 * the client inventing device data.
 */
function blankLike(neighbour: unknown): unknown {
  switch (containerRowValueKind(neighbour)) {
    case "number":
      return 0;
    case "boolean":
      return false;
    case "nested-container":
      return Array.isArray(neighbour) ? [] : {};
    case "null":
    case "string":
      return "";
  }
}
