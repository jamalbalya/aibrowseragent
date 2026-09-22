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
 * in every direction that matters: an undecided user uploads nothing, a local
 * user uploads nothing, and a secret uploads nothing whatever the mode says.
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

  // Device-scoped and meaningless elsewhere.
  evidence: 'LOCAL_ONLY',
  'persistence-health': 'LOCAL_ONLY',
  policy: 'LOCAL_ONLY',
  'device-id': 'LOCAL_ONLY',
};

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

/** Where the user asked their data to live. `undecided` uploads nothing. */
export const DATA_STORAGE_MODES = ['local', 'cloud', 'undecided'] as const;
export type DataStorageMode = (typeof DATA_STORAGE_MODES)[number];

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
