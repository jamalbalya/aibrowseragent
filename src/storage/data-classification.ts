/**
 * What may leave this device, and under which setting.
 *
 * The product requirement is that every persistent data type is classified and
 * that none is left ambiguous. A prose table in a document satisfies neither
 * half of that: it cannot be enforced and it cannot fail. This is the same
 * table as a total `Record`, so a data kind added without a classification is
 * a compile error rather than an omission nobody notices until it has been
 * uploaded.
 *
 * `cloudEligible` is the single question any sync path asks. It fails closed
 * in every direction that matters: a local user uploads nothing, a legacy
 * undecided record uploads nothing, and a secret uploads nothing whatever the
 * mode says. Local is the default, so the closed direction is also the one a
 * fresh installation is already in.
 */

/** The six classifications, exactly as the requirement names them. */
export const DATA_CLASSES = [
  'LOCAL_ONLY',
  'CLOUD_SYNCED',
  'USER_SELECTABLE',
  'NEVER_PERSISTED',
  'SECRET_LOCAL_ONLY',
  'SECRET_RECOVERABLE_ONLY_IF_SECURE_DESIGN_EXISTS',
] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** Every kind of thing this extension persists or deliberately refuses to. */
export const PERSISTED_DATA_KINDS = [
  'provider-credential',
  'connector-token',
  'aba-refresh-token',
  'aba-access-token',
  'oauth-transient',
  'identity-profile',
  'connection-metadata',
  'ai-brain',
  'task',
  'workflow',
  'shortcut',
  'preference',
  'audit',
  'evidence',
  'persistence-health',
  'policy',
  'device-id',
  'page-content',
  /**
   * Browser workspaces. Persisted since workspaces existed, and absent from
   * this table until the portability audit went looking for them — which is
   * the failure mode a total table is supposed to prevent and did not, because
   * nothing forced a new *store* to declare a kind here.
   */
  'workspace',
  /** Skill run progress records, reconciled after a worker restart. */
  'skill-run',
] as const;
export type PersistedDataKind = (typeof PERSISTED_DATA_KINDS)[number];

/**
 * The classification table.
 *
 * Total by construction: `Record<PersistedDataKind, DataClass>` means a new
 * kind does not compile until it has been classified here, which is the only
 * way "nothing is ambiguous" stays true after this commit.
 */
export const DATA_CLASSIFICATION: Readonly<Record<PersistedDataKind, DataClass>> = {
  // Never uploaded, encrypted or otherwise. The backend is not a custodian of
  // the user's paid provider credentials, and making it one would expand the
  // blast radius of any breach to every key every user owns.
  'provider-credential': 'SECRET_LOCAL_ONLY',
  'connector-token': 'SECRET_LOCAL_ONLY',
  'aba-refresh-token': 'SECRET_LOCAL_ONLY',

  // Memory only. Gone when the browser closes, by design.
  'aba-access-token': 'NEVER_PERSISTED',
  // PKCE verifier, state, nonce: single-use, TTL-bounded, memory-backed.
  'oauth-transient': 'NEVER_PERSISTED',
  // Prompts, page text and screenshots never reach the ABA backend under any
  // setting. Cloud Sync existing does not make this negotiable.
  'page-content': 'NEVER_PERSISTED',

  // The backend is the authority for identity, so this is not optional.
  'identity-profile': 'CLOUD_SYNCED',

  // The user chooses. None of these carries a credential.
  'connection-metadata': 'USER_SELECTABLE',
  'ai-brain': 'USER_SELECTABLE',
  task: 'USER_SELECTABLE',
  workflow: 'USER_SELECTABLE',
  shortcut: 'USER_SELECTABLE',
  preference: 'USER_SELECTABLE',
  audit: 'USER_SELECTABLE',

  // Tab origins and titles the user put in a workspace: their data, and the
  // same class as `task`, which already carries tab context.
  workspace: 'USER_SELECTABLE',

  // Device-scoped and meaningless elsewhere.
  'skill-run': 'LOCAL_ONLY',
  evidence: 'LOCAL_ONLY',
  'persistence-health': 'LOCAL_ONLY',
  policy: 'LOCAL_ONLY',
  'device-id': 'LOCAL_ONLY',
};

/**
 * Portability: may this kind travel in a user-controlled export file?
 *
 * A **different question** from `cloudEligible`, and kept as its own table
 * because conflating them would be wrong in both directions. Cloud eligibility
 * asks whether a server the user trusts may hold something. Portability asks
 * whether a file the user might email, sync through a third-party drive, or
 * restore onto a machine that is not theirs may contain it — and whether the
 * importing installation can take it without taking something else with it.
 *
 * Total over `PersistedDataKind` for the same reason the classification is: a
 * new kind does not compile until somebody has decided whether it travels.
 */
