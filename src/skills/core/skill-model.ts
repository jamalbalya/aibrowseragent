/**
 * What a skill is, and — more importantly — what it cannot be.
 *
 * A skill is a reusable workflow: an ordered list of steps, each naming a tool
 * that is already registered, with arguments assembled from values the
 * definition states and outputs earlier steps produced.
 *
 * It is **structured data**. There is no expression language here, no template
 * interpolation, no callback, no string that is ever parsed as code. A step
 * cannot say "run this JavaScript", because there is nowhere in these types to
 * put JavaScript and nothing that would execute it if there were. That is the
 * whole design: the absence of a scripting engine is not a policy that could be
 * relaxed, it is a shape the data does not have.
 *
 * What a skill therefore cannot do follows from where it executes rather than
 * from any check written here. Every step goes through `ToolRegistry.dispatch`,
 * which is the one path from a proposed call to a real effect — so a skill gets
 * schema validation, risk classification, policy, the permission prompt, the
 * egress gate, sanitisation and evidence, and gets them per step. A skill has
 * no way to reach the network, the filesystem or a credential except by naming
 * a tool that already has that ability and already guards it.
 *
 * A skill definition is also not authorization. Declaring `requiredTools` or a
 * risk level describes what the skill intends; it grants nothing. The decision
 * still comes from the registry, the policy engine and the user.
 */
import { hashContent } from '@/evidence/evidence-model';
import { RISK_LEVELS, maxRisk, type RiskLevel } from '@/policy/risk-classifier';

/** Hard structural limits. A skill that exceeds one is unregistrable. */
export const MAX_STEPS_PER_SKILL = 24;
export const MAX_COMPOSITION_DEPTH = 3;
export const MAX_BINDING_PATH_SEGMENTS = 6;
export const MAX_SKILL_INPUTS = 12;

/**
 * How one argument to one step is produced.
 *
 * Three sources, all of them data:
 *
 *  - `literal` — a value written in the definition by whoever authored it.
 *  - `input` — a value the caller supplied when invoking the skill.
 *  - `step` — a value an earlier step returned, addressed by a plain path.
 *
 * There is deliberately no fourth. No concatenation, no arithmetic, no
 * conditional, no format string. Every one of those would be a small language,
 * and a small language is the thing that grows into an interpreter.
 */
export type SkillBinding =
  | { readonly kind: 'literal'; readonly value: unknown }
  | { readonly kind: 'input'; readonly name: string }
  | {
      readonly kind: 'step';
      /** The `id` of an earlier step in the same skill. */
      readonly step: string;
      /** Dotted path into that step's result, e.g. `handles.0.id`. */
      readonly path: string;
    }
  | ElementBinding;

/**
 * An element handle, re-resolved against a page read at run time.
 *
 * The fourth binding, and the only one added since P-024. It exists because
 * an element handle is **unrecordable**: `elementId` is minted by one
 * `browser.read_page` in one task and is deliberately refused once stale, so
 * a workflow that stored one would be a workflow that could never replay. The
 * alternatives were a positional index, which is silently wrong the moment a
 * page changes, or recording no interactions at all.
 *
 * It is data, not a language. `role` and `name` are compared literally
 * against the semantic page model — there is no selector syntax, no pattern,
 * no expression, and nothing here is ever passed to the DOM or evaluated.
 * That matters: a CSS or XPath field would have been a hidden execution
 * language wearing a declarative hat.
 *
 * Every ambiguity fails closed. See `resolveElement` in the runner for what
 * "closed" means at each point.
 */
