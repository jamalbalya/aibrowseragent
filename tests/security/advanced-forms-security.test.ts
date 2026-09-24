/**
 * @vitest-environment jsdom
 *
 * TEST-SECURITY-029 — what the new form tools must not become (P-006).
 *
 * Two tools were added, and both take a value from a model and write it into
 * a page. That is the shape of every page-write tool this product already
 * has, so the question is not whether the shape is new — it is whether these
 * two acquired anything the others do not have.
 *
 * Three claims:
 *
 *  1. **No new way to reach the page.** No evaluator, no selector, no
 *     injected script, no new permission. The only thing that reaches the DOM
 *     is an element handle from a page read this build issued.
 *  2. **No new way past a gate.** Both declare an egress like every other
 *     page write, both are ordinary registry tools, and neither carries a
 *     route or an authorisation of its own.
 *  3. **Hostile arguments are refused, not interpreted.** A value is matched
 *     against a fixed format and the control's own bounds, and anything else
 *     is a refusal — never a best effort at what the model might have meant.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performSelectMany, performSetValue } from '@/content/interaction-engine';
import { STRUCTURED_INPUT_TYPES } from '@/content/form-controls';

const root = resolve(import.meta.dirname, '../..');
const read = (relative: string): string => readFileSync(resolve(root, relative), 'utf8');

const TOOLS = read('src/tools/browser/browser-tools.ts');
const ENGINE = read('src/content/interaction-engine.ts');

/**
 * A tool's schema and its definition together.
 *
 * Starting at the `name:` line would leave the input schema outside the
 * slice, and the schema is where the argument bounds live — which is most of
 * what there is to check.
 */
function toolBody(name: string): string {
  const local = name.split('.')[1]!.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
  const schema = TOOLS.indexOf(`const ${local}Input = z.object({`);
  const named = TOOLS.indexOf(`name: '${name}'`);
  expect(named, `${name} is not registered`).toBeGreaterThan(-1);
  expect(schema, `${name} has no input schema`).toBeGreaterThan(-1);
  const end = TOOLS.indexOf('\n  };\n}', named);
  return TOOLS.slice(schema, end === -1 ? undefined : end);
}

describe('1. no new way to reach the page', () => {
  it('registers both tools in the one registry', () => {
    expect(TOOLS).toContain("name: 'browser.set_value'");
    expect(TOOLS).toContain("name: 'browser.select_many'");
    expect(TOOLS).toContain('createSetValueTool(deps)');
    expect(TOOLS).toContain('createSelectManyTool(deps)');
  });

  it('takes an element handle, never a selector or an expression', () => {
    for (const name of ['browser.set_value', 'browser.select_many']) {
      const body = toolBody(name);
      expect(body, name).toContain('elementId');
      // Whole words: "description" contains "script", and a naive substring
      // check would fail on every tool in the file for that reason alone.
      for (const forbidden of ['selector', 'queryselector', 'xpath', 'script', 'expression']) {
        expect(
          new RegExp(`\\b${forbidden}\\b`).test(body.toLowerCase()),
          `${name} accepts ${forbidden}`,
        ).toBe(false);
      }
    }
  });

  it('adds no execution primitive to the interaction engine', () => {
    for (const forbidden of [
      'eval(',
      'new Function',
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'setAttribute("on',
      'javascript:',
    ]) {
      expect(ENGINE, forbidden).not.toContain(forbidden);
    }
  });

  it('adds no permission and no host access', () => {
    const manifest = read('public/manifest.json');
    expect(manifest).not.toContain('<all_urls>');
    expect(manifest).not.toContain('clipboardRead');
    expect(manifest).not.toContain('clipboardWrite');
    const parsed = JSON.parse(manifest) as {
      permissions: string[];
      content_scripts: { all_frames: boolean }[];
    };
    expect(parsed.permissions).toEqual([
      'sidePanel',
      'storage',
      'unlimitedStorage',
      'tabs',
      'tabGroups',
      'scripting',
      'debugger',
      'notifications',
      'activeTab',
      'alarms',
    ]);
    expect(parsed.content_scripts[0]?.all_frames).toBe(false);
  });

  it('reaches the page only through the existing content channel', () => {
    for (const name of ['browser.set_value', 'browser.select_many']) {
      expect(toolBody(name), name).toContain('adapter.callContent');
    }
  });
});

