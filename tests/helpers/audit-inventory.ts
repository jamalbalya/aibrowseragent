/**
 * What production actually writes into each audit record, read from `src/`.
 *
 * Shared by the record-budget proof and the argued-classes suite because both
 * need the same answer and a second copy of this scanning was already producing a
 * different one — a crude "look 2000 characters after the `type:`" window spilled
 * into neighbouring code and attributed fields to types that never carry them.
 *
 * The approach: find each audit record literal by its `type:` and collect the
 * object literal's keys, then intersect with the fields the record schema
 * declares. Keys are collected at every nesting depth, because most optional
 * fields arrive through `...(x === undefined ? {} : { field: x })` and so sit
 * inside a nested brace. That can over-state a type's field set, which is the
 * safe direction for a bound: what holds for a superset holds for the real set.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'src';

export function sourceFiles(dir: string = SRC, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, into);
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) into.push(path);
  }
  return into;
}

/** The field names the record schema declares. */
export function declaredAuditFields(): Set<string> {
  const text = readFileSync(join(SRC, 'audit/audit-log.ts'), 'utf8');
  const start = text.indexOf('export interface AuditEvent');
  if (start === -1) throw new Error('the AuditEvent interface moved');
  const body = text.slice(start, text.indexOf('\n}', start));
  const fields = new Set<string>();
  for (const match of body.matchAll(/readonly ([A-Za-z_][A-Za-z0-9_]*)\??:/g)) {
    fields.add(match[1]!);
  }
  return fields;
}

/** The keys of the object literal that contains `index`. */
function literalKeysAround(text: string, index: number): Set<string> | null {
  let depth = 0;
  let open = index;
  for (; open >= 0; open--) {
    const c = text[open];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (open < 0) return null;
  let close = open;
  let d = 0;
  for (; close < text.length; close++) {
    const c = text[close];
    if (c === '{') d++;
    else if (c === '}') {
      d--;
      if (d === 0) break;
    }
  }
  const body = text.slice(open + 1, close);
  const keys = new Set<string>();
  let inString: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inString) {
      if (c === inString && body[i - 1] !== '\\') inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      continue;
    }
    if (c === ':') {
      const match = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(body.slice(Math.max(0, i - 60), i));
      if (match) keys.add(match[1]!);
    }
  }
  return keys;
}

/**
 * Every event type mapped to the fields production writes on it.
 *
 * `types` is passed in rather than imported so the caller uses the declared list
 * as its population, and a type with no producer shows up as a missing key.
 */
export function auditFieldInventory(types: readonly string[]): Map<string, Set<string>> {
  const schema = declaredAuditFields();
  const found = new Map<string, Set<string>>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    for (const type of types) {
      let index = 0;
      for (;;) {
        index = text.indexOf(`'${type}'`, index);
        if (index === -1) break;
        // `type: 'x'`, and a ternary whose branches are types —
        // `type: executed ? 'tool.invoked' : 'tool.refused'`.
        const back = text.slice(Math.max(0, index - 200), index);
        if (!/\btype:\s*[^;{}]*$/.test(back)) {
          index += 1;
          continue;
        }
        const keys = literalKeysAround(text, index);
        if (keys) {
          const set = found.get(type) ?? new Set<string>();
          for (const key of keys) if (schema.has(key)) set.add(key);
          found.set(type, set);
        }
        index += 1;
      }
    }
  }
  return found;
}