export interface ElementBinding {
  readonly kind: 'element';
  /**
   * Where the role and name came from, permanently.
   *
   * `PAGE_DERIVED` means these strings were read out of a page's
   * accessibility model. `AUTHORED` means a person wrote them into a bundled
   * definition. The two are the same bytes and a different fact, which is why
   * provenance is recorded at the point of origin rather than inferred from
   * the value: an ARIA-valid role read from a page is page-derived, and an
   * identical one typed by a build author is not.
   *
   * Nothing promotes `PAGE_DERIVED` to `AUTHORED`, and nothing derives
   * `KNOWN_UNTAINTED` from it. Passing ARIA validation, secret detection, a
   * length check, a shape check or a uniqueness check gates **whether the
   * binding may be stored at all** — semantic validity. It never touches
   * provenance, which is an independent property.
   *
   * Required and non-optional so an untagged page-derived binding cannot be
   * represented: there is no default to fall through to.
   */
  readonly provenance: BindingProvenance;
  /**
   * The single sanctioned use of this data.
   *
   * It exists so the tag is a rule rather than a description: a
   * `PAGE_DERIVED` value may be persisted only as the match predicate of a
   * binding carrying this purpose, and the store refuses one anywhere else.
   * There is exactly one purpose and no way to add another at run time.
   */
  readonly purpose: 'ELEMENT_BINDING';
  /** The step whose `browser.read_page` result is searched. */
  readonly step: string;
  /** ARIA role, compared exactly. */
  readonly role: string;
  /** Accessible name, compared exactly after trimming. */
  readonly name: string;
  /**
   * Which match to take, in the page model's own document order.
   *
   * Omitted means "there must be exactly one". Supplying it is how a caller
   * says a duplicate is expected and which one is meant; it never turns an
   * ambiguous match into a guess.
   */
  readonly nth?: number;
  /** Refuses a match that is not this kind of control, when it matters. */
  readonly expect?: 'enabled' | 'visible' | 'editable';
}

/**
 * Where a binding's match data came from. Assigned at origin, never changed.
 *
 * Deliberately **not** a fourth state in the task taint lattice. Taint
 * (`KNOWN_UNTAINTED` / `TAINTED` / `UNKNOWN`) is a property of a task and is
 * compared everywhere; adding a state to it would make every one of those
 * comparisons a question again. This is a separate, narrower property of one
 * field of one binding type, checked by the code that stores and resolves it
 * and by nothing else.
 */
export type BindingProvenance = 'AUTHORED' | 'PAGE_DERIVED';

export type SkillInputType = 'string' | 'number' | 'boolean';

/**
 * One value a caller must or may supply.
 *
 * Constrained here as well as by the tool's own schema. The tool schema is
 * authoritative and runs anyway; this exists so a skill can be narrower than
 * the tools it uses — a skill that only ever files issues in one repository
 * should not accept an arbitrary repository just because the tool would.
 */
export interface SkillInput {
  readonly name: string;
  readonly type: SkillInputType;
  readonly description: string;
  readonly required: boolean;
  readonly maxLength?: number;
  /** When present, the value must be one of these. */
  readonly enum?: readonly string[];
}

export interface SkillOutput {
  readonly name: string;
  readonly description: string;
  /** The step whose result supplies it, and the path within that result. */
  readonly step: string;
  readonly path: string;
}

/**
 * One step.
 *
 * `kind: 'tool'` names a registered tool. `kind: 'skill'` composes another
 * registered skill, pinned to an exact version — composition that floated to
 * "whatever is current" would mean a skill's behaviour could change without
 * the skill changing.
 */
export type SkillStep =
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly tool: string;
      readonly description: string;
      readonly arguments: Readonly<Record<string, SkillBinding>>;
      /** A failure here does not abort the run. Default false. */
      readonly optional?: boolean;
    }
  | {
      readonly kind: 'skill';
      readonly id: string;
      readonly skill: string;
      readonly skillVersion: string;
      readonly description: string;
      readonly arguments: Readonly<Record<string, SkillBinding>>;
      readonly optional?: boolean;
    };

