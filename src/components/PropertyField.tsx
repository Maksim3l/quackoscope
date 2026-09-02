import { useState, type KeyboardEvent } from "react";
import type { PropertyDescriptor } from "../transport";
import { OpButton, OpInput, OpSelect } from "../ui/op";

/**
 * A pure function from PropertyDescriptor to widget.
 *
 * There is deliberately no device-specific or property-name-specific knowledge
 * anywhere in this file: the descriptor is the only input that decides shape,
 * bounds, enablement and visibility.
 */

export type PrecheckResult = string | null;

/**
 * Client-side pre-check is limited by contract to min, max and membership in
 * selection_values. Everything else is the host's job and comes back as
 * invalid_value with the native message in detail.
 */
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
      if (!Number.isInteger(value) || value < 0 || value >= d.selection_values.length) {
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

function displayString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Enter is the commit gesture in a grid, and it must reach commit even from a
 * keyboard, IME or automation driver that fills in only some of the three key
 * identifications a KeyboardEvent carries.
 */
function keystrokeCommitsEdit(e: KeyboardEvent<HTMLInputElement>): boolean {
  return (
    e.key === "Enter" ||
    e.code === "Enter" ||
    e.code === "NumpadEnter" ||
    e.keyCode === 13
  );
}

/** Escape throws the uncommitted keystrokes away and shows the host value again. */
function keystrokeRevertsEdit(e: KeyboardEvent<HTMLInputElement>): boolean {
  return e.key === "Escape" || e.code === "Escape" || e.keyCode === 27;
}

/** What a field row says about the last write the host answered for it. */
export type FieldNotice = {
  /** rejected: the host refused the write. unconfirmed: no answer arrived, the write may still have landed. */
  severity: "rejected" | "unconfirmed";
  text: string;
};

export function PropertyField({
  descriptor,
  value,
  notice,
  pending,
  onWrite,
  onRereadFromHost,
}: {
  descriptor: PropertyDescriptor;
  value: unknown;
  notice: FieldNotice | null;
  pending: boolean;
  onWrite: (value: unknown) => Promise<void>;
  onRereadFromHost: () => void;
}) {
  const d = descriptor;
  // The draft holds keystrokes only. The DISPLAYED value after a commit always
  // comes from the host (property_changed event or read-back), never from what
  // was submitted, so the draft is dropped as soon as the write settles.
  const [draft, setDraft] = useState<string | null>(null);
  const disabled = d.read_only || pending;
  const hostValue = displayString(value);
  // An uncommitted draft is a number the device does NOT hold. It is marked in
  // the markup, in the styling and in words, so it can never be read as device
  // state.
  const uncommitted = draft !== null && draft !== hostValue;

  const commit = async (v: unknown) => {
    await onWrite(v);
    setDraft(null);
  };

  const revertToHostValue = () => setDraft(null);

  const shown = draft ?? hostValue;
  const editedFieldMarkup = {
    className: uncommitted ? "edited-not-yet-committed" : undefined,
    "data-uncommitted": uncommitted ? "true" : undefined,
    title: uncommitted
      ? `uncommitted: the device still holds ${hostValue}. Enter commits, Escape reverts.`
      : undefined,
  };

  let widget;
  switch (d.value_type) {
    case "bool":
      widget = (
        <OpInput
          op={["property.write"]}
          type="checkbox"
          disabled={disabled}
          checked={value === true}
          onChange={(e) => void commit(e.currentTarget.checked)}
        />
      );
      break;

    case "int":
    case "float":
      widget = (
        <OpInput
          op={["property.write"]}
          {...editedFieldMarkup}
          type="number"
          disabled={disabled}
          step={d.value_type === "int" ? 1 : "any"}
          min={d.min ?? undefined}
          max={d.max ?? undefined}
          value={shown}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => {
            if (draft === null) return;
            void commit(Number(draft));
          }}
          onKeyDown={(e) => {
            // Enter commits exactly what blur commits; Escape drops the draft.
            if (keystrokeCommitsEdit(e) && draft !== null) {
              e.preventDefault();
              void commit(Number(draft));
            } else if (keystrokeRevertsEdit(e) && draft !== null) {
              e.preventDefault();
              revertToHostValue();
            }
          }}
        />
      );
      break;

    case "string":
      widget = (
        <OpInput
          op={["property.write"]}
          {...editedFieldMarkup}
          type="text"
          disabled={disabled}
          value={shown}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => {
            if (draft === null) return;
            void commit(draft);
          }}
          onKeyDown={(e) => {
            // Enter commits exactly what blur commits; Escape drops the draft.
            if (keystrokeCommitsEdit(e) && draft !== null) {
              e.preventDefault();
              void commit(draft);
            } else if (keystrokeRevertsEdit(e) && draft !== null) {
              e.preventDefault();
              revertToHostValue();
            }
          }}
        />
      );
      break;

    case "selection": {
      const options = d.selection_values ?? [];
      // The wire contract does not fix whether a selection value is the index or
      // the label, so echo back whatever shape the host currently reports.
      const useIndex = typeof value === "number";
      const current = useIndex
        ? String(value)
        : options.indexOf(String(value ?? "")).toString();
      widget = (
        <OpSelect
          op={["property.write"]}
          disabled={disabled}
          value={current}
          onChange={(e) => {
            const idx = Number(e.currentTarget.value);
            void commit(useIndex ? idx : options[idx]);
          }}
        >
          {current === "-1" && <option value="-1">{displayString(value)}</option>}
          {options.map((label, i) => (
            <option key={label + i} value={String(i)}>
              {label}
            </option>
          ))}
        </OpSelect>
      );
      break;
    }

    case "struct":
    default:
      // M1 accepts read-only display for struct.
      widget = <code className="struct">{displayString(value)}</code>;
      break;
  }

  return (
    <div className="prop">
      <div className="prop-label">
        <span className="prop-name" title={d.id}>
          {d.name}
        </span>
        {d.unit !== null && <span className="prop-unit">{d.unit}</span>}
        {d.read_only && <span className="tag">read only</span>}
      </div>
      <div className="prop-widget">
        {widget}
        {uncommitted && (
          <div className="prop-uncommitted">
            uncommitted — the device holds {hostValue}. Enter commits, Escape
            reverts.
          </div>
        )}
      </div>
      <div className="prop-meta">
        <span className="prop-type">{d.value_type}</span>
        {(d.min !== null || d.max !== null) && (
          <span className="prop-range">
            [{d.min ?? "−∞"} … {d.max ?? "∞"}]
          </span>
        )}
        {d.validator !== null && (
          <span className="prop-eval" title="validator (EvalValue source, display only)">
            v: {d.validator}
          </span>
        )}
        {d.coercer !== null && (
          <span className="prop-eval" title="coercer (EvalValue source, display only)">
            c: {d.coercer}
          </span>
        )}
      </div>
      {d.description !== null && <div className="prop-desc">{d.description}</div>}
      {notice !== null && (
        <div
          className={`prop-notice prop-notice--${notice.severity}`}
          role={notice.severity === "rejected" ? "alert" : "status"}
        >
          <span>{notice.text}</span>
          {notice.severity === "unconfirmed" && (
            <OpButton
              op={["property.read"]}
              className="prop-reread"
              onClick={onRereadFromHost}
            >
              Re-read {d.name} from the host
            </OpButton>
          )}
        </div>
      )}
    </div>
  );
}
