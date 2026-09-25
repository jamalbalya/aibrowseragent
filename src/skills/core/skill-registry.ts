/**
 * The trusted skill registry.
 *
 * Everything that can run is in here, and nothing gets in without passing
 * `validateSkillDefinition` first. That is the entire trust decision: a skill
 * is trusted because it is in this registry, and it is in this registry
 * because it shipped inside the extension and was reviewed as source.
 *
 * A definition's hash is recorded on the way in and travels with every
 * invocation, but the hash is **not** what makes a skill trusted. A caller
 * that presents a hash has proved nothing — it could have computed one over
 * anything. The hash answers a narrower question: "is this the same definition
 * that was running a minute ago", which matters when a run is resumed after
 * the worker was evicted.
 *
 * There is deliberately no `registerFromJson`, no `install`, no loader that
 * takes a URL, and no path from model output to this class. Adding a skill
 * means editing source and shipping a build.
 */
import { getLogger } from '@/logging/logger';
import type { RiskLevel } from '@/policy/risk-classifier';
import {
  effectiveSkillRisk,
  skillHash,
  skillKey,
  toolsReachedBy,
  validateSkillDefinition,
  type SkillDefinition,
} from './skill-model';

const log = getLogger('agent');

/** A definition plus what the registry worked out about it. */
export interface RegisteredSkill {
  readonly definition: SkillDefinition;
  /** SHA-256 over the canonical definition, computed at registration. */
  readonly hash: string;
  /** The highest risk any step reaches, composition included. */
  readonly risk: RiskLevel;
  /** Every tool this skill can reach, composition included. */
  readonly tools: readonly string[];
  readonly registeredAt: number;
}

export class SkillRegistrationError extends Error {
  constructor(
    readonly skillId: string,
    readonly problems: readonly string[],
  ) {
    super(`Skill "${skillId}" is not registrable — ${problems.join('; ')}`);
    this.name = 'SkillRegistrationError';
  }
}

export interface SkillRegistryOptions {
  /** Whether a tool of this name is registered, and at what risk. */
  readonly riskOfTool: (name: string) => RiskLevel | undefined;
  /**
   * Whether the user has this skill switched on (P-024).
   *
   * Consulted by every read below, which is the whole enforcement: a disabled
   * skill is absent from `list`, absent from `get` and absent from `latest`,
   * so nothing downstream — the model's `skills.list`, `skills.run`, the
   * panel's launcher, a shortcut resolving its target — needs to remember to
   * check. Filtering the listing alone would leave a model able to run a
   * skill it was never shown.
   *
   * Synchronous by design. The durable state lives in
   * `SkillEnablementStore`; the worker holds the current snapshot and hands
   * it in, because a registry read happens on the dispatch path where there
   * is nothing to await into.
   *
   * **Required, with no default.** An optional predicate would mean a
   * construction site that forgot it got "everything is enabled" silently,
   * which is a permissive answer to a security question arrived at by
   * omission — the same failure `siteAuthorization` was made required to
   * avoid. A caller that genuinely has no enablement state passes
   * `ALL_SKILLS_ENABLED`, which says so at the call site where a reviewer can
   * see it.
   */
  readonly isEnabled: (id: string, version: string) => boolean;
  readonly now?: () => number;
}

/**
 * The predicate for a registry with no enablement state behind it.
 *
 * Named rather than defaulted so that "every skill is available here" is a
 * visible choice at each construction site instead of the consequence of
 * leaving a field out.
 */
export const ALL_SKILLS_ENABLED = (): boolean => true;

export class SkillRegistry {
  private readonly skills = new Map<string, RegisteredSkill>();
  private readonly now: () => number;

  constructor(private readonly options: SkillRegistryOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Validates a definition and takes it, or refuses and takes nothing.
   *
   * Asynchronous because the hash is, which is worth the small awkwardness:
   * computing it at registration means every later comparison is against a
   * value this class produced rather than one a caller supplied.
   */
  async register(definition: SkillDefinition): Promise<RegisteredSkill> {
    const key = skillKey(definition.id, definition.version);
    if (this.skills.has(key)) {
      throw new SkillRegistrationError(key, ['it is already registered']);
    }

    const problems = validateSkillDefinition(definition, {
      hasTool: (name) => this.options.riskOfTool(name) !== undefined,
      getSkill: (id, version) => this.skills.get(skillKey(id, version))?.definition,
    });
    if (problems.length > 0) throw new SkillRegistrationError(key, problems);

    const resolve = (id: string, version: string): SkillDefinition | undefined =>
      this.skills.get(skillKey(id, version))?.definition;

    const registered: RegisteredSkill = {
      definition,
      hash: await skillHash(definition),
      risk: effectiveSkillRisk(definition, this.options.riskOfTool, resolve),
      tools: toolsReachedBy(definition, resolve),
      registeredAt: this.now(),
    };

    this.skills.set(key, registered);
    log.info('Skill registered.', {
      skill: key,
      risk: registered.risk,
      tools: registered.tools.length,
    });
    return registered;
  }

  /** Registers several, stopping at the first that will not validate. */
  async registerAll(definitions: readonly SkillDefinition[]): Promise<void> {
    for (const definition of definitions) await this.register(definition);
  }

  /** The skill at exactly this version, or `undefined` — including when it is off. */
  get(id: string, version: string): RegisteredSkill | undefined {
    const entry = this.skills.get(skillKey(id, version));
    if (entry === undefined) return undefined;
    return this.enabled(id, version) ? entry : undefined;
  }

  /**
   * The registered entry whether or not the user has it switched on.
   *
   * For the settings surface, which has to show a disabled skill in order to
   * offer turning it back on. Named so that reaching for it on an execution
   * path reads as the mistake it would be: there is exactly one caller, and a
   * test asserts it.
   */
  getIncludingDisabled(id: string, version: string): RegisteredSkill | undefined {
    return this.skills.get(skillKey(id, version));
  }

  /** Every registered skill with its on/off state, for the settings surface. */
  listIncludingDisabled(): { entry: RegisteredSkill; enabled: boolean }[] {
    return this.all().map((entry) => ({
      entry,
      enabled: this.enabled(entry.definition.id, entry.definition.version),
    }));
  }

  private enabled(id: string, version: string): boolean {
    return this.options.isEnabled(id, version);
  }

  /**
   * The newest registered version of a skill.
   *
   * Used only when a caller names a skill without a version, and the version
   * it picked is then recorded on the invocation. A run never floats: it binds
   * to the exact version resolved here, so registering a newer one mid-run
   * cannot change what is executing.
   */
  latest(id: string): RegisteredSkill | undefined {
    const candidates = [...this.skills.values()]
      .filter((entry) => entry.definition.id === id)
      .filter((entry) => this.enabled(entry.definition.id, entry.definition.version))
      .sort((a, b) => compareVersions(b.definition.version, a.definition.version));
    return candidates[0];
  }

  /** The enabled skills, which is what "the skills there are" means everywhere but settings. */
  list(): RegisteredSkill[] {
    return this.all().filter((entry) =>
      this.enabled(entry.definition.id, entry.definition.version),
    );
  }

  private all(): RegisteredSkill[] {
    return [...this.skills.values()].sort((a, b) =>
      a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0,
    );
  }

  has(id: string, version: string): boolean {
    return this.get(id, version) !== undefined;
  }

  get size(): number {
    return this.skills.size;
  }
}

/** Numeric comparison, so 0.10.0 sorts above 0.9.0. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