export interface SkillDefinition {
  readonly id: string;
  /** Semantic version. An invocation binds to exactly one. */
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly inputs: readonly SkillInput[];
  readonly outputs: readonly SkillOutput[];
  readonly steps: readonly SkillStep[];
  /**
   * Every tool this skill may reach, stated rather than inferred.
   *
   * Redundant with the steps on purpose: a reviewer reads one list instead of
   * every step, and a step that reaches a tool the author did not declare
   * fails registration. Least privilege is only checkable if the intended
   * privilege is written down.
   */
  readonly requiredTools: readonly string[];
  /** Connectors this skill needs. Declaration, never authorization. */
  readonly requiredConnectors: readonly string[];
  /**
   * The risk the author claims.
   *
   * A floor, not a cap. The effective risk of a run is the highest of this and
   * every tool it invokes, so understating it here makes a skill stricter to
   * approve rather than laxer.
   */
  readonly risk: RiskLevel;
  /** Where this definition came from. Only `bundled` is trusted to execute. */
  readonly provenance: SkillProvenance;
  /** Free text shown to the user before approval. Never executed. */
  readonly instructions?: string;
}

/**
 * Where a definition came from.
 *
 * `bundled` means it shipped inside the extension and was reviewed as source.
 * Everything else exists so an untrusted definition has somewhere to be
 * *named* while being refused — a proposal the model wrote is a
 * `SkillDefinition`-shaped object, and it must be possible to hold one without
 * it being executable.
 */
export type SkillProvenance = 'bundled' | 'recorded' | 'model_proposed' | 'imported' | 'unknown';

/** The only provenance the registry will accept. */
export const TRUSTED_PROVENANCE: SkillProvenance = 'bundled';

/**
 * Capability names a skill may never claim.
 *
 * These do not correspond to anything the permission system grants, so a skill
 * asking for one is either confused or trying its luck. Refusing at
 * registration means neither reaches a user as a prompt saying "this skill
 * requires admin", which is exactly the prompt someone clicks through.
 */
export const FORBIDDEN_CAPABILITY_NAMES: readonly string[] = [
  'admin',
  'administrator',
  'root',
  'superuser',
  'sudo',
  'bypass',
  'bypass_policy',
  'bypass_consent',
  'bypass_egress',
  'skip_policy',
  'skip_permission',
  'all',
  'all_tools',
  'any',
  'unrestricted',
  'full_access',
  '*',
];

/** Path segments that would reach the prototype chain rather than data. */
const FORBIDDEN_PATH_SEGMENTS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const PATH_PATTERN = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

/** What the validator needs to know about the world around a definition. */
export interface SkillValidationContext {
  /** Whether a tool of this name is registered. */
  readonly hasTool: (name: string) => boolean;
  /** An already-registered skill at this exact version, for composition. */
  readonly getSkill?: (id: string, version: string) => SkillDefinition | undefined;
  /**
   * Which provenances this caller will accept.
   *
   * Defaults to `bundled` alone, which is what `SkillRegistry` passes — a
   * registered skill is model-invokable through `skills.list`, so only
   * definitions a human reviewed as source belong there.
   *
   * The workflow store passes `recorded` instead. That is not a relaxation:
   * a recording is never registered, never listed and never model-invokable,
   * and it authorises nothing, because replay re-adjudicates every step.
   * Model-written, imported and unknown definitions are accepted by neither.
   */
  readonly allowProvenance?: readonly SkillProvenance[];
}

/**
 * Checks a definition before it can be registered.
 *
 * Registration time rather than use time, and exhaustive rather than
 * first-failure, so someone writing a skill sees everything wrong with it at
 * once instead of one problem per attempt.
 */
