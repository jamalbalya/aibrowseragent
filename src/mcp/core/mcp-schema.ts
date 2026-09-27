/**
 * Compiling an untrusted JSON Schema into a validator (specification §22).
 *
 * §22 makes argument validation the contract rather than a convenience, and
 * every tool in this build satisfies it with a Zod schema its author wrote. An
 * MCP tool has no author here: its schema arrived from the server, so this is
 * the one place where a validator is built out of something hostile.
 *
 * ## Why a subset, and why refusal rather than coercion
 *
 * The obvious shortcut is `z.record(z.unknown())` — accept any object, let the
 * server sort it out. That fails §22 in a way that matters: the registry would
 * pass the model's arguments through unvalidated, so a model that hallucinated
 * a field would reach the server with it, and the error would come back from
 * the far side rather than being refused here.
 *
 * The other shortcut is a full JSON Schema implementation. That is a large
 * parser over attacker-controlled input running inside the service worker,
 * which is a poor trade for a feature nobody asked for: `$ref` alone brings
 * cycles, remote references and resolution order.
 *
 * So a **subset** is compiled and everything else is **refused**, with the
 * reason named. A tool whose schema this cannot express does not become a tool.
 * That is a real cost — some servers will offer tools this build cannot use —
 * and it is the right direction, because the alternative to refusing a schema
 * is guessing at it.
 *
 * ## What is in the subset
 *
 * A top-level `object`, with properties whose types are `string`, `number`,
 * `integer`, `boolean`, a homogeneous `array` of those, or a nested `object`
 * one level deep. `required` is honoured. `enum` is honoured for strings.
 * Everything else — `$ref`, `oneOf`, `anyOf`, `allOf`, `not`,
 * `patternProperties`, tuple `items`, `additionalProperties` as a schema — is
 * refused by name.
 *
 * ## The bounds, and why each exists
 *
 * Each of these is a number the server would otherwise choose:
 *
 * - `MAX_PROPERTIES` per object — an object with ten thousand properties is a
 *   context-exhaustion channel, because the schema is shown to the model.
 * - `MAX_DEPTH` — nesting is what turns a schema into a stack.
 * - `MAX_ENUM` — an enum is a list of strings the server wrote.
 * - `MAX_NAME` per property name — names reach the model and a log line.
 *
 * Strings inside a *value* are not bounded here. That is the transport's job
 * for what comes back, and the model's arguments are this build's own output.
 */

import { z } from 'zod';

export const MAX_PROPERTIES = 32;
export const MAX_DEPTH = 3;
export const MAX_ENUM = 24;
export const MAX_NAME = 64;

/** Keywords that are refused by name rather than ignored. */
const REFUSED_KEYWORDS = [
  '$ref',
  '$dynamicRef',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  'dependentSchemas',
] as const;

export type SchemaRefusal = string;

export type CompileOutcome =
  | { readonly ok: true; readonly schema: z.ZodType }
  | { readonly ok: false; readonly reason: SchemaRefusal };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Names that must never become a property, whatever the charset allows.
 *
 * Found by a test rather than by reading: the compiler builds its shape with
 * `shape[name] = …`, and `shape['__proto__'] = x` **sets the prototype** rather
 * than adding a key. The property then vanished from the compiled schema and
 * the argument was refused as unrecognised — fail-closed, and by accident.
 * `shape`'s prototype had been replaced in the meantime.
 *
 * Refusing the three names is the fix rather than switching the accumulator to
 * a null-prototype object, because `z.object` wants an ordinary one and a
 * server has no legitimate reason to name an argument any of these.
 */
const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A property name that is safe to show, log, assign and pass on. */
function usableName(name: string): boolean {
  if (FORBIDDEN_NAMES.has(name)) return false;
  return name.length > 0 && name.length <= MAX_NAME && /^[A-Za-z0-9_.-]+$/.test(name);
}

function refusedKeyword(node: Record<string, unknown>): string | null {
  for (const keyword of REFUSED_KEYWORDS) {
    if (keyword in node) return keyword;
  }
  return null;
}

function compileString(node: Record<string, unknown>): CompileOutcome {
  if (!('enum' in node)) return { ok: true, schema: z.string() };
  const values = node.enum;
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, reason: 'an enum that is not a non-empty list' };
  }
  if (values.length > MAX_ENUM) {
    return { ok: false, reason: `an enum of more than ${MAX_ENUM} values` };
  }
  if (!values.every((value): value is string => typeof value === 'string')) {
    return { ok: false, reason: 'an enum holding something that is not a string' };
  }
  // `z.enum` needs a non-empty tuple; the length check above establishes that,
  // and the cast is confined to this line rather than widening the signature.
  return { ok: true, schema: z.enum(values as [string, ...string[]]) };
}

