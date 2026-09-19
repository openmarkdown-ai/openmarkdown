/**
 * Background: a service worker in Chromium, an event page in Firefox.
 *
 * - Context menus and keyboard commands.
 * - The app bridge: registers the bridge content script on the configured app
 *   origins, keeps one port per app tab, delivers clips (opening an app tab
 *   when none is open) and waits for the app's acknowledgement.
 * - The network bridge: fetches on behalf of app pages, without CORS, only
 *   for configured origins the user consented to, with credentials omitted and
 *   a response size cap.
 * - Quick clip: no UI. The engine needs a DOM-capable page, so Chromium builds
 *   the note in an offscreen document; Firefox's background page has a DOM.
 *
 * No wasm runs in the service worker.
 */
import {
  PROTOCOL_VERSION,
  type AppHello,
  type AppToExt,
  type ClipRequest,
  type ClipResult,
  type ExtStatus,
  type FetchRequest,
  type FetchResponse,
  type SetFramingHosts,
  type VaultRef,
} from "../../../../packages/app/src/companion/protocol";
import { capturePage } from "../shared/capture";
import type { ClipIntent, ConnectedVaults, DeliverResult, OutgoingClip, RuntimeMessage } from "../shared/messages";
import {
  appEntryUrl,
  getHighlights,
  getSettings,
  getTemplates,
  isAppOrigin,
  newId,
  originMatchPattern,
  saveSettings,
  type Settings,
} from "../shared/settings";
import { findMatchingTemplate } from "../shared/templates";


const BRIDGE_SCRIPT_ID = "app-bridge";
const CLIP_TIMEOUT_MS = 90_000;
/** Once the app says it is running a clip's prompts through its AI (a local model can be slow). */
const INTERPRET_TIMEOUT_MS = 10 * 60_000;
const CONSENT_TIMEOUT_MS = 120_000;

// ---- app ports ------------------------------------------------------------------

interface AppConnection {
  port: chrome.runtime.Port;
  tabId: number;
  windowId?: number;
  origin: string;
  vault?: VaultRef;
}

const connections = new Map<chrome.runtime.Port, AppConnection>();
const helloWaiters: (() => void)[] = [];
const clipWaiters = new Map<string, (r: ClipResult) => void>();
const clipProgress = new Map<string, () => void>();
/** Clip ids already posted to a tab in this worker's lifetime. */
const delivered = new Set<string>();

interface PendingClip {
  id: string;
  origin: string;
  vaultId?: string;
  clip: OutgoingClip;
  createdAt: number;
}

async function pendingClips(): Promise<Record<string, PendingClip>> {
  const got = await chrome.storage.session.get("pendingClips");
  return (got.pendingClips as Record<string, PendingClip> | undefined) ?? {};
}

async function setPendingClips(all: Record<string, PendingClip>) {
  const now = Date.now();
  for (const [id, p] of Object.entries(all)) if (now - p.createdAt > 10 * 60_000) delete all[id];
  await chrome.storage.session.set({ pendingClips: all });
}

function toClipMessage(p: PendingClip): ClipRequest {
  return { type: "clip", id: p.id, vaultId: p.vaultId, path: p.clip.path, content: p.clip.content, behavior: p.clip.behavior, silent: p.clip.silent, interpreter: p.clip.interpreter };
}

async function statusFor(origin: string, settings?: Settings): Promise<ExtStatus> {
  const s = settings ?? (await getSettings());
  const granted = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  return {
    type: "ext-status",
    bridgeEnabled: s.bridge.enabled && granted,
    consent: s.bridge.consent[origin] ?? "ask",
    maxResponseBytes: s.bridge.maxResponseMB * 1024 * 1024,
    framingHosts: s.framingHosts[origin] ?? [],
  };
}

async function broadcastStatus() {
  const s = await getSettings();
  for (const c of connections.values()) {
    try {
      c.port.postMessage(await statusFor(c.origin, s));
    } catch {
      /* port went away */
    }
  }
}

