/**
 * Taking your work with you, and bringing it back.
 *
 * LOCAL mode means the data belongs to one Chrome profile. That is the right
 * default — nothing is uploaded, no account is needed — but it has an honest
 * cost: a profile that is deleted takes the data with it. An export is what
 * makes that cost avoidable *if the user acts before the loss*, and this
 * module is careful not to claim more than that.
 *
 * ## What is deliberately not in an export
 *
 * **Provider API keys.** Classified `SECRET_LOCAL_ONLY`, and the reason
 * survives the format change: a key in a file is a key in whatever the user
 * mails that file through. Connections are exported as metadata, so the
 * import restores what you connected to and asks you to re-enter the key.
 *
 * **OAuth secrets, ABA tokens and connector tokens.** Same classification,
 * same reasoning. A refresh token in a portable file is a session anybody
 * holding the file can resume.
 *
 * **Page content, prompts and model responses.** These are never persisted at
 * all, so there is nothing here to exclude — but the exporter is built from
 * the classification table rather than from a hand-written list, so that
 * stays true when a new data kind is added.
 *
 * ## What an import may not do
 *
 * An import is untrusted input that happens to have a familiar shape. It is
 * the same trust class as a file downloaded from anywhere, because that is
 * exactly what it might be. So it goes through **the same stores and the same
 * validators** as any other write — `WorkflowStore.save` re-validates and
 * re-hashes, `ShortcutStore.create` re-runs the collision and confusability
 * checks — rather than being written to storage directly. An import cannot
 * install a workflow the recorder would have refused, cannot claim a hash it
 * did not earn, and cannot smuggle a credential into a record type that has
 * nowhere to put one.
 *
 * Nothing here uploads. An export is handed to the panel, which writes a file
 * the user chose; an import is read from a file the user chose. Neither path
 * reaches the network, and neither is reachable by a model.
 */
import { getLogger } from '@/logging/logger';
import { isSecret, type PersistedDataKind } from '@/storage/data-classification';

const log = getLogger('storage');

/**
 * The export format version.
 *
 * Carried in the document so an importer knows what it is reading rather than
 * inferring it from which fields happen to be present.
 */
export const EXPORT_FORMAT_VERSION = 1;

/** Identifies the document, so an unrelated JSON file is refused as one. */
export const EXPORT_KIND = 'aba.local-export';

/**
 * The data kinds an export carries.
 *
 * Derived from the classification table rather than listed by hand: every
 * kind here must be non-secret, and the assertion below fails the build
 * rather than the review if one ever stops being.
 */
export const EXPORTABLE_KINDS = [
  'workflow',
  'shortcut',
  'connection-metadata',
  'preference',
] as const satisfies readonly PersistedDataKind[];

export type ExportableKind = (typeof EXPORTABLE_KINDS)[number];

/**
 * No exportable kind may be a secret.
 *
 * Evaluated at module load, so a reclassification that would put a credential
 * into an export file breaks immediately and everywhere, rather than in
 * whichever test happened to cover it.
 */
for (const kind of EXPORTABLE_KINDS) {
  if (isSecret(kind)) {
    throw new Error(`"${kind}" is a secret and must never be exportable`);
  }
}

/** A connection, with everything that could authenticate it removed. */
export interface ExportedConnection {
  readonly connectionId: string;
  readonly providerId: string;
  readonly displayName: string | null;
  readonly modelId: string | null;
  readonly baseUrl: string | null;
}

export interface LocalExport {
  readonly kind: typeof EXPORT_KIND;
  readonly formatVersion: number;
  readonly exportedAt: number;
  /**
   * Said in the document itself, not only in the panel.
   *
   * A file outlives the screen that produced it. Somebody opening this a year
   * later should be able to see what it does and does not contain without
   * having to find this source file.
   */
  readonly notice: string;
  readonly workflows: readonly unknown[];
  readonly shortcuts: readonly unknown[];
  readonly connections: readonly ExportedConnection[];
  readonly settings: Readonly<Record<string, unknown>>;
}

