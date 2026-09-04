import type {
  DeviceInfo,
  MethodName,
  Node,
  PropertyDescriptor,
  TransportClient,
} from "../transport";
import {
  ADD_FUNCTION_BLOCK,
  GENERATED_CONTRACT_TYPES_PATH,
  LIST_FUNCTION_BLOCK_TYPES,
  SCAN_AVAILABLE_DEVICES,
} from "./wire-methods-and-capability-ids-these-grids-name";

/**
 * The six contract rows these two grids send, over the session's existing
 * TransportClient, and the shape check applied to every answer.
 *
 * `TransportClient.call` is typed on `MethodContract`, which now carries all
 * thirteen rows of contract/contract.yaml, so every call below is the ordinary
 * typed call — there is no assertion anywhere in this file and no second path to
 * the socket. A call made here lands in the pond, in the drawer and in a card's
 * quack strip count exactly like any other.
 *
 * The decoding is the point that remains. `call` gives back the type the contract
 * promises; it does not verify that the host kept the promise. A host that
 * answers `scan_available_devices` with something other than an array of
 * DeviceInfo must produce a sentence naming what it actually sent, not a card
 * grid over `undefined`.
 */

/** What a host sent back when it did not send back what the contract says. */
export class HostAnsweredOffContract extends Error {
  constructor(
    readonly method: MethodName,
    readonly complaint: string,
    readonly received: unknown,
  ) {
    super(
      `${method} answered off contract: ${complaint}. ` +
        `${GENERATED_CONTRACT_TYPES_PATH} is the shape it was checked against. ` +
        `Received: ${JSON.stringify(received)?.slice(0, 400) ?? String(received)}`,
    );
    this.name = "HostAnsweredOffContract";
  }
}

function requireArray(method: MethodName, received: unknown): unknown[] {
  if (!Array.isArray(received)) {
    throw new HostAnsweredOffContract(
      method,
      `the contract's returns is an array and the host sent ${typeof received}`,
      received,
    );
  }
  return received;
}

function requireStringField(
  method: MethodName,
  record: Record<string, unknown>,
  field: string,
  index: number,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new HostAnsweredOffContract(
      method,
      `element ${index} has ${field} of type ${typeof value}, and the contract makes it a required string`,
      record,
    );
  }
  return value;
}

/**
 * `scan_available_devices` -> `array of DeviceInfo`.
 *
 * DeviceInfo has exactly three fields in contract/contract.yaml:
 * connection_string (required), name (required), serial (nullable). There is no
 * `location`, which is what the reference's Add-device table's second column
 * shows — §2.5 of the design asks for it and the wire does not carry it. The
 * card says so rather than leaving a blank column.
 */
export function decodeScannedDevices(received: unknown): DeviceInfo[] {
  const elements = requireArray(SCAN_AVAILABLE_DEVICES, received);
  return elements.map((element, index) => {
    if (typeof element !== "object" || element === null) {
      throw new HostAnsweredOffContract(
        SCAN_AVAILABLE_DEVICES,
        `element ${index} is ${element === null ? "null" : typeof element}, and the contract makes it a DeviceInfo record`,
        element,
      );
    }
    const record = element as Record<string, unknown>;
    const serial = record.serial;
    if (serial !== null && serial !== undefined && typeof serial !== "string") {
      throw new HostAnsweredOffContract(
        SCAN_AVAILABLE_DEVICES,
        `element ${index} has serial of type ${typeof serial}, and the contract makes it a nullable string`,
        record,
      );
    }
    return {
      connection_string: requireStringField(
        SCAN_AVAILABLE_DEVICES,
        record,
        "connection_string",
        index,
      ),
      name: requireStringField(SCAN_AVAILABLE_DEVICES, record, "name", index),
      serial: typeof serial === "string" ? serial : null,
    };
  });
}

/**
 * `list_function_block_types` -> `array of string`.
 *
 * Strings, not records. The contract row returns `{type: array, items: string}`,
 * so a function block type on this wire is a type id and nothing else: no name,
 * no description. §2.7 of the design draws a card with `name`, `id in mono` and
 * a `description clamped to 3 lines`, and two of those three have no field to
 * come from. The type card prints the id and states the absence.
 */
export function decodeFunctionBlockTypeIds(received: unknown): string[] {
  const elements = requireArray(LIST_FUNCTION_BLOCK_TYPES, received);
  return elements.map((element, index) => {
    if (typeof element !== "string") {
      throw new HostAnsweredOffContract(
        LIST_FUNCTION_BLOCK_TYPES,
        `element ${index} is ${typeof element}, and the contract's returns is an array of string`,
        element,
      );
    }
    return element;
  });
}

/** `connect_device` and `add_function_block` both return one Node. */
export function decodeReturnedNode(method: MethodName, received: unknown): Node {
  if (typeof received !== "object" || received === null) {
    throw new HostAnsweredOffContract(
      method,
      `the contract's returns is a Node record and the host sent ${received === null ? "null" : typeof received}`,
      received,
    );
  }
  const record = received as Record<string, unknown>;
  for (const field of ["id", "name", "kind"]) {
    if (typeof record[field] !== "string") {
      throw new HostAnsweredOffContract(
        method,
        `the returned Node has ${field} of type ${typeof record[field]}, and the contract makes it a required string`,
        received,
      );
    }
  }
  return received as Node;
}

// --- the six rows, each one call, each named for the row it sends ------------

export async function scanAvailableDevices(
  client: TransportClient,
): Promise<DeviceInfo[]> {
  return decodeScannedDevices(await client.call("scan_available_devices", {}));
}

export async function connectDevice(
  client: TransportClient,
  connectionString: string,
): Promise<Node> {
  return decodeReturnedNode(
    "connect_device",
    await client.call("connect_device", {
      connection_string: connectionString,
    }),
  );
}

export async function listFunctionBlockTypes(
  client: TransportClient,
): Promise<string[]> {
  return decodeFunctionBlockTypeIds(
    await client.call("list_function_block_types", {}),
  );
}

export async function addFunctionBlock(
  client: TransportClient,
  parentId: string,
  typeId: string,
): Promise<Node> {
  return decodeReturnedNode(
    ADD_FUNCTION_BLOCK,
    await client.call("add_function_block", {
      parent_id: parentId,
      type_id: typeId,
    }),
  );
}

export async function removeFunctionBlock(
  client: TransportClient,
  nodeId: string,
): Promise<void> {
  await client.call("remove_function_block", { node_id: nodeId });
}

/**
 * The configuration step of §2.7, after the add: the descriptors of the block
 * that was just created. Routed through here only so every call these two grids
 * make is written out once, in one file, with its params visible beside the
 * preview that promises them.
 */
export async function getPropertyDescriptors(
  client: TransportClient,
  nodeId: string,
): Promise<PropertyDescriptor[]> {
  const received = await client.call("get_property_descriptors", {
    node_id: nodeId,
  });
  return requireArray("get_property_descriptors", received) as PropertyDescriptor[];
}