function senderOrigin(port: chrome.runtime.Port): string | null {
  const url = port.sender?.url ?? port.sender?.tab?.url;
  const origin = (port.sender as { origin?: string } | undefined)?.origin;
  try {
    return origin && origin !== "null" ? origin : url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

async function onAppPort(port: chrome.runtime.Port) {
  const origin = senderOrigin(port);
  const tabId = port.sender?.tab?.id;
  const settings = await getSettings();
  if (!origin || tabId === undefined || !isAppOrigin(origin, settings.appOrigins)) {
    port.disconnect();
    return;
  }
  const conn: AppConnection = { port, tabId, windowId: port.sender?.tab?.windowId, origin };
  connections.set(port, conn);
  port.onDisconnect.addListener(() => connections.delete(port));
  port.onMessage.addListener((msg: AppToExt) => void onAppMessage(conn, msg));
  port.postMessage(await statusFor(origin, settings));
}

async function onAppMessage(conn: AppConnection, msg: AppToExt) {
  switch (msg?.type) {
    case "app-hello":
      await onHello(conn, msg);
      break;
    case "fetch":
      conn.port.postMessage(await bridgeFetch(conn, msg));
      break;
    case "clip-result":
      clipWaiters.get(msg.id)?.(msg);
      break;
    case "clip-progress":
      clipProgress.get(msg.id)?.();
      break;
    case "set-framing-hosts":
      conn.port.postMessage(await setFramingHosts(conn, msg));
      break;
  }
}

// ---- framing rules ------------------------------------------------------------------
//
// The web viewer shows sites in an iframe; many send X-Frame-Options or a CSP
// `frame-ancestors` and refuse. For hosts the user allowed from the app, a dynamic
// declarativeNetRequest rule strips those two headers — only for sub-frames whose
// initiator is that app origin, so the same sites stay protected everywhere else.
// Requires the network bridge (on, `<all_urls>` granted, this origin consented).

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const FRAMING_RULE_BASE = 50_000;

function ruleIdFor(origin: string, index: number): number {
  let h = 0;
  for (const ch of origin) h = (h * 31 + ch.charCodeAt(0)) % 1000;
  return FRAMING_RULE_BASE + h * 100 + index;
}

async function applyFramingRules(all: Record<string, string[]>) {
  const dnr = (chrome as unknown as { declarativeNetRequest?: typeof chrome.declarativeNetRequest }).declarativeNetRequest;
  if (!dnr?.updateDynamicRules) throw new Error("This browser does not let extensions change response headers.");
  const existing = await dnr.getDynamicRules();
  const removeRuleIds = existing.filter((r) => r.id >= FRAMING_RULE_BASE && r.id < FRAMING_RULE_BASE + 100_000).map((r) => r.id);
  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  for (const [origin, hosts] of Object.entries(all)) {
    if (!hosts.length) continue;
    const initiator = new URL(origin).hostname;
    addRules.push({
      id: ruleIdFor(origin, 0),
      priority: 1,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        responseHeaders: [
          { header: "x-frame-options", operation: "remove" as chrome.declarativeNetRequest.HeaderOperation },
          { header: "content-security-policy", operation: "remove" as chrome.declarativeNetRequest.HeaderOperation },
        ],
      },
      condition: {
        requestDomains: hosts,
        initiatorDomains: [initiator],
        resourceTypes: ["sub_frame" as chrome.declarativeNetRequest.ResourceType],
      },
    });
  }
  await dnr.updateDynamicRules({ removeRuleIds, addRules });
}

async function setFramingHosts(conn: AppConnection, msg: SetFramingHosts) {
  const s = await getSettings();
  const current = s.framingHosts[conn.origin] ?? [];
  const status = await statusFor(conn.origin, s);
  if (!status.bridgeEnabled || status.consent !== "granted") {
    return { type: "framing-result" as const, id: msg.id, ok: false, hosts: current, error: "Turn on the network bridge in the extension and allow this app to use it first." };
  }
  const hosts = [...new Set((Array.isArray(msg.hosts) ? msg.hosts : []).map((h) => String(h).trim().toLowerCase()))].filter((h) => HOST_RE.test(h)).slice(0, 200);
  const framingHosts = { ...s.framingHosts, [conn.origin]: hosts };
  try {
    await applyFramingRules(framingHosts);
  } catch (e) {
    return { type: "framing-result" as const, id: msg.id, ok: false, hosts: current, error: e instanceof Error ? e.message : String(e) };
  }
  await saveSettings({ framingHosts });
  return { type: "framing-result" as const, id: msg.id, ok: true, hosts };
}

async function onHello(conn: AppConnection, hello: AppHello) {
  if (hello.protocol !== PROTOCOL_VERSION) console.warn(`app speaks protocol ${hello.protocol}, extension ${PROTOCOL_VERSION}`);
  conn.vault = hello.vault;
  const s = await getSettings();
  const others = s.knownVaults.filter((v) => v.origin !== conn.origin);
  const known = [...others, ...hello.vaults.map((v) => ({ ...v, origin: conn.origin }))];
  if (JSON.stringify(known) !== JSON.stringify(s.knownVaults)) await saveSettings({ knownVaults: known });
  conn.port.postMessage(await statusFor(conn.origin, s));
  helloWaiters.splice(0).forEach((w) => w());
  // Deliver clips waiting for this tab: the one named in its URL, or any for this vault.
  const all = await pendingClips();
  for (const p of Object.values(all)) {
    const forUrl = hello.pendingClip === p.id;
    const forVault = p.origin === conn.origin && (!p.vaultId || p.vaultId === hello.vault.id) && !delivered.has(p.id);
    if (forUrl || forVault) {
      delivered.add(p.id);
      conn.port.postMessage(toClipMessage(p));
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === BRIDGE_SCRIPT_ID) void onAppPort(port);
});
if (!__FIREFOX__) {
  // Chromium pages on the manifest's externally_connectable origins may also
  // connect directly with chrome.runtime.connect(extensionId); same protocol.
  chrome.runtime.onConnectExternal?.addListener((port) => void onAppPort(port));
}

// ---- bridge content script registration ------------------------------------------

async function syncBridgeScripts() {
  const s = await getSettings();
  const patterns = [...new Set(s.appOrigins.map((o) => originMatchPattern(o, __FIREFOX__)))];
  const granted: string[] = [];
  for (const p of patterns) if (await chrome.permissions.contains({ origins: [p] }).catch(() => false)) granted.push(p);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
  } catch {
    /* not registered */
  }
  if (!granted.length) return;
  await chrome.scripting.registerContentScripts([
    { id: BRIDGE_SCRIPT_ID, matches: granted, js: ["content/app-bridge.js"], runAt: "document_start", allFrames: false, persistAcrossSessions: true },
  ]);
  // Tabs already open on an app origin get the script now.
  const tabs = await chrome.tabs.query({ url: granted });
  for (const t of tabs) {
    if (t.id === undefined || !t.url || !isAppOrigin(new URL(t.url).origin, s.appOrigins)) continue;
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content/app-bridge.js"] }).catch(() => {});
  }
}

