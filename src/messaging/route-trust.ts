/**
 * Route trust: who is allowed to send which message.
 *
 * Every message this extension routes arrives over `chrome.runtime` or
 * `chrome.tabs`, and until now the receiver looked only at the message. That
 * is the wrong half. A message says what the sender wants; it cannot say who
 * the sender is, and a `taskId`, a `requestId` or a `scope` in a payload is a
 * request, never a credential.
 *
 * The property this module establishes is that a route runs only when the
 * sender is **positively identified** as a context allowed to invoke it. Not
 * "no known caller could abuse this", not "the model has no tool for it", not
 * "no page can reach the content script today" — those are all true, and none
 * of them is a check. They are facts about the current shape of the code, and
 * a single future line could change any of them without anyone noticing.
 *
 * Three consequences worth stating, because they are the reasons this is
 * shaped the way it is:
 *
 *  - **Default deny.** A route with no class is refused. Registration alone
 *    grants nothing, so a route added by a later wave is unreachable until
 *    someone decides, in writing, who may call it.
 *  - **Identity is a conjunction, and `sender.id` is the weakest part of it.**
 *    That field is the *extension* id and is identical for the side panel and
 *    for this extension's content scripts, so it separates this extension
 *    from another one and nothing else. What separates the panel from a
 *    content script is that the panel is an extension-origin document, and
 *    which document it is.
 *  - **Ambiguity is a denial.** A sender missing a field, or carrying fields
 *    that contradict each other, is not classified as the most likely thing
 *    it could be. It is refused.
 *
 * This is a filter in front of the existing routes. It never says "allow"
 * where policy, permission, egress or consent would say "deny" — it runs
 * before them and can only subtract.
 */
import type { PanelRequestType } from './protocol';

/**
 * What a message sender is, in the only terms worth deciding on.
 *
 * `EXTERNAL` covers a web page and another extension together, deliberately:
 * neither may reach anything here, and separating them would invite a rule
 * that treats one of them as nearly trusted.
 */
export const SENDER_CLASSES = [
  'SERVICE_WORKER',
  'SIDE_PANEL',
  'CONTENT_SCRIPT',
  'OTHER_EXTENSION_CONTEXT',
  'EXTERNAL',
  'INVALID',
] as const;

export type SenderClass = (typeof SENDER_CLASSES)[number];

/** What a route is, in terms of who may reach it. */
export const ROUTE_CLASSES = [
  /** Reachable only from inside the worker. Nothing may message it. */
  'CLASS_A_INTERNAL_WORKER_ONLY',
  /** The panel's control plane: mutates, executes, authorises or discloses. */
  'CLASS_B_PANEL_CONTROL_PLANE',
  /** Worker → content script. Never content-originated. */
  'CLASS_C_CONTENT_DATA_PLANE',
  /** The OAuth redirect target, which carries no message path at all. */
  'CLASS_D_AUTH_CALLBACK',
  /** Panel reads that change nothing. Still panel-only. */
  'CLASS_E_PANEL_READ_ONLY',
  /** Worker → panel broadcasts. */
  'CLASS_F_EVENT_CHANNEL',
] as const;

export type RouteClass = (typeof ROUTE_CLASSES)[number];

/**
 * The part of `chrome.runtime.MessageSender` this module reads.
 *
 * Narrowed to an interface so classification is testable without a browser,
 * and so it is obvious at a glance which fields carry weight. Every field is
 * optional because Chrome genuinely omits them in some contexts, and a
 * missing field must be handled rather than assumed.
 */
export interface MessageSenderLike {
  readonly id?: string | undefined;
  readonly origin?: string | undefined;
  readonly url?: string | undefined;
  readonly tab?: { readonly id?: number | undefined } | undefined;
  readonly documentId?: string | undefined;
  readonly frameId?: number | undefined;
}

/**
 * This extension's own identity, resolved once.
 *
 * One definition, reused by the worker, the content script and the panel.
 * Three independent notions of "is this the panel" would eventually disagree,
 * and the one that disagreed in the permissive direction would be the bug.
 */
export interface ExtensionIdentity {
  readonly extensionId: string;
  /** `chrome-extension://<id>`, with no trailing slash — what `sender.origin` holds. */
  readonly origin: string;
  /** The side panel document, exactly as the manifest declares it. */
  readonly panelDocumentUrl: string;
  /** The background service worker script. */
  readonly workerUrl: string;
}

