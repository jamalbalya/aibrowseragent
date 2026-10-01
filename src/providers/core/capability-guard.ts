/**
 * Deterministic handling of a capability a model does not have.
 *
 * The failure mode this exists to prevent is the quiet one: a request carries
 * a screenshot, the model cannot read images, the adapter drops the image part
 * and sends the text alone. The provider answers, the task continues, and the
 * agent reasons about a page it never saw. Nothing errored, and the result is
 * wrong in a way nobody can trace back.
 *
 * So an unsupported capability is refused, with the same category from every
 * provider, before a request is built (specification section 69).
 */
import { providerFailure, type ProviderFailure } from './provider-error';
import { isUnverified, REQUESTABLE_CAPABILITIES, type RequestableCapability } from './types';
import type { CanonicalRequest, ModelCapabilities } from './types';

// Declared in `types.ts` so `ModelCapabilities` can name these, and re-exported
// here because this is where callers have always imported them from.
export { REQUESTABLE_CAPABILITIES };
export type { RequestableCapability };

const LABELS: Record<RequestableCapability, string> = {
  vision: 'image input',
  toolCalling: 'tool calling',
  streaming: 'streaming',
  systemInstruction: 'system instructions',
};

/**
 * What a request actually asks for, read from its content.
 *
 * Derived rather than declared: a caller that forgot to flag an image would
 * otherwise slip past the check that exists to catch exactly that.
 */
export function requestedCapabilities(
  request: CanonicalRequest,
  streaming: boolean,
): RequestableCapability[] {
  const requested: RequestableCapability[] = [];

  if (request.messages.some((m) => m.content.some((p) => p.type === 'image'))) {
    requested.push('vision');
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    requested.push('toolCalling');
  }
  if (streaming) requested.push('streaming');
  if (request.systemInstruction.trim().length > 0) requested.push('systemInstruction');

  return requested;
}

/** The normalised failure for a capability the model does not have. */
export function unsupportedCapability(
  providerId: string,
  modelId: string,
  capability: RequestableCapability,
): ProviderFailure {
  const label = LABELS[capability];
  return providerFailure(
    providerId,
    'unsupported_capability',
    `"${modelId}" does not support ${label}.`,
    {
      providerCode: `unsupported:${capability}`,
      userMessage:
        `This task needs ${label}, which "${modelId}" does not provide. ` +
        'Choose a model that supports it, or run a task that does not need it.',
    },
  );
}

/**
 * The normalised failure for a capability nobody has established yet.
 *
 * Separate from `unsupportedCapability` because the two are different facts and
 * the user acts on them differently. A model behind a gateway this build has
 * never heard of starts out here, not there, and saying so is the whole point:
 * the previous behaviour reported "does not support image input" for a model
 * that had simply never been probed, which is a claim the build was not in a
 * position to make.
 */
export function unverifiedCapability(
  providerId: string,
  modelId: string,
  capability: RequestableCapability,
): ProviderFailure {
  const label = LABELS[capability];
  return providerFailure(
    providerId,
    'capability_unverified',
    `Whether "${modelId}" supports ${label} has not been established.`,
    {
      providerCode: `unverified:${capability}`,
      userMessage:
        `This task needs ${label}, and it is not yet known whether "${modelId}" ` +
        'provides it. Run the capability doctor for this model, then try again.',
    },
  );
}

/**
 * Finds the first requested capability the model cannot be shown to have.
 *
 * Returns the failure rather than throwing so that `generate` can throw it and
 * `stream` can yield it as an error event, without either having to reconstruct
 * the other's reading of the same condition.
 *
 * Three states, three outcomes. Confirmed supported passes. Confirmed
 * unsupported is refused as such. **Not yet established is refused as that**,
 * and the order matters: the placeholder boolean for an unverified capability
 * is `false`, so reading it before asking whether it is a claim is exactly the
 * collapse this prevents.
 *
 * `probing` is the one narrow exemption, and it exists because without it the
 * third state cannot be resolved. `CapabilityDoctor` settles an unverified
 * capability by *attempting* it — sending a one-pixel image and seeing whether
 * the model answers — and that attempt arrives here as an ordinary request for
 * a capability nobody has established. Refusing it makes the refusal
 * self-fulfilling: the probe fails with "has not been established", which is
 * then the reason it stays unestablished for ever.
 *
 * So a measurement may attempt the thing it is measuring. The exemption is
 * narrow in three ways: it comes from the egress context's `management` flag,
 * which is set by `managementContext` and not by anything a task can reach; it
 * applies only to the **unverified** branch, so a capability measured and found
 * absent is still refused to the doctor; and it changes nothing about the gate,
 * the destination, the credential check or the record.
 */
export function checkCapabilities(
  providerId: string,
  modelId: string,
  request: CanonicalRequest,
  capabilities: ModelCapabilities,
  streaming: boolean,
  probing = false,
): ProviderFailure | null {
  for (const capability of requestedCapabilities(request, streaming)) {
    if (isUnverified(capabilities, capability)) {
      if (!probing) return unverifiedCapability(providerId, modelId, capability);
      // A probe proceeds, and what comes back is the measurement.
      continue;
    }
    if (!capabilities[capability]) {
      return unsupportedCapability(providerId, modelId, capability);
    }
  }
  return null;
}