// ---- clip delivery -------------------------------------------------------------------

/** The most recent app tab for `origin` (any app origin when absent) holding `vaultId` (any vault when absent). */
function pickConnection(origin: string | undefined, vaultId: string | undefined, preferOrigin?: string): AppConnection | null {
  let best: AppConnection | null = null;
  for (const c of connections.values()) {
    if (!c.vault || (origin && c.origin !== origin) || (vaultId && c.vault.id !== vaultId)) continue;
    if (best && preferOrigin && best.origin === preferOrigin && c.origin !== preferOrigin) continue;
    best = c;
  }
  return best;
}

async function wakeAppTabs(appOrigins: string[]): Promise<void> {
  const patterns = [...new Set(appOrigins.map((o) => originMatchPattern(o, __FIREFOX__)))];
  const tabs = await chrome.tabs.query({ url: patterns }).catch(() => [] as chrome.tabs.Tab[]);
  const targets = tabs.filter((t) => t.id !== undefined && t.url && isAppOrigin(new URL(t.url).origin, appOrigins));
  if (!targets.length) return;
  const waited = new Promise<void>((resolve) => {
    helloWaiters.push(resolve);
    setTimeout(resolve, 2000);
  });
  for (const t of targets) {
    const msg: RuntimeMessage = { kind: "bridge-reconnect" };
    await chrome.tabs.sendMessage(t.id!, msg).catch(async () => {
      await chrome.scripting.executeScript({ target: { tabId: t.id! }, files: ["content/app-bridge.js"] }).catch(() => {});
    });
  }
  await waited;
}

/**
 * Sends a clip to the app. With no origin, any open app tab will do (the
 * default origin preferred); with no vault, the vault open in that tab. When
 * no tab qualifies, one is opened at `<origin>/?vault=<id>&clip=<id>` and the
 * clip is delivered when its bridge says hello.
 */
