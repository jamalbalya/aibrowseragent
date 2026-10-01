/**
 * The API providers this build registers — the one list, in one place.
 *
 * It exists because the conformance suite needs to be able to *read* the set it
 * claims to cover. That guard used to be a hardcoded array of three names with
 * a comment saying "the registry is the source of truth, not this file", which
 * was the opposite of what the code did: when a fourth provider was registered
 * in the service worker, the array still listed three, the assertion still
 * passed, and the new provider went through the shared conformance, pin and
 * transport matrices not at all.
 *
 * So the service worker registers from this list and the suite enumerates the
 * same list. Adding a provider in one place now changes both, and a provider
 * without a conformance pack fails a test instead of being quietly untested.
 *
 * Web providers are deliberately absent. They are foundation only, and
 * registering one would make it selectable — inference against an
 * authenticated web session stays closed.
 */
import { openAICompatibleFactory } from '@/providers/adapters/openai-compatible';
import { anthropicFactory } from '@/providers/adapters/anthropic';
import { geminiFactory } from '@/providers/adapters/gemini';
import { nineRouterFactory } from '@/providers/adapters/nine-router';
import type { ProviderFactory } from '@/providers/core/types';

export const API_PROVIDER_FACTORIES: readonly ProviderFactory[] = [
  openAICompatibleFactory,
  anthropicFactory,
  geminiFactory,
  nineRouterFactory,
];

/** Their ids, sorted, for a test that wants to compare sets rather than order. */
export const API_PROVIDER_IDS: readonly string[] = API_PROVIDER_FACTORIES.map(
  (factory) => factory.id,
)
  .slice()
  .sort();
