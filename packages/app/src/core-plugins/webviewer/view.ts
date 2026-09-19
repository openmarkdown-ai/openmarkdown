/**
 * The `webviewer` view: an address bar and an `<iframe>`.
 *
 * Obsidian's desktop web viewer is an Electron `<webview>`, which ignores
 * X-Frame-Options and CSP `frame-ancestors`. A browser `<iframe>` honours
 * them, and a refused frame raises no event the embedding page can read. So
 * when a request transport (the companion extension) is available the view
 * reads the response headers first and shows a clear refusal instead of a
 * blank frame; without one it keeps a small hint with "Open in browser".
 */
import type { ViewStateResult } from "obsidian";
import { ItemView } from "../../obsidian/workspace/view";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { setIcon } from "../../obsidian/ui/icons";
import { getRequestTransport } from "../../obsidian/util";
import { companionFraming } from "../../companion";
import { knownFraming } from "./frames";

export const VIEW_TYPE_WEBVIEWER = "webviewer";

export interface WebviewerHost {
  options: { homepage: string; searchEngine: string; customSearchUrl: string };
  saveToVault(view: WebviewerView): Promise<void>;
  /** A configured web pane (Custom Frames–style), by id. */
  getFrame?(id: string): { id: string; name: string; icon: string; zoom: number } | null;
}

const SEARCH_ENGINES: Record<string, string> = {
  duckduckgo: "https://duckduckgo.com/?q=%s",
  google: "https://www.google.com/search?q=%s",
  bing: "https://www.bing.com/search?q=%s",
  kagi: "https://kagi.com/search?q=%s",
};

export function searchUrl(options: WebviewerHost["options"], query: string): string {
  const template = options.searchEngine === "custom" && options.customSearchUrl.includes("%s") ? options.customSearchUrl : (SEARCH_ENGINES[options.searchEngine] ?? SEARCH_ENGINES.duckduckgo!);
  return template.replace("%s", encodeURIComponent(query));
}

/** Address-bar input → URL: a URL when it looks like one, else a web search. */
export function resolveAddress(options: WebviewerHost["options"], input: string): string {
  const text = input.trim();
  if (!text) return "";
  if (/^(https?|file|data|about):/i.test(text)) return text;
  if (!/\s/.test(text) && (/^localhost(:\d+)?(\/|$)/i.test(text) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text))) {
    return `${/^localhost/i.test(text) ? "http" : "https"}://${text}`;
  }
  return searchUrl(options, text);
}

export class WebviewerView extends ItemView {
  plugin: WebviewerHost;
  url = "";
  title = "";
  zoom = 1;
  // internal: the last HTML the transport fetched for `url`, reused by Save to vault
  cachedHtml: { url: string; html: string } | null = null;
  // internal: the web pane this tab shows, if it was opened from one
  frameId: string | null = null;

  private historyStack: string[] = [];
  private historyIndex = -1;
  private addressEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private backEl!: HTMLElement;
  private forwardEl!: HTMLElement;
  private frameWrapEl!: HTMLElement;
  private iframeEl: HTMLIFrameElement | null = null;
  private messageEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private loadSeq = 0;

  constructor(leaf: WorkspaceLeaf, plugin: WebviewerHost) {
    super(leaf);
    this.plugin = plugin;
    this.icon = "lucide-globe";
    this.navigation = true;
  }

  getViewType(): string {
    return VIEW_TYPE_WEBVIEWER;
  }

  getDisplayText(): string {
    const frame = this.frameId ? this.plugin.getFrame?.(this.frameId) : null;
    if (frame) return frame.name;
    if (this.title) return this.title;
    if (!this.url) return "New web tab";
    try {
      return new URL(this.url).host || this.url;
    } catch {
      return this.url;
    }
  }

