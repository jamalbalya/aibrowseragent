/**
 * How each provider can be authorized — the verified matrix, in one place.
 *
 * ## The question this answers
 *
 * "Connect my Google account and show me the AI accounts and models I can
 * use" is a reasonable thing to want and a specific thing to promise. This
 * file is what stops the product promising more of it than is true.
 *
 * A Google connection authorizes **Google's own API**. It does not reveal,
 * authorize or discover an account at any other vendor, and no amount of
 * Google consent makes an Anthropic subscription reachable. A UI that showed
 * one "Connect with Google" button above a list of five providers would be
 * implying otherwise, so the button is attached to the one provider it works
 * for and every other provider says what it actually needs.
 *
 * ## Where each row came from
 *
 * Every entry below was checked against the vendor's own documentation or
 * measured against the live endpoint, and the citation is on the entry. The
 * three distinctions that kept mattering:
 *
 *  - **an identity sign-in is not API access.** A provider can offer OAuth
 *    that proves who you are and grants nothing that can run a model.
 *  - **a consumer subscription is not an API entitlement.** Plus, Pro and Max
 *    plans are sold for the vendor's own apps; several vendors say in writing
 *    that a third party must not route them.
 *  - **"no client secret" is not the only blocker.** OpenAI's plan-sharing
 *    flow needs no secret and is still unavailable here, because it requires
 *    a loopback redirect an MV3 extension cannot serve.
 *
 * ## What this file is not
 *
 * Not a credential, not a client id, not a permission, and not a model list.
 * Models are always discovered from the endpoint with the user's own
 * credential; nothing here declares one.
 */

import { ANTHROPIC_PROVIDER_ID } from '@/providers/adapters/anthropic';
import { GEMINI_PROVIDER_ID } from '@/providers/adapters/gemini';
import { NINE_ROUTER_PROVIDER_ID } from '@/providers/adapters/nine-router-catalog';
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '@/providers/adapters/openai-compatible';

/**
 * How a credential is obtained.
 *
 * `api_key` — the user creates one in their own account and pastes it.
 * `google_oauth` — the user authorizes this extension against Google, and the
 * resulting access token is the credential. There is no third kind, because
 * no other vendor offers one this build can reach.
 */
export const AUTHORIZATION_KINDS = ['api_key', 'google_oauth'] as const;
export type AuthorizationKind = (typeof AUTHORIZATION_KINDS)[number];

/** Whether models can be listed before the user has chosen one. */
export type ModelDiscovery =
  /** The endpoint lists them, with the user's credential. */
  | 'from_endpoint'
  /** The user types the id. No endpoint here lists models without a credential. */
  | 'manual';

export interface AuthorizationMethod {
  readonly kind: AuthorizationKind;
  /** One line for the panel: what the user is about to do. */
  readonly label: string;
  /** What the user has to have or do first. Shown before the button. */
  readonly requires: string;
  /** Where the user obtains the credential, in their own account. */
  readonly page?: string;
  /**
   * True when the shipped build can perform it at all.
   *
   * A method needing something the build does not carry — a registered client
   * id — reports `false` and `unavailableReason`, so the panel disables it and
   * says why instead of offering a button that cannot work.
   */
  readonly configured: boolean;
  readonly unavailableReason?: string;
}

/**
 * A way of connecting that a vendor documents and this build cannot use.
 *
 * Recorded rather than omitted. Each of these is the thing a reader would
 * reasonably expect to be possible, and the specific reason it is not is more
 * useful than its absence — especially where the reason is not a secret but a
 * redirect URI, which is the case that surprised this project.
 */
export interface UnavailableMethod {
  readonly label: string;
  /** The precise blocker, in one sentence. */
  readonly reason: string;
  /** The vendor page that establishes it. */
  readonly source: string;
}

export interface ProviderAuthorization {
  readonly providerId: string;
  readonly displayName: string;
  readonly methods: readonly AuthorizationMethod[];
  readonly unavailable: readonly UnavailableMethod[];
  readonly modelDiscovery: ModelDiscovery;
  /**
   * True when authorizing this provider involves a Google account.
   *
   * Exactly one provider sets it, and the panel uses it to place the Google
   * button where it belongs rather than above the whole list.
   */
  readonly googleAuthorizable: boolean;
  /** Whether using this connection can cost the user money. */
  readonly billing: 'paid_api' | 'depends_on_endpoint';
}

