/**
 * Pop-out windows: `workspace.openPopoutLeaf()`, "Open in new window",
 * "Move to new window", and the floating (always-on-top) window.
 *
 * A pop-out is a same-origin `window.open("")` document driven by *this* page:
 * one App, one vault, one set of plugins, as in Obsidian where every window
 * shares the app instance. The leaf's DOM lives in the other document, and the
 * API plugins use for multi-window support behaves as in Obsidian:
 *
 * - `leaf.getContainer()` is a `WorkspaceWindow` with `win` / `doc`, and it
 *   sits in `workspace.floatingSplit`;
 * - `el.win`, `el.doc`, `activeWindow`, `activeDocument` follow focus;
 * - `workspace.on("window-open", (win: WorkspaceWindow, window: Window))` and
 *   `"window-close"` fire;
 * - the second window's DOM prototypes get the same helpers (`createDiv`,
 *   `addClass` …) so plugin code that calls `activeDocument.createElement(…)`
 *   keeps working, and CodeMirror editors are re-rooted into that document.
 *
 * The floating variant uses Document Picture-in-Picture where available.
 * If the browser blocks the window, the leaf opens in a split and a notice says so.
 *
 * Installed from boot.ts by patching `Workspace.prototype`, so workspace.ts
 * only needs to call `openPopoutLeaf` / `moveLeafToPopout` as it already does.
 */
import { EditorView } from "@codemirror/view";
import { Notice } from "../ui/notice";
import { readResource } from "../vault/resource";
import { WorkspaceTabs, WorkspaceWindow } from "./items";
import { WorkspaceLeaf } from "./leaf";

type AnyWorkspace = any;

const DOM_INTERFACES = [
  "EventTarget",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Document",
  "DocumentFragment",
  "Text",
  "UIEvent",
  "MouseEvent",
  "KeyboardEvent",
  "DragEvent",
  "TouchEvent",
  "PointerEvent",
  "FocusEvent",
];
const GLOBAL_HELPERS = ["createEl", "createDiv", "createSpan", "createSvg", "createFragment", "fish", "fishAll", "ready", "sleep", "nextFrame", "ajax", "ajaxPromise", "isBoolean", "moment", "i18next", "app"];

/** Gives another window's realm the DOM helpers `installDomExtensions` put on this one. */
export function extendWindow(win: Window) {
  const src = window as unknown as Record<string, any>;
  const dst = win as unknown as Record<string, any>;
  if (dst.__openmarkdownExtended) return;
  dst.__openmarkdownExtended = true;
  for (const name of DOM_INTERFACES) {
    const from = src[name]?.prototype;
    const to = dst[name]?.prototype;
    if (!from || !to || from === to) continue;
    for (const key of Reflect.ownKeys(from)) {
      if (Object.prototype.hasOwnProperty.call(to, key)) continue;
      const desc = Object.getOwnPropertyDescriptor(from, key);
      if (!desc || !desc.configurable) continue;
      // Only the helpers added by dom.ts: native members already exist on the other prototype.
      try {
        Object.defineProperty(to, key, desc);
      } catch {
        /* non-configurable in this realm */
      }
    }
  }
  for (const key of GLOBAL_HELPERS) if (key in src && !(key in dst)) dst[key] = src[key];
}

let focusTracking = false;
function setActiveWindow(win: Window) {
  for (const w of [window, win] as unknown as Record<string, unknown>[]) {
    w.activeWindow = win;
    w.activeDocument = win.document;
  }
}

function trackMainWindowFocus() {
  if (focusTracking) return;
  focusTracking = true;
  window.addEventListener("focus", () => setActiveWindow(window));
}

function syncHead(doc: Document): () => void {
  const clones = new Map<Node, Node>();
  const sync = () => {
    const wanted = Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]'));
    for (const [orig, clone] of clones) {
      if (!wanted.includes(orig as Element)) {
        (clone as ChildNode).remove();
        clones.delete(orig);
      }
    }
    for (const orig of wanted) {
      let clone = clones.get(orig) as HTMLElement | undefined;
      if (!clone) {
        clone = doc.importNode(orig, true) as HTMLElement;
        if (orig instanceof HTMLLinkElement) (clone as HTMLLinkElement).href = orig.href;
        clones.set(orig, clone);
      } else if (orig instanceof HTMLStyleElement && clone.textContent !== orig.textContent) {
        clone.textContent = orig.textContent;
      }
      doc.head.appendChild(clone);
    }
  };
  sync();
  let pending = 0;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = window.setTimeout(() => {
      pending = 0;
      sync();
    }, 50);
  });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
  return () => observer.disconnect();
}

