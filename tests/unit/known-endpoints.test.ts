/**
 * TEST-ENDPOINTS-001 — the list of endpoints offered as defaults.
 *
 * ## What is actually at risk here
 *
 * This is a data file, so the temptation is to treat it as unbreakable. It is
 * not. Every entry is a URL this build will send **somebody's API key** to,
 * chosen from a dropdown by a user who is trusting the name beside it. Three
 * things can go wrong and all three are silent:
 *
 *  - an entry naming a provider id that is not registered, so picking it
 *    produces a form that cannot connect;
 *  - an entry whose URL the adapter itself refuses, so picking it produces a
 *    failure that looks like the user's fault;
 *  - an entry whose URL is wrong in a way nothing checks — a typo'd host, a
 *    plain-http vendor, a path that is not the API root.
 *
 * So the cases below check each entry against the **registry** and against
 * the **adapter**, not against a copy of the list. The adapter check is the
 * one that matters most: it is the same `connect` the panel will call, and it
 * is where the https rule lives.
 *
 * ## No network, and no credentials
 *
 * `connect` validates the URL and builds a label; it does not reach the
 * endpoint. The keys here are fixed strings that authenticate nothing, and
 * nothing in this file opens a socket.
 */
import { describe, expect, it } from 'vitest';
import {
  endpointsFor,
  knownEndpoint,
  KNOWN_ENDPOINTS,
  OPENAI_COMPATIBLE_ENDPOINTS,
} from '@/providers/registry/known-endpoints';
import { API_PROVIDER_IDS } from '@/providers/registry/api-providers';
import {
  OpenAICompatibleAdapter,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from '@/providers/adapters/openai-compatible';

/** Not a credential: a fixed string that authenticates nothing. */
const KEY = 'key-under-test';

describe('every entry runs on something this build has', () => {
  it('names a provider the build actually registers', () => {
    // The failure this catches: an entry added for a vendor whose adapter was
    // planned and never written. The form would offer it and the connect
    // would fail with "unknown provider".
    expect(KNOWN_ENDPOINTS.length).toBeGreaterThan(0);
    for (const entry of KNOWN_ENDPOINTS) {
      expect(API_PROVIDER_IDS, entry.id).toContain(entry.providerId);
    }
  });

  it('adds no adapter, because every entry is on one protocol’s adapter', () => {
    // The architectural rule this list exists to respect: one adapter per
    // protocol, not one per vendor. Ten vendors, one adapter.
    expect(new Set(KNOWN_ENDPOINTS.map((entry) => entry.providerId))).toEqual(
      new Set([OPENAI_COMPATIBLE_PROVIDER_ID]),
    );
  });

  it('has unique ids, so a form value resolves to one entry', () => {
    const ids = KNOWN_ENDPOINTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique base URLs, so two entries are never the same endpoint twice', () => {
    const urls = KNOWN_ENDPOINTS.map((entry) => entry.baseUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe('every entry is a URL the adapter will accept', () => {
  it('connects for each one, with no refusal', async () => {
    // **The case that makes this list trustworthy.** It calls the same
    // `connect` the panel calls, so an entry the build would reject fails
    // here rather than in front of a user who has just pasted their key.
    const adapter = new OpenAICompatibleAdapter();
    for (const entry of OPENAI_COMPATIBLE_ENDPOINTS) {
      const result = await adapter.connect({
        providerId: entry.providerId,
        baseUrl: entry.baseUrl,
        apiKey: KEY,
        model: 'a-model',
      });
      expect(result.authenticated, `${entry.id}: ${result.error?.message ?? ''}`).toBe(true);
    }
  });

  it('is https everywhere except loopback, which the adapter also enforces', async () => {
    // Both halves measured. The rule is the adapter's — *"API keys are only
    // sent over https. Use an https endpoint, or localhost for a local model
    // server."* — and this asserts the list obeys it *and* that the rule is
    // still there, so a future list cannot quietly rely on it being gone.
    for (const entry of KNOWN_ENDPOINTS) {
      const url = new URL(entry.baseUrl);
      const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
      expect(url.protocol === 'https:' || loopback, entry.id).toBe(true);
    }

    const adapter = new OpenAICompatibleAdapter();
    const refused = await adapter.connect({
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      baseUrl: 'http://not-loopback.test/v1',
      apiKey: KEY,
      model: 'a-model',
    });
    expect(refused.authenticated).toBe(false);
    expect(refused.error?.userMessage).toContain('https');
  });

  it('points at an API root, not a completions path', async () => {
    // An entry ending in `/chat/completions` would produce a request to
    // `…/chat/completions/chat/completions`, which 404s in a way that reads
    // as the vendor being broken.
    for (const entry of KNOWN_ENDPOINTS) {
      expect(entry.baseUrl, entry.id).not.toContain('/chat/completions');
      expect(entry.baseUrl, entry.id).not.toMatch(/\/$/);
    }
  });
});

describe('an entry carries no credential and no model', () => {
  it('declares no model id, because a catalogue is discovered', () => {
    // A default model here would be a claim about somebody else's catalogue
    // that this file cannot keep true — and the build refuses a selection the
    // last discovery did not offer, so it would break the first time a vendor
    // renamed one.
    for (const entry of KNOWN_ENDPOINTS) {
      expect(Object.keys(entry).sort(), entry.id).toEqual(
        entry.keyPage === undefined
          ? ['baseUrl', 'displayName', 'id', 'note', 'providerId']
          : ['baseUrl', 'displayName', 'id', 'keyPage', 'note', 'providerId'],
      );
    }
  });

  it('carries nothing key-shaped in any field', () => {
    const serialised = JSON.stringify(KNOWN_ENDPOINTS);
    expect(serialised).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(serialised).not.toMatch(/\bapi[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{8,}/i);
    // A key page is a URL the user opens; it must not carry a query that
    // could hold one.
    for (const entry of KNOWN_ENDPOINTS) {
      if (entry.keyPage === undefined) continue;
      const url = new URL(entry.keyPage);
      expect(url.protocol, entry.id).toBe('https:');
      expect(url.search, entry.id).toBe('');
    }
  });

  it('says something about every entry, because the name alone is not enough', () => {
    // The user is choosing where their key goes. Two Moonshot hosts with
    // non-interchangeable accounts is exactly the case a bare name fails.
    for (const entry of KNOWN_ENDPOINTS) {
      expect(entry.note.trim().length, entry.id).toBeGreaterThan(10);
      expect(entry.displayName.trim().length, entry.id).toBeGreaterThan(0);
    }
  });

  it('keeps the two Moonshot regions apart', () => {
    // A key for one is not a key for the other. One entry telling the user to
    // edit the host would silently fail for half of them.
    const moonshot = KNOWN_ENDPOINTS.filter((entry) => entry.baseUrl.includes('moonshot'));
    expect(moonshot).toHaveLength(2);
    expect(new Set(moonshot.map((entry) => new URL(entry.baseUrl).hostname)).size).toBe(2);
    for (const entry of moonshot) expect(entry.note).toMatch(/not interchangeable|and not on/i);
  });

  it('tells the user when no key is needed', () => {
    // A local runner with an empty key field is a connection that works. A
    // user who does not know that types something and wonders why.
    for (const entry of KNOWN_ENDPOINTS) {
      const loopback = ['localhost', '127.0.0.1', '::1'].includes(new URL(entry.baseUrl).hostname);
      if (loopback) expect(entry.note, entry.id).toMatch(/no key/i);
      else expect(entry.keyPage, entry.id).toBeDefined();
    }
  });
});

describe('looking an entry up', () => {
  it('returns the one asked for', () => {
    expect(knownEndpoint('moonshot-global')?.baseUrl).toBe('https://api.moonshot.ai/v1');
  });

  it('returns nothing for an id it does not have, rather than a default', () => {
    // A form that fell back to some other vendor's endpoint would send the
    // user's key to the wrong place.
    expect(knownEndpoint('not-an-endpoint')).toBeUndefined();
    expect(knownEndpoint('')).toBeUndefined();
  });

  it('filters by provider, and offers none for a provider with no entries', () => {
    expect(endpointsFor(OPENAI_COMPATIBLE_PROVIDER_ID).length).toBe(
      OPENAI_COMPATIBLE_ENDPOINTS.length,
    );
    expect(endpointsFor('anthropic')).toEqual([]);
    expect(endpointsFor('not-a-provider')).toEqual([]);
  });
});
