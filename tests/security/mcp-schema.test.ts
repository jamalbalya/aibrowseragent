/**
 * TEST-MCP-004 — compiling an untrusted JSON Schema (§22).
 *
 * §22 makes argument validation the contract. Every other tool in this build
 * satisfies it with a Zod schema its author wrote; an MCP tool's schema arrived
 * from the server, so this is the only validator in the product built out of
 * hostile input.
 *
 * The shape of the suite follows from that. The positive cases establish that
 * the subset is usable at all — a compiler that refused everything would be
 * trivially safe and useless. The negative cases are the point: each one is a
 * schema a server could send to get an argument through unvalidated, to put a
 * parser into a loop, or to fill the model's context.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  MAX_ENUM,
  MAX_NAME,
  MAX_PROPERTIES,
  compileToolSchema,
} from '@/mcp/core/mcp-schema';

/** Compiles, or fails the case with the reason it refused. */
function compiled(schema: unknown) {
  const outcome = compileToolSchema(schema);
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
  return outcome.schema;
}

function refusal(schema: unknown): string {
  const outcome = compileToolSchema(schema);
  expect(outcome.ok, 'expected a refusal').toBe(false);
  return outcome.ok ? '' : outcome.reason;
}

describe('01 the subset is usable', () => {
  it('compiles the ordinary tool schema a server sends', () => {
    const schema = compiled({
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        exact: { type: 'boolean' },
        weight: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    });
    expect(schema.parse({ query: 'hello' })).toEqual({ query: 'hello' });
    expect(schema.parse({ query: 'a', limit: 3, exact: true, weight: 1.5, tags: ['x'] })).toEqual({
      query: 'a',
      limit: 3,
      exact: true,
      weight: 1.5,
      tags: ['x'],
    });
  });

  it('treats a missing top-level type as an object, which several servers omit', () => {
    // The one default allowed. `properties` is still required, so this does
    // not open the accept-anything case.
    const schema = compiled({ properties: { q: { type: 'string' } }, required: ['q'] });
    expect(schema.parse({ q: 'x' })).toEqual({ q: 'x' });
  });

  it('honours required, so a missing argument is refused here and not at the server', () => {
    const schema = compiled({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
    expect(() => schema.parse({})).toThrow();
  });

  it('honours a string enum', () => {
    const schema = compiled({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['fast', 'slow'] } },
      required: ['mode'],
    });
    expect(schema.parse({ mode: 'fast' })).toEqual({ mode: 'fast' });
    expect(() => schema.parse({ mode: 'other' })).toThrow();
  });

  it('compiles a nested object within the depth allowed', () => {
    const schema = compiled({
      type: 'object',
      properties: {
        filter: { type: 'object', properties: { since: { type: 'string' } } },
      },
    });
    expect(schema.parse({ filter: { since: 'yesterday' } })).toEqual({
      filter: { since: 'yesterday' },
    });
  });

  it('rejects an integer given a fraction, rather than rounding it', () => {
    const schema = compiled({
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
    });
    expect(() => schema.parse({ n: 1.5 })).toThrow();
  });
});