function syncBody(doc: Document, extraClasses: string[]): () => void {
  const copy = () => {
    doc.body.className = document.body.className;
    for (const c of extraClasses) doc.body.classList.add(c);
    doc.body.setAttribute("style", document.body.getAttribute("style") ?? "");
    doc.documentElement.className = document.documentElement.className;
    doc.documentElement.setAttribute("style", document.documentElement.getAttribute("style") ?? "");
    doc.documentElement.lang = document.documentElement.lang;
  };
  copy();
  const observer = new MutationObserver(copy);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  return () => observer.disconnect();
}

/** CodeMirror binds selection and resize listeners to its document; move them with the editor. */
function rerootEditors(doc: Document): () => void {
  const fix = (root: ParentNode) => {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(".cm-editor"))) {
      const view = EditorView.findFromDOM(el);
      if (view && view.root !== doc && el.ownerDocument === doc) view.setRoot(doc);
    }
  };
  fix(doc);
  let queued = false;
  const observer = new MutationObserver((records) => {
    if (queued || !records.some((r) => r.addedNodes.length)) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      fix(doc);
    });
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

export interface PreparedWindow {
  win: Window;
  dispose(): void;
}

/**
 * Makes a blank same-origin window (a pop-up or a Picture-in-Picture window)
 * look and behave like this one: styles, theme classes, DOM helpers, hotkeys,
 * focus tracking, and vault resources for images.
 */
export function prepareWindow(app: any, win: Window, opts: { title?: string; classes?: string[] } = {}): PreparedWindow {
  const doc = win.document;
  extendWindow(win);
  trackMainWindowFocus();
  if (!doc.head) doc.documentElement.prepend(doc.createElement("head"));
  if (!doc.body) doc.documentElement.append(doc.createElement("body"));
  doc.title = opts.title ?? document.title;
  const meta = doc.createElement("meta");
  meta.name = "color-scheme";
  meta.content = "light dark";
  doc.head.appendChild(meta);
  const disposers: (() => void)[] = [];
  disposers.push(syncHead(doc));
  disposers.push(syncBody(doc, ["is-popout-window", ...(opts.classes ?? [])]));
  disposers.push(rerootEditors(doc));

  const onKey = (evt: KeyboardEvent) => (app as { onKeyDown?: (e: KeyboardEvent) => void }).onKeyDown?.(evt);
  doc.addEventListener("keydown", onKey, true);
  const onFocus = () => setActiveWindow(win);
  win.addEventListener("focus", onFocus);
  setActiveWindow(win);

  // The service worker asks the window that requested an image for its bytes.
  const sw = (win.navigator as Navigator).serviceWorker;
  const onSwMessage = async (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; url?: string } | null;
    if (msg?.type !== "vault-resource" || !msg.url || !ev.ports[0]) return;
    const port = ev.ports[0];
    try {
      const res = await readResource(msg.url);
      if (!res) port.postMessage({ status: 404 });
      else port.postMessage({ status: 200, type: res.type, data: res.data }, [res.data]);
    } catch (e) {
      port.postMessage({ status: 404, error: String(e) });
    }
  };
  try {
    sw?.addEventListener("message", onSwMessage);
    sw?.startMessages?.();
  } catch {
    /* no service worker in this window */
  }

  const dispose = () => {
    for (const d of disposers.splice(0)) d();
    try {
      sw?.removeEventListener("message", onSwMessage);
    } catch {
      /* window gone */
    }
    if ((window as unknown as { activeWindow?: Window }).activeWindow === win) setActiveWindow(window);
  };
  win.addEventListener("pagehide", dispose, { once: true });
  const closeWithMain = () => {
    try {
      win.close();
    } catch {
      /* already closed */
    }
  };
  window.addEventListener("pagehide", closeWithMain, { once: true });
  return { win, dispose };
}

function popoutFeatures(data?: { size?: { width?: number; height?: number } }): string {
  const width = Math.round(data?.size?.width ?? Math.min(900, Math.max(480, window.outerWidth * 0.6)));
  const height = Math.round(data?.size?.height ?? Math.min(800, Math.max(400, window.outerHeight * 0.8)));
  const left = Math.round(window.screenX + (window.outerWidth - width) / 2 + 40);
  const top = Math.round(window.screenY + (window.outerHeight - height) / 2 + 40);
  return `popup,width=${width},height=${height},left=${left},top=${top}`;
}

