/**
 * Test setup.
 *
 * Silences the console sink so test output stays readable. The logger's
 * redaction behaviour is asserted directly in its own tests, using an
 * explicit MemorySink rather than the shared one.
 */
import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