async function deliverClip(clip: OutgoingClip, originIn?: string, vaultIn?: string): Promise<DeliverResult> {
  const s = await getSettings();
  const vaultId = vaultIn || s.defaultVault || undefined;
  if (originIn && !isAppOrigin(originIn, s.appOrigins)) return { ok: false, error: `${originIn} is not one of the app addresses in the extension's options.` };

  let conn = pickConnection(originIn, vaultId, s.defaultAppOrigin);
  if (!conn) {
    await wakeAppTabs(originIn ? [originIn] : s.appOrigins);
    conn = pickConnection(originIn, vaultId, s.defaultAppOrigin);
  }
  const origin = conn?.origin ?? originIn ?? s.defaultAppOrigin;
  if (!isAppOrigin(origin, s.appOrigins)) return { ok: false, error: `${origin} is not one of the app addresses in the extension's options.` };

  const pending: PendingClip = { id: newId(), origin, vaultId, clip: { ...clip, silent: clip.silent ?? s.silentOpen }, createdAt: Date.now() };
  const all = await pendingClips();
  all[pending.id] = pending;
  await setPendingClips(all);

  const result = new Promise<ClipResult>((resolve) => {
    const timeout = () => resolve({ type: "clip-result", id: pending.id, ok: false, error: "The app did not confirm the clip in time. Is it open and unlocked?" });
    let timer = setTimeout(timeout, CLIP_TIMEOUT_MS);
    clipProgress.set(pending.id, () => {
      clearTimeout(timer);
      timer = setTimeout(timeout, INTERPRET_TIMEOUT_MS);
    });
    clipWaiters.set(pending.id, (r) => {
      if (!r.ok && r.error?.startsWith("wrong-vault")) return; // another tab; keep waiting
      clearTimeout(timer);
      resolve(r);
    });
  });

  let targetTab: number | undefined;
  if (conn) {
    delivered.add(pending.id);
    targetTab = conn.tabId;
    conn.port.postMessage(toClipMessage(pending));
  } else {
    const url = appEntryUrl(origin);
    if (vaultId) url.searchParams.set("vault", vaultId);
    url.searchParams.set("clip", pending.id);
    targetTab = (await chrome.tabs.create({ url: url.toString(), active: !pending.clip.silent })).id;
  }

  const r = await result;
  clipWaiters.delete(pending.id);
  clipProgress.delete(pending.id);
  delivered.delete(pending.id);
  const left = await pendingClips();
  delete left[pending.id];
  await setPendingClips(left);
  if (r.ok && !pending.clip.silent && targetTab !== undefined) {
    const tab = await chrome.tabs.update(targetTab, { active: true }).catch(() => undefined);
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  return { ok: r.ok, path: r.path, error: r.error, interpreter: r.interpreter };
}

// ---- network bridge ------------------------------------------------------------------

const consentPrompts = new Map<string, Promise<boolean>>();

function askConsent(origin: string): Promise<boolean> {
  const existing = consentPrompts.get(origin);
  if (existing) return existing;
  const prompt = new Promise<boolean>((resolve) => {
    let windowId: number | undefined;
    const done = (granted: boolean | null) => {
      chrome.runtime.onMessage.removeListener(onAnswer);
      chrome.windows.onRemoved.removeListener(onClosed);
      clearTimeout(timer);
      consentPrompts.delete(origin);
      resolve(granted === true);
    };
    const onAnswer = (msg: RuntimeMessage) => {
      if (msg?.kind === "consent-answer" && msg.origin === origin) {
        // Settle now: the consent window closes itself right after sending.
        done(msg.granted);
        void (async () => {
          const s = await getSettings();
          await saveSettings({ bridge: { ...s.bridge, consent: { ...s.bridge.consent, [origin]: msg.granted ? "granted" : "denied" } } });
          await broadcastStatus();
          if (windowId !== undefined) chrome.windows.remove(windowId).catch(() => {});
        })();
      }
    };
    const onClosed = (id: number) => {
      if (id === windowId) done(null);
    };
    const timer = setTimeout(() => done(null), CONSENT_TIMEOUT_MS);
    chrome.runtime.onMessage.addListener(onAnswer);
    chrome.windows.onRemoved.addListener(onClosed);
    const url = chrome.runtime.getURL(`consent.html?origin=${encodeURIComponent(origin)}`);
    chrome.windows.create({ url, type: "popup", width: 460, height: 360, focused: true }).then(
      (w) => (windowId = w?.id),
      () => done(null),
    );
  });
  consentPrompts.set(origin, prompt);
  return prompt;
}

const DROP_REQUEST_HEADERS = new Set(["cookie", "cookie2", "host", "origin", "referer", "content-length", "connection", "proxy-authorization"]);

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function bridgeFetch(conn: AppConnection, req: FetchRequest): Promise<FetchResponse> {
  const fail = (code: FetchResponse["code"], error: string): FetchResponse => ({ type: "fetch-result", id: req.id, code, error });
  const s = await getSettings();
  if (!isAppOrigin(conn.origin, s.appOrigins)) return fail("origin", `${conn.origin} is not an app origin.`);
  if (!s.bridge.enabled || !(await chrome.permissions.contains({ origins: ["<all_urls>"] })))
    return fail("disabled", "The network bridge is off. Turn it on in the extension's options.");
  let consent = s.bridge.consent[conn.origin];
  if (consent === "denied") return fail("denied", `Network requests from ${conn.origin} were refused in the extension.`);
  if (consent !== "granted") {
    consent = (await askConsent(conn.origin)) ? "granted" : "denied";
    if (consent !== "granted") return fail("denied", `Network requests from ${conn.origin} were not allowed.`);
  }
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return fail("bad-request", `Invalid URL: ${req.url}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return fail("bad-request", `Only http and https URLs can be fetched (${url.protocol}).`);
  const method = (req.method || "GET").toUpperCase();
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers ?? {})) if (!DROP_REQUEST_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  const cap = s.bridge.maxResponseMB * 1024 * 1024;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" || !req.body ? undefined : (b64decode(req.body) as BodyInit),
      credentials: "omit",
      redirect: "follow",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > cap) return fail("too-large", `The response is ${declared} bytes; the bridge allows ${cap}.`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > cap) {
          await reader.cancel();
          return fail("too-large", `The response is larger than ${cap} bytes.`);
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      body.set(c, at);
      at += c.length;
    }
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "set-cookie") outHeaders[k] = v;
    });
    return { type: "fetch-result", id: req.id, status: res.status, headers: outHeaders, body: b64encode(body) };
  } catch (e) {
    return fail("network", e instanceof Error ? e.message : String(e));
  }
}

// ---- menus, commands, UI entry points --------------------------------------------------

const MENU = {
  page: "clip-page",
  selection: "clip-selection",
  link: "clip-link",
  highlighter: "toggle-highlighter",
  reader: "toggle-reader",
  sidePanel: "open-side-panel",
} as const;

async function createMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU.page, title: "Clip this page", contexts: ["page"] });
  chrome.contextMenus.create({ id: MENU.selection, title: "Clip selection", contexts: ["selection"] });
  chrome.contextMenus.create({ id: MENU.link, title: "Clip link", contexts: ["link"] });
  chrome.contextMenus.create({ id: MENU.highlighter, title: "Toggle highlighter", contexts: ["page", "selection"] });
  chrome.contextMenus.create({ id: MENU.reader, title: "Toggle reader view", contexts: ["page"] });
  if (!__FIREFOX__) chrome.contextMenus.create({ id: MENU.sidePanel, title: "Open side panel", contexts: ["page", "selection", "link"] });
}

async function setIntent(intent: ClipIntent) {
  await chrome.storage.session.set({ [`intent:${intent.tabId}`]: intent });
}

/** Opens the clipper UI next to the page: the side panel in Chromium, the sidebar in Firefox. */
function openClipperUi(tab: chrome.tabs.Tab) {
  if (__FIREFOX__) {
    // Must run synchronously inside the user gesture.
    void (globalThis as unknown as { browser: { sidebarAction: { open(): Promise<void> } } }).browser.sidebarAction.open();
    return;
  }
  if (tab.windowId !== undefined && tab.id !== undefined) void chrome.sidePanel.open({ tabId: tab.id });
}

async function toggleContentScript(tabId: number, file: string) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const tabId = tab.id;
  switch (info.menuItemId) {
    case MENU.page:
    case MENU.selection:
    case MENU.link:
    case MENU.sidePanel: {
      openClipperUi(tab);
      const mode = info.menuItemId === MENU.selection ? "selection" : info.menuItemId === MENU.link ? "link" : "page";
      void setIntent({ mode, tabId, linkUrl: info.linkUrl, at: Date.now() });
      break;
    }
    case MENU.highlighter:
      void toggleContentScript(tabId, "content/highlighter.js");
      break;
    case MENU.reader:
      void toggleContentScript(tabId, "content/reader.js");
      break;
  }
});

async function setBadge(tabId: number, text: string, color: string) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  setTimeout(() => void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}), 4000);
}

async function ensureOffscreen() {
  const offscreen = (chrome as unknown as { offscreen: typeof chrome.offscreen }).offscreen;
  const contexts = await (chrome.runtime as unknown as { getContexts(f: object): Promise<unknown[]> }).getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return;
  await offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER" as chrome.offscreen.Reason],
    justification: "Convert the captured page to Markdown with the bundled WebAssembly engine.",
  });
}

async function quickClip(tabId: number) {
  try {
    const [page, templates, settings] = await Promise.all([capturePage(tabId), getTemplates(), getSettings()]);
    const highlights = await getHighlights(page.url);
    let template = templates[0]!;
    if (templates.some((t) => t.triggers.length)) {
      // Schema triggers need the page's JSON-LD; read it from the capture without the engine.
      const schema: unknown[] = [];
      for (const m of page.html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
          schema.push(JSON.parse(m[1]!));
        } catch {
          /* malformed JSON-LD is ignored, as Defuddle does */
        }
      }
      template = findMatchingTemplate(templates, page.url, schema) ?? template;
    }
    let note: { path: string; content: string; interpreter?: OutgoingClip["interpreter"] };
    if (__FIREFOX__) {
      const { buildClip, assembleNote } = await import("../shared/clip");
      note = assembleNote(await buildClip(page, template, { settings, highlights }), settings);
    } else {
      await ensureOffscreen();
      const msg: RuntimeMessage = { kind: "build-note", target: "offscreen", page, template, settings, highlights };
      const res = (await chrome.runtime.sendMessage(msg)) as { path: string; content: string; interpreter?: OutgoingClip["interpreter"] } | { error: string };
      if ("error" in res) throw new Error(res.error);
      note = res;
    }
    const r = await deliverClip({ path: note.path, content: note.content, behavior: template.behavior, interpreter: note.interpreter }, undefined, template.vault);
    await setBadge(tabId, r.ok ? "ok" : "!", r.ok ? "#00c896" : "#ff4d4d");
    if (!r.ok) console.warn("Quick clip failed:", r.error);
  } catch (e) {
    console.warn("Quick clip failed:", e);
    await setBadge(tabId, "!", "#ff4d4d");
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  const run = async () => {
    const t = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!t?.id) return;
    if (command === "quick_clip") await quickClip(t.id);
    else if (command === "toggle_highlighter") await toggleContentScript(t.id, "content/highlighter.js");
    else if (command === "toggle_reader") await toggleContentScript(t.id, "content/reader.js");
  };
  void run();
});

// ---- runtime messages from the extension's own pages ------------------------------------

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  // Only the extension's own pages and scripts talk to the background this way.
  if (sender.id !== chrome.runtime.id) return false;
  switch (msg?.kind) {
    case "deliver-clip":
      void deliverClip(msg.clip, msg.origin, msg.vaultId).then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case "settings-changed":
      void syncBridgeScripts()
        .then(broadcastStatus)
        .then(() => sendResponse({ ok: true }), (e: unknown) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case "connected-vaults": {
      const out: ConnectedVaults = { tabs: [...connections.values()].map((c) => ({ tabId: c.tabId, origin: c.origin, vault: c.vault })) };
      sendResponse(out);
      return false;
    }
  }
  return false;
});

chrome.permissions.onAdded?.addListener(() => void syncBridgeScripts().then(broadcastStatus));
chrome.permissions.onRemoved?.addListener(() => void syncBridgeScripts().then(broadcastStatus));

chrome.runtime.onInstalled.addListener(() => {
  void createMenus();
  void syncBridgeScripts();
  if (!__FIREFOX__) void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => void syncBridgeScripts());

// internal (e2e tests drive the keyboard-command paths through this; commands cannot be synthesised)
(globalThis as unknown as { __vaultClipper: object }).__vaultClipper = { quickClip, deliverClip };
