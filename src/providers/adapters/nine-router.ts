/**
 * 9Router adapter — one gateway, many upstream providers.
 *
 * 9Router is an OpenAI-compatible gateway the user runs and owns: a single `/v1`
 * endpoint in front of whatever upstream accounts they have connected. So it is
 * an AI *provider* here, exactly like the others, and the browser-agent
 * behaviour above it is unchanged. Selecting 9Router does not make this extension
 * depend on 9Router, and nothing about the agent requires any particular brain.
 *
 * ## What is different, and what is not
 *
 * The wire format is not different, which is why this class extends
 * `OpenAICompatibleAdapter` rather than restating it. Request building,
 * streaming, tool-call parsing, finish-reason mapping, the guarded transport and
 * the error taxonomy are all inherited and unmodified.
 *
 * Two things are different:
 *
 *  1. **The catalogue is a hierarchy.** `GET /models` returns models from several
 *     upstream providers at once, and `owned_by` says which. `listModels` is
 *     overridden to carry that grouping; `nine-router-catalog.ts` does the
 *     parsing and holds the reasoning about why `owned_by` rather than the id.
 *  2. **There is a default endpoint.** 9Router runs on a documented local port,
 *     so `baseUrl` is defaulted rather than demanded — unlike the generic
 *     OpenAI-compatible entry, where pointing it somewhere is the whole point.
 *
 * ## What this adapter must not do
 *
 * It must not read a model id as structured data. A 9Router id contains `/` in
 * the ordinary case and none at all for a combination, and the id that reaches
 * `/chat/completions` is the id the catalogue offered, unchanged. The
 * `managementTaskId` defect — a model id interpolated into an internal identifier,
 * where a `/` made the identifier invalid and every probe lost its audit record —
 * is the reason that rule is written down rather than assumed.
 *
 * It must not treat catalogue metadata as a capability report either. 9Router
 * derives its own capability hints by pattern-matching model names against a
 * table, with a floor for anything unrecognised, so a model it has never seen
 * still comes back claiming a context window and tool support. Those are hints;
 * `CapabilityDoctor` is the authority, as it is for every provider here.
 */
import { getLogger } from '@/logging/logger';
import {
  OpenAICompatibleAdapter,
  type WireModelList,
} from '@/providers/adapters/openai-compatible';
import {
  NINE_ROUTER_DEFAULT_BASE_URL,
  NINE_ROUTER_PROVIDER_ID,
  parseModelCatalogue,
  type ModelCatalogue,
} from '@/providers/adapters/nine-router-catalog';
import { managementContext } from '@/security/egress/provider-transport';
import { parseJsonBody } from '@/providers/core/provider-http';
import type {
  AuthResult,
  ModelCapabilities,
  ModelInfo,
  ProviderConfig,
  ProviderFactory,
} from '@/providers/core/types';

const log = getLogger('provider');

const DISCOVERY_TIMEOUT_MS = 20_000;

/**
 * Capability floor for a gateway whose models are not known at build time.
 *
 * Everything optional is `false`. The generic OpenAI-compatible adapter guesses
 * vision from the model name; that guess cannot be made here, because the name
 * belongs to an upstream this build has never heard of. `CapabilityDoctor`
 * measures what is actually there, and a floor of `false` means the UI reports
 * only what was proved.
 */
function gatewayFloor(): ModelCapabilities {
  return {
    // Part of the Chat Completions contract the gateway implements, so declared
    // and then verified — the same reasoning the generic adapter gives.
    text: true,
    streaming: true,
    toolCalling: true,
    parallelToolCalling: true,
    systemInstruction: true,
    structuredOutput: true,
    modelListing: true,
    // Not guessable here. The generic adapter infers vision from the model name;
    // that inference cannot be made for an upstream this build has never heard
    // of, so it stays false until a probe says otherwise.
    vision: false,
    fileInput: false,
    audioInput: false,
    // `null`, not a number: the gateway reports a window it inferred from the
    // model name, and repeating that here would dress a guess as a measurement.
    contextWindow: null,
    maxOutputTokens: null,
  };
}

export class NineRouterAdapter extends OpenAICompatibleAdapter {
  // Widened to `string` in the base class so a subclass can name itself; the
  // adapter contract has always declared these as `string`.
  override readonly id: string = NINE_ROUTER_PROVIDER_ID;
  override readonly displayName: string = '9Router';

