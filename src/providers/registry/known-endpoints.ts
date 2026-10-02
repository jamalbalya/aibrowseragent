/**
 * Endpoints that speak a protocol this build already has, named so a user can
 * recognise their own account.
 *
 * ## The gap this closes
 *
 * Four adapters are registered, one per **protocol**: `openai-compatible`,
 * `anthropic`, `gemini`, `nine-router`. That is deliberate and
 * `account-model.ts` says why — *"DeepSeek, Groq, Together and a local
 * llama.cpp all speak `openai-compatible`; they are different vendors with
 * different endpoints... Collapsing the two would mean a new adapter per
 * vendor, which is the architecture this project already decided against."*
 *
 * The cost of that correctness landed on the user. Somebody holding a Kimi
 * key had to know that Moonshot speaks the OpenAI protocol, pick a provider
 * called "OpenAI-compatible", and type `https://api.moonshot.ai/v1` from
 * memory. The capability was there and the connection was not discoverable,
 * which for the person holding the key is the same as not having it.
 *
 * So this is a list of **defaults**, and it is nothing else:
 *
 * | It is not | Because |
 * | --- | --- |
 * | an adapter | every entry runs on an adapter that already exists |
 * | a credential | no key, no client id, no secret; the user brings their own |
 * | a permission | no host permission is added; egress is decided as always |
 * | a guarantee | an endpoint can change, and a connection is confirmed by connecting |
 * | a model list | models are discovered from the endpoint, never declared here |
 * | an endorsement | it records that a vendor speaks a protocol, nothing more |
 *
 * **The base URL stays editable.** Every entry fills the field the user could
 * already type into, and nothing stops them changing it — a self-hosted
 * gateway, a regional host, a proxy. An entry that forced its URL would be a
 * downgrade from the free-text field it replaces.
 *
 * ## Why no model ids
 *
 * Because a model id here would be a claim about somebody else's catalogue
 * that this file cannot keep true, and the build already has the honest
 * mechanism: discovery asks the endpoint, and a selection the last discovery
 * did not offer is refused rather than sent. A default model would walk
 * straight into that refusal the first time a vendor renamed one.
 *
 * ## The two http entries
 *
 * `localhost` over plain http, which the adapter accepts and which it refuses
 * for any other host: *"API keys are only sent over https. Use an https
 * endpoint, or localhost for a local model server."* Measured rather than
 * assumed — both outcomes were run against the real adapter before either
 * entry was written, because an entry whose URL the build would refuse is
 * worse than no entry at all.
 *
 * ## Why the regional pairs are separate entries
 *
 * Moonshot answers on `.ai` and `.cn` with **different accounts** behind them,
 * and a key for one is not a key for the other. One entry with a note telling
 * the user to edit the host would be an entry that silently fails for half of
 * them.
 */
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '@/providers/adapters/openai-compatible';

export interface KnownEndpoint {
  /** Stable, lowercase, used as a form value and in no stored record. */
  readonly id: string;
  readonly displayName: string;
  /** The adapter this runs on. Always one that is already registered. */
  readonly providerId: string;
  /** Prefilled into the editable Base URL field. Never forced. */
  readonly baseUrl: string;
  /** One line: what it is, and anything about the key the user needs to know. */
  readonly note: string;
  /** Where the user creates a key, in their own account. Opened by the user. */
  readonly keyPage?: string;
}

/**
 * Endpoints known to speak the OpenAI Chat Completions protocol.
 *
 * Each was chosen on one criterion: a user plausibly already holds a key for
 * it, and this build can reach it today with no new code. Ordered roughly by
 * how likely that is rather than alphabetically, because this is a list
 * somebody reads to find their own account in.
 *
 * `api.openai.com` is deliberately absent: it is the adapter's own default,
 * already prefilled, and listing it twice would suggest the two were different.
 */
export const OPENAI_COMPATIBLE_ENDPOINTS: readonly KnownEndpoint[] = [
  {
    id: 'moonshot-global',
    displayName: 'Kimi (Moonshot, global)',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: 'https://api.moonshot.ai/v1',
    note: 'Moonshot AI’s international endpoint. A key issued on platform.moonshot.ai works here and not on the mainland host below.',
    keyPage: 'https://platform.moonshot.ai/console/api-keys',
  },
  {
    id: 'moonshot-cn',
    displayName: 'Kimi (Moonshot, mainland China)',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: 'https://api.moonshot.cn/v1',
    note: 'Moonshot AI’s mainland endpoint. A separate account from the global one — the keys are not interchangeable.',
    keyPage: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: 'https://api.deepseek.com/v1',
    note: 'DeepSeek’s own API.',
    keyPage: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: 'https://openrouter.ai/api/v1',
    note: 'A gateway in front of many vendors. Model ids carry a prefix — the whole id is the identifier and this build never splits one.',
    keyPage: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: 'https://api.groq.com/openai/v1',
    note: 'Groq’s OpenAI-compatible route. Note the /openai path segment.',
    keyPage: 'https://console.groq.com/keys',
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: 'https://api.mistral.ai/v1',
    note: 'Mistral’s own API.',
    keyPage: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'xai',
    displayName: 'xAI (Grok)',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: 'https://api.x.ai/v1',
    note: 'xAI’s OpenAI-compatible API.',
    keyPage: 'https://console.x.ai',
  },
  {
    id: 'together',
    displayName: 'Together AI',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: 'https://api.together.xyz/v1',
    note: 'Together’s OpenAI-compatible API.',
    keyPage: 'https://api.together.ai/settings/api-keys',
  },
  {
    id: 'ollama',
    displayName: 'Ollama (on this computer)',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: 'http://localhost:11434/v1',
    note: 'A local model runner. It needs no key — leave the field as it is. Plain http is accepted here because the host is loopback; the adapter refuses it anywhere else, and says so.',
  },
  {
    id: 'lmstudio',
    displayName: 'LM Studio (on this computer)',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: 'http://localhost:1234/v1',
    note: 'A local model runner. It needs no key — leave the field as it is.',
  },
];

/** Every known endpoint, across protocols. One list for the panel to render. */
export const KNOWN_ENDPOINTS: readonly KnownEndpoint[] = OPENAI_COMPATIBLE_ENDPOINTS;

/**
 * The entry with this id, or `undefined`.
 *
 * `undefined` rather than a default, because a form that silently fell back to
 * some other vendor's endpoint would send the user's key to the wrong place.
 */
export function knownEndpoint(id: string): KnownEndpoint | undefined {
  return KNOWN_ENDPOINTS.find((entry) => entry.id === id);
}

/** The entries that run on one registered provider. */
export function endpointsFor(providerId: string): readonly KnownEndpoint[] {
  return KNOWN_ENDPOINTS.filter((entry) => entry.providerId === providerId);
}