  override getIcon(): string {
    const frame = this.frameId ? this.plugin.getFrame?.(this.frameId) : null;
    return frame?.icon || "lucide-globe";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("webviewer-content");
    this.addressEl = this.contentEl.createDiv({ cls: "webviewer-address" });
    this.backEl = this.navButton("lucide-arrow-left", "Back", () => this.back());
    this.forwardEl = this.navButton("lucide-arrow-right", "Forward", () => this.forward());
    this.navButton("lucide-rotate-cw", "Reload", () => this.reload());
    this.inputEl = this.addressEl.createEl("input", {
      cls: "webviewer-address-input",
      type: "text",
      attr: { placeholder: "Search or enter address", spellcheck: "false", autocomplete: "off" },
    });
    this.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        const url = resolveAddress(this.plugin.options, this.inputEl.value);
        if (url) void this.navigate(url);
      } else if (evt.key === "Escape") {
        this.inputEl.value = this.url;
        this.inputEl.blur();
      }
    });
    this.inputEl.addEventListener("focus", () => this.inputEl.select());
    this.navButton("lucide-download", "Save to vault", () => void this.plugin.saveToVault(this));
    this.navButton("lucide-external-link", "Open in browser", () => this.openExternally());

    this.hintEl = this.contentEl.createDiv({ cls: "webviewer-hint" });
    this.hintEl.createSpan({ text: "Some sites refuse to be shown inside the app." });
    const hintBtn = this.hintEl.createEl("button", { cls: "mod-muted", text: "Open in browser" });
    hintBtn.addEventListener("click", () => this.openExternally());
    this.hintEl.hide();

    this.frameWrapEl = this.contentEl.createDiv({ cls: "webviewer-frame" });
    this.messageEl = this.contentEl.createDiv({ cls: "webviewer-message" });
    this.messageEl.hide();
    this.updateNav();
    if (!this.url) this.showBlank();
  }

  override async onClose(): Promise<void> {
    this.iframeEl?.remove();
    this.iframeEl = null;
  }

  private navButton(icon: string, label: string, run: () => void): HTMLElement {
    const btn = this.addressEl.createEl("button", { cls: "clickable-icon webviewer-nav-button", attr: { "aria-label": label } });
    setIcon(btn, icon);
    btn.addEventListener("click", run);
    return btn;
  }

  override getState(): Record<string, unknown> {
    return { url: this.url, ...(this.title ? { title: this.title } : {}), ...(this.frameId ? { frame: this.frameId } : {}) };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    const url = state && typeof state.url === "string" ? state.url : "";
    if (state && typeof state.title === "string") this.title = state.title;
    if (state && typeof state.frame === "string" && state.frame !== this.frameId) {
      this.frameId = state.frame;
      const frame = this.plugin.getFrame?.(state.frame);
      if (frame) {
        this.contentEl.addClass("mod-web-pane");
        this.contentEl.setAttr("data-frame", frame.id);
        if (frame.zoom && frame.zoom !== 1) this.zoom = frame.zoom;
        this.icon = frame.icon || "lucide-globe";
      }
    }
    if (url && url !== this.url) {
      await this.navigate(url);
      result.history = false;
    }
    this.updateHeader();
  }

  focusAddressBar() {
    this.inputEl?.focus();
    this.inputEl?.select();
  }

  // ---- navigation ------------------------------------------------------------------

  async navigate(url: string, push = true): Promise<void> {
    if (push) {
      this.historyStack.splice(this.historyIndex + 1);
      if (this.historyStack[this.historyStack.length - 1] !== url) this.historyStack.push(url);
      this.historyIndex = this.historyStack.length - 1;
    }
    this.url = url;
    this.title = "";
    this.cachedHtml = null;
    if (this.inputEl) this.inputEl.value = url;
    this.updateNav();
    this.updateHeader();
    this.app.workspace.requestSaveLayout();
    await this.load_(url);
  }

  back() {
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    void this.navigate(this.historyStack[this.historyIndex]!, false);
  }

  forward() {
    if (this.historyIndex >= this.historyStack.length - 1) return;
    this.historyIndex++;
    void this.navigate(this.historyStack[this.historyIndex]!, false);
  }

  reload() {
    if (this.url) void this.load_(this.url);
  }

  // internal
  getHistory(): string[] {
    return this.historyStack.slice();
  }

  setZoom(zoom: number) {
    this.zoom = Math.min(3, Math.max(0.25, Math.round(zoom * 100) / 100));
    this.applyZoom();
  }

  openExternally() {
    if (this.url) window.open(this.url, "_blank", "noopener");
  }

  private updateNav() {
    if (!this.backEl) return;
    this.backEl.toggleClass("is-disabled", this.historyIndex <= 0);
    this.forwardEl.toggleClass("is-disabled", this.historyIndex >= this.historyStack.length - 1);
  }

  private applyZoom() {
    const f = this.iframeEl;
    if (!f) return;
    const z = this.zoom;
    f.style.width = `${100 / z}%`;
    f.style.height = `${100 / z}%`;
    f.style.transform = z === 1 ? "" : `scale(${z})`;
  }

  private showBlank() {
    this.frameWrapEl.empty();
    this.iframeEl = null;
    this.hintEl.hide();
    this.messageEl.empty();
    this.messageEl.show();
    this.messageEl.createDiv({ cls: "webviewer-message-title", text: "Enter an address or search the web" });
    setTimeout(() => {
      if (!this.url) this.focusAddressBar();
    }, 0);
  }

  private showRefusal(reason: string, tryAnyway?: () => void, url?: string) {
    this.frameWrapEl.empty();
    this.iframeEl = null;
    this.hintEl.hide();
    this.messageEl.empty();
    this.messageEl.show();
    const icon = this.messageEl.createDiv({ cls: "webviewer-message-icon" });
    setIcon(icon, "lucide-shield-alert");
    this.messageEl.createDiv({ cls: "webviewer-message-title", text: "This site can't be shown inside the app" });
    this.messageEl.createDiv({ cls: "webviewer-message-desc", text: reason });
    const buttons = this.messageEl.createDiv({ cls: "webviewer-message-buttons" });
    const btn = buttons.createEl("button", { cls: "mod-cta", text: "Open in browser" });
    btn.addEventListener("click", () => this.openExternally());
    if (tryAnyway) {
      const again = buttons.createEl("button", { text: "Try anyway" });
      again.addEventListener("click", tryAnyway);
    }
    const framing = url ? companionFraming() : null;
    const host = url ? hostOf(url) : null;
    if (framing && host) {
      const allow = buttons.createEl("button", { text: `Allow ${host} in the app` });
      allow.addEventListener("click", () => {
        allow.disabled = true;
        framing.set([...framing.hosts.filter((h) => h !== host), host]).then(
          () => void this.load_(url!, true),
          (e: unknown) => {
            allow.disabled = false;
            this.messageEl.createDiv({ cls: "webviewer-message-desc mod-warning", text: e instanceof Error ? e.message : String(e) });
          },
        );
      });
      this.messageEl.createDiv({
        cls: "webviewer-message-desc",
        text: "The companion extension will remove this site's framing headers, only for frames this app opens.",
      });
    }
  }

  private async load_(url: string, force = false) {
    const seq = ++this.loadSeq;
    this.messageEl.hide();
    const transport = getRequestTransport();
    if (transport && /^https?:/i.test(url)) {
      try {
        const res = await transport.request({ url, method: "GET" });
        if (seq !== this.loadSeq) return;
        const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
        const refusal = framingRefusal(headers);
        const type = headers["content-type"] ?? "";
        if (!type || /html/i.test(type)) {
          const html = new TextDecoder().decode(res.body);
          this.cachedHtml = { url, html };
          const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
          if (m) {
            this.title = decodeEntities(m[1]!.trim()).slice(0, 200);
            this.updateHeader();
            this.app.workspace.requestSaveLayout();
          }
        }
        const allowed = companionFraming()?.hosts.includes(hostOf(url) ?? "") ?? false;
        if (refusal && !allowed) {
          this.showRefusal(refusal, undefined, url);
          return;
        }
        this.hintEl.hide();
      } catch {
        if (seq !== this.loadSeq) return;
        this.hintEl.show();
      }
    } else {
      // Without the extension the headers cannot be read; for sites known to refuse, say so up front.
      const known = /^https?:/i.test(url) && !force ? knownFraming(url) : null;
      if (known) {
        this.showRefusal(`When last checked, this site refused to be shown inside other pages (${known}).`, () => void this.load_(url, true));
        return;
      }
      this.hintEl.toggle(/^https?:/i.test(url));
    }
    this.frameWrapEl.empty();
    const iframe = this.frameWrapEl.createEl("iframe", {
      cls: "webviewer-iframe",
      attr: {
        sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
        referrerpolicy: "no-referrer",
        allow: "fullscreen; clipboard-write",
        src: url,
      },
    });
    this.iframeEl = iframe;
    this.applyZoom();
    iframe.addEventListener("load", () => {
      if (this.iframeEl !== iframe) return;
      // Same-origin pages expose their title; cross-origin ones throw.
      try {
        const t = iframe.contentDocument?.title;
        if (t) {
          this.title = t;
          this.updateHeader();
        }
      } catch {
        /* cross-origin */
      }
    });
  }
}

/** The reason a response forbids framing by another origin, or null. */
export function framingRefusal(headers: Record<string, string>): string | null {
  const xfo = (headers["x-frame-options"] ?? "").trim().toLowerCase();
  if (xfo === "deny" || xfo === "sameorigin" || xfo.startsWith("allow-from")) {
    return `The site sends “X-Frame-Options: ${headers["x-frame-options"]}”, which forbids showing it inside another page.`;
  }
  const csp = headers["content-security-policy"] ?? "";
  const m = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp);
  if (m) {
    const sources = m[1]!.trim().split(/\s+/);
    if (!sources.includes("*")) return "The site's Content-Security-Policy (frame-ancestors) forbids showing it inside another page.";
  }
  return null;
}

function decodeEntities(s: string): string {
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