  /**
   * The catalogue from the last successful discovery.
   *
   * Held so the groups can be read back without a second request, and cleared on
   * disconnect. It is a cache of *grouping*, never of capability: nothing here
   * feeds `getCapabilities`, so stale metadata cannot become an authoritative
   * capability claim after a reload.
   */
  private catalogue: ModelCatalogue | null = null;

  override connect(config: ProviderConfig): Promise<AuthResult> {
    // The documented local endpoint, when the user did not name one. Applied
    // here rather than in the base class so the generic OpenAI-compatible entry
    // keeps requiring an explicit URL.
    const withDefault: ProviderConfig =
      config.baseUrl && config.baseUrl.trim().length > 0
        ? config
        : { ...config, baseUrl: NINE_ROUTER_DEFAULT_BASE_URL };
    return super.connect(withDefault);
  }

  override async disconnect(): Promise<void> {
    this.catalogue = null;
    await super.disconnect();
  }

  /**
   * The upstream groups from the last discovery.
   *
   * Empty until `listModels` has run, which is the honest answer: the hierarchy
   * is discovered, so before discovery there is none.
   */
  groups(): ModelCatalogue['groups'] {
    return this.catalogue?.groups ?? [];
  }

  /** How many catalogue entries the last discovery could not use. */
  refusedCount(): number {
    return this.catalogue?.refused.length ?? 0;
  }

  override async listModels(): Promise<ModelInfo[]> {
    const config = this.require();
    try {
      const response = await this.transport.request(
        `${config.baseUrl ?? ''}/models`,
        {
          method: 'GET',
          headers: this.headers(),
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        },
        await managementContext(NINE_ROUTER_PROVIDER_ID, config.model ?? '', this.managementSalt),
      );
      if (!response.ok) {
        // Status handling is the base class's taxonomy; discovery specifically
        // degrades to "no catalogue" rather than throwing, because a gateway that
        // is up but not answering `/models` is still worth reporting as
        // unreachable-for-discovery instead of failing the whole connection.
        log.debug('9Router did not return a model catalogue.', { status: response.status });
        this.catalogue = null;
        return [];
      }
      const body = await parseJsonBody<WireModelList>(NINE_ROUTER_PROVIDER_ID, response);
      const catalogue = parseModelCatalogue(body);
      this.catalogue = catalogue;
      log.info('Discovered the 9Router catalogue.', {
        models: catalogue.models.length,
        groups: catalogue.groups.length,
        refused: catalogue.refused.length,
      });
      // `NineRouterModel` widens `ModelInfo` with `upstreamKey`; the array is
      // returned as-is so a caller that knows about the hierarchy can read it and
      // one that does not sees ordinary models.
      return [...catalogue.models];
    } catch (error) {
      log.debug('The 9Router catalogue request failed.', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.catalogue = null;
      return [];
    }
  }

  /**
   * Capabilities for one exact model.
   *
   * The floor, not the catalogue's opinion. 9Router will happily report a context
   * window for a model it inferred from the name, and this adapter does not pass
   * that on as though it were measured. `CapabilityDoctor` probes the model and
   * the report it produces is what the UI shows.
   */
  override getCapabilities(_model: string): Promise<ModelCapabilities> {
    // The model is deliberately unread. The base class infers vision from the
    // name; for a gateway the name belongs to an upstream this build has never
    // heard of, so there is nothing to infer from and guessing would be worse
    // than admitting ignorance. The doctor measures it.
    return Promise.resolve(gatewayFloor());
  }
}

export const nineRouterFactory: ProviderFactory = {
  id: NINE_ROUTER_PROVIDER_ID,
  displayName: '9Router',
  kind: 'api',
  authKind: 'api_key',
  description:
    'A 9Router gateway you run, in front of the upstream AI accounts you have connected to it. ' +
    'The model catalogue is discovered from the gateway and grouped by upstream provider.',
  // Defaulted rather than required: 9Router has a documented local endpoint.
  baseUrl: { required: false, defaultUrl: NINE_ROUTER_DEFAULT_BASE_URL },
  operations: ['generate', 'stream', 'listModels', 'validateConnection', 'toolCalling', 'vision'],
  baselineCapabilities: gatewayFloor(),
  requiresGuardedTransport: true,
  create: (transport) => new NineRouterAdapter(transport),
};
