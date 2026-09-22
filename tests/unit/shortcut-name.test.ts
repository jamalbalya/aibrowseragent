/**
 * TEST-SHORTCUT-001 — what a typed name becomes, and what it refuses to be.
 *
 * Normalisation decides identity, so it has to be deterministic and
 * idempotent: a name that normalises differently on two reads is a name that
 * could run two different things. Skeletonisation decides only whether a new
 * name may exist, and is never a lookup key.
 */
import { describe, expect, it } from 'vitest';
import {
  looksLikeShortcut,
  MAX_SHORTCUT_NAME,
  normaliseShortcutName,
  skeletonOf,
} from '@/shortcuts/shortcut-name';

describe('normalisation', () => {
  it('is idempotent, so a stored name is a stable identity', () => {
    for (const typed of ['/QA_Regression', 'review ticket', '--debug--page--']) {
      const once = normaliseShortcutName(typed);
      expect(once.ok).toBe(true);
      if (!once.ok) continue;
      const twice = normaliseShortcutName(once.name);
      expect(twice.ok && twice.name).toBe(once.name);
      expect(twice.ok && twice.skeleton).toBe(once.skeleton);
    }
  });

  it('strips any number of leading slashes and surrounding whitespace', () => {
    for (const typed of ['/x', '//x', '   ///x   ', '/ x']) {
      expect(normaliseShortcutName(typed), typed).toMatchObject({ ok: true, name: 'x' });
    }
  });

  it('collapses separators rather than preserving them', () => {
    expect(normaliseShortcutName('a___b')).toMatchObject({ ok: true, name: 'a-b' });
    expect(normaliseShortcutName('a   b')).toMatchObject({ ok: true, name: 'a-b' });
    expect(normaliseShortcutName('a---b')).toMatchObject({ ok: true, name: 'a-b' });
    expect(normaliseShortcutName('a-\t-b')).toMatchObject({ ok: true, name: 'a-b' });
  });

  it('applies NFKC, so a compatibility spelling is not a second name', () => {
    // Fullwidth and ligature forms fold onto their ASCII equivalents.
    expect(normaliseShortcutName('ａｂ')).toMatchObject({ ok: true, name: 'ab' });
    expect(normaliseShortcutName('ﬀ')).toMatchObject({ ok: true, name: 'ff' });
  });

  it('refuses an empty, overlong or unsafe name', () => {
    expect(normaliseShortcutName('')).toMatchObject({ ok: false, reason: 'EMPTY' });
    expect(normaliseShortcutName('   /// ')).toMatchObject({ ok: false, reason: 'EMPTY' });
    expect(normaliseShortcutName('a'.repeat(MAX_SHORTCUT_NAME + 1))).toMatchObject({
      ok: false,
      reason: 'TOO_LONG',
    });
    expect(normaliseShortcutName('a'.repeat(MAX_SHORTCUT_NAME)).ok).toBe(true);
    for (const bad of ['a.b', 'a/b', 'a:b', 'a$b', 'a b!', '<b>', '../etc']) {
      expect(normaliseShortcutName(bad).ok, bad).toBe(false);
    }
  });

  it('names a character that reads as a letter but is not one', () => {
    // Cyrillic а, е, о and Greek ο all render as their Latin twins.
    for (const sneaky of ['аbc', 'dеploy', 'depоy', 'depοy']) {
      expect(normaliseShortcutName(sneaky), sneaky).toMatchObject({
        ok: false,
        reason: 'CONFUSABLE_CHARACTER',
      });
    }
  });
});

describe('skeletonisation', () => {
  it('maps digit/letter lookalikes onto one key', () => {
    expect(skeletonOf('dep1oy')).toBe(skeletonOf('deploy'));
    expect(skeletonOf('depl0y')).toBe(skeletonOf('deploy'));
    expect(skeletonOf('5end')).toBe(skeletonOf('send'));
    expect(skeletonOf('rnail')).toBe(skeletonOf('mail'));
  });

  it('ignores hyphens, which a reader in a hurry does too', () => {
    expect(skeletonOf('qa-regression')).toBe(skeletonOf('qaregression'));
  });

  it('keeps genuinely different names apart', () => {
    expect(skeletonOf('deploy')).not.toBe(skeletonOf('destroy'));
    expect(skeletonOf('review')).not.toBe(skeletonOf('revoke'));
  });
});

describe('detection', () => {
  it('treats a leading slash as an attempt to invoke a shortcut', () => {
    expect(looksLikeShortcut('/qa')).toBe(true);
    expect(looksLikeShortcut('   /qa')).toBe(true);
    expect(looksLikeShortcut('open /qa')).toBe(false);
    expect(looksLikeShortcut('summarise this page')).toBe(false);
  });
});
