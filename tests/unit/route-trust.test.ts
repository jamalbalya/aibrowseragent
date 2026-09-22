/**
 * TEST-ROUTETRUST-001 — Sender classification and route classes (D-1).
 *
 * The classifier is the hinge the whole boundary turns on, so the cases here
 * are about *which field decides what*, and about every way a sender can be
 * something other than what it claims. The browser-boundary claims — that a
 * real content script and a real side panel actually produce these shapes —
 * are proved in `tests/e2e/route-trust.spec.ts`, where Chrome fills the
 * sender in rather than a fixture.
 */
import { describe, expect, it } from 'vitest';
import {
  PANEL_ROUTE_CLASSES,
  ROUTE_CLASSES,
  SENDER_CLASSES,
  classifySender,
  panelRouteClass,
  senderMayBroadcastEvent,
  senderMayInvokeContentRoute,
  senderMayInvokePanelRoute,
  type MessageSenderLike,
  type RouteClass,
} from '@/messaging/route-trust';
import { TEST_IDENTITY, contentSender, panelSender, workerSender } from '../fixtures/senders';

const classify = (sender: MessageSenderLike | undefined | null): string =>
  classifySender(sender, TEST_IDENTITY);

describe('classifySender', () => {
  it('recognises the side panel by its extension-origin document', () => {
    expect(classify(panelSender)).toBe('SIDE_PANEL');
  });

  it('recognises the service worker by its script URL, with no origin to go on', () => {
    // Chrome sets no `origin` on a worker sender. Measured, not assumed.
    expect(workerSender.origin).toBeUndefined();
    expect(classify(workerSender)).toBe('SERVICE_WORKER');
  });

  it('refuses a worker URL that arrives with a tab', () => {
    // Nothing that reports this extension's worker script also lives in a
    // tab, so the combination is a contradiction rather than a worker.
    expect(classify({ ...workerSender, tab: { id: 4 } })).toBe('INVALID');
  });

  it('does not let a page claim the worker by naming it', () => {
    // `sender.url` is filled in by Chrome from the sending context, so this
    // shape cannot occur — the assertion records which field is load-bearing.
    expect(classify({ ...contentSender, url: `${TEST_IDENTITY.origin}/service-worker.js` })).toBe(
      'INVALID',
    );
  });

  it('recognises a content script by this extension id with a page origin', () => {
    expect(classify(contentSender)).toBe('CONTENT_SCRIPT');
  });

  it('does not treat the panel as identified by the absence of a tab', () => {
    // Chrome may associate a side panel with a tab. If that ever happens, the
    // panel must still be the panel: the document decides, not the tab.
    expect(classify({ ...panelSender, tab: { id: 3 } })).toBe('SIDE_PANEL');
  });

  it('refuses a missing sender', () => {
    expect(classify(undefined)).toBe('INVALID');
    expect(classify(null)).toBe('INVALID');
  });

  it('refuses a sender that is not an object', () => {
    expect(classify('panel' as unknown as MessageSenderLike)).toBe('INVALID');
  });

  it('treats a sender with no extension id as external', () => {
    expect(classify({ origin: 'https://evil.test', url: 'https://evil.test/' })).toBe('EXTERNAL');
  });

  it('treats another extension as external', () => {
    expect(classify({ ...panelSender, id: 'someotherextensionidsomeotherid00' })).toBe('EXTERNAL');
  });

  it('refuses a sender missing its origin', () => {
    const { origin: _origin, ...rest } = panelSender;
    expect(classify(rest)).toBe('INVALID');
  });

  it('refuses a sender missing its url', () => {
    const { url: _url, ...rest } = panelSender;
    expect(classify(rest)).toBe('INVALID');
  });

  it('refuses contradictory fields: our origin, someone else’s document', () => {
    expect(classify({ ...panelSender, url: 'https://evil.test/panel' })).toBe('INVALID');
  });

  it('refuses our id with a foreign origin and no tab', () => {
    const { tab: _tab, ...rest } = contentSender;
    expect(classify(rest)).toBe('INVALID');
  });

  it('does not accept a document that merely sits beside the panel', () => {
    // An extension-origin document is not automatically the panel. A prefix
    // match on the directory would admit anything this extension ever adds
    // there.
    expect(
      classify({ ...panelSender, url: `${TEST_IDENTITY.origin}/src/sidepanel/other.html` }),
    ).toBe('OTHER_EXTENSION_CONTEXT');
  });

  it('accepts the panel document with a query string or a fragment', () => {
    expect(classify({ ...panelSender, url: `${TEST_IDENTITY.panelDocumentUrl}?view=audit` })).toBe(
      'SIDE_PANEL',
    );
    expect(classify({ ...panelSender, url: `${TEST_IDENTITY.panelDocumentUrl}#/tasks` })).toBe(
      'SIDE_PANEL',
    );
  });

  it('does not accept a URL that only starts with the panel URL', () => {
    // `…/index.html.evil` shares a prefix and is a different document.
    expect(classify({ ...panelSender, url: `${TEST_IDENTITY.panelDocumentUrl}.evil` })).not.toBe(
      'SIDE_PANEL',
    );
  });

  it('classifies every sender it returns into the declared set', () => {
    const seen = [
      classify(panelSender),
      classify(workerSender),
      classify(contentSender),
      classify(undefined),
      classify({ origin: 'https://x.test', url: 'https://x.test/' }),
      classify({ ...panelSender, url: `${TEST_IDENTITY.origin}/src/sidepanel/other.html` }),
    ];
    for (const value of seen) expect(SENDER_CLASSES).toContain(value);
  });
});