/**
 * Google's OAuth endpoints and the scope a Gemini connection asks for.
 *
 * `cloud-platform` is what Google's own Gemini OAuth quickstart uses. It is
 * broad, and that is disclosed to the user rather than narrowed to something
 * that would not work: the narrower documented scope,
 * `generative-language.retriever`, covers semantic retrieval and not
 * generation, so a connection built on it could list nothing and run nothing.
 *
 * **Measured, not assumed.** `generativelanguage.googleapis.com` answers an
 * unauthenticated request with *"Please use API Key or other form of API
 * consumer identity"* and a bearer-token request with *"Expected OAuth 2
 * access token, login cookie or other valid authentication credential"* — so
 * an access token is a credential this API recognises, which is the fact the
 * whole flow rests on.
 */
export const GOOGLE_AUTH = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  /** Space-separated, in the order Google's quickstart lists them. */
  scope: 'https://www.googleapis.com/auth/cloud-platform',
  /** Shown to the user before they are sent to Google. */
  scopeExplanation:
    'This asks Google for access to the Gemini API on your Google Cloud project. ' +
    'It is a broad scope — it is the one Google’s own Gemini OAuth guide uses, and ' +
    'the narrower one covers retrieval only and cannot run a model.',
} as const;

/**
 * The matrix.
 *
 * Ordered with the Google-authorizable provider first, because that is the
 * one the clarified requirement is about, and a reader looking for it should
 * not have to scan.
 */
export const PROVIDER_AUTHORIZATION: readonly ProviderAuthorization[] = [
  {
    providerId: GEMINI_PROVIDER_ID,
    displayName: 'Google Gemini',
    googleAuthorizable: true,
    modelDiscovery: 'from_endpoint',
    billing: 'paid_api',
    methods: [
      {
        kind: 'google_oauth',
        label: 'Connect with Google',
        requires:
          'A Google account with the Gemini API enabled on a Google Cloud project. ' +
          'Usage is billed to that project.',
        configured: false,
        unavailableReason: 'placeholder — replaced at load time',
      },
      {
        kind: 'api_key',
        label: 'Paste a Gemini API key',
        requires: 'A key you create in Google AI Studio. Usage is billed to its project.',
        page: 'https://aistudio.google.com/apikey',
        configured: true,
      },
    ],
    unavailable: [
      {
        label: 'Using a Google One AI Premium or Gemini Advanced subscription',
        reason:
          'A consumer Gemini subscription is sold for Google’s own apps and is not an API ' +
          'entitlement. API calls are billed to a Cloud project, whether authorized by OAuth ' +
          'or by a key.',
        source: 'https://ai.google.dev/gemini-api/docs/pricing',
      },
    ],
  },
  {
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    displayName: 'OpenAI-compatible',
    googleAuthorizable: false,
    modelDiscovery: 'from_endpoint',
    billing: 'depends_on_endpoint',
    methods: [
      {
        kind: 'api_key',
        label: 'Paste an API key',
        requires: 'A key from the endpoint you are connecting to. A local model runner needs none.',
        page: 'https://platform.openai.com/api-keys',
        configured: true,
      },
    ],
    unavailable: [
      {
        label: 'Sign in with ChatGPT, using a ChatGPT Plus or Pro plan',
        reason:
          'It exists and needs no client secret, and it still cannot be used here: the ' +
          'plan-sharing flow requires a redirect to http://127.0.0.1:{port}/callback, and an ' +
          'MV3 extension cannot listen on a loopback port. The variant that takes an https ' +
          'redirect is identity-only — it proves who you are and grants no model access — and ' +
          'needs a registered client and a server to receive the callback.',
        source: 'https://developers.openai.com/siwc/token-sharing-open-source/sign-in',
      },
      {
        label: 'Authorizing with a Google account',
        reason:
          'OpenAI accepts Google as a way to sign in to OpenAI’s own site. That is OpenAI’s ' +
          'login screen, not an authorization this extension can receive, and it grants no API ' +
          'credential to anybody else.',
        source: 'https://developers.openai.com/api/reference/overview',
      },
    ],
  },
  {
    providerId: ANTHROPIC_PROVIDER_ID,
    displayName: 'Anthropic Claude',
    googleAuthorizable: false,
    modelDiscovery: 'from_endpoint',
    billing: 'paid_api',
    methods: [
      {
        kind: 'api_key',
        label: 'Paste an Anthropic API key',
        requires: 'A key you create in the Anthropic Console. Usage is billed to that account.',
        page: 'https://console.anthropic.com/settings/keys',
        configured: true,
      },
    ],
    unavailable: [
      {
        label: 'Using a Claude Free, Pro or Max subscription',
        reason:
          'Anthropic states that third-party developers may not offer Claude.ai login in their ' +
          'own applications, nor route requests through Free, Pro or Max plan credentials on ' +
          'behalf of their users, nor intermediate Claude.ai credentials or session tokens. ' +
          'This is a term, not a technical gap: building it would breach it.',
        source: 'https://docs.anthropic.com/en/docs/claude-code/legal-and-compliance',
      },
    ],
  },
  {
    providerId: NINE_ROUTER_PROVIDER_ID,
    displayName: '9Router',
    googleAuthorizable: false,
    modelDiscovery: 'from_endpoint',
    billing: 'depends_on_endpoint',
    methods: [
      {
        kind: 'api_key',
        label: 'Paste a 9Router key',
        requires: 'A key from your own 9Router deployment.',
        configured: true,
      },
    ],
    unavailable: [
      {
        label: 'Authorizing with a Google account',
        reason:
          '9Router is a gateway you run yourself and it issues its own keys. It operates no ' +
          'OAuth authorization server, so there is nothing for a Google consent to authorize ' +
          'here — and a key for the gateway is not a key for the upstream vendors behind it, ' +
          'which hold their own credentials.',
        source: 'https://github.com/jamalbalya/9router',
      },
    ],
  },
];

