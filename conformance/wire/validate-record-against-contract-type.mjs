// Validates a JSON value from the wire against a record type declared in
// contract/contract.yaml `types`.
//
// The presence vocabulary is the contract's own, quoted from section 3:
//   required        the JSON key is always present and never null
//   nullable        the JSON key is always present and may be null
//   optional        the JSON key may be absent; when present it is not null
//   optional_null   the JSON key may be absent and may be null when present
//
// contract.yaml also says, in the same section: "Type-record fields never use
// 'optional': a host emits every key of a type record, writing null where a
// value is absent." So an absent key on a record is a violation, always, and the
// message says which key and which record.

const PRIMITIVE_PREDICATES = {
  string: (value) => typeof value === "string",
  int: (value) => typeof value === "number" && Number.isInteger(value),
  float: (value) => typeof value === "number",
  number: (value) => typeof value === "number",
  bool: (value) => typeof value === "boolean",
  any: () => true,
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value),
};

function describe(value) {
  if (value === undefined) return "the key is absent";
  return JSON.stringify(value) ?? String(value);
}

/**
 * Returns a list of violation strings; an empty list means the record conforms.
 * `path` is used only to make the violation text say where in the payload it is.
 */
export function findRecordViolations(value, typeName, contract, path = typeName) {
  const typeSpec = contract.types[typeName];
  if (!typeSpec) return [`${path}: contract.yaml declares no type named "${typeName}"`];
  const violations = [];

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`${path}: expected a ${typeName} record (a JSON object), got ${describe(value)}`];
  }

  for (const [fieldName, fieldSpec] of Object.entries(typeSpec.fields)) {
    const present = fieldName in value;
    const fieldValue = value[fieldName];
    const presence = fieldSpec.presence;

    if (!present) {
      if (presence === "optional" || presence === "optional_null") continue;
      violations.push(
        `${path}.${fieldName}: contract.yaml types.${typeName}.${fieldName}.presence is "${presence}", so the key must be present; it is absent`,
      );
      continue;
    }
    if (fieldValue === null) {
      if (presence === "nullable" || presence === "optional_null") continue;
      violations.push(
        `${path}.${fieldName}: contract.yaml types.${typeName}.${fieldName}.presence is "${presence}", so the value must not be null; it is null`,
      );
      continue;
    }
    violations.push(...findValueViolations(fieldValue, fieldSpec, `${path}.${fieldName}`, contract, typeName, fieldName));
  }

  for (const key of Object.keys(value)) {
    if (!(key in typeSpec.fields)) {
      violations.push(
        `${path}.${key}: contract.yaml types.${typeName} declares no field "${key}"; its fields are ${Object.keys(typeSpec.fields).join(", ")}`,
      );
    }
  }
  return violations;
}

function findValueViolations(value, fieldSpec, path, contract, typeName, fieldName) {
  const violations = [];
  const declaredType = fieldSpec.type;

  if (declaredType === "enum") {
    if (!fieldSpec.values.includes(value)) {
      violations.push(
        `${path}: contract.yaml types.${typeName}.${fieldName} is an enum over [${fieldSpec.values.join(", ")}]; got ${describe(value)}`,
      );
    }
    return violations;
  }
  if (declaredType === "array") {
    if (!Array.isArray(value)) {
      violations.push(`${path}: expected an array; got ${describe(value)}`);
      return violations;
    }
    const itemType = fieldSpec.items;
    value.forEach((item, index) => {
      if (contract.types[itemType]) {
        violations.push(...findRecordViolations(item, itemType, contract, `${path}[${index}]`));
      } else if (PRIMITIVE_PREDICATES[itemType] && !PRIMITIVE_PREDICATES[itemType](item)) {
        violations.push(`${path}[${index}]: expected ${itemType}; got ${describe(item)}`);
      }
    });
    return violations;
  }
  if (contract.types[declaredType]) {
    return findRecordViolations(value, declaredType, contract, path);
  }
  const predicate = PRIMITIVE_PREDICATES[declaredType];
  if (predicate && !predicate(value)) {
    violations.push(
      `${path}: contract.yaml types.${typeName}.${fieldName}.type is "${declaredType}"; got ${describe(value)}`,
    );
  }
  if (typeof value === "string" && typeof fieldSpec.min_length === "number" && value.length < fieldSpec.min_length) {
    violations.push(
      `${path}: contract.yaml types.${typeName}.${fieldName}.min_length is ${fieldSpec.min_length}; the string is ${value.length} characters long`,
    );
  }
  return violations;
}

/** Validates an error envelope's error object against contract.yaml error_shape. */
export function findErrorShapeViolations(errorObject, contract, path = "error") {
  const violations = [];
  if (errorObject === null || typeof errorObject !== "object" || Array.isArray(errorObject)) {
    return [`${path}: expected an error record with the fields ${contract.errorShapeFields.join(" and ")}; got ${describe(errorObject)}`];
  }
  for (const fieldName of contract.errorShapeFields) {
    if (!(fieldName in errorObject)) {
      violations.push(`${path}.${fieldName}: contract.yaml error_shape declares it required; the key is absent`);
    }
  }
  if ("code" in errorObject && !contract.errorCodes.includes(errorObject.code)) {
    violations.push(
      `${path}.code: contract.yaml error_codes is a closed set [${contract.errorCodes.join(", ")}]; got ${describe(errorObject.code)}`,
    );
  }
  if ("detail" in errorObject && typeof errorObject.detail !== "string") {
    violations.push(`${path}.detail: contract.yaml error_shape declares it a string; got ${describe(errorObject.detail)}`);
  }
  return violations;
}