export function validateSkillDefinition(
  definition: SkillDefinition,
  context: SkillValidationContext,
): string[] {
  const problems: string[] = [];

  if (!ID_PATTERN.test(definition.id)) {
    problems.push(`"${definition.id}" is not a usable skill id`);
  }
  if (!VERSION_PATTERN.test(definition.version)) {
    problems.push(`"${definition.version}" is not a major.minor.patch version`);
  }
  if (definition.name.trim().length === 0) problems.push('a display name is required');
  if (definition.description.trim().length === 0) problems.push('a description is required');
  if (!RISK_LEVELS.includes(definition.risk)) {
    problems.push(`"${String(definition.risk)}" is not a risk level`);
  }
  const allowed = context.allowProvenance ?? [TRUSTED_PROVENANCE];
  if (!allowed.includes(definition.provenance)) {
    // The one check that makes a model-written definition inert. A proposal
    // can be held, logged and shown; it cannot be stored as executable.
    problems.push(
      `this definition may only carry ${allowed.map((p) => `"${p}"`).join(' or ')} provenance, ` +
        `not "${definition.provenance}"`,
    );
  }

  problems.push(...validateInputs(definition));
  problems.push(...validateSteps(definition, context));
  problems.push(...validateDeclaredTools(definition));
  problems.push(...validateOutputs(definition));

  return problems;
}

function validateInputs(definition: SkillDefinition): string[] {
  const problems: string[] = [];
  if (definition.inputs.length > MAX_SKILL_INPUTS) {
    problems.push(`a skill takes at most ${MAX_SKILL_INPUTS} inputs`);
  }
  const seen = new Set<string>();
  for (const input of definition.inputs) {
    if (seen.has(input.name)) problems.push(`input "${input.name}" is declared twice`);
    seen.add(input.name);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(input.name)) {
      problems.push(`"${input.name}" is not a usable input name`);
    }
    if (input.enum !== undefined && input.enum.length === 0) {
      problems.push(`input "${input.name}" has an empty set of allowed values`);
    }
  }
  return problems;
}

function validateSteps(definition: SkillDefinition, context: SkillValidationContext): string[] {
  const problems: string[] = [];

  if (definition.steps.length === 0) problems.push('a skill needs at least one step');
  if (definition.steps.length > MAX_STEPS_PER_SKILL) {
    problems.push(`a skill has at most ${MAX_STEPS_PER_SKILL} steps`);
  }

  const inputNames = new Set(definition.inputs.map((input) => input.name));
  // Steps run in order, so a binding may only read a step that has already
  // produced a result. Tracking what exists *so far* rather than what exists
  // at all is what makes a forward reference — and therefore a cycle within
  // one skill — impossible to express.
  const earlier = new Set<string>();

  for (const step of definition.steps) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(step.id)) {
      problems.push(`"${step.id}" is not a usable step id`);
    }
    if (earlier.has(step.id)) problems.push(`step id "${step.id}" is used twice`);

    if (step.kind === 'tool') {
      if (!context.hasTool(step.tool)) {
        // The check that keeps a skill from naming a capability into
        // existence. An unknown tool is a broken skill, not a new one.
        problems.push(`step "${step.id}" references unknown tool "${step.tool}"`);
      }
    } else {
      if (!VERSION_PATTERN.test(step.skillVersion)) {
        problems.push(`step "${step.id}" pins an unusable skill version`);
      } else if (step.skill === definition.id) {
        problems.push(`step "${step.id}" composes the skill it belongs to`);
      } else {
        const composed = context.getSkill?.(step.skill, step.skillVersion);
        if (!composed) {
          problems.push(
            `step "${step.id}" composes "${step.skill}@${step.skillVersion}", which is not ` +
              'registered',
          );
        } else {
          problems.push(...validateComposition(definition, step.skill, step.skillVersion, context));
        }
      }
    }

    problems.push(...validateBindings(step, inputNames, earlier));
    earlier.add(step.id);
  }

  return problems;
}

