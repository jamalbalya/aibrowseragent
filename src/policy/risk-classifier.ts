/**
 * Risk classification (specification section 28).
 *
 * R0 read-only … R5 prohibited. The level a tool declares is its *floor*;
 * argument- and origin-aware escalation may raise it but never lower it.
 */
export const RISK_LEVELS = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_RANK: Record<RiskLevel, number> = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R4: 4,
  R5: 5,
};

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

export function riskAtLeast(level: RiskLevel, threshold: RiskLevel): boolean {
  return RISK_RANK[level] >= RISK_RANK[threshold];
}

export const RISK_DESCRIPTIONS: Record<RiskLevel, string> = {
  R0: 'Read-only. No page or external state changes.',
  R1: 'Low risk and reversible.',
  R2: 'Medium risk. Changes page state or transfers a file.',
  R3: 'Sensitive external side effect. Writes data outside the browser.',
  R4: 'Destructive or high consequence.',
  R5: 'Prohibited. Never executed.',
};

/**
 * Hard prohibitions (specification section 29).
 *
 * The policy engine refuses any call that carries one of these, in every
 * permission mode, unlockable by no site allowlist and no user instruction.
 *
 * That is a statement about what the engine does with a category, not about
 * whether anything supplies one. See `PROHIBITION_ENFORCEMENT` below for which
 * of them are actually kept today and how.
 */
export const PROHIBITED_CATEGORIES = [
  'financial_transaction',
  'payment_instrument_entry',
  'account_creation',
  'credential_submission_to_third_party',
  'permanent_deletion',
  'securities_trading',
  'system_file_modification',
  'bot_protection_bypass',
  'arbitrary_code_execution',
] as const;

export type ProhibitedCategory = (typeof PROHIBITED_CATEGORIES)[number];

/**
 * How each prohibition is actually kept — which is not the same question as
 * whether it is declared.
 *
 * The policy engine refuses any call carrying a prohibited category, in every
 * mode, unlockable by nothing. That half works and is tested. The other half
 * is *arrival*: something has to put the category on the call, and for five of
 * the nine that something does not exist yet.
 *
 * Splitting the two is the point of this table. A prohibition kept because the
 * product has no tool that could reach it is a real guarantee and stays true
 * as long as the tool surface does. A prohibition kept only by the engine is a
 * guarantee about a call nobody constructs, and for a browser agent that is a
 * very different thing: buying something, creating an account or typing a card
 * number are all ordinary clicks and keystrokes through `browser.click` and
 * `browser.type`, and nothing today tells those calls apart from any other.
 *
 * This is recorded here rather than left in prose because prose said the
 * opposite for a while. `docs/security.md` listed all of them as "refused in
 * every permission mode" without distinguishing the two cases, which read as a
 * stronger claim than the code makes. The table is the claim now, a test holds
 * the documentation to it, and closing a `REQUIRES_DETECTION` row means adding
 * a producer and moving it here in the same commit.
 */
export const PROHIBITION_ENFORCEMENT: Record<
  ProhibitedCategory,
  'UNREACHABLE_BY_CONSTRUCTION' | 'REQUIRES_DETECTION'
> = {
  /*
   * Kept by the tool surface, not by a classifier.
   *
   * There is no filesystem tool, no CAPTCHA solver and no evaluator: the
   * debugger allowlist holds no code-evaluation method, no tool takes a method
   * name as an argument, and the extension CSP omits `unsafe-eval`. A call in
   * these categories cannot be built out of the tools that exist, so the
   * guarantee holds without anything having to notice.
   */
  system_file_modification: 'UNREACHABLE_BY_CONSTRUCTION',
  bot_protection_bypass: 'UNREACHABLE_BY_CONSTRUCTION',
  arbitrary_code_execution: 'UNREACHABLE_BY_CONSTRUCTION',

  /*
   * Declared, enforced if raised, and raised by nothing.
   *
   * Each of these is reachable through ordinary page interaction: a purchase
   * is a click, a card number is a `browser.type`, a signup form is both, and
   * "delete forever" is a button like any other. The policy engine would
   * refuse them the instant a call arrived carrying the category — no call
   * does. Detecting intent from a page is a design with real content in it
   * (where detection happens, and whether the outcome is a refusal or a
   * confirmation), and guessing at it here would be worse than saying so.
   */
  financial_transaction: 'REQUIRES_DETECTION',
  payment_instrument_entry: 'REQUIRES_DETECTION',
  account_creation: 'REQUIRES_DETECTION',
  credential_submission_to_third_party: 'REQUIRES_DETECTION',
  permanent_deletion: 'REQUIRES_DETECTION',
  securities_trading: 'REQUIRES_DETECTION',
};

/** The prohibitions no tool can currently raise. Derived, so it cannot drift. */
export const UNDETECTED_PROHIBITIONS: readonly ProhibitedCategory[] = PROHIBITED_CATEGORIES.filter(
  (category) => PROHIBITION_ENFORCEMENT[category] === 'REQUIRES_DETECTION',
);

export const PROHIBITED_DESCRIPTIONS: Record<ProhibitedCategory, string> = {
  financial_transaction: 'Completing a purchase, payment, or money transfer.',
  payment_instrument_entry: 'Entering credit card, bank, or government ID numbers.',
  account_creation: 'Creating an account on the user’s behalf.',
  credential_submission_to_third_party:
    'Submitting credentials into a page that did not issue them.',
  permanent_deletion: 'Irreversibly deleting records or files.',
  securities_trading: 'Placing trades or investment transactions.',
  system_file_modification: 'Modifying operating system or browser configuration files.',
  bot_protection_bypass: 'Defeating CAPTCHA or other bot authorisation controls.',
  arbitrary_code_execution: 'Executing arbitrary script supplied by the model.',
};