/** Builds the Obsidian pop-out DOM and a WorkspaceWindow in `workspace.floatingSplit`. */
export function createWorkspaceWindow(workspace: AnyWorkspace, win: Window, opts: { title?: string; classes?: string[] } = {}): WorkspaceWindow {
  const app = workspace.app;
  const prepared = prepareWindow(app, win, opts);
  const doc = win.document;
  const container = new WorkspaceWindow(workspace, win);
  workspace.floatingSplit.insertChild(workspace.floatingSplit.children.length, container);
  const appContainer = doc.body.createDiv({ cls: "app-container" });
  const main = appContainer.createDiv({ cls: "horizontal-main-container" });
  const ws = main.createDiv({ cls: "workspace" });
  ws.appendChild(container.containerEl);

  let closed = false;
  const onClose = () => {
    if (closed) return;
    closed = true;
    // Views save on close; their code runs in this window, so it finishes after the pop-out is gone.
    const leaves: WorkspaceLeaf[] = [];
    workspace.iterateTabs?.(container, (l: WorkspaceLeaf) => leaves.push(l));
    for (const leaf of leaves) leaf.detach();
    container.parent?.removeChild(container);
    prepared.dispose();
    workspace.trigger("window-close", container, win);
    workspace.requestSaveLayout?.();
  };
  win.addEventListener("pagehide", onClose, { once: true });
  // PiP windows close without pagehide in some builds; poll as a backstop.
  const poll = window.setInterval(() => {
    if (win.closed) {
      window.clearInterval(poll);
      onClose();
    }
  }, 1000);
  win.addEventListener(
    "focus",
    () => {
      const leaf = (container.children[0] as WorkspaceTabs | undefined)?.getActiveLeaf?.();
      if (leaf && workspace.activeLeaf !== leaf) workspace.setActiveLeaf(leaf, { focus: false });
    },
  );
  workspace.trigger("window-open", container, win);
  return container;
}

function fallbackSplit(workspace: AnyWorkspace, why: string): WorkspaceLeaf {
  new Notice(`${why} Opened to the right instead.`);
  const active = workspace.activeLeaf && workspace.activeLeaf.getRoot() === workspace.rootSplit ? workspace.activeLeaf : workspace.getUnpinnedLeaf();
  return workspace.createLeafBySplit(active, "vertical");
}

export function openPopoutLeaf(workspace: AnyWorkspace, data?: { size?: { width?: number; height?: number } }): WorkspaceLeaf {
  let win: Window | null = null;
  try {
    win = window.open("", "", popoutFeatures(data));
  } catch {
    win = null;
  }
  if (!win) return fallbackSplit(workspace, "The browser blocked the new window.");
  let doc: Document;
  try {
    doc = win.document;
    void doc.body;
  } catch {
    return fallbackSplit(workspace, "The new window could not be reached.");
  }
  const container = createWorkspaceWindow(workspace, win);
  const tabs = new WorkspaceTabs(workspace);
  container.insertChild(0, tabs);
  const leaf = new WorkspaceLeaf(workspace.app);
  tabs.insertChild(0, leaf);
  return leaf;
}

export function moveLeafToPopout(workspace: AnyWorkspace, leaf: WorkspaceLeaf, data?: { size?: { width?: number; height?: number } }): WorkspaceWindow | any {
  const state = leaf.getViewState();
  const eState = leaf.getEphemeralState();
  const target = openPopoutLeaf(workspace, data);
  void target.setViewState({ ...state, active: true }, eState).then(() => {
    leaf.detach();
    workspace.setActiveLeaf(target, { focus: true });
  });
  return target.getContainer?.() ?? workspace.rootSplit;
}

/**
 * A floating always-on-top window for one leaf, via Document Picture-in-Picture.
 * Needs a user gesture. Falls back to an ordinary pop-out.
 */
export async function openFloatingLeaf(workspace: AnyWorkspace, opts: { width?: number; height?: number } = {}): Promise<WorkspaceLeaf> {
  const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<Window> } }).documentPictureInPicture;
  if (!dpip) return openPopoutLeaf(workspace, { size: opts });
  let win: Window;
  try {
    win = await dpip.requestWindow({ width: opts.width ?? 480, height: opts.height ?? 600 });
  } catch {
    return openPopoutLeaf(workspace, { size: opts });
  }
  const container = createWorkspaceWindow(workspace, win, { classes: ["is-floating-window"] });
  const tabs = new WorkspaceTabs(workspace);
  container.insertChild(0, tabs);
  const leaf = new WorkspaceLeaf(workspace.app);
  tabs.insertChild(0, leaf);
  return leaf;
}

/** Replaces the split fallback in workspace.ts with real windows. */
export function installPopouts(WorkspaceClass: { prototype: any }) {
  const proto = WorkspaceClass.prototype;
  if (proto.__openmarkdownPopouts) return;
  proto.__openmarkdownPopouts = true;
  proto.openPopoutLeaf = function (this: AnyWorkspace, data?: { size?: { width?: number; height?: number } }) {
    return openPopoutLeaf(this, data);
  };
  proto.moveLeafToPopout = function (this: AnyWorkspace, leaf: WorkspaceLeaf, data?: { size?: { width?: number; height?: number } }) {
    return moveLeafToPopout(this, leaf, data);
  };
  // internal
  proto.openFloatingLeaf = function (this: AnyWorkspace, opts?: { width?: number; height?: number }) {
    return openFloatingLeaf(this, opts);
  };
}