function validateBindings(
  step: SkillStep,
  inputNames: ReadonlySet<string>,
  earlier: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];

  for (const [argument, binding] of Object.entries(step.arguments)) {
    const where = `step "${step.id}" argument "${argument}"`;

    if (binding.kind === 'literal') {
      if (!isPlainData(binding.value)) {
        // A function, a class instance or anything with behaviour is not a
        // value a definition may carry. This is where "no code in a skill"
        // stops being a convention.
        problems.push(`${where} is not plain data`);
      }
      continue;
    }

    if (binding.kind === 'input') {
      if (!inputNames.has(binding.name)) {
        problems.push(`${where} reads undeclared input "${binding.name}"`);
      }
      continue;
    }

    if (!earlier.has(binding.step)) {
      // Either the step does not exist or it runs later. Both are the same
      // mistake from here, and both would be a value read before it exists.
      problems.push(`${where} reads step "${binding.step}", which does not run before it`);
    }

    if (binding.kind === 'element') {
      problems.push(...validateElementBinding(binding, where));
      continue;
    }

    problems.push(...validatePath(binding.path, where));
  }

  return problems;
}

/**
 * Anything that would turn a declarative match into a selector language.
 *
 * `role` and `name` are compared literally against the page model, so a value
 * carrying selector or scheme syntax is either a mistake or an attempt to
 * smuggle one in. Neither should register.
 */
const SELECTOR_SHAPED = /[<>{}()[\]$*|\\/]|^[.#]|javascript:|data:|::|=>/i;

/**
 * A role is an ARIA role token, so it is held to a much narrower shape.
 *
 * `button` is a role; `button.primary`, `button[type=submit]` and
 * `//button[1]` are selectors. The shape rule above catches most of those but
 * not a plain `tag.class`, so a role is checked against a closed list instead
 * of against a pattern.
 *
 * A closed list rather than a pattern because a role is page-controlled: a
 * page sets `role="whatever"` and the page model reports it, and for an
 * element with no mapping the model falls back to the tag name. Neither is a
 * value this project chose. Only the roles a recorded interaction can
 * meaningfully target are bindable; anything else makes the step
 * unrecordable, which is the fail-closed direction.
 *
 * An accessible name is not held to this — names contain dots, spaces and
 * punctuation ("Save file.txt", "Open example.com") — so the shape rule above
 * is the right check there.
 */
const BINDABLE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'combobox',
  'file',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

/** Whether a role may be bound to at all. Exported so the recorder agrees. */
export function isBindableRole(role: string): boolean {
  return BINDABLE_ROLES.has(role.trim().toLowerCase());
}

function validateElementBinding(binding: ElementBinding, where: string): string[] {
  const problems: string[] = [];

  // Provenance first, and as an exact literal rather than a truthiness check.
  // A binding that does not say where its match data came from is refused
  // outright: the alternative is a default, and a default is how an untagged
  // page-derived value would end up being treated as authored.
  if (binding.provenance !== 'PAGE_DERIVED' && binding.provenance !== 'AUTHORED') {
    problems.push(`${where} does not say where its match data came from`);
  }
  if (binding.purpose !== 'ELEMENT_BINDING') {
    problems.push(`${where} is not tagged for the one use this data has`);
  }

  for (const [field, value] of [
    ['role', binding.role],
    ['name', binding.name],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      problems.push(`${where} needs a ${field} to match on`);
      continue;
    }
    if (value.length > 200) problems.push(`${where} has a ${field} that is too long`);
    if (field === 'role') {
      if (!isBindableRole(value)) {
        problems.push(`${where} has a role that looks like a selector or a URL scheme`);
      }
      continue;
    }
    // A CSS or XPath field would be a hidden execution language wearing a
    // declarative hat, so the shape is refused rather than sanitised.
    if (SELECTOR_SHAPED.test(value)) {
      problems.push(`${where} has a name that looks like a selector or a URL scheme`);
    }
  }

  if (binding.nth !== undefined) {
    if (!Number.isInteger(binding.nth) || binding.nth < 0 || binding.nth > 200) {
      problems.push(`${where} has an unusable nth`);
    }
  }

  if (
    binding.expect !== undefined &&
    !['enabled', 'visible', 'editable'].includes(binding.expect)
  ) {
    problems.push(`${where} expects "${String(binding.expect)}", which is not a known condition`);
  }

  return problems;
}

function validatePath(path: string, where: string): string[] {
  if (!PATH_PATTERN.test(path)) return [`${where} has an unusable path "${path}"`];
  const segments = path.split('.');
  if (segments.length > MAX_BINDING_PATH_SEGMENTS) {
    return [`${where} reaches more than ${MAX_BINDING_PATH_SEGMENTS} levels deep`];
  }
  for (const segment of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.includes(segment)) {
      // `a.constructor.constructor` is the classic route from a data path to
      // the Function constructor. The path syntax excludes it, and so does
      // the resolver at run time; neither relies on the other.
      return [`${where} reaches "${segment}", which is not data`];
    }
  }
  return [];
}