export const PORTABILITY_CLASSES = [
  /** Travels as-is. */
  'PORTABLE',
  /** Travels only after fields are dropped or rewritten on the way out. */
  'PORTABLE_AFTER_TRANSFORMATION',
  /** Meaningful only on the installation that wrote it. */
  'LOCAL_ONLY',
  /** Excluded on purpose, and not a gap waiting to be filled. */
  'NOT_PORTABLE_BY_DESIGN',
  /** Might travel one day; nobody has done the security work yet. */
  'REQUIRES_FURTHER_SECURITY_DESIGN',
] as const;
export type PortabilityClass = (typeof PORTABILITY_CLASSES)[number];

export const EXPORT_PORTABILITY: Readonly<Record<PersistedDataKind, PortabilityClass>> = {
  // Secrets. A key in a file is a key in whatever the file is mailed through,
  // and no transformation makes that acceptable.
  'provider-credential': 'NOT_PORTABLE_BY_DESIGN',
  'connector-token': 'NOT_PORTABLE_BY_DESIGN',
  'aba-refresh-token': 'NOT_PORTABLE_BY_DESIGN',
  'aba-access-token': 'NOT_PORTABLE_BY_DESIGN',
  'oauth-transient': 'NOT_PORTABLE_BY_DESIGN',
  'page-content': 'NOT_PORTABLE_BY_DESIGN',

  // Evidence is a payload plus an HMAC digest under a per-task salt. Carrying
  // the digest without the salt proves nothing; carrying the salt exports
  // private cryptographic material.
  evidence: 'NOT_PORTABLE_BY_DESIGN',

  // Site rules are consent, not preference. An imported one would be an
  // archive granting itself permission to automate a site — policy injection
  // in the most literal sense.
  policy: 'NOT_PORTABLE_BY_DESIGN',

  // Health *gates execution*. A `HEALTHY` record from another device would be
  // an archive clearing this device's own safety interlock: replay of stale
  // security state, and the clearest authorization bypass in this table.
  'persistence-health': 'NOT_PORTABLE_BY_DESIGN',

  // Identity. Exporting either is how two installations come to claim one
  // owner, and neither authorises anything on the device that receives it —
  // so there is nothing to gain and an identity collision to lose.
  'identity-profile': 'LOCAL_ONLY',
  'device-id': 'LOCAL_ONLY',

  // Names a `connectionId` whose credential deliberately does not travel, so
  // a restored pointer would select an account that cannot run. The importing
  // installation chooses its own brain from the accounts it actually has.
  'ai-brain': 'LOCAL_ONLY',

  // Progress through a run on a worker generation that no longer exists,
  // naming a task id this installation does not have.
  'skill-run': 'LOCAL_ONLY',

  // Has its own scoped, user-initiated export route. The trail is a hash
  // chain anchored to this installation; re-anchoring it elsewhere would
  // produce a record that verifies while describing decisions this device
  // never made.
  audit: 'LOCAL_ONLY',

  // What the export carries today.
  workflow: 'PORTABLE',
  shortcut: 'PORTABLE',
  // Metadata only: the five fields that say what you connected to, never how
  // you authenticate. The transformation is applied by the exporter.
  'connection-metadata': 'PORTABLE_AFTER_TRANSFORMATION',
  // The portable allowlist, not the whole settings record: `permissionMode`
  // and `allowInsecureOrigins` are security posture and stay behind.
  preference: 'PORTABLE_AFTER_TRANSFORMATION',

  /*
   * The two the portability audit deliberately left where they were.
   *
   * A task carries page-derived tab context, a monotone taint state, a
   * per-task HMAC salt and evidence ids. Exporting one would put browsing
   * content in a portable file, and importing one would ask an installation
   * to accept a taint state it never measured and evidence ids that resolve
   * to nothing — a taint downgrade dressed as a restore. The salt alone puts
   * it out of reach without a design.
   */
  task: 'REQUIRES_FURTHER_SECURITY_DESIGN',
  /*
   * A workspace's members are tab origins and titles — browsing history in a
   * file the user may mail — and `workspaceId` is the boundary tasks are
   * bound to, so an imported one would name a Chrome tab group that does not
   * exist. Neither is unsolvable; neither has been solved.
   */
  workspace: 'REQUIRES_FURTHER_SECURITY_DESIGN',
};

/**
 * The kinds an export may carry, derived rather than listed.
 *
 * `data-export.ts` imports this instead of keeping its own list, so the
 * portability decision lives in exactly one place and a kind reclassified
 * here changes what the exporter does without anybody editing the exporter.
 */
