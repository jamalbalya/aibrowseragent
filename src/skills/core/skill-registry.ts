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
  readonly now?: () => number;
}

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

  /** The skill at exactly this version, or `undefined`. */
  get(id: string, version: string): RegisteredSkill | undefined {
    return this.skills.get(skillKey(id, version));
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
      .sort((a, b) => compareVersions(b.definition.version, a.definition.version));
    return candidates[0];
  }

  list(): RegisteredSkill[] {
    return [...this.skills.values()].sort((a, b) =>
      a.definition.id < b.definition.id ? -1 : a.definition.id > b.definition.id ? 1 : 0,
    );
  }

  has(id: string, version: string): boolean {
    return this.skills.has(skillKey(id, version));
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