/** Composition depth and cycles, walked eagerly at registration. */
function validateComposition(
  root: SkillDefinition,
  childId: string,
  childVersion: string,
  context: SkillValidationContext,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>([`${root.id}@${root.version}`]);

  const walk = (id: string, version: string, depth: number): void => {
    const key = `${id}@${version}`;
    if (seen.has(key)) {
      problems.push(`composition reaches "${key}" again, which is a cycle`);
      return;
    }
    if (depth > MAX_COMPOSITION_DEPTH) {
      problems.push(`composition is deeper than ${MAX_COMPOSITION_DEPTH} skills`);
      return;
    }
    seen.add(key);
    const definition = context.getSkill?.(id, version);
    if (!definition) return;
    for (const step of definition.steps) {
      if (step.kind === 'skill') walk(step.skill, step.skillVersion, depth + 1);
    }
    seen.delete(key);
  };

  walk(childId, childVersion, 1);
  return problems;
}

function validateDeclaredTools(definition: SkillDefinition): string[] {
  const problems: string[] = [];

  for (const name of definition.requiredTools) {
    if (FORBIDDEN_CAPABILITY_NAMES.includes(name.toLowerCase())) {
      problems.push(`"${name}" is not a capability anything grants`);
    }
  }
  for (const name of definition.requiredConnectors) {
    if (FORBIDDEN_CAPABILITY_NAMES.includes(name.toLowerCase())) {
      problems.push(`"${name}" is not a connector anything grants`);
    }
  }

  const declared = new Set(definition.requiredTools);
  for (const step of definition.steps) {
    if (step.kind === 'tool' && !declared.has(step.tool)) {
      problems.push(`step "${step.id}" uses "${step.tool}", which is not in requiredTools`);
    }
  }
  // The other direction too: a skill that declares a tool it never uses has
  // asked for privilege it does not need, which is the definition of the
  // thing least privilege is against.
  const used = new Set(
    definition.steps.filter((step) => step.kind === 'tool').map((step) => step.tool),
  );
  for (const name of declared) {
    if (!used.has(name)) problems.push(`requiredTools lists "${name}", which no step uses`);
  }

  return problems;
}

function validateOutputs(definition: SkillDefinition): string[] {
  const problems: string[] = [];
  const stepIds = new Set(definition.steps.map((step) => step.id));
  for (const output of definition.outputs) {
    if (!stepIds.has(output.step)) {
      problems.push(`output "${output.name}" reads step "${output.step}", which does not exist`);
    }
    problems.push(...validatePath(output.path, `output "${output.name}"`));
  }
  return problems;
}

/**
 * Whether a value is data rather than something with behaviour.
 *
 * Structural: a function, a class instance, a `Date`, a `Proxy` over one —
 * anything whose prototype is not `Object.prototype` or `Array.prototype` is
 * refused. Being strict here is cheap, because a skill literal has no reason
 * to be anything but JSON.
 */
export function isPlainData(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  if (type !== 'object') return false;

  if (Array.isArray(value)) return value.every((item) => isPlainData(item, depth + 1));

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every((nested) =>
    isPlainData(nested, depth + 1),
  );
}