/**
 * The side panel's path, from `manifest.json`'s `side_panel.default_path`.
 *
 * Kept next to the identity it builds rather than inlined at a use site, so
 * that a manifest change has one place to be reflected.
 */
const PANEL_PATH = 'src/sidepanel/index.html';
const WORKER_PATH = 'service-worker.js';

let cached: ExtensionIdentity | null = null;

/** Resolves this extension's identity from `chrome.runtime`. */
export function extensionIdentity(): ExtensionIdentity {
  if (cached) return cached;
  // `getURL('')` returns `chrome-extension://<id>/`; `sender.origin` has no
  // trailing slash, so it is trimmed here rather than at each comparison.
  const base = chrome.runtime.getURL('');
  cached = {
    extensionId: chrome.runtime.id,
    origin: base.replace(/\/$/, ''),
    panelDocumentUrl: chrome.runtime.getURL(PANEL_PATH),
    workerUrl: chrome.runtime.getURL(WORKER_PATH),
  };
  return cached;
}

/** Test seam. Production resolves from `chrome.runtime` and never calls this. */
export function resetExtensionIdentityCache(): void {
  cached = null;
}

/**
 * True when a URL is the side panel document itself.
 *
 * Exact, not a directory prefix: an extension-origin document is not
 * automatically the panel, and if this extension ever gains an options page
 * or an offscreen document, a prefix match would quietly admit it. A query
 * string or a fragment is allowed because those belong to the same document.
 */
function isPanelDocument(url: string, panelDocumentUrl: string): boolean {
  if (url === panelDocumentUrl) return true;
  return url.startsWith(`${panelDocumentUrl}?`) || url.startsWith(`${panelDocumentUrl}#`);
}

/**
 * Decides what a sender is.
 *
 * The order matters and is fail-closed at every step: anything that is not
 * positively recognised lands on `INVALID` or `EXTERNAL`, never on the class
 * it most resembles.
 *
 * `sender.tab` is used only to recognise a content script — a context that is
 * denied everything anyway — and never to establish that a sender *is* the
 * panel. Chrome may associate a side panel with a tab, and a rule that read
 * "the panel has no tab" would break the product the day that changed.
 */
export function classifySender(
  sender: MessageSenderLike | undefined | null,
  identity: ExtensionIdentity,
): SenderClass {
  if (!sender || typeof sender !== 'object') return 'INVALID';

  const { id, origin, url, tab } = sender;

  // No extension id means the message did not come from an extension context
  // of ours: a web page (were `externally_connectable` ever added) or
  // something unrecognised. A different id means a different extension.
  if (typeof id !== 'string' || id.length === 0) return 'EXTERNAL';
  if (id !== identity.extensionId) return 'EXTERNAL';

  if (typeof url !== 'string' || url.length === 0) return 'INVALID';

  // The service worker, recognised by its script URL and by having no tab.
  //
  // `origin` is deliberately *not* required here, and that is a measured
  // fact rather than a convenience: Chrome sets no `origin` on a sender that
  // is a service worker, at least for `chrome.runtime.sendMessage`. Requiring
  // it made every worker broadcast unrecognised, which the file-selection
  // prompt noticed by never appearing. A rule that depends on a field the
  // browser does not set is not a rule.
  //
  // What carries the weight instead is that `sender.url` is filled in by
  // Chrome from the sending context, never by the sender, and no context
  // outside this extension can have this extension's worker URL.
  if (url === identity.workerUrl) {
    return tab === undefined ? 'SERVICE_WORKER' : 'INVALID';
  }

  // Everything else is a document, and a document does report its origin.
  // Missing here is a sender we cannot reason about, which is a denial rather
  // than a guess — and it fails in the safe direction, because the classes
  // below are the ones that can reach something.
  if (typeof origin !== 'string' || origin.length === 0) return 'INVALID';

  if (origin === identity.origin) {
    // An extension-origin document. Its URL must agree with its origin; a
    // sender claiming our origin while pointing somewhere else is
    // contradictory, and contradictions are refused rather than resolved.
    if (!url.startsWith(`${identity.origin}/`)) return 'INVALID';
    if (isPanelDocument(url, identity.panelDocumentUrl)) return 'SIDE_PANEL';
    return 'OTHER_EXTENSION_CONTEXT';
  }

  // Our extension id with a non-extension origin is a content script: it runs
  // in a page, so it reports the page's origin. The tab corroborates it.
  if (tab !== undefined) return 'CONTENT_SCRIPT';

  // Our id, someone else's origin, and no tab. Nothing legitimate looks like
  // this.
  return 'INVALID';
}

