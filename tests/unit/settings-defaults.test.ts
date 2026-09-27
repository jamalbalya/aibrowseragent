/**
 * TEST-CONFIG-001 — the defaults a fresh install runs under (§25, §31).
 *
 * These are a security posture, not a preferences list. The difference between
 * `auto` and `skip` is whether anything reviews an action at all, and §25 names
 * the default explicitly — so it is worth a case that fails if somebody changes
 * the constant. It had no test until a clause inventory asked for one and found
 * nothing to cite.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/config/settings';

describe('the defaults a fresh install runs under', () => {
  it('defaults to auto permission mode', () => {
    // §25: the reference side panel defaults to Auto. Not `skip`, which would
    // mean no prompt and no safety review, and not `manual`, which would ask
    // about every state change on a fresh install.
    expect(DEFAULT_SETTINGS.permissionMode).toBe('auto');
  });

  it('does not allow insecure origins out of the box', () => {
    // A convenience toggle for a local dev server, off until somebody asks.
    expect(DEFAULT_SETTINGS.allowInsecureOrigins).toBe(false);
  });

  it('starts with no provider chosen, so nothing is assumed', () => {
    // A default provider would be a default destination for the user's data.
    expect(DEFAULT_SETTINGS.activeProviderId).toBeNull();
    expect(DEFAULT_SETTINGS.activeModelId).toBeNull();
  });

  it('starts with debug mode off', () => {
    expect(DEFAULT_SETTINGS.debugMode).toBe(false);
  });
});
