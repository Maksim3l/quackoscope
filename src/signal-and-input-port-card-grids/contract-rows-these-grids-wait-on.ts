import {
  WIRE_METHOD_NAMES,
  WIRE_EVENT_NAMES,
  BASELINE_CAPABILITY_IDS,
} from "../../generated/typescript/contract-types";

/**
 * The rows of contract/contract.yaml's operation table that the output signals
 * view (§2.15), the input ports view (§2.7) and the data descriptor view (§2.4)
 * need and that DO NOT EXIST.
 *
 * This file is the whole reason the three grids can be honest. The contract has
 * thirteen operations and eight capability ids; not one of them returns a signal
 * descriptor, a signal's last value, or an input port. So every card below is
 * §3.7's gapped card — "a gapped card teaches more than a working one" — and
 * what it teaches is the literal YAML row it is waiting on.
 *
 * Two type facts make the gap impossible to fake, and both are compile errors
 * rather than comments:
 *
 *   - `wireMethodThatDoesNotExist` is typed `string`, NOT `MethodName`. It
 *     cannot be `MethodName`: that union has exactly the thirteen names in
 *     generated/typescript/contract-types.ts and none of these is among them.
 *     So none of these names can be handed to `client.call(...)`, and none can
 *     be handed to a card's quack strip, whose `CardCall.wireMethod` is
 *     `MethodName` too. A gapped card can print the method; it cannot send it.
 *   - `capabilityIdThatDoesNotExist` is typed `string`, NOT `OperationId`, for
 *     the same reason against the eight baseline capability ids. Which is also
 *     why these cards carry no `CapabilityStanding`: a standing is computed as
 *     baseline-minus-declared, and a capability outside the baseline has no
 *     standing to compute. The host is not at fault here and the card must not
 *     say it is — this is the contract's gap, not the host's.
 *
 * `refuseRowsTheContractHasSinceGrown` below inverts the check the discovery
 * lane's wire-methods file makes. That one refuses a row the contract does not
 * carry; this one refuses a row the contract DOES carry, because the moment a
 * row lands, the gapped card built on it is a lie and must be replaced by the
 * working grid. The gap expires by itself.
 */

/** One missing row, exactly as §4B of the design specification writes it. */
export interface ContractRowThisGridIsWaitingOn {
  /** §4B.1's own label for the row: "O8", "O15". `null` when §4B does not have it. */
  designSpecificationRow: string | null;
  /** Where the design specification asks for the surface this row would feed. */
  designSpecificationSection: string;
  /** The wire method the row would add. Not a `MethodName`: see the file comment. */
  wireMethodThatDoesNotExist: string;
  /** The capability id the row would be filed under. Not an `OperationId`. */
  capabilityIdThatDoesNotExist: string;
  /** What the call would answer with, in the contract's own type vocabulary. */
  whatItWouldReturn: string;
  /** The concrete thing the reader cannot see because the row is absent. */
  whatIsMissingWithoutIt: string;
}

export const GET_INPUT_PORTS_ROW: ContractRowThisGridIsWaitingOn = {
  designSpecificationRow: "O8",
  designSpecificationSection: "§2.7, the input ports view",
  wireMethodThatDoesNotExist: "get_input_ports",
  capabilityIdThatDoesNotExist: "input_port.read",
  whatItWouldReturn:
    "one record per input port of a function block — its id, its name, and the id of the signal connected to it",
  whatIsMissingWithoutIt:
    "every input port. The wire's NodeKind has five members — device, channel, function_block, signal, folder — and none of them is input_port, so get_component_tree cannot answer with a port even in principle.",
};

export const CONNECT_INPUT_PORT_ROW: ContractRowThisGridIsWaitingOn = {
  designSpecificationRow: "O9",
  designSpecificationSection: "§2.7, commit on select change",
  wireMethodThatDoesNotExist: "connect_input_port",
  capabilityIdThatDoesNotExist: "input_port.write",
  whatItWouldReturn: "nothing; it is an action taking input_port_id and signal_id",
  whatIsMissingWithoutIt:
    "the commit. Choosing a signal on a port card would send this; today the select has nothing to send.",
};