/**
 * Whether a sender may invoke a panel route.
 *
 * Both panel classes require the panel. They are separated because they say
 * different things about what the route does — `CLASS_B_PANEL_CONTROL_PLANE` mutates,
 * executes, authorises or discloses; `CLASS_E_PANEL_READ_ONLY` does not — and because
 * a reader deciding where a new route belongs should have to think about
 * that. The authorisation they carry today is identical, and saying so here
 * is better than implying a difference that does not exist.
 */
export function senderMayInvokePanelRoute(
  senderClass: SenderClass,
  routeClass: RouteClass,
): boolean {
  switch (routeClass) {
    case 'CLASS_B_PANEL_CONTROL_PLANE':
    case 'CLASS_E_PANEL_READ_ONLY':
      return senderClass === 'SIDE_PANEL';
    // The rest are not served by this listener at all. They are refused here
    // rather than omitted, so that classifying a route into one of them can
    // never make it reachable over the panel channel by accident.
    case 'CLASS_A_INTERNAL_WORKER_ONLY':
    case 'CLASS_C_CONTENT_DATA_PLANE':
    case 'CLASS_D_AUTH_CALLBACK':
    case 'CLASS_F_EVENT_CHANNEL':
      return false;
  }
}

/**
 * Whether a sender may invoke a content route.
 *
 * Content routes arrive by `chrome.tabs.sendMessage`, which a content script
 * cannot call — it has no `chrome.tabs`. That is a property of the platform,
 * not of this extension, so it is checked here as well: a boundary that holds
 * only because an API is currently unavailable is not a boundary this code
 * has established.
 */
export function senderMayInvokeContentRoute(senderClass: SenderClass): boolean {
  return senderClass === 'SERVICE_WORKER';
}

/**
 * Whether a sender may broadcast an event to the panel.
 *
 * The panel renders permission prompts from this channel. An event arriving
 * from anywhere but the worker would put text of someone else's choosing in
 * front of the person at the exact moment they are deciding whether to allow
 * something, which is the one place in this architecture where a human is the
 * control.
 */
export function senderMayBroadcastEvent(senderClass: SenderClass): boolean {
  return senderClass === 'SERVICE_WORKER';
}

/**
 * Every panel route, with the class that decides who may call it.
 *
 * Typed as a total `Record` on purpose. Adding a route to `PanelRequestMap`
 * without adding it here does not compile, so "who may call this?" is
 * answered before the route exists rather than discovered afterwards. That is
 * the whole mechanism behind R13, and it is why this table is exhaustive
 * rather than a list of exceptions.
 *
 * `CLASS_B_PANEL_CONTROL_PLANE` covers anything that mutates state, starts or resumes
 * execution, answers an authorisation, changes policy, or discloses audit,
 * evidence or log material. `CLASS_E_PANEL_READ_ONLY` is for reads that do none of
 * those. Where a route was arguable, it is in the control plane: the cost of
 * over-classifying is nothing, since both require the panel.
 */