describe('2. no new way past a gate', () => {
  it('declares a page-write egress, like every other page write', () => {
    for (const name of ['browser.set_value', 'browser.select_many']) {
      const body = toolBody(name);
      expect(body, name).toContain("urlDestination('page_write'");
      expect(body, name).toContain('writesValue: true');
      expect(body, name).toContain('payload:');
    }
  });

  it('carries a risk level rather than leaving one to be inferred', () => {
    for (const name of ['browser.set_value', 'browser.select_many']) {
      expect(toolBody(name), name).toMatch(/risk: 'R[0-5]'/);
    }
  });

  it('adds no authorization of its own', () => {
    for (const name of ['browser.set_value', 'browser.select_many']) {
      const body = toolBody(name);
      for (const forbidden of ['authorizeEgress', 'requestApproval', 'permissionEngine']) {
        expect(body, `${name} calls ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('adds no panel route — these are model tools, not panel actions', () => {
    const classes = read('src/messaging/route-trust.ts');
    expect(classes).not.toContain('set_value');
    expect(classes).not.toContain('select_many');
  });

  it('keeps the content routes worker-directed, like the rest', () => {
    const protocol = read('src/messaging/protocol.ts');
    expect(protocol).toContain("'content.setValue'");
    expect(protocol).toContain("'content.selectMany'");
    // Content routes live in the content receiver and are reached by
    // `chrome.tabs.sendMessage`, which a content script cannot call.
    const content = read('src/content/content-script.ts');
    expect(content).toContain('senderMayInvokeContentRoute');
  });
});

describe('3. hostile arguments are refused, not interpreted', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const hostile = [
    'javascript:alert(1)',
    '<script>alert(1)</script>',
    '2026-06-01"; DROP TABLE',
    '../../etc/passwd',
    '#000000\n#ffffff',
    'data:text/html,<h1>x',
    '{{constructor.constructor("return 1")()}}',
    '2026-06-01\u0000',
  ];

  it.each(hostile)('refuses %s on a date field', (value) => {
    const element = document.createElement('input');
    element.type = 'date';
    document.body.append(element);
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
    expect(() => performSetValue(element, value)).toThrow(RangeError);
    expect(element.value).toBe('');
  });

  it('refuses a colour that is valid CSS but not a settable value', () => {
    const element = document.createElement('input');
    element.type = 'color';
    document.body.append(element);
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
    // `red` and `#FFF` are both real colours and neither survives a DOM round
    // trip, so accepting them would mean reporting a value the page does not
    // hold.
    for (const value of ['red', '#FFF', 'rgb(1,2,3)', 'var(--brand)']) {
      expect(() => performSetValue(element, value), value).toThrow(RangeError);
    }
  });

  it('matches an option exactly, never by prefix or substring', () => {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
    const select = document.createElement('select');
    select.multiple = true;
    for (const value of ['admin-readonly', 'admin']) {
      const option = document.createElement('option');
      option.value = value;
      option.text = value;
      select.append(option);
    }
    document.body.append(select);
    // A prefix match would turn "admin" into "admin-readonly" or the reverse,
    // depending on document order — which is exactly the kind of silent
    // substitution a permissions dropdown must not make.
    expect(performSelectMany(select, ['admin']).values).toEqual(['admin']);
    expect(() => performSelectMany(select, ['adm'])).toThrow(RangeError);
  });

  it('bounds the size of what it will accept', () => {
    const body = toolBody('browser.set_value');
    expect(body).toContain('.max(64)');
    const many = toolBody('browser.select_many');
    expect(many).toContain('.max(100)');
    expect(many).toContain('.max(200)');
  });

  it('never reports a value the control does not hold', () => {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {};
    const element = document.createElement('input');
    element.type = 'range';
    element.min = '0';
    element.max = '10';
    element.step = '5';
    document.body.append(element);
    // The browser snaps to the nearest step. What is reported is what the
    // control settled on, and the fact that it differs is reported too.
    const result = performSetValue(element, '7');
    expect(result.value).toBe(element.value);
    if (result.value !== '7') expect(result.adjusted).toBe(true);
  });
});

describe('the page model tells a model which tool to reach for', () => {
  it('advertises the type and bounds of a structured input', () => {
    const tree = read('src/content/semantic-tree.ts');
    expect(tree).toContain('extras.inputType = type');
    expect(tree).toContain('extras.min = element.min');
    expect(tree).toContain('extras.max = element.max');
    expect(tree).toContain('extras.step = element.step');
  });

  it('advertises a multi-select as one, with its whole selection', () => {
    const tree = read('src/content/semantic-tree.ts');
    expect(tree).toContain('extras.multiple = true');
    expect(tree).toContain('extras.selected =');
  });

  it('still never reports a password value', () => {
    // The new reporting sits beside the old rule and must not have widened
    // it: password, hidden and file values stay out of the page model.
    const tree = read('src/content/semantic-tree.ts');
    expect(tree).toContain("type !== 'password' && type !== 'hidden' && type !== 'file'");
    expect((STRUCTURED_INPUT_TYPES as readonly string[]).includes('password')).toBe(false);
  });
});