export const PORTABLE_DATA_KINDS: readonly PersistedDataKind[] = PERSISTED_DATA_KINDS.filter(
  (kind) =>
    EXPORT_PORTABILITY[kind] === 'PORTABLE' ||
    EXPORT_PORTABILITY[kind] === 'PORTABLE_AFTER_TRANSFORMATION',
);

/**
 * Does a design exist for recovering a secret to another device?
 *
 * It does not. End-to-end encryption under a user passphrase would make one
 * possible, and until that is built and reviewed, anything classified
 * `SECRET_RECOVERABLE_ONLY_IF_SECURE_DESIGN_EXISTS` is treated exactly like
 * `SECRET_LOCAL_ONLY`.
 *
 * A constant rather than a comment so that enabling it is one reviewable line
 * with a test attached, instead of a scattering of conditions.
 */
export const SECURE_CREDENTIAL_RECOVERY_EXISTS = false;

/**
 * Where the user asked their data to live.
 *
 * `undecided` is a **legacy persisted value**, not a runtime state. Builds
 * before the local-first correction defaulted to it, and those records still
 * exist in real profiles, so the parser must still understand it. Nothing
 * reads it as a mode: `resolveStorageMode` maps it to `local`, which is what
 * it always behaved as anyway — it uploaded nothing.
 *
 * Keeping it readable rather than deleting it is the difference between
 * upgrading a profile and discarding one.
 */
export const DATA_STORAGE_MODES = ['local', 'cloud', 'undecided'] as const;
export type DataStorageMode = (typeof DATA_STORAGE_MODES)[number];

/**
 * The two modes that actually exist at run time.
 *
 * LOCAL is the product default and the only mode a fresh installation can be
 * in. CLOUD is reachable only by an explicit choice the user makes, and this
 * type is what makes "there is no third state" checkable rather than stated.
 */
export const STORAGE_MODES = ['local', 'cloud'] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

/**
 * The mode a fresh installation runs in.
 *
 * Local-first is the product, not a fallback: the extension performs every
 * browser-agent operation against `chrome.storage` alone, with no account, no
 * backend and no database. Cloud is an addition somebody opts into later.
 */
export const DEFAULT_STORAGE_MODE: StorageMode = 'local';

/**
 * Collapses anything that could be stored into one of the two real modes.
 *
 * Every branch that is not an explicit, well-formed `cloud` resolves to
 * `local`. That direction is deliberate and is the whole safety property:
 * a corrupt byte, a truncated write, a value from a future build or a legacy
 * `undecided` all mean *do not upload*, because the alternative is enrolling
 * somebody into remote storage on the strength of damaged state.
 */
export function resolveStorageMode(stored: unknown): StorageMode {
  return stored === 'cloud' ? 'cloud' : DEFAULT_STORAGE_MODE;
}

/**
 * May this kind of data be uploaded under this setting?
 *
 * The only place that question is answered. Every branch that is not an
 * explicit yes is a no, so a kind whose handling was never considered is
 * refused rather than defaulting to upload.
 */
export function cloudEligible(kind: PersistedDataKind, mode: DataStorageMode): boolean {
  // Nothing leaves until the user has actually chosen cloud. `undecided` is
  // not a soft yes, and silence is not consent.
  if (mode !== 'cloud') return false;

  switch (DATA_CLASSIFICATION[kind]) {
    case 'CLOUD_SYNCED':
    case 'USER_SELECTABLE':
      return true;
    case 'SECRET_RECOVERABLE_ONLY_IF_SECURE_DESIGN_EXISTS':
      return SECURE_CREDENTIAL_RECOVERY_EXISTS;
    case 'LOCAL_ONLY':
    case 'NEVER_PERSISTED':
    case 'SECRET_LOCAL_ONLY':
      return false;
  }
}

/** Is this a secret, whatever its recoverability? Never logged, never shown. */
export function isSecret(kind: PersistedDataKind): boolean {
  const classification = DATA_CLASSIFICATION[kind];
  return (
    classification === 'SECRET_LOCAL_ONLY' ||
    classification === 'SECRET_RECOVERABLE_ONLY_IF_SECURE_DESIGN_EXISTS'
  );
}

/**
 * What a restored account can promise about its credential.
 *
 * Cloud restore brings back connection metadata and cannot bring back the key.
 * Saying so is better than losing the connection, and far better than
 * presenting one that will fail at its first request.
 */
export const CREDENTIAL_RECONNECT_NOTICE =
  'This connection was restored, but its API key needs to be reconnected on this device.';