describe('route class authorization', () => {
  it('admits only the side panel to both panel classes', () => {
    for (const routeClass of ['CLASS_B_PANEL_CONTROL_PLANE', 'CLASS_E_PANEL_READ_ONLY'] as const) {
      expect(senderMayInvokePanelRoute('SIDE_PANEL', routeClass)).toBe(true);
      for (const sender of [
        'CONTENT_SCRIPT',
        'SERVICE_WORKER',
        'OTHER_EXTENSION_CONTEXT',
        'EXTERNAL',
        'INVALID',
      ] as const) {
        expect(senderMayInvokePanelRoute(sender, routeClass)).toBe(false);
      }
    }
  });

  it('admits nobody to the classes this listener does not serve', () => {
    const notServed: RouteClass[] = [
      'CLASS_A_INTERNAL_WORKER_ONLY',
      'CLASS_C_CONTENT_DATA_PLANE',
      'CLASS_D_AUTH_CALLBACK',
      'CLASS_F_EVENT_CHANNEL',
    ];
    for (const routeClass of notServed) {
      for (const sender of SENDER_CLASSES) {
        expect(senderMayInvokePanelRoute(sender, routeClass)).toBe(false);
      }
    }
  });

  it('admits only the service worker to content routes and to the event channel', () => {
    for (const sender of SENDER_CLASSES) {
      const expected = sender === 'SERVICE_WORKER';
      expect(senderMayInvokeContentRoute(sender)).toBe(expected);
      expect(senderMayBroadcastEvent(sender)).toBe(expected);
    }
  });
});

describe('the route class table', () => {
  it('classifies every route into a declared class', () => {
    for (const [route, routeClass] of Object.entries(PANEL_ROUTE_CLASSES)) {
      expect(ROUTE_CLASSES, `${route} has an undeclared class`).toContain(routeClass);
    }
  });

  it('puts every route in a panel class, so none is reachable from elsewhere', () => {
    for (const [route, routeClass] of Object.entries(PANEL_ROUTE_CLASSES)) {
      expect(
        ['CLASS_B_PANEL_CONTROL_PLANE', 'CLASS_E_PANEL_READ_ONLY'],
        `${route} is not a panel route`,
      ).toContain(routeClass);
    }
  });

  it('classes every route that executes, authorises, mutates policy or discloses as control plane', () => {
    // Named explicitly rather than derived, so that moving one of these to a
    // read-only class is a visible edit to this list rather than a quiet
    // reclassification somewhere else.
    const mustBeControlPlane = [
      'task.create',
      'task.resume',
      'task.retry',
      'skill.run',
      'workflow.replay',
      'permission.respond',
      'permission.listPending',
      'session.setPermissionMode',
      'file.respondSelection',
      'file.listPendingSelections',
      'connector.authorize',
      'connector.resolveWrite',
      'connector.disconnect',
      'policy.removeSiteRule',
      'provider.connect',
      'provider.disconnect',
      'audit.export',
      'evidence.getPayload',
    ] as const;
    for (const route of mustBeControlPlane) {
      expect(PANEL_ROUTE_CLASSES[route], route).toBe('CLASS_B_PANEL_CONTROL_PLANE');
    }
  });

  it('returns nothing for a route it does not know', () => {
    expect(panelRouteClass('nope')).toBeUndefined();
    expect(panelRouteClass('audit.export')).toBe('CLASS_B_PANEL_CONTROL_PLANE');
  });

  it('is not fooled by inherited object properties', () => {
    // `toString` exists on every object. A lookup that did not check own
    // properties would hand back a truthy value and read as classified.
    expect(panelRouteClass('toString')).toBeUndefined();
    expect(panelRouteClass('constructor')).toBeUndefined();
  });
});
