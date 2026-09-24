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
 *  4. The documentation says what the code says.
 *
 * Nothing here asserts that the gap is acceptable. It asserts that the gap is
 * described accurately, which is the only claim this repository is entitled to
 * make until detection is designed. See `architecture/CLAUDE_BENCHMARK.md`
 * §Gap-1.
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
        /^(UNREACHABLE_BY_CONSTRUCTION|REQUIRES_DETECTION)$/,
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
  it('06 no production source supplies a prohibited category to a classification', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC_ROOT)) {
      // The declaration site itself names every category; it is not a producer.
      if (file.endsWith('risk-classifier.ts')) continue;
      const code = codeOnly(readFileSync(file, 'utf8'));
      if (/prohibited\s*:\s*\[/.test(code)) offenders.push(file);
    }
    // Passes while the gap is open, and fails the moment detection lands —
    // at which point `docs/security.md` and PROHIBITION_ENFORCEMENT must move
    // together. That is the point of the case.
    expect(offenders).toEqual([]);
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
      doc.indexOf('### Declared, enforced if raised'),
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

  it('10 no longer claims all of them are refused in every mode', () => {
    // The wording this suite exists to have corrected.
    expect(doc).not.toContain(
      'Refused in **every** permission mode, including Skip, and not unlockable by a\nsite allowlist entry:',
    );
  });
});
