/**
 * Where MCP servers the user added live (P-026).
 *
 * A stored record is the whole of what this build knows about a server before it
 * connects, so the store owns two properties.
 *
 * **Identity is stable and unique.** A server id becomes part of every tool name
 * it contributes, so two servers must never collapse into one id: a collision is
 * refused rather than resolved, because the alternative is a task calling
 * `mcp__docs__search` and reaching whichever server was written last.
 *
 * **A record holds no credential, and has nowhere to put one.** The descriptor
 * is an id, a display name and an address. `validateServerDescriptor` produces
 * exactly those three fields, and `isStorableServer` refuses anything that grew
 * a fourth — so a record cannot acquire a token by being written through some
 * other path, and `mcp-server` can be `PLAINTEXT_BY_DESIGN` without that being
 * a claim the implementation fails to make. Server authentication, if it is ever
 * added, is a different kind with its own classification.
 *
 * Nothing here connects to anything. Adding, listing and removing a server are
 * storage operations; discovery and dispatch happen elsewhere, and a server that
 * is stored has been *named*, not trusted.
 */
import type { TransactionalStorageArea } from '@/storage/storage-area';
import { RecordStore } from '@/storage/record-store';
import type { PersistenceHealthStore } from '@/storage/persistence-health';
import { validateServerDescriptor, type McpServerDescriptor } from './mcp-model';

/**
 * How many servers may be stored.
 *
 * Bounded because each one contributes up to `MAX_TOOLS` names to the model's
 * context, so the product of the two is the real surface: sixteen servers at
 * sixty-four tools is already more tools than any model uses well.
 */
export const MAX_SERVERS = 16;

/** The exact field set a stored record may have. */
const ALLOWED_FIELDS: readonly string[] = ['id', 'displayName', 'url'];

export const MCP_SERVER_FORMAT_VERSION = 1;

/**
 * Accepts a stored record, or does not.
 *
 * Runs the same validator that admitted it, and then asserts the field set — so
 * a record that gained a field in storage is dropped rather than read. Dropped
 * and never repaired: a half-understood server descriptor is one that could
 * resolve to the wrong endpoint.
 */
export function isStorableServer(candidate: unknown): candidate is McpServerDescriptor {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const keys = Object.keys(candidate);
  if (keys.length !== ALLOWED_FIELDS.length) return false;
  if (!keys.every((key) => ALLOWED_FIELDS.includes(key))) return false;
  return validateServerDescriptor(candidate).ok;
}

export type McpServerRefusal =
  | 'INVALID'
  /** The id is taken. Refused, never renamed: an id is part of a tool name. */
  | 'ID_TAKEN'
  | 'TOO_MANY'
  | 'NOT_FOUND';

export class McpServerError extends Error {
  constructor(
    readonly reason: McpServerRefusal,
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(message);
    this.name = 'McpServerError';
  }
}

export interface McpServerStoreOptions {
  readonly area: TransactionalStorageArea;
  readonly health?: PersistenceHealthStore;
}

export class McpServerStore {
  private readonly records: RecordStore<McpServerDescriptor>;

  constructor(options: McpServerStoreOptions) {
    this.records = new RecordStore<McpServerDescriptor>({
      area: options.area,
      kind: 'mcp-servers',
      version: MCP_SERVER_FORMAT_VERSION,
      identify: (record) => record.id,
      validate: isStorableServer,
      max: MAX_SERVERS,
      ...(options.health === undefined ? {} : { health: options.health }),
    });
  }

  async list(): Promise<readonly McpServerDescriptor[]> {
    return this.records.list();
  }

  async get(id: string): Promise<McpServerDescriptor | undefined> {
    return this.records.get(id);
  }

  /**
   * Adds a server, or refuses.
   *
   * Nothing is contacted. A stored server is one the user named; whether it
   * answers, and what it offers, is discovery's question and is asked every time
   * rather than recorded here.
   */
  async add(input: {
    readonly id?: unknown;
    readonly displayName?: unknown;
    readonly url?: unknown;
  }): Promise<McpServerDescriptor> {
    const verdict = validateServerDescriptor(input);
    if (!verdict.ok) {
      throw new McpServerError(
        'INVALID',
        'That server cannot be added as described.',
        verdict.problems,
      );
    }

    const existing = await this.list();
    if (existing.length >= MAX_SERVERS) {
      throw new McpServerError('TOO_MANY', `There is room for ${MAX_SERVERS} MCP servers.`);
    }
    // Refused rather than renamed or merged. An id is part of every tool name
    // the server contributes, so silently resolving a collision would point a
    // task's existing tool at a different endpoint.
    if (existing.some((record) => record.id === verdict.server.id)) {
      throw new McpServerError(
        'ID_TAKEN',
        `A server called "${verdict.server.id}" already exists. Remove it first, or choose ` +
          'another id.',
      );
    }

    await this.records.put(verdict.server);
    return verdict.server;
  }

  /**
   * Removes a server.
   *
   * Its tools stop existing with it: they are built from the record at
   * registration and nothing persists a tool, so there is no residual grant to
   * revoke. That is the point of the risk model rather than an accident — see
   * `docs/MCP_GUIDE.md` §5.3.
   */
  async remove(id: string): Promise<void> {
    const existing = await this.get(id);
    if (existing === undefined) {
      throw new McpServerError('NOT_FOUND', `There is no MCP server called "${id}".`);
    }
    await this.records.remove(id);
  }
}
