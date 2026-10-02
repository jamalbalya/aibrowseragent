/**
 * A connector whose API lives at an origin only the user knows.
 *
 * ## The problem, exactly
 *
 * Every connector so far reaches a fixed origin: `api.github.com`,
 * `api.figma.com`. The transport builds its allowlist once from
 * `descriptor.apiOrigins` and checks every request's origin against it, with
 * scheme, host **and** port all participating — *"a connector authorised for
 * `https://api.example` is not authorised for `http://api.example` or for
 * `https://api.example:8443`."*
 *
 * Jira Cloud does not fit. Its API base is the customer's own site —
 * `https://your-team.atlassian.net/rest/api/3/…` — so the origin is a fact
 * about the credential, not about the connector. That is why Jira has been
 * recorded as unimplemented rather than attempted: `apiOrigins` is fixed when
 * a descriptor is registered, and the obvious fixes are both wrong. A wildcard
 * origin would let one credential authorise any host; resolving the origin from
 * a *request* would let the caller choose where the credential goes, which is
 * the single decision the transport exists to keep.
 *
 * ## The rule this module implements
 *
 * **The origin is bound to the credential, and a request must match the
 * binding exactly.** Two independent checks, both of which must pass, and
 * neither of which a caller can influence:
 *
 *  1. **At connect time**, the site the user typed is parsed and must satisfy
 *     every clause of `parseBoundSite` below. It is stored *with* the
 *     credential, by the only code that writes credentials.
 *  2. **At request time**, the transport's existing `assertDeclared` runs
 *     unchanged against an allowlist of exactly **one** origin — the bound
 *     one. Scheme, host and port still all participate.
 *
 * That is strictly stronger than the fixed case rather than weaker. A fixed
 * descriptor may declare several origins; a bound one permits exactly the one
 * the credential was saved against. And because the binding travels with the
 * credential, replacing the site means replacing the credential: a token saved
 * for one site can never be sent to another, which is the adversarial case
 * that matters most for a multi-tenant host.
 *
 * ## What is deliberately refused
 *
 * **Anything but `*.atlassian.net`.** Jira Data Center runs on arbitrary
 * customer hosts, and supporting it would mean accepting any origin a user
 * typed — the wildcard this module exists to avoid. So Cloud only, and the
 * suffix is a property of the descriptor rather than of the user's input.
 *
 * **Any port, any path, any query, any fragment, any credentials in the URL,
 * any userinfo.** An origin is a scheme, a host and a port; a "site" that
 * carried a path would make `assertDeclared` compare one thing and the request
 * build another.
 *
 * **Plain http, always.** There is no loopback exception here. A local model
 * runner is a thing that exists; a loopback Jira Cloud is not, and an
 * exception nobody needs is an exception somebody will use.
 */

/** What a descriptor says about the site its credential will be bound to. */
export interface SiteBinding {
  /**
   * The exact host suffix a site must end with, including the leading dot.
   *
   * A suffix and not a pattern. `.atlassian.net` matches
   * `team.atlassian.net` and refuses `atlassian.net.evil.test`, because the
   * check is on the end of the hostname and the hostname is what the URL
   * parser produced — not on a substring of the string the user typed.
   */
  readonly hostSuffix: string;
  /** Shown above the field. "Your Jira site". */
  readonly label: string;
  /** Shown as the placeholder. Never used as a default. */
  readonly example: string;
}

export type SiteRefusal =
  | 'EMPTY'
  | 'UNPARSEABLE'
  | 'NOT_HTTPS'
  | 'HAS_PORT'
  | 'HAS_PATH'
  | 'HAS_QUERY_OR_FRAGMENT'
  | 'HAS_USERINFO'
  | 'WRONG_HOST'
  | 'HOST_NOT_A_SUBDOMAIN';

export type SiteParse =
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly refusal: SiteRefusal; readonly message: string };

/**
 * Turns what the user typed into the one origin their credential may reach.
 *
 * Every clause is a refusal rather than a repair. A parser that helpfully
 * stripped a path, or added a scheme, or lowercased a host it had not
 * validated, would be deciding on the user's behalf where their credential
 * goes — and the whole value of binding the origin is that nobody decides that
 * except the person who typed it and this function.
 *
 * The returned value is `URL.origin`, which is the same string
 * `assertDeclared` compares a request against. Producing it here, from a
 * parsed URL, is what makes the two sides of the check the same kind of thing.
 */
export function parseBoundSite(input: string, binding: SiteBinding): SiteParse {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, refusal: 'EMPTY', message: 'Enter your site address.' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Deliberately not retried with `https://` prepended. A string that is not
    // a URL is a typo, and guessing at it is how `https://evil.test` becomes
    // `https://https//evil.test` or worse.
    return {
      ok: false,
      refusal: 'UNPARSEABLE',
      message: `That is not a web address. It should look like ${binding.example}`,
    };
  }

  if (url.protocol !== 'https:') {
    // No loopback exception, unlike the AI provider path. A local model runner
    // is a real thing; a loopback Jira Cloud is not.
    return {
      ok: false,
      refusal: 'NOT_HTTPS',
      message: 'The address must start with https://. An API token is only ever sent over https.',
    };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return {
      ok: false,
      refusal: 'HAS_USERINFO',
      message: 'Remove the username or password from the address.',
    };
  }
  if (url.port.length > 0) {
    return {
      ok: false,
      refusal: 'HAS_PORT',
      message: 'Remove the port. A Jira Cloud site is reached on the default https port.',
    };
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    return {
      ok: false,
      refusal: 'HAS_PATH',
      message: `Enter only the site address, with no path after it — like ${binding.example}`,
    };
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return {
      ok: false,
      refusal: 'HAS_QUERY_OR_FRAGMENT',
      message: `Enter only the site address — like ${binding.example}`,
    };
  }

  // On the hostname the parser produced, never on the string the user typed.
  // `https://evil.test/?x=team.atlassian.net` has the suffix in its text and
  // not in its host, and `https://atlassian.net.evil.test` has it in the
  // middle — the first is refused above and the second here.
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(binding.hostSuffix)) {
    return {
      ok: false,
      refusal: 'WRONG_HOST',
      message: `The address must be a ${binding.hostSuffix.replace(/^\./, '')} site — like ${binding.example}`,
    };
  }
  // A suffix match alone would accept the bare apex. There is no API there,
  // and accepting it would bind a credential to a host shared by everybody.
  const label = host.slice(0, -binding.hostSuffix.length);
  if (label.length === 0 || label.includes('.')) {
    return {
      ok: false,
      refusal: 'HOST_NOT_A_SUBDOMAIN',
      message: `Enter your own site — like ${binding.example}`,
    };
  }

  return { ok: true, origin: url.origin };
}