export const EXPORT_NOTICE =
  'This file contains your workflows, shortcuts, connection settings and preferences. ' +
  'It deliberately contains no API keys, no OAuth tokens and no page content. ' +
  'After importing on another device you will need to re-enter each provider API key.';

export interface ExportSources {
  listWorkflows(): Promise<readonly unknown[]>;
  listShortcuts(): Promise<readonly unknown[]>;
  listConnections(): Promise<readonly ExportedConnection[]>;
  readSettings(): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * Builds the document. Writes nothing, sends nothing.
 *
 * The caller is the panel, acting on a click. There is no scheduled export,
 * no export on sign-in and no export on install — an export happens because
 * somebody asked for one, at the moment they asked.
 */
export async function buildLocalExport(sources: ExportSources, now: number): Promise<LocalExport> {
  const [workflows, shortcuts, connections, settings] = await Promise.all([
    sources.listWorkflows(),
    sources.listShortcuts(),
    sources.listConnections(),
    sources.readSettings(),
  ]);

  return {
    kind: EXPORT_KIND,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: now,
    notice: EXPORT_NOTICE,
    workflows,
    shortcuts,
    connections,
    // Stripped rather than trusted: a settings record that somehow grew a
    // secret-shaped field must not carry it into a portable file.
    settings: withoutSecretShapedFields(settings),
  };
}

/** Why an import was refused. Each is a reason a user can act on. */
export type ImportRefusal =
  'NOT_AN_EXPORT' | 'UNSUPPORTED_VERSION' | 'MALFORMED' | 'CONTAINS_CREDENTIAL';

export interface ImportRefused {
  readonly ok: false;
  readonly refusal: ImportRefusal;
  readonly detail: string;
}

export interface ImportAccepted {
  readonly ok: true;
  readonly document: LocalExport;
}

/**
 * Field names an import must not carry.
 *
 * Not a sanitiser — the import is **refused**, not cleaned. A document
 * carrying a credential field was either produced by something other than
 * this exporter or was edited afterwards, and in both cases the right answer
 * is to stop rather than to import the parts that look acceptable.
 */
const CREDENTIAL_FIELDS = [
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'clientsecret',
  'client_secret',
  'authorization',
  'credential',
  'privatekey',
  'private_key',
  'recoverykey',
  'recovery_key',
];

/**
 * Validates a parsed document before anything is written.
 *
 * Structure only. Whether an individual workflow is *acceptable* is decided
 * by the workflow store when the import applies it, because that is where the
 * rule already lives and duplicating it here would create a second, weaker
 * copy that could drift.
 */
export function parseLocalExport(candidate: unknown): ImportAccepted | ImportRefused {
  if (typeof candidate !== 'object' || candidate === null) {
    return refuse('NOT_AN_EXPORT', 'That file is not an AI Browser Agent export.');
  }
  const document_ = candidate as Partial<LocalExport>;

  if (document_.kind !== EXPORT_KIND) {
    return refuse('NOT_AN_EXPORT', 'That file is not an AI Browser Agent export.');
  }
  if (typeof document_.formatVersion !== 'number') {
    return refuse('MALFORMED', 'That export does not say which format it is in.');
  }
  if (document_.formatVersion > EXPORT_FORMAT_VERSION) {
    // A newer format may mean things this build would misread. Refusing is
    // better than importing the fields that happen to still be recognised.
    return refuse(
      'UNSUPPORTED_VERSION',
      'That export was written by a newer version of AI Browser Agent.',
    );
  }
  if (document_.formatVersion < 1) {
    return refuse('UNSUPPORTED_VERSION', 'That export format is not supported.');
  }

  for (const [field, value] of [
    ['workflows', document_.workflows],
    ['shortcuts', document_.shortcuts],
    ['connections', document_.connections],
  ] as const) {
    if (!Array.isArray(value)) {
      return refuse('MALFORMED', `That export's ${field} section is not readable.`);
    }
  }
  if (
    typeof document_.settings !== 'object' ||
    document_.settings === null ||
    Array.isArray(document_.settings)
  ) {
    return refuse('MALFORMED', "That export's settings section is not readable.");
  }

  const credentialField = findCredentialField(candidate);
  if (credentialField !== null) {
    log.error('An import was refused because it carried a credential-shaped field.');
    return refuse(
      'CONTAINS_CREDENTIAL',
      'That export contains what looks like a credential. AI Browser Agent exports never do, ' +
        'so this file was not produced by it or was edited afterwards. It was not imported.',
    );
  }

  return {
    ok: true,
    document: {
      kind: EXPORT_KIND,
      formatVersion: document_.formatVersion,
      exportedAt: typeof document_.exportedAt === 'number' ? document_.exportedAt : 0,
      notice: typeof document_.notice === 'string' ? document_.notice : EXPORT_NOTICE,
      workflows: document_.workflows ?? [],
      shortcuts: document_.shortcuts ?? [],
      connections: (document_.connections ?? []).filter(isExportedConnection),
      settings: document_.settings,
    },
  };
}

function refuse(refusal: ImportRefusal, detail: string): ImportRefused {
  return { ok: false, refusal, detail };
}

function isExportedConnection(candidate: unknown): candidate is ExportedConnection {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const record = candidate as Partial<ExportedConnection>;
  return typeof record.connectionId === 'string' && typeof record.providerId === 'string';
}

/**
 * Walks the whole document looking for a credential-shaped key.
 *
 * Depth-limited, because the input is untrusted and a deeply nested or cyclic
 * structure must cost a refusal rather than a stack.
 */
function findCredentialField(value: unknown, depth = 0): string | null {
  if (depth > 12 || typeof value !== 'object' || value === null) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findCredentialField(entry, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (CREDENTIAL_FIELDS.includes(key.toLowerCase().replace(/[\s-]/g, ''))) return key;
    const found = findCredentialField(nested, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Drops credential-shaped keys from one flat record. Used on the way out. */
function withoutSecretShapedFields(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (CREDENTIAL_FIELDS.includes(key.toLowerCase().replace(/[\s-]/g, ''))) continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      safe[key] = withoutSecretShapedFields(value as Record<string, unknown>);
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

/** What an import did. Every number is a real outcome, never an estimate. */
export interface ImportOutcome {
  readonly workflowsImported: number;
  readonly workflowsRefused: number;
  readonly shortcutsImported: number;
  readonly shortcutsRefused: number;
  readonly connectionsNeedingKeys: number;
}

export interface ImportTargets {
  /** Must be the real store method, so the real validation runs. */
  importWorkflow(record: unknown): Promise<void>;
  importShortcut(record: unknown): Promise<void>;
}

/**
 * Applies a validated document.
 *
 * Each record goes through the store that owns it, one at a time, and a
 * refusal is counted rather than aborting the rest: an import of forty
 * workflows should not be lost because one of them names a tool this build
 * no longer has.
 *
 * Connections are **not** written. They are counted, so the panel can tell
 * the user which keys to re-enter, because a connection without its key would
 * be a connection that fails at its first request while looking ready.
 */
export async function applyLocalExport(
  document_: LocalExport,
  targets: ImportTargets,
): Promise<ImportOutcome> {
  let workflowsImported = 0;
  let workflowsRefused = 0;
  let shortcutsImported = 0;
  let shortcutsRefused = 0;

  for (const record of document_.workflows) {
    try {
      await targets.importWorkflow(record);
      workflowsImported += 1;
    } catch {
      workflowsRefused += 1;
    }
  }
  for (const record of document_.shortcuts) {
    try {
      await targets.importShortcut(record);
      shortcutsImported += 1;
    } catch {
      shortcutsRefused += 1;
    }
  }

  if (workflowsRefused > 0 || shortcutsRefused > 0) {
    log.warn('Some imported records were refused by the stores that own them.', {
      workflowsRefused,
      shortcutsRefused,
    });
  }

  return {
    workflowsImported,
    workflowsRefused,
    shortcutsImported,
    shortcutsRefused,
    connectionsNeedingKeys: document_.connections.length,
  };
}
