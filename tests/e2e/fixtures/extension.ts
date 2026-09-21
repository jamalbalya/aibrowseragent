/**
 * Playwright fixture that loads the built extension into a real Chromium.
 *
 * Notes that cost time to discover:
 *
 * - Extensions require a persistent context; they cannot be loaded into the
 *   default ephemeral one.
 * - Playwright's bundled browser revision may not match what this image has,
 *   so the binary is taken from PLAYWRIGHT_BROWSERS_PATH explicitly.
 * - `headless: true` alone resolves to `chrome-headless-shell`, which cannot
 *   load extensions at all. Every test then fails identically waiting for a
 *   service worker that never registers — which is exactly how this suite
 *   failed in CI while passing locally, where an explicit binary was used.
 *   `channel: 'chromium'` pins the full browser in its new headless mode.
 * - `chrome.runtime.sendMessage` sent from inside the service worker is not
 *   delivered to that worker's own listener. Messages must originate from an
 *   extension page, which is why `openPanel` exists.
 */
import {
  chromium,
  test as base,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  PanelRequest,
  PanelRequestType,
  PanelResponse,
} from '../../../src/messaging/protocol';
import { startMockProvider, type MockProvider } from './mock-provider';
import { startNativeProviders, type NativeProviders } from './native-providers';
import { startTestSite, type TestSite } from './test-site';
import { startCollector, type Collector } from './collector';

const EXTENSION_PATH = resolve(import.meta.dirname, '../../../dist');
/**
 * Chromium binary.
 *
 * This image ships a Chromium whose revision may not match the one Playwright
 * expects, so the path is given explicitly. Setting E2E_CHROMIUM_PATH to an
 * empty string (as CI does, after `playwright install`) hands resolution back
 * to Playwright.
 */
const CHROMIUM = process.env.E2E_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

/**
 * Launch options that decide *which* Chromium runs.
 *
 * An explicit path wins. Otherwise the `chromium` channel is requested by
 * name, because Playwright's default for `headless: true` is the headless
 * shell, and the headless shell has no extension support.
 */
const BROWSER: { executablePath?: string; channel?: string } =
  CHROMIUM.length > 0 ? { executablePath: CHROMIUM } : { channel: 'chromium' };

/** What the message router returns across the boundary. */
interface MessageEnvelope {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly userMessage: string };
}

/** Calls the service worker's message router from an extension page. */
export type SendToWorker = <T extends PanelRequestType>(
  type: T,
  payload: PanelRequest<T>,
) => Promise<PanelResponse<T>>;

export interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  /** The side panel document, opened as a normal page. */
  panel: Page;
  send: SendToWorker;
  provider: MockProvider;
  /** One server speaking the Anthropic and Gemini wire protocols. */
  nativeProviders: NativeProviders;
  site: TestSite;
  /** A second origin that records what actually reaches it. */
  collector: Collector;
  /** Console output from the service worker, for asserting on logs. */
  workerLogs: string[];
}

/* eslint-disable no-empty-pattern -- Playwright fixtures that depend on
   nothing still have to declare the destructured first argument. */
export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    const profile = mkdtempSync(join(tmpdir(), 'aiba-e2e-'));
    const context = await chromium.launchPersistentContext(profile, {
      ...BROWSER,
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    await use(context);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  },

  serviceWorker: async ({ context }, use) => {
    const existing = context.serviceWorkers()[0];
    const worker =
      existing ??
      (await context.waitForEvent('serviceworker', { timeout: 20_000 }).catch(() => {
        // Every test in the suite depends on this, so a silent 20-second
        // timeout repeated per test says nothing about the cause. The cause
        // that has actually happened is a browser with no extension support.
        throw new Error(
          `The extension's service worker never registered. Chromium loaded ` +
            `${EXTENSION_PATH}, so either the build is broken or this browser ` +
            `cannot load extensions — chrome-headless-shell cannot, which is ` +
            `why the launch pins the "chromium" channel. Browser: ` +
            `${JSON.stringify(BROWSER)}.`,
        );
      }));
    // Let startup() finish before a test inspects state it populates.
    await new Promise((r) => setTimeout(r, 800));
    await use(worker);
  },

  workerLogs: async ({ serviceWorker }, use) => {
    const logs: string[] = [];
    serviceWorker.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
    await use(logs);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },

  panel: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    await page.waitForSelector('.app', { timeout: 10_000 });

    await use(page);

    // A React error during the run would otherwise pass unnoticed.
    if (errors.length > 0) {
      throw new Error(`The side panel raised errors: ${errors.join('; ')}`);
    }
  },

  send: async ({ panel }, use) => {
    const send: SendToWorker = async (type, payload) => {
      const envelope: MessageEnvelope = await panel.evaluate(
        ([messageType, messagePayload]) =>
          chrome.runtime.sendMessage({
            id: `e2e_${Math.random().toString(36).slice(2)}`,
            type: messageType,
            timestamp: Date.now(),
            payload: messagePayload,
          }),
        [type, payload] as const,
      );
      if (!envelope?.ok) {
        throw new Error(
          `${type} failed: ${envelope?.error?.code ?? 'no response'} — ${envelope?.error?.userMessage ?? ''}`,
        );
      }
      return envelope.value as PanelResponse<typeof type>;
    };
    await use(send);
  },

  provider: async ({}, use) => {
    const mock = await startMockProvider();
    await use(mock);
    await mock.close();
  },

  nativeProviders: async ({}, use) => {
    const servers = await startNativeProviders();
    await use(servers);
    await servers.close();
  },

  site: async ({ collector }, use) => {
    // Depends on the collector so a cross-site form can point at a real
    // receiving origin rather than a placeholder.
    const server = await startTestSite({ collectorUrl: collector.baseUrl });
    await use(server);
    await server.close();
  },

  collector: async ({}, use) => {
    const server = await startCollector();
    await use(server);
    await server.close();
  },
});

/* eslint-enable no-empty-pattern */

export const expect = test.expect;

/** Connects the mock provider and makes it active, as the Settings flow does. */
export async function connectProvider(
  send: SendToWorker,
  provider: MockProvider,
  options: { runDoctor?: boolean } = {},
): Promise<void> {
  const result = await send('provider.connect', {
    providerId: 'openai-compatible',
    baseUrl: provider.baseUrl,
    apiKey: 'test-key-abcdefghijklmnop',
    model: 'mock-model',
  });
  if (result.error) throw new Error(`connect failed: ${result.error.userMessage}`);

  if (options.runDoctor !== false) {
    await send('provider.runDoctor', { providerId: 'openai-compatible', modelId: 'mock-model' });
  }
  await send('provider.setActive', { providerId: 'openai-compatible', modelId: 'mock-model' });
}

/** Polls a task until it reaches a terminal state. */
export async function waitForTask(
  send: SendToWorker,
  taskId: string,
  timeoutMs = 25_000,
): Promise<NonNullable<PanelResponse<'task.get'>['task']>> {
  const terminal = ['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'CANCELLED'];
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { task } = await send('task.get', { taskId });
    if (task && terminal.includes(task.state)) return task;
    if (Date.now() > deadline) {
      throw new Error(
        `Task ${taskId} did not finish within ${timeoutMs}ms (state: ${task?.state}).`,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}