export const DISCONNECT_INPUT_PORT_ROW: ContractRowThisGridIsWaitingOn = {
  designSpecificationRow: "O10",
  designSpecificationSection: "§2.7, selecting `none`",
  wireMethodThatDoesNotExist: "disconnect_input_port",
  capabilityIdThatDoesNotExist: "input_port.write",
  whatItWouldReturn: "nothing; it is an action taking input_port_id",
  whatIsMissingWithoutIt:
    "the other commit: selecting a signal would connect it, selecting `none` would disconnect it.",
};

export const INPUT_PORT_CONNECTION_CHANGED_EVENT: ContractRowThisGridIsWaitingOn =
  {
    designSpecificationRow: "an edit to the existing input_port_connection_changed row",
    designSpecificationSection: "§4B.3, flagged as an edit and not an addition",
    wireMethodThatDoesNotExist: "input_port_connection_changed",
    capabilityIdThatDoesNotExist: "(an event, so no capability of its own)",
    whatItWouldReturn: "{input_port_id, signal_id} pushed by the host",
    whatIsMissingWithoutIt:
      "liveness. A connection made from another client would not reach this card. contract/contract.yaml sets events.closed: true, so adding it weighs the same as adding an operation.",
  };

export const GET_SIGNAL_DESCRIPTOR_ROW: ContractRowThisGridIsWaitingOn = {
  designSpecificationRow: "O15",
  designSpecificationSection: "§2.4, the data descriptor cards",
  wireMethodThatDoesNotExist: "get_signal_descriptor",
  capabilityIdThatDoesNotExist: "signal.describe",
  whatItWouldReturn:
    "a SignalDescriptor — the record contract/contract.yaml already declares, with id, name, sample_type, unit and domain_id",
  whatIsMissingWithoutIt:
    "every descriptor field, and with it the reference's own chartability test: output_signal_graph.py's _is_chartable reads sample_type, dimensions, struct_fields, the domain unit symbol, the tick resolution and the data rule, and not one of those crosses this wire.",
};

export const GET_SIGNAL_LAST_VALUE_ROW: ContractRowThisGridIsWaitingOn = {
  designSpecificationRow: "O16",
  designSpecificationSection: "§2.15, the signal card face",
  wireMethodThatDoesNotExist: "get_signal_last_value",
  capabilityIdThatDoesNotExist: "signal.describe",
  whatItWouldReturn: "the signal's current last value, of whatever type it holds",
  whatIsMissingWithoutIt:
    "the value on the card face, and the read-only value view behind the expander.",
};

/**
 * The display-duration presets of §2.15, which the contract cannot carry.
 *
 * Stated separately and stated plainly: this one is NOT in §4B. The design
 * specification asks for the reference's `0.01 / 0.05 / 0.1 / 0.2 / 0.5 / 1 s`
 * presets on the expanded signal card, and it does not notice that
 * `subscribe_signal` takes `signal_id` and `pixel_columns` and nothing else —
 * there is no parameter a duration could go in. It is named here because the
 * preset control would otherwise be a control that silently does nothing, which
 * is worse than a control that says what it is waiting for.
 */
export const SUBSCRIBE_SIGNAL_HAS_NO_WINDOW_PARAMETER: ContractRowThisGridIsWaitingOn =
  {
    designSpecificationRow: null,
    designSpecificationSection:
      "§2.15 asks for the presets; §4B does not propose the parameter they would need",
    wireMethodThatDoesNotExist: "subscribe_signal { window_seconds }",
    capabilityIdThatDoesNotExist: "streaming.decimated (the capability exists; the parameter does not)",
    whatItWouldReturn:
      "the same subscription id, over a window of the requested length",
    whatIsMissingWithoutIt:
      "the display duration. subscribe_signal's parameters are signal_id and pixel_columns, so the host alone decides how much time a frame covers and the client cannot ask for 0.2 s.",
  };

/**
 * §2.15's Device domain card, which nothing anywhere proposes.
 *
 * `output_signals_view.make_device_domain_section` reads `device.domain` for a
 * unit quantity, a tick resolution, an origin and `ticks_since_origin`. No row
 * in contract/contract.yaml returns any of those, and §4B does not propose one
 * either — so unlike every other entry here, this card is not waiting on a row
 * somebody has already written down. It is waiting on a row nobody has.
 */