/**
 * The matrix with the Google method's availability filled in from the build.
 *
 * `configured` is not a constant: it depends on whether a Google OAuth client
 * id was compiled into this build. The table above carries a placeholder so
 * that reading it without the build state cannot accidentally report the
 * method as available, and this function is the only thing that clears it.
 */
export function providerAuthorization(options: {
  readonly googleClientConfigured: boolean;
}): readonly ProviderAuthorization[] {
  return PROVIDER_AUTHORIZATION.map((provider) => ({
    ...provider,
    methods: provider.methods.map((method) => {
      if (method.kind !== 'google_oauth') return method;
      if (options.googleClientConfigured) {
        const { unavailableReason: _cleared, ...rest } = method;
        return { ...rest, configured: true };
      }
      return {
        ...method,
        configured: false,
        unavailableReason:
          'This build carries no Google OAuth client id, so there is nothing to authorize ' +
          'against. Paste a Gemini API key instead, or see docs/release/OWNER-CHECKLIST.md ' +
          'section G-6 for registering one.',
      };
    }),
  }));
}

/** The row for one provider, or `undefined` for a provider with no row. */
export function authorizationFor(
  providerId: string,
  options: { readonly googleClientConfigured: boolean },
): ProviderAuthorization | undefined {
  return providerAuthorization(options).find((entry) => entry.providerId === providerId);
}

/**
 * Can this provider be authorized with a Google account?
 *
 * One function so the answer cannot be re-derived differently in the panel,
 * the worker and the documentation. It is `true` for exactly one provider,
 * and a test asserts that — if a second one ever becomes Google-authorizable
 * it will be because a vendor changed something, which is worth noticing.
 */
export function isGoogleAuthorizable(providerId: string): boolean {
  return PROVIDER_AUTHORIZATION.some(
    (entry) => entry.providerId === providerId && entry.googleAuthorizable,
  );
}

/**
 * Whether connecting a Gmail address could ever enumerate a user's AI accounts.
 *
 * Always `false`, and a function rather than a comment so the answer is
 * citable from the panel and from a test. No vendor on this list offers an API
 * that, given a Google identity, returns the accounts or subscriptions that
 * identity holds elsewhere. Model discovery is a different thing and does
 * work: it happens **after** a credential exists, against that credential's
 * own endpoint.
 */
export function supportsAccountDiscoveryFromGoogleIdentity(): false {
  return false;
}