function compileNode(node: unknown, depth: number): CompileOutcome {
  const record = asRecord(node);
  if (record === null) {
    return { ok: false, reason: 'a schema that is not an object' };
  }
  const refused = refusedKeyword(record);
  if (refused !== null) {
    return { ok: false, reason: `the unsupported keyword "${refused}"` };
  }
  if (depth > MAX_DEPTH) {
    return { ok: false, reason: `nesting deeper than ${MAX_DEPTH} levels` };
  }

  // `type` as an array — `["string", "null"]` — is a union, and a union of
  // types is the thing this subset deliberately does not do.
  const type = record.type;
  if (typeof type !== 'string') {
    return {
      ok: false,
      reason: Array.isArray(type) ? 'a type that is a list of types' : 'no declared type',
    };
  }

  switch (type) {
    case 'string':
      return compileString(record);
    case 'number':
      return { ok: true, schema: z.number() };
    case 'integer':
      return { ok: true, schema: z.number().int() };
    case 'boolean':
      return { ok: true, schema: z.boolean() };
    case 'array': {
      if (Array.isArray(record.items)) {
        // A tuple. Positional schemas are a different shape and are refused
        // rather than approximated by the first entry.
        return { ok: false, reason: 'an array with positional item schemas' };
      }
      if (record.items === undefined) {
        return { ok: false, reason: 'an array that does not say what it holds' };
      }
      const item = compileNode(record.items, depth + 1);
      if (!item.ok) return item;
      return { ok: true, schema: z.array(item.schema) };
    }
    case 'object':
      return compileObject(record, depth);
    case 'null':
      return { ok: false, reason: 'a null-typed property' };
    default:
      return { ok: false, reason: `the unsupported type "${type.slice(0, 32)}"` };
  }
}

function compileObject(node: Record<string, unknown>, depth: number): CompileOutcome {
  const properties = asRecord(node.properties);
  if (properties === null) {
    // An object with no `properties` accepts anything, which is the
    // unvalidated case this module exists to avoid.
    return { ok: false, reason: 'an object that declares no properties' };
  }
  const names = Object.keys(properties);
  if (names.length > MAX_PROPERTIES) {
    return { ok: false, reason: `more than ${MAX_PROPERTIES} properties` };
  }
  if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
    // `true`, or a schema. Either would let through fields nothing validated,
    // which is the whole point of compiling this.
    return { ok: false, reason: 'additionalProperties that are not refused' };
  }

  const required = new Set(
    Array.isArray(node.required)
      ? node.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  for (const name of required) {
    if (!names.includes(name)) {
      // A required property with no schema would have to be accepted
      // unvalidated, or silently dropped. Both are worse than refusing.
      return {
        ok: false,
        reason: `a required property "${name.slice(0, MAX_NAME)}" with no schema`,
      };
    }
  }

  const shape: Record<string, z.ZodType> = {};
  for (const name of names) {
    if (!usableName(name)) {
      return { ok: false, reason: 'a property name that cannot be used' };
    }
    const compiled = compileNode(properties[name], depth + 1);
    if (!compiled.ok) return compiled;
    shape[name] = required.has(name) ? compiled.schema : compiled.schema.optional();
  }

  // `.strict()` rather than the default: an unexpected key is a refusal. The
  // model does not get to send a field the server never declared, and the
  // server does not get to receive one this build never validated.
  return { ok: true, schema: z.object(shape).strict() };
}

/**
 * Compiles a discovered tool's `inputSchema`.
 *
 * The top level must be an object schema. A tool taking a bare string or a
 * bare array is refused rather than wrapped: the registry dispatches named
 * arguments, and inventing a wrapper name would be inventing part of the
 * server's interface.
 */
export function compileToolSchema(inputSchema: unknown): CompileOutcome {
  const record = asRecord(inputSchema);
  if (record === null) {
    return { ok: false, reason: 'a schema that is not an object' };
  }
  // An absent top-level `type` is treated as `object`, which is the one place
  // a default is allowed: every real MCP tool schema is an object schema, and
  // several servers omit the keyword. `properties` still has to be there, so
  // this does not open the unvalidated case.
  const withType = record.type === undefined ? { ...record, type: 'object' } : record;
  if (withType.type !== 'object') {
    return {
      ok: false,
      reason: `a top-level schema of type "${String(withType.type).slice(0, 32)}"`,
    };
  }
  return compileNode(withType, 0);
}
