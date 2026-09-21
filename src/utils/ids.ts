/**
 * Identifier helpers.
 *
 * `crypto.randomUUID` is available in service workers, content scripts and the
 * side panel, so no polyfill is needed.
 */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export const newTaskId = (): string => newId('task');
export const newSessionId = (): string => newId('session');
export const newToolCallId = (): string => newId('tc');
export const newEvidenceId = (): string => newId('ev');
export const newMessageId = (): string => newId('msg');
