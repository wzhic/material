import { JsonValue, ValueSchema } from './types';

export interface ValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface ValidationResult {
  issues: readonly ValidationIssue[];
  ok: boolean;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_PROPERTIES = 256;

const issue = (path: string, code: string, message: string): ValidationIssue => ({
  code,
  message,
  path,
});

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const validateDefinitionAt = (
  schema: ValueSchema,
  path: string,
  depth: number,
  issues: ValidationIssue[],
): void => {
  if (depth > MAX_SCHEMA_DEPTH) {
    issues.push(issue(path, 'SCHEMA_DEPTH', 'schema nesting is too deep'));
    return;
  }
  if ('anyOf' in schema) {
    if (schema.anyOf.length < 2 || schema.anyOf.length > 8) {
      issues.push(issue(path, 'SCHEMA_UNION', 'anyOf must contain between 2 and 8 branches'));
      return;
    }
    schema.anyOf.forEach((branch, index) =>
      validateDefinitionAt(branch, `${path}.anyOf[${index}]`, depth + 1, issues),
    );
    return;
  }
  if (schema.type === 'string') {
    if (schema.minLength !== undefined && schema.minLength < 0) {
      issues.push(issue(path, 'SCHEMA_RANGE', 'minLength must be non-negative'));
    }
    if (
      schema.maxLength !== undefined &&
      (schema.maxLength < 0 ||
        (schema.minLength !== undefined && schema.maxLength < schema.minLength))
    ) {
      issues.push(issue(path, 'SCHEMA_RANGE', 'maxLength is invalid'));
    }
    if (schema.pattern !== undefined) {
      try {
        new RegExp(schema.pattern, 'u');
      } catch {
        issues.push(issue(path, 'SCHEMA_PATTERN', 'pattern is not a valid regular expression'));
      }
    }
    return;
  }
  if (schema.type === 'number') {
    if (
      schema.minimum !== undefined &&
      schema.maximum !== undefined &&
      schema.maximum < schema.minimum
    ) {
      issues.push(issue(path, 'SCHEMA_RANGE', 'maximum must not be lower than minimum'));
    }
    return;
  }
  if (schema.type === 'array') {
    if (
      schema.minItems !== undefined &&
      schema.maxItems !== undefined &&
      schema.maxItems < schema.minItems
    ) {
      issues.push(issue(path, 'SCHEMA_RANGE', 'maxItems must not be lower than minItems'));
    }
    validateDefinitionAt(schema.items, `${path}.items`, depth + 1, issues);
    return;
  }
  if (schema.type === 'object') {
    const keys = Object.keys(schema.properties);
    if (keys.length > MAX_SCHEMA_PROPERTIES) {
      issues.push(issue(path, 'SCHEMA_SIZE', 'schema declares too many properties'));
    }
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) {
        issues.push(issue(`${path}.${key}`, 'FORBIDDEN_KEY', 'unsafe property name'));
      }
      validateDefinitionAt(
        schema.properties[key],
        `${path}.properties.${key}`,
        depth + 1,
        issues,
      );
    }
    for (const required of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, required)) {
        issues.push(
          issue(`${path}.required`, 'SCHEMA_REQUIRED', 'required property is not declared'),
        );
      }
    }
  }
};

export const validateSchemaDefinition = (schema: ValueSchema): ValidationResult => {
  const issues: ValidationIssue[] = [];
  validateDefinitionAt(schema, '$', 0, issues);
  return { issues, ok: issues.length === 0 };
};

const validateValueAt = (
  schema: ValueSchema,
  value: unknown,
  path: string,
  depth: number,
  issues: ValidationIssue[],
): void => {
  if (depth > MAX_SCHEMA_DEPTH) {
    issues.push(issue(path, 'VALUE_DEPTH', 'value nesting is too deep'));
    return;
  }
  if ('anyOf' in schema) {
    const matched = schema.anyOf.some((branch) => {
      const branchIssues: ValidationIssue[] = [];
      validateValueAt(branch, value, path, depth + 1, branchIssues);
      return branchIssues.length === 0;
    });
    if (!matched) issues.push(issue(path, 'UNION', 'value does not match any allowed schema'));
    return;
  }
  if (schema.type === 'null') {
    if (value !== null) issues.push(issue(path, 'TYPE', 'expected null'));
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') issues.push(issue(path, 'TYPE', 'expected boolean'));
    return;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      issues.push(issue(path, 'TYPE', 'expected string'));
      return;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push(issue(path, 'MIN_LENGTH', 'string is shorter than allowed'));
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push(issue(path, 'MAX_LENGTH', 'string is longer than allowed'));
    }
    if (schema.enum && !schema.enum.includes(value)) {
      issues.push(issue(path, 'ENUM', 'string is not an allowed value'));
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      issues.push(issue(path, 'PATTERN', 'string does not match the required pattern'));
    }
    return;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push(issue(path, 'TYPE', 'expected finite number'));
      return;
    }
    if (schema.integer && !Number.isInteger(value)) {
      issues.push(issue(path, 'INTEGER', 'expected integer'));
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push(issue(path, 'MINIMUM', 'number is below minimum'));
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push(issue(path, 'MAXIMUM', 'number is above maximum'));
    }
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      issues.push(issue(path, 'TYPE', 'expected array'));
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push(issue(path, 'MIN_ITEMS', 'array has too few items'));
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push(issue(path, 'MAX_ITEMS', 'array has too many items'));
    }
    value.forEach((item, index) =>
      validateValueAt(schema.items, item, `${path}[${index}]`, depth + 1, issues),
    );
    return;
  }
  if (!isPlainObject(value)) {
    issues.push(issue(path, 'TYPE', 'expected plain object'));
    return;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      issues.push(issue(`${path}.${key}`, 'FORBIDDEN_KEY', 'unsafe property name'));
      continue;
    }
    const childSchema = schema.properties[key];
    if (!childSchema) {
      issues.push(issue(`${path}.${key}`, 'ADDITIONAL_PROPERTY', 'property is not allowed'));
      continue;
    }
    validateValueAt(childSchema, value[key], `${path}.${key}`, depth + 1, issues);
  }
  for (const required of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, required)) {
      issues.push(issue(`${path}.${required}`, 'REQUIRED', 'required property is missing'));
    }
  }
};

export const validateValue = (schema: ValueSchema, value: unknown): ValidationResult => {
  const issues: ValidationIssue[] = [];
  validateValueAt(schema, value, '$', 0, issues);
  return { issues, ok: issues.length === 0 };
};

export const jsonByteLength = (value: unknown): number => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('value is not JSON serializable');
  }
  return Buffer.byteLength(encoded, 'utf8');
};

export const cloneJson = <T extends JsonValue>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;
