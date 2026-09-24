/**
 * TEST-SECURITY-065 — what the hard prohibitions actually keep.
 *
 * The policy engine refuses any call carrying a prohibited category, in every
 * mode, unlockable by nothing. That half is covered by `policy-engine.test.ts`
 * and holds. This suite covers the half nobody was checking: whether a
 * category ever *arrives*.
 *
 * It matters because the two are easy to conflate and the documentation did
 * conflate them. `docs/security.md` listed eight prohibitions under "refused in
 * every permission mode", which reads as a guarantee about the product. For
 * three of them it is: no filesystem tool, no CAPTCHA solver and no evaluator
 * exist, so the call cannot be built. For the other five it is a guarantee
 * about a call nobody constructs — a purchase is a click, a card number is a
 * `browser.type`, and nothing tells those apart from any other keystroke.
 *
 * So the cases below pin the distinction rather than the wish:
 *
 *  1. `PROHIBITION_ENFORCEMENT` is total over the categories.
 *  2. The categories marked unreachable really have no tool that could reach
 *     them — asserted against the shipped tool surface, not against a list.
 *  3. The categories marked `REQUIRES_DETECTION` are, today, raised by nothing.
 *     This case **passes while a gap is open**, which is unusual and
 *     deliberate: it fails the moment somebody adds a producer, which is the
 *     moment `docs/security.md` has to stop calling it undetected.
 *  4. The one category marked `DETECTED_AND_ENFORCED` has a producer, and the
 *     producer is named. A row claiming detection with nothing behind it would
 *     be worse than the overclaiming this suite was written to remove.
 *  5. The documentation says what the code says.
 *
 * Gate 1 moved exactly one row. `payment_instrument_entry` acquired a producer
 * in `browser.type` and `browser.set_value`; the other four that need
 * *action*-intent detection — knowing what a button does — did not, and case
 * 06 still holds them to that. Nothing here asserts the remaining gap is
 * acceptable. It asserts that the gap is described accurately, which is the
 * only claim this repository is entitled to make until that detection is
 * designed. See `architecture/CLAUDE_BENCHMARK.md` §Gap-1.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PROHIBITED_CATEGORIES,
  PROHIBITED_DESCRIPTIONS,
  PROHIBITION_ENFORCEMENT,
  UNDETECTED_PROHIBITIONS,
  type ProhibitedCategory,
} from '@/policy/risk-classifier';

const SRC_ROOT = resolve(import.meta.dirname, '../../src');
const TOOLS_ROOT = resolve(import.meta.dirname, '../../src/tools');
const SECURITY_DOC = resolve(import.meta.dirname, '../../docs/security.md');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Source with comments removed, so a docblock cannot satisfy a code check. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('the prohibition table is total and honest', () => {
  it('01 classifies every declared category', () => {
    expect(Object.keys(PROHIBITION_ENFORCEMENT).sort()).toEqual([...PROHIBITED_CATEGORIES].sort());
    for (const category of PROHIBITED_CATEGORIES) {
      expect(PROHIBITION_ENFORCEMENT[category], category).toMatch(
        /^(UNREACHABLE_BY_CONSTRUCTION|REQUIRES_DETECTION|DETECTED_AND_ENFORCED)$/,
      );
      expect(PROHIBITED_DESCRIPTIONS[category], category).toBeTruthy();
    }
  });

  it('02 derives the undetected set rather than listing it', () => {
    const expected = PROHIBITED_CATEGORIES.filter(
      (category) => PROHIBITION_ENFORCEMENT[category] === 'REQUIRES_DETECTION',
    );
    expect([...UNDETECTED_PROHIBITIONS]).toEqual([...expected]);
    expect(UNDETECTED_PROHIBITIONS.length).toBeGreaterThan(0);
  });
});

describe('the categories called unreachable really have no tool behind them', () => {
  const toolCode = sources(TOOLS_ROOT)
    .map((file) => codeOnly(readFileSync(file, 'utf8')))
    .join('\n');

  it('03 no tool writes to the filesystem', () => {
    for (const forbidden of ['node:fs', 'writeFileSync', 'openSync', 'fs.promises']) {
      expect(toolCode, forbidden).not.toContain(forbidden);
    }
  });

  it('04 no tool evaluates model-supplied script', () => {
    for (const forbidden of [
      'Runtime.evaluate',
      'Runtime.callFunctionOn',
      'eval(',
      'new Function',
    ]) {
      expect(toolCode, forbidden).not.toContain(forbidden);
    }
  });

  it('04b script injection names a shipped file and never a function or a string', () => {
    // `chrome.scripting.executeScript` does exist, for injecting the content
    // script into a tab that loaded before the extension. That is not arbitrary
    // execution *provided* it only ever names a file: `func` and a code string
    // are the two shapes that would make it so, and neither appears.
    expect(toolCode).toContain('executeScript');
    expect(toolCode).toMatch(/files:\s*\['content-script\.js'\]/);
    expect(toolCode).not.toMatch(/executeScript\([\s\S]{0,400}?\bfunc\s*:/);
    expect(toolCode).not.toMatch(/executeScript\([\s\S]{0,400}?\bargs\s*:/);
  });

  it('05 no tool accepts a CDP method name as an argument', () => {
    // A tool taking a method name would make the debugger allowlist advisory.
    expect(toolCode).not.toMatch(/method:\s*z\.string\(\)/);
  });
});

describe('the categories called undetected are, in fact, raised by nothing', () => {
  it('06 the only production source supplying a prohibited category is the one that claims to', () => {
    const producers: string[] = [];
    for (const file of sources(SRC_ROOT)) {
      // The declaration site itself names every category; it is not a producer.
      if (file.endsWith('risk-classifier.ts')) continue;
      const code = codeOnly(readFileSync(file, 'utf8'));
      if (/prohibited\s*:\s*\[/.test(code)) producers.push(file);
    }

    // Exactly one file, and the categories it names must all be marked
    // detected. A file that raised `permanent_deletion` while the table still
    // called it undetected would fail here, which is the same protection the
    // original "no producers at all" assertion gave — now expressed as a
    // correspondence rather than an absence, because an absence stopped being
    // true the moment a real producer landed.
    expect(producers.map((file) => file.replace(`${SRC_ROOT}/`, ''))).toEqual([
      'tools/browser/browser-tools.ts',
    ]);

    const raised = new Set<string>();
    for (const file of producers) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const match of code.matchAll(/prohibited\s*:\s*\[([^\]]*)\]/g)) {
        for (const literal of (match[1] ?? '').matchAll(/'([a-z_]+)'/g)) {
          raised.add(literal[1] as string);
        }
      }
      // The category can also arrive via a variable rather than a literal, and
      // it does: `dispositionToClassification` passes `disposition.category`
      // through. The literal it comes from is in `field-sensitivity.ts`, so
      // that file is read too rather than the indirection being waved past.
      const sensitivity = codeOnly(
        readFileSync(join(SRC_ROOT, 'policy/field-sensitivity.ts'), 'utf8'),
      );
      for (const match of sensitivity.matchAll(/category:\s*'([a-z_]+)'/g)) {
        raised.add(match[1] as string);
      }
    }

    expect([...raised].sort()).toEqual(['payment_instrument_entry']);
    for (const category of raised) {
      expect(PROHIBITION_ENFORCEMENT[category as ProhibitedCategory], category).toBe(
        'DETECTED_AND_ENFORCED',
      );
    }
  });

  it('06b every category still marked undetected is raised by nothing', () => {
    const production = sources(SRC_ROOT)
      .filter((file) => !file.endsWith('risk-classifier.ts'))
      .map((file) => codeOnly(readFileSync(file, 'utf8')))
      .join('\n');

    for (const category of UNDETECTED_PROHIBITIONS) {
      expect(production, category).not.toContain(`'${category}'`);
    }
    // The four that need action-intent detection, named so that closing one
    // without moving its row is a failure rather than a silent drift.
    expect([...UNDETECTED_PROHIBITIONS].sort()).toEqual([
      'account_creation',
      'credential_submission_to_third_party',
      'financial_transaction',
      'permanent_deletion',
      'securities_trading',
    ]);
  });

  it('07 the engine would still refuse one if it arrived', async () => {
    // The enforcement half, re-asserted here so this file cannot be read as
    // saying prohibitions do nothing.
    const { evaluatePolicy } = await import('@/policy/policy-engine');
    const { emptySitePolicyState } = await import('@/policy/site-policy');
    for (const category of PROHIBITED_CATEGORIES) {
      for (const mode of ['manual', 'auto', 'skip'] as const) {
        const decision = evaluatePolicy(
          { tool: 'browser.click', taskId: 't', risk: 'R0', prohibited: [category] },
          { mode, sitePolicy: emptySitePolicyState() },
        );
        expect(decision.verdict, `${category}/${mode}`).toBe('DENY');
        expect(decision.code, `${category}/${mode}`).toBe('PROHIBITED_ACTION');
      }
    }
  });
});

describe('the documentation says what the code says', () => {
  const doc = readFileSync(SECURITY_DOC, 'utf8');

  it('08 states plainly that no tool raises the undetected categories', () => {
    expect(doc).toContain('**No tool in this build raises any of these.**');
  });

  it('09 lists every unreachable category under the tool-surface heading', () => {
    const section = doc.slice(
      doc.indexOf('### Kept by the tool surface'),
      doc.indexOf('### Declared, detected and enforced'),
    );
    expect(section.length).toBeGreaterThan(0);
    const unreachable = PROHIBITED_CATEGORIES.filter(
      (c) => PROHIBITION_ENFORCEMENT[c] === 'UNREACHABLE_BY_CONSTRUCTION',
    );
    const expectedPhrases: Record<ProhibitedCategory, string> = {
      system_file_modification: 'No filesystem tool exists',
      bot_protection_bypass: 'No solver exists',
      arbitrary_code_execution: 'no code-evaluation method',
      financial_transaction: '',
      payment_instrument_entry: '',
      account_creation: '',
      credential_submission_to_third_party: '',
      permanent_deletion: '',
      securities_trading: '',
    };
    for (const category of unreachable) {
      expect(section, category).toContain(expectedPhrases[category]);
    }
  });

  it('09b names the producer for the one category that has one', () => {
    const start = doc.indexOf('### Declared, detected and enforced');
    const section = doc.slice(start, doc.indexOf('### Declared, enforced if raised'));
    expect(start).toBeGreaterThan(-1);
    expect(section).toContain('browser.type');
    expect(section).toContain('browser.set_value');
    // The limits are part of the claim. A section that named a producer but
    // not what it fails to cover would be the overclaiming this suite exists
    // to prevent, in a new place.
    expect(section).toContain('cross-origin iframe');
    expect(section).toContain('shadow root');
  });

  it('10 no longer claims all of them are refused in every mode', () => {
    // The wording this suite exists to have corrected.
    expect(doc).not.toContain(
      'Refused in **every** permission mode, including Skip, and not unlockable by a\nsite allowlist entry:',
    );
  });
});
