import { OpButton } from "../ui/op";

/**
 * A boolean property, as a switch.
 *
 * The user's ruling, in full: "bool renders as a SWITCH, not a checkbox." The
 * design specification's §2.2 table says checkbox and the reference uses a
 * `ttk.Checkbutton`; the ruling overrides both, and the ruling is what is built.
 *
 * It commits immediately, which is the one part of §2.2's row that survives
 * unchanged: there is no draft state for a control with two positions, so there
 * is nothing an Enter key could commit that the click did not already.
 *
 * `role="switch"` with `aria-checked` is what makes it a switch to a screen
 * reader as well as to the eye — a `<button>` with a sliding knob and no role is
 * a switch only to people who can see it.
 */
export function PropertyValueSwitch({
  propertyName,
  propertyId,
  value,
  disabled,
  onCommit,
}: {
  propertyName: string;
  propertyId: string;
  /** What the HOST reports. Anything that is not `true` reads as off. */
  value: unknown;
  disabled: boolean;
  onCommit: (value: boolean) => void;
}) {
  const on = value === true;
  const unreadable = typeof value !== "boolean";

  return (
    <span className="property-switch-row">
      <OpButton
        op={["property.write"]}
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${propertyName}: ${on ? "true" : "false"}`}
        className={`property-switch ${on ? "property-switch--on" : "property-switch--off"}`}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onCommit(!on);
        }}
      >
        <span className="property-switch-track" aria-hidden="true">
          <span className="property-switch-knob" />
        </span>
        <span className="property-switch-word mono">{on ? "true" : "false"}</span>
      </OpButton>

      {unreadable && (
        <span
          className="property-switch-unreadable mono"
          title={`${propertyId} is declared bool and the host sent ${JSON.stringify(value)}`}
        >
          {JSON.stringify(value)}
        </span>
      )}
    </span>
  );
}
