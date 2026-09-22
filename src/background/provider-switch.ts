/**
 * What a stored provider connection becomes when the active pair changes.
 *
 * Pulled out as a function rather than written inline in the route for a
 * reason that a test found the hard way: a suite that re-implemented this
 * logic in order to exercise it proved only that its own copy behaved, and
 * two mutations to the real route survived untouched. Logic worth testing is
 * logic worth importing.
 *
 * The rule it encodes is small and easy to get wrong by spreading: a
 * capability measurement belongs to the provider and model it was measured
 * on. Carrying it across a switch turns evidence about one thing into a claim
 * about another, and a stale claim is worse than no claim, because nothing
 * downstream can tell it apart from a real one.
 */
import type { ProviderConnection } from '@/providers/registry/provider-registry';

/** True when the pair actually changed, rather than being re-selected. */
export function isProviderSwitch(
  existing: ProviderConnection | null | undefined,
  providerId: string,
  modelId: string,
): boolean {
  if (!existing) return false;
  return existing.providerId !== providerId || existing.modelId !== modelId;
}

/**
 * The connection record to store after selecting `providerId` / `modelId`.
 *
 * On a genuine switch the measurement goes: the capabilities, the timestamp
 * that said when they were taken, and the readiness that was decided from
 * them. What remains is configuration — which is what a connection record is
 * for. Re-selecting the current pair changes nothing, because re-measuring on
 * every settings save would be its own kind of wrong.
 */
export function connectionAfterSwitch(
  existing: ProviderConnection | null | undefined,
  providerId: string,
  modelId: string,
  fresh: () => ProviderConnection,
): ProviderConnection {
  if (!existing) return fresh();
  if (!isProviderSwitch(existing, providerId, modelId)) {
    return { ...existing, providerId, modelId };
  }

  const { capabilities: _measured, lastValidated: _measuredAt, ...configuration } = existing;
  void _measured;
  void _measuredAt;
  return {
    ...configuration,
    providerId,
    modelId,
    // Configured, not yet validated. Whether credentials are stored is a
    // different question from whether the model can do the work, and only the
    // capability doctor answers the second one — by measuring.
    status: 'connected',
  };
}