/**
 * The risk of running a skill, given what its tools are worth.
 *
 * The highest of the declared floor and every tool it reaches, so a skill is
 * never approved at a lower bar than its most dangerous step. Composition is
 * followed, because a skill that composes a deleting skill deletes.
 */
export function effectiveSkillRisk(
  definition: SkillDefinition,
  riskOfTool: (name: string) => RiskLevel | undefined,
  resolveSkill: (id: string, version: string) => SkillDefinition | undefined,
  depth = 0,
): RiskLevel {
  let risk: RiskLevel = definition.risk;
  if (depth > MAX_COMPOSITION_DEPTH) return risk;

  for (const step of definition.steps) {
    if (step.kind === 'tool') {
      risk = maxRisk(risk, riskOfTool(step.tool) ?? 'R3');
    } else {
      const composed = resolveSkill(step.skill, step.skillVersion);
      // An unresolvable composition is treated as the worst case rather than
      // skipped. It cannot happen through the registry, which validates, but
      // guessing low here would be the wrong way to be wrong.
      risk = composed
        ? maxRisk(risk, effectiveSkillRisk(composed, riskOfTool, resolveSkill, depth + 1))
        : maxRisk(risk, 'R3');
    }
  }
  return risk;
}

/** Every tool a skill can reach, including through composition. */
export function toolsReachedBy(
  definition: SkillDefinition,
  resolveSkill: (id: string, version: string) => SkillDefinition | undefined,
  depth = 0,
): string[] {
  if (depth > MAX_COMPOSITION_DEPTH) return [];
  const names = new Set<string>();
  for (const step of definition.steps) {
    if (step.kind === 'tool') names.add(step.tool);
    else {
      const composed = resolveSkill(step.skill, step.skillVersion);
      if (composed) {
        for (const name of toolsReachedBy(composed, resolveSkill, depth + 1)) names.add(name);
      }
    }
  }
  return [...names].sort();
}

/**
 * A stable hash of a definition.
 *
 * Canonicalised with sorted keys so formatting cannot change it, and covering
 * everything that decides what the skill does — steps, bindings, declared
 * tools, risk. Used for audit, for provenance on a task record, and to notice
 * that a definition changed under a run that was already in progress.
 *
 * It is **not** an authorization mechanism. A matching hash says a definition
 * is the one recorded earlier; it says nothing about whether it was ever
 * trusted. Trust comes from the registry, which only holds bundled
 * definitions. A hash presented by a caller proves nothing at all, and nothing
 * here treats one as if it did.
 */
export async function skillHash(definition: SkillDefinition): Promise<string> {
  return await hashContent(canonicalJson(canonicalDefinition(definition)));
}

function canonicalDefinition(definition: SkillDefinition): Record<string, unknown> {
  return {
    id: definition.id,
    version: definition.version,
    risk: definition.risk,
    requiredTools: [...definition.requiredTools].sort(),
    requiredConnectors: [...definition.requiredConnectors].sort(),
    inputs: definition.inputs.map((input) => ({
      name: input.name,
      type: input.type,
      required: input.required,
      ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }),
      ...(input.enum === undefined ? {} : { enum: [...input.enum] }),
    })),
    outputs: definition.outputs.map((output) => ({
      name: output.name,
      step: output.step,
      path: output.path,
    })),
    steps: definition.steps.map((step) =>
      step.kind === 'tool'
        ? {
            kind: step.kind,
            id: step.id,
            tool: step.tool,
            optional: step.optional === true,
            arguments: step.arguments,
          }
        : {
            kind: step.kind,
            id: step.id,
            skill: step.skill,
            skillVersion: step.skillVersion,
            optional: step.optional === true,
            arguments: step.arguments,
          },
    ),
  };
}

/** JSON with object keys sorted at every level, so equal values hash equally. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
  return `{${entries.join(',')}}`;
}

/** `id@version`, the key an invocation binds to. */
export function skillKey(id: string, version: string): string {
  return `${id}@${version}`;
}
