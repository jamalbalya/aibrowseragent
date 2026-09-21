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
 * These are enforced by the policy engine and cannot be unlocked by any
 * permission mode, site allowlist, or user instruction.
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