describe('02 an argument the model invented does not get through', () => {
  it('refuses a field the schema never declared', () => {
    // The whole reason not to use `z.record(z.unknown())`. A hallucinated
    // field would otherwise reach the server, and the error would come back
    // from the far side instead of being refused here.
    const schema = compiled({ type: 'object', properties: { q: { type: 'string' } } });
    expect(() => schema.parse({ q: 'x', andAlso: 'surprise' })).toThrow();
  });

  it('refuses a declared field of the wrong type', () => {
    const schema = compiled({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
    expect(() => schema.parse({ q: 42 })).toThrow();
  });

  it('refuses an array holding the wrong thing', () => {
    const schema = compiled({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    });
    expect(() => schema.parse({ tags: ['ok', 7] })).toThrow();
  });
});

describe('03 what a server cannot make this build compile', () => {
  it('refuses a schema that would accept anything', () => {
    // An object with no `properties` validates nothing, which is the case the
    // module exists to avoid.
    expect(refusal({ type: 'object' })).toContain('declares no properties');
    expect(refusal({ type: 'object', properties: 'all of them' })).toContain(
      'declares no properties',
    );
  });

  it('refuses additionalProperties that are not shut', () => {
    for (const additionalProperties of [true, {}, { type: 'string' }]) {
      expect(refusal({ type: 'object', properties: {}, additionalProperties })).toContain(
        'additionalProperties',
      );
    }
  });

  it('refuses every reference and combinator by name', () => {
    for (const keyword of [
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
    ]) {
      // `$ref` is the one that matters most: it brings cycles, remote
      // resolution and ordering, all over attacker-controlled input.
      expect(refusal({ type: 'object', properties: {}, [keyword]: 'x' }), keyword).toContain(
        keyword,
      );
    }
  });

  it('refuses a reference nested inside a property, not only at the top', () => {
    expect(
      refusal({
        type: 'object',
        properties: { a: { type: 'object', properties: { b: { $ref: '#/x' } } } },
      }),
    ).toContain('$ref');
  });

  it('refuses a self-referential schema, which is what a cycle arrives as', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.properties = { self: cyclic };
    // It is refused for depth rather than by cycle detection, and that is the
    // honest account: nothing here walks a graph looking for loops, and the
    // depth bound is what makes a loop terminate.
    expect(refusal(cyclic)).toContain('nesting deeper than');
  });

  it('refuses a union of types', () => {
    expect(refusal({ type: 'object', properties: { a: { type: ['string', 'null'] } } })).toContain(
      'a list of types',
    );
  });

  it('refuses a property with no type at all', () => {
    expect(refusal({ type: 'object', properties: { a: {} } })).toContain('no declared type');
  });

  it('refuses a type this subset does not express', () => {
    expect(refusal({ type: 'object', properties: { a: { type: 'null' } } })).toContain(
      'null-typed',
    );
    expect(refusal({ type: 'object', properties: { a: { type: 'invented' } } })).toContain(
      'unsupported type "invented"',
    );
  });

  it('refuses a top-level schema that is not an object', () => {
    // Not wrapped in one. The registry dispatches named arguments, and
    // inventing a wrapper name would be inventing part of the server's
    // interface.
    expect(refusal({ type: 'string' })).toContain('top-level schema of type "string"');
    expect(refusal('a schema')).toContain('not an object');
    expect(refusal([{ type: 'object' }])).toContain('not an object');
    expect(refusal(null)).toContain('not an object');
  });

  it('refuses an array that does not say what it holds, or holds a tuple', () => {
    expect(refusal({ type: 'object', properties: { a: { type: 'array' } } })).toContain(
      'does not say what it holds',
    );
    expect(
      refusal({
        type: 'object',
        properties: { a: { type: 'array', items: [{ type: 'string' }] } },
      }),
    ).toContain('positional item schemas');
  });

  it('refuses a required property with no schema, rather than dropping it', () => {
    // Accepting it unvalidated and silently dropping it are both worse than
    // refusing: one lets an argument through, the other makes a tool that
    // cannot work.
    expect(
      refusal({ type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }),
    ).toContain('"b" with no schema');
  });
});

describe('04 the bounds, each of which the server would otherwise choose', () => {
  it('bounds the property count, because the schema is shown to the model', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_PROPERTIES; i += 1) properties[`p${i}`] = { type: 'string' };
    expect(refusal({ type: 'object', properties })).toContain(
      `more than ${MAX_PROPERTIES} properties`,
    );
  });

  it('bounds nesting, because nesting is what turns a schema into a stack', () => {
    let node: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < MAX_DEPTH + 2; i += 1) {
      node = { type: 'object', properties: { deeper: node } };
    }
    expect(refusal(node)).toContain(`nesting deeper than ${MAX_DEPTH}`);
  });

  it('bounds an enum, which is a list of strings the server wrote', () => {
    const values = Array.from({ length: MAX_ENUM + 1 }, (_, i) => `v${i}`);
    expect(
      refusal({ type: 'object', properties: { a: { type: 'string', enum: values } } }),
    ).toContain(`more than ${MAX_ENUM} values`);
  });

  it('refuses a malformed enum rather than ignoring it', () => {
    for (const enumeration of [[], 'fast', [1, 2], [{}]]) {
      expect(
        refusal({ type: 'object', properties: { a: { type: 'string', enum: enumeration } } }),
      ).toMatch(/enum/);
    }
  });

  it('bounds a property name, which reaches the model and a log line', () => {
    expect(
      refusal({ type: 'object', properties: { ['n'.repeat(MAX_NAME + 1)]: { type: 'string' } } }),
    ).toContain('cannot be used');
  });

  it('refuses a property name holding characters a name may not', () => {
    for (const name of ['a b', 'a/b', '', 'a\nb', '__proto__x!']) {
      expect(refusal({ type: 'object', properties: { [name]: { type: 'string' } } })).toContain(
        'cannot be used',
      );
    }
  });

  it('bounds the refusal message, which quotes something the server chose', () => {
    const reason = refusal({ type: 'object', properties: { a: { type: 'x'.repeat(5000) } } });
    expect(reason.length).toBeLessThan(120);
  });
});

describe('05 the three names that cannot become a property', () => {
  it('refuses __proto__, constructor and prototype', () => {
    // This case found a defect rather than confirming a rule. The compiler
    // builds its shape with `shape[name] = …`, and `shape['__proto__'] = x`
    // sets the prototype instead of adding a key — so the property vanished
    // from the compiled schema and the argument was refused as unrecognised.
    // Fail-closed, and by accident, with the accumulator's prototype replaced
    // on the way. The names are refused now.
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(
        refusal({ type: 'object', properties: { [name]: { type: 'string' } } }),
        name,
      ).toContain('cannot be used');
    }
  });

  it('refuses one nested inside a property too, not only at the top', () => {
    expect(
      refusal({
        type: 'object',
        properties: {
          filter: { type: 'object', properties: { ['__proto__']: { type: 'string' } } },
        },
      }),
    ).toContain('cannot be used');
  });

  it('refuses it as a required name as well, where the message quotes it', () => {
    expect(
      refusal({ type: 'object', properties: { a: { type: 'string' } }, required: ['__proto__'] }),
    ).toContain('with no schema');
  });

  it('leaves Object.prototype alone throughout', () => {
    compileToolSchema({ type: 'object', properties: { ['__proto__']: { type: 'string' } } });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
