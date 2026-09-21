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
import type { CanonicalRequest, ModelCapabilities } from './types';

/** Capabilities a single request can ask for. */
export const REQUESTABLE_CAPABILITIES = [
  'vision',
  'toolCalling',
  'streaming',
  'systemInstruction',
] as const;

export type RequestableCapability = (typeof REQUESTABLE_CAPABILITIES)[number];

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
 * Finds the first requested capability the model lacks.
 *
 * Returns the failure rather than throwing so that `generate` can throw it and
 * `stream` can yield it as an error event, without either having to reconstruct
 * the other's reading of the same condition.
 */
export function checkCapabilities(
  providerId: string,
  modelId: string,
  request: CanonicalRequest,
  capabilities: ModelCapabilities,
  streaming: boolean,
): ProviderFailure | null {
  for (const capability of requestedCapabilities(request, streaming)) {
    if (!capabilities[capability]) {
      return unsupportedCapability(providerId, modelId, capability);
    }
  }
  return null;
}
