/**
 * Message senders, as Chrome actually shapes them.
 *
 * Route trust is decided from `chrome.runtime.MessageSender`, so a test that
 * invented its own sender shape would be testing its invention. These are
 * modelled on what each context really reports:
 *
 *  - the **side panel** is an extension-origin document at the manifest's
 *    `side_panel.default_path`;
 *  - the **service worker** is an extension-origin script at the manifest's
 *    `background.service_worker`;
 *  - a **content script** carries this extension's id with the *page's*
 *    origin, plus a tab.
 *
 * The browser-boundary claims are proved in real Chromium, where Chrome
 * fills these in rather than a fixture. These exist for the classification
 * logic itself — which field decides what, and what happens when one is
 * missing or two disagree.
 */
import type { ExtensionIdentity, MessageSenderLike } from '@/messaging/route-trust';

export const TEST_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

export const TEST_IDENTITY: ExtensionIdentity = {
  extensionId: TEST_EXTENSION_ID,
  origin: `chrome-extension://${TEST_EXTENSION_ID}`,
  panelDocumentUrl: `chrome-extension://${TEST_EXTENSION_ID}/src/sidepanel/index.html`,
  workerUrl: `chrome-extension://${TEST_EXTENSION_ID}/service-worker.js`,
};

export const panelSender: MessageSenderLike = {
  id: TEST_IDENTITY.extensionId,
  origin: TEST_IDENTITY.origin,
  url: TEST_IDENTITY.panelDocumentUrl,
  documentId: 'panel-doc-1',
};

/**
 * The worker as Chrome really reports it: an id and a script URL, and **no
 * `origin`**. Measured in real Chromium rather than assumed — requiring an
 * origin here is what silently stopped the panel receiving broadcasts, and a
 * fixture that supplied one would have hidden that.
 */
export const workerSender: MessageSenderLike = {
  id: TEST_IDENTITY.extensionId,
  url: TEST_IDENTITY.workerUrl,
};

export const contentSender: MessageSenderLike = {
  id: TEST_IDENTITY.extensionId,
  origin: 'https://example.com',
  url: 'https://example.com/a/page',
  tab: { id: 7 },
  frameId: 0,
  documentId: 'page-doc-1',
};