export const NOTHING_RETURNS_A_DEVICE_DOMAIN: ContractRowThisGridIsWaitingOn = {
  designSpecificationRow: null,
  designSpecificationSection: "§2.15, \"the device-domain section becomes one Device domain card\"",
  wireMethodThatDoesNotExist: "(no operation returns a device domain)",
  capabilityIdThatDoesNotExist: "(none proposed)",
  whatItWouldReturn:
    "the device's domain: unit quantity, tick resolution numerator and denominator, origin, and ticks since origin",
  whatIsMissingWithoutIt:
    "the whole card. This is the only surface in this lane with no proposed row behind it at all.",
};

export const CONTRACT_ROWS_THESE_GRIDS_WAIT_ON: readonly ContractRowThisGridIsWaitingOn[] =
  [
    GET_INPUT_PORTS_ROW,
    CONNECT_INPUT_PORT_ROW,
    DISCONNECT_INPUT_PORT_ROW,
    INPUT_PORT_CONNECTION_CHANGED_EVENT,
    GET_SIGNAL_DESCRIPTOR_ROW,
    GET_SIGNAL_LAST_VALUE_ROW,
    SUBSCRIBE_SIGNAL_HAS_NO_WINDOW_PARAMETER,
    NOTHING_RETURNS_A_DEVICE_DOMAIN,
  ];

/**
 * One line, for the card that is waiting on it: what the contract does not
 * carry, and which row has been proposed to carry it.
 *
 * It names the contract and the proposed row and stops there. Which section of
 * the design specification asked for the surface, and what that section says
 * the surface should look like, is this app's own build plan; a reader looking
 * at their device is not told about it.
 */
export function describeTheRowInOneLine(
  row: ContractRowThisGridIsWaitingOn,
): string {
  if (row.designSpecificationRow === null) {
    return (
      `currently not available: none of the ${WIRE_METHOD_NAMES.length} operations in ` +
      `contract/contract.yaml returns ${row.whatItWouldReturn}. No row has been ` +
      `proposed that would.`
    );
  }
  return (
    `currently not available: ${row.wireMethodThatDoesNotExist} is not one of the ` +
    `${WIRE_METHOD_NAMES.length} operations in contract/contract.yaml; proposed as ` +
    `${row.designSpecificationRow}.`
  );
}

/**
 * Refuses at import time once a row this lane calls missing has actually landed.
 *
 * The inverse of the guard in
 * src/discovery-and-function-block-card-grids/wire-methods-and-capability-ids-these-grids-name.ts:
 * that one refuses a name the contract does not carry, this one refuses a name
 * the contract has since grown. A gapped card outliving its gap is a card that
 * lies, so it fails loudly and names the file to rewrite.
 */
function refuseRowsTheContractHasSinceGrown(): void {
  const methods: readonly string[] = WIRE_METHOD_NAMES;
  const events: readonly string[] = WIRE_EVENT_NAMES;
  const capabilities: readonly string[] = BASELINE_CAPABILITY_IDS;
  for (const row of CONTRACT_ROWS_THESE_GRIDS_WAIT_ON) {
    const name = row.wireMethodThatDoesNotExist;
    if (methods.includes(name) || events.includes(name)) {
      throw new Error(
        `contract/contract.yaml now carries "${name}", so the gapped card built on it in ` +
          "src/signal-and-input-port-card-grids/ is out of date and must be replaced by the " +
          "working grid. Remove the row from " +
          "src/signal-and-input-port-card-grids/contract-rows-these-grids-wait-on.ts and build " +
          `${row.designSpecificationSection} for real.`,
      );
    }
    if (capabilities.includes(row.capabilityIdThatDoesNotExist)) {
      throw new Error(
        `capability "${row.capabilityIdThatDoesNotExist}" is now one of the ` +
          `${BASELINE_CAPABILITY_IDS.length} baseline capability ids, so the gap this lane ` +
          `prints for ${name} is no longer the contract's gap. It would now be a host gap, ` +
          "with a CapabilityStanding to render, and the card must use CapabilityGapNotice instead.",
      );
    }
  }
}

refuseRowsTheContractHasSinceGrown();