export const PANEL_ROUTE_CLASSES: Record<PanelRequestType, RouteClass> = {
  // Tasks. Creating, resuming and retrying all reach `ToolRegistry.dispatch`.
  'task.create': 'CLASS_B_PANEL_CONTROL_PLANE',
  'task.get': 'CLASS_E_PANEL_READ_ONLY',
  'task.list': 'CLASS_E_PANEL_READ_ONLY',
  'task.pause': 'CLASS_B_PANEL_CONTROL_PLANE',
  'task.resume': 'CLASS_B_PANEL_CONTROL_PLANE',
  'task.cancel': 'CLASS_B_PANEL_CONTROL_PLANE',
  'task.retry': 'CLASS_B_PANEL_CONTROL_PLANE',

  // The plan routes.
  //
  // `plan.approve` is the one route in the product that creates a
  // `PlanApproval`, so its class *is* the authorization check: CLASS_B admits
  // the side-panel document and refuses every other sender, which is how a
  // page, a content script, a connector or a model-produced message cannot
  // approve anything. `plan.revise` creates no authorization and is CLASS_B
  // for the ordinary reason — it mutates a task and restarts its planning.
  'plan.approve': 'CLASS_B_PANEL_CONTROL_PLANE',
  'plan.revise': 'CLASS_B_PANEL_CONTROL_PLANE',

  // `session.get` creates a session when none exists, so it is not a read.
  'session.get': 'CLASS_B_PANEL_CONTROL_PLANE',
  'session.setPermissionMode': 'CLASS_B_PANEL_CONTROL_PLANE',
  // Changes a stored preference, so it is control plane like every other
  // setting write. A page must never be able to silence the agent's own
  // notifications.
  'settings.setNotificationsEnabled': 'CLASS_B_PANEL_CONTROL_PLANE',
  'settings.getNotificationsEnabled': 'CLASS_E_PANEL_READ_ONLY',

  // Providers. `listModels` and `runDoctor` mutate nothing but reach the
  // network through the guarded transport, which is not a read either.
  'provider.list': 'CLASS_E_PANEL_READ_ONLY',
  'provider.connect': 'CLASS_B_PANEL_CONTROL_PLANE',
  'provider.disconnect': 'CLASS_B_PANEL_CONTROL_PLANE',
  'provider.getConnection': 'CLASS_E_PANEL_READ_ONLY',
  'provider.listModels': 'CLASS_B_PANEL_CONTROL_PLANE',
  'provider.runDoctor': 'CLASS_B_PANEL_CONTROL_PLANE',
  'provider.setActive': 'CLASS_B_PANEL_CONTROL_PLANE',

  // Authentication. `auth.status` changes nothing and is a read; starting a
  // sign-in opens a tab and creates a session, and signing out revokes one,
  // so both are control plane. No content script or page may reach any of
  // them — an authentication a page could start is an authentication a page
  // could start without the user.
  'auth.status': 'CLASS_E_PANEL_READ_ONLY',
  'auth.signInWithGoogle': 'CLASS_B_PANEL_CONTROL_PLANE',
  // Email sign-in, both halves. Control plane for the same reason: starting
  // one sends mail to an address the caller named, and completing one creates
  // a session. A page that could reach either could mail a stranger a code,
  // or finish a sign-in the person did not start. No tool reaches them.
  'auth.startEmailSignIn': 'CLASS_B_PANEL_CONTROL_PLANE',
  'auth.verifyEmailSignIn': 'CLASS_B_PANEL_CONTROL_PLANE',
  // Control plane, not a read: a refresh rotates a credential and can end a
  // session. No tool reaches it.
  'auth.refresh': 'CLASS_B_PANEL_CONTROL_PLANE',
  'auth.signOut': 'CLASS_B_PANEL_CONTROL_PLANE',

  // Authentication identities. Listing is a read; everything that links or
  // unlinks changes how an account can be signed in to, which is as
  // control-plane as anything gets. A page that could reach these could
  // attach a sign-in method to somebody's account, or remove theirs.
  'identities.list': 'CLASS_E_PANEL_READ_ONLY',
  'identities.linkGoogle': 'CLASS_B_PANEL_CONTROL_PLANE',
  'identities.startEmailLink': 'CLASS_B_PANEL_CONTROL_PLANE',
  'identities.completeEmailLink': 'CLASS_B_PANEL_CONTROL_PLANE',
  'identities.detach': 'CLASS_B_PANEL_CONTROL_PLANE',

  // Connected AI accounts. Reads are CLASS_E; anything that creates, removes,
  // re-homes or selects an account is control plane, because each of those
  // moves a credential or changes which one a task will use. No content
  // script or page may reach any of them.
  'accounts.list': 'CLASS_E_PANEL_READ_ONLY',
  'accounts.connect': 'CLASS_B_PANEL_CONTROL_PLANE',
  'accounts.disconnect': 'CLASS_B_PANEL_CONTROL_PLANE',
  'accounts.listModels': 'CLASS_B_PANEL_CONTROL_PLANE',
  'accounts.runDoctor': 'CLASS_B_PANEL_CONTROL_PLANE',
  'accounts.setBrain': 'CLASS_B_PANEL_CONTROL_PLANE',
  'accounts.associationOffer': 'CLASS_E_PANEL_READ_ONLY',
  // Taking ownership of someone else's unowned connections is exactly the
  // kind of thing that must come from a deliberate click in the panel.
  'accounts.associate': 'CLASS_B_PANEL_CONTROL_PLANE',
  'accounts.declineAssociation': 'CLASS_B_PANEL_CONTROL_PLANE',

  'storage.getPreference': 'CLASS_E_PANEL_READ_ONLY',
  'storage.setPreference': 'CLASS_B_PANEL_CONTROL_PLANE',
  // Switching protection on, unlocking it and changing the passphrase are
  // decisions a person makes. A model that could make them could unlock the
  // credentials it is not allowed to read.
  'k1.status': 'CLASS_B_PANEL_CONTROL_PLANE',
  'k1.enable': 'CLASS_B_PANEL_CONTROL_PLANE',
  'k1.unlock': 'CLASS_B_PANEL_CONTROL_PLANE',
  'k1.lock': 'CLASS_B_PANEL_CONTROL_PLANE',
  'k1.changePassphrase': 'CLASS_B_PANEL_CONTROL_PLANE',
  'k1.disable': 'CLASS_B_PANEL_CONTROL_PLANE',
  // Moving a user's own data in or out is a control-plane act, not a read: an
  // import writes, and an export decides what leaves. Neither is CLASS_E, and
  // neither is reachable from a tool.
  'data.export': 'CLASS_B_PANEL_CONTROL_PLANE',
  'data.import': 'CLASS_B_PANEL_CONTROL_PLANE',

  // Browser workspaces. The read changes nothing and is CLASS_E; every
  // mutation is control plane, because each one changes which tabs the agent
  // may see. None is reachable by a content script or a page, and none is
  // exposed to the model: a model that could switch workspace or add a tab
  // could widen its own reach, which is the opposite of what the boundary is
  // for.
  'workspace.state': 'CLASS_E_PANEL_READ_ONLY',
  'workspace.create': 'CLASS_B_PANEL_CONTROL_PLANE',
  'workspace.switch': 'CLASS_B_PANEL_CONTROL_PLANE',
  'workspace.addCurrentTab': 'CLASS_B_PANEL_CONTROL_PLANE',
  'workspace.removeTab': 'CLASS_B_PANEL_CONTROL_PLANE',
  'workspace.reattach': 'CLASS_B_PANEL_CONTROL_PLANE',

  'connector.list': 'CLASS_E_PANEL_READ_ONLY',
  'connector.authorize': 'CLASS_B_PANEL_CONTROL_PLANE',
  'connector.disconnect': 'CLASS_B_PANEL_CONTROL_PLANE',
  'connector.pendingWrites': 'CLASS_E_PANEL_READ_ONLY',
  'connector.resolveWrite': 'CLASS_B_PANEL_CONTROL_PLANE',

  // File selection. The listing is a request-id oracle, so it is classed with
  // the route those ids unlock rather than as a harmless read.
  'file.respondSelection': 'CLASS_B_PANEL_CONTROL_PLANE',
  'file.listPendingSelections': 'CLASS_B_PANEL_CONTROL_PLANE',
  'file.downloadsPermission': 'CLASS_E_PANEL_READ_ONLY',

  // The same reasoning, and the sharpest case: `listPending` hands out live
  // request ids, and `respond` turns one into an approval — including
  // `approve_site`, which writes a lasting rule.
  'permission.respond': 'CLASS_B_PANEL_CONTROL_PLANE',
  'permission.listPending': 'CLASS_B_PANEL_CONTROL_PLANE',

  // Reading health changes nothing. Acknowledging is the only way down the
  // severity ladder, which makes it a control-plane action even though it
  // repairs nothing: it is what lets work start again.
  'health.get': 'CLASS_E_PANEL_READ_ONLY',
  'health.acknowledge': 'CLASS_B_PANEL_CONTROL_PLANE',

  'policy.getSitePolicy': 'CLASS_E_PANEL_READ_ONLY',
  'policy.removeSiteRule': 'CLASS_B_PANEL_CONTROL_PLANE',

  // Audit reads are panel-only like everything else; export is in the control
  // plane because it produces a cross-task artefact.
  'audit.list': 'CLASS_E_PANEL_READ_ONLY',
  'audit.integrity': 'CLASS_E_PANEL_READ_ONLY',
  'audit.export': 'CLASS_B_PANEL_CONTROL_PLANE',

  // `getPayload` returns captured page content rather than identifiers, which
  // makes it the one disclosure route that is not metadata.
  'evidence.listForTask': 'CLASS_E_PANEL_READ_ONLY',
  'evidence.getPayload': 'CLASS_B_PANEL_CONTROL_PLANE',

  'debug.getLogs': 'CLASS_B_PANEL_CONTROL_PLANE',
  'debug.setLogLevel': 'CLASS_B_PANEL_CONTROL_PLANE',

  'skill.list': 'CLASS_E_PANEL_READ_ONLY',
  'skill.runs': 'CLASS_E_PANEL_READ_ONLY',
  'skill.run': 'CLASS_B_PANEL_CONTROL_PLANE',
  // Changes what the agent can reach, so control-plane: a page, a content
  // script or a model-originated message cannot switch a skill back on.
  'skill.setEnabled': 'CLASS_B_PANEL_CONTROL_PLANE',

  'workflow.recordStart': 'CLASS_B_PANEL_CONTROL_PLANE',
  'workflow.recordStop': 'CLASS_B_PANEL_CONTROL_PLANE',
  'workflow.recordCancel': 'CLASS_B_PANEL_CONTROL_PLANE',
  'workflow.recordStatus': 'CLASS_E_PANEL_READ_ONLY',
  'workflow.list': 'CLASS_E_PANEL_READ_ONLY',
  'workflow.get': 'CLASS_E_PANEL_READ_ONLY',
  'workflow.remove': 'CLASS_B_PANEL_CONTROL_PLANE',
  'workflow.revalidate': 'CLASS_E_PANEL_READ_ONLY',
  'workflow.replay': 'CLASS_B_PANEL_CONTROL_PLANE',
  'workflow.cancelReplay': 'CLASS_B_PANEL_CONTROL_PLANE',

  // Schedules (P-020). Reads are read-only; everything that changes a
  // schedule, or runs one, is the panel's control plane. `schedule.runNow`
  // executes, which is exactly why it is CLASS_B and not CLASS_E — and there
  // is no route here a model could reach whatever class it carried, because
  // nothing in this map is a tool.
  'schedule.list': 'CLASS_E_PANEL_READ_ONLY',
  'schedule.runs': 'CLASS_E_PANEL_READ_ONLY',
  'schedule.create': 'CLASS_B_PANEL_CONTROL_PLANE',
  'schedule.edit': 'CLASS_B_PANEL_CONTROL_PLANE',
  'schedule.setEnabled': 'CLASS_B_PANEL_CONTROL_PLANE',
  'schedule.remove': 'CLASS_B_PANEL_CONTROL_PLANE',
  'schedule.runNow': 'CLASS_B_PANEL_CONTROL_PLANE',
  'schedule.cancelRun': 'CLASS_B_PANEL_CONTROL_PLANE',
  'shortcut.list': 'CLASS_E_PANEL_READ_ONLY',
  'shortcut.create': 'CLASS_B_PANEL_CONTROL_PLANE',
  'shortcut.retarget': 'CLASS_B_PANEL_CONTROL_PLANE',
  'shortcut.remove': 'CLASS_B_PANEL_CONTROL_PLANE',
  'shortcut.resolve': 'CLASS_E_PANEL_READ_ONLY',

  'tools.list': 'CLASS_E_PANEL_READ_ONLY',
};

/**
 * The class of a route, or `undefined` when it has none.
 *
 * Takes a plain string rather than a `PanelRequestType` because the value
 * being looked up came off the wire. `undefined` is the default-deny case and
 * the caller must treat it as a refusal.
 */
export function panelRouteClass(type: string): RouteClass | undefined {
  return Object.prototype.hasOwnProperty.call(PANEL_ROUTE_CLASSES, type)
    ? PANEL_ROUTE_CLASSES[type as PanelRequestType]
    : undefined;
}
