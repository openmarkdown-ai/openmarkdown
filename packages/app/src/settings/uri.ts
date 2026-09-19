/**
 * `obsidian://` links for the web app (docs/research/obsidian-features.md §9).
 *
 * A web page cannot own the `obsidian:` scheme. Links reach the app three ways:
 *
 * - `#obsidian://open?vault=…&file=…` in the page URL (the hash never reaches a server),
 * - `?uri=obsidian%3A%2F%2F…` in the query string,
 * - `web+obsidian://…` through the manifest's `protocol_handlers` (installed
 *   app) or `navigator.registerProtocolHandler` (Settings → General → App),
 *   which browsers allow only for `web+` schemes; the browser rewrites such a
 *   link to `?uri=web%2Bobsidian%3A%2F%2F…`. A link naming another vault is
 *   routed at boot (boot.ts) so that vault opens directly.
 *
 * `hook-get-address` is desktop-only (the Hook app) and answers with a notice.
 *
 * Supported actions: `open` (with `append`/`prepend`/`content`, `paneType`),
 * `new`, `daily`, `unique`, `search`, `choose-vault`, `show-plugin`,
 * `show-theme`, `debug-info`, the shorthands
 * `obsidian://vault/<vault>/<file>` and `obsidian:///<absolute path>`, and any
 * action a plugin registered with `registerObsidianProtocolHandler`.
 */
import type { App } from "../obsidian/app";
import { Notice } from "../obsidian/ui/notice";
import { normalizePath } from "../obsidian/util";
import type { TFile } from "../obsidian/vault/files";
import { obsidianUrlFor, openDebugInfo } from "./commands";
import { whenLayoutReady } from "./helpers";

export interface ParsedUri {
  action: string;
  params: Record<string, string>;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parses `obsidian://action?a=b` (also `web+obsidian:`); values are percent-decoded, `+` stays `+`. */
export function parseObsidianUri(input: string): ParsedUri | null {
  let url = input.trim();
  const m = /^(?:web\+)?obsidian:\/\/(.*)$/is.exec(url);
  if (!m) return null;
  url = m[1]!;
  const hashAt = url.indexOf("#");
  const qAt = url.indexOf("?");
  // A `#` inside a query value (file=Note#Heading, unencoded) belongs to the value.
  const head = qAt === -1 ? (hashAt === -1 ? url : url.slice(0, hashAt)) : url.slice(0, qAt);
  const query = qAt === -1 ? "" : url.slice(qAt + 1);
  const params: Record<string, string> = {};
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decode(eq === -1 ? part : part.slice(0, eq));
    params[key] = eq === -1 ? "true" : decode(part.slice(eq + 1));
  }
  if (head.startsWith("/")) {
    // obsidian:///absolute/path/to/note
    return { action: "open", params: { ...params, path: decode(head) } };
  }
  const segments = head.split("/");
  if (segments[0] === "vault" && segments.length >= 2) {
    // obsidian://vault/my vault/my note
    const vault = decode(segments[1]!);
    const file = segments.slice(2).map(decode).join("/");
    return { action: "open", params: { ...params, vault, ...(file ? { file } : {}) } };
  }
  return { action: decode(segments[0] ?? "").toLowerCase(), params };
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== "false" && v !== "0";
}

function paneType(params: Record<string, string>): "tab" | "split" | "window" | false {
  const p = params.paneType;
  return p === "tab" || p === "split" || p === "window" ? p : false;
}

async function readClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    new Notice("The browser did not allow reading the clipboard.");
    return null;
  }
}

function findFile(app: App, name: string): TFile | null {
  const clean = normalizePath(name);
  return (
    app.vault.getFileByPath(clean) ??
    app.vault.getFileByPath(`${clean}.md`) ??
    (app.metadataCache.getFirstLinkpathDest(clean, "") as TFile | null) ??
    null
  );
}

function splitSubpath(file: string): { path: string; subpath: string } {
  const i = file.indexOf("#");
  return i === -1 ? { path: file, subpath: "" } : { path: file.slice(0, i), subpath: file.slice(i) };
}

function callback(app: App, params: Record<string, string>, kind: "x-success" | "x-error", values: Record<string, string>) {
  const target = params[kind];
  if (!target || !app.vault.getConfig("uriCallbacks")) return;
  try {
    const url = new URL(target);
    for (const [k, v] of Object.entries(values)) url.searchParams.set(k, v);
    window.open(url.toString(), "_blank", "noopener");
  } catch {
    console.warn(`Invalid ${kind} URL: ${target}`);
  }
}

function successValues(app: App, file: TFile): Record<string, string> {
  return { name: file.basename, url: obsidianUrlFor(app, file.path) };
}

/** Merges `content` into `text`: after the frontmatter for prepend, on a new line for append. */
export function mergeContent(text: string, content: string, mode: "append" | "prepend"): string {
  if (!content) return text;
  if (mode === "append") return text === "" || text.endsWith("\n") ? text + content : `${text}\n${content}`;
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  const at = fm ? fm[0].length : 0;
  const head = text.slice(0, at);
  const rest = text.slice(at);
  return `${head}${content}${content.endsWith("\n") || rest === "" ? "" : "\n"}${rest}`;
}

async function openFileIn(app: App, file: TFile, params: Record<string, string>, extra: { state?: Record<string, unknown>; eState?: Record<string, unknown> } = {}) {
  const leaf = app.workspace.getLeaf(paneType(params));
  await leaf.openFile(file, { active: true, state: extra.state, eState: extra.eState });
}

/** Resolves the `vault`/`path` parameters. Returns false when the link was handed to another vault. */
async function routeVault(app: App, parsed: ParsedUri, rawUri: string): Promise<boolean> {
  const { params } = parsed;
  let wanted = params.vault;
  if (params.path && !params.file) {
    // An absolute file system path: find a known vault named by one of its folders.
    const segs = params.path.split(/[\\/]/).filter(Boolean);
    const names = await knownVaults(app);
    for (let i = segs.length - 2; i >= 0; i--) {
      const hit = names.find((v) => v.name === segs[i]);
      if (hit) {
        wanted = hit.id;
        params.file = segs.slice(i + 1).join("/");
        break;
      }
    }
    if (!params.file) {
      new Notice(`No open vault contains "${params.path}".`);
      return false;
    }
  }
  if (!wanted || wanted === app.vault.getName() || wanted === app.appId) return true;
  const target = (await knownVaults(app)).find((v) => v.id === wanted || v.name === wanted);
  if (!target) {
    new Notice(`Vault "${wanted}" not found.`);
    callback(app, params, "x-error", { errorCode: "NotFound", errorMessage: `Vault not found: ${wanted}` });
    return false;
  }
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("vault", target.id);
  url.searchParams.set("uri", rawUri);
  location.href = url.toString();
  return false;
}

async function knownVaults(app: App): Promise<{ id: string; name: string }[]> {
  try {
    const { listVaults } = await import("../boot");
    const list = (await listVaults()).map((v) => ({ id: v.id, name: v.name }));
    if (!list.some((v) => v.id === app.appId)) list.push({ id: app.appId, name: app.vault.getName() });
    return list;
  } catch {
    return [{ id: app.appId, name: app.vault.getName() }];
  }
}

async function handleNew(app: App, params: Record<string, string>) {
  let content = params.content ?? "";
  if (truthy(params.clipboard)) {
    const clip = await readClipboard();
    if (clip === null) return;
    content = clip;
  }
  let path: string;
  if (params.file) {
    if (params.file.split("/").includes("..")) {
      new Notice("The file path cannot contain \"..\".");
      return;
    }
    path = normalizePath(params.file);
  } else {
    const parent = app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? "");
    const name = params.name?.trim() || "Untitled";
    path = normalizePath(parent.isRoot() ? name : `${parent.path}/${name}`);
  }
  if (!/\.[a-z0-9]+$/i.test(path)) path += ".md";

  let file = app.vault.getFileByPath(path);
  const append = truthy(params.append);
  const prepend = truthy(params.prepend);
  if (file && (append || prepend)) {
    await app.vault.process(file, (text) => mergeContent(text, content, append ? "append" : "prepend"));
  } else if (file && truthy(params.overwrite)) {
    await app.vault.modify(file, content);
  } else {
    if (file) {
      const dot = path.lastIndexOf(".");
      path = app.vault.getAvailablePath(path.slice(0, dot), path.slice(dot + 1));
    }
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
    file = await app.vault.create(path, content);
  }
  callback(app, params, "x-success", successValues(app, file));
  if (!truthy(params.silent)) await openFileIn(app, file, params, { state: { mode: "source" }, eState: { rename: "all" } });
}

/** Resolves on the next `file-open`, or after `timeout` ms. */
function nextFileOpen(app: App, timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const ref = app.workspace.on("file-open", () => finish());
    const timer = window.setTimeout(() => finish(), timeout);
    function finish() {
      window.clearTimeout(timer);
      app.workspace.offref(ref);
      resolve();
    }
  });
}

/** Content, append/prepend/overwrite applied to a note a plugin command just opened or created. */
async function applyToActiveNote(app: App, params: Record<string, string>) {
  const file = app.workspace.getActiveFile();
  if (!file) return;
  let content = params.content ?? "";
  if (truthy(params.clipboard)) content = (await readClipboard()) ?? "";
  if (!content) return;
  if (truthy(params.overwrite) && !truthy(params.append) && !truthy(params.prepend)) await app.vault.modify(file, content);
  else await app.vault.process(file, (text) => mergeContent(text, content, truthy(params.prepend) ? "prepend" : "append"));
  callback(app, params, "x-success", successValues(app, file));
}

export async function handleUri(app: App, url: string): Promise<boolean> {
  const parsed = parseObsidianUri(url);
  if (!parsed) return false;
  const { action, params } = parsed;
  const handler = app.workspace.protocolHandlers.get(action);
  if (!(await routeVault(app, parsed, url))) return true;
  try {
    if (handler) {
      await handler({ action, ...params });
      return true;
    }
    switch (action) {
      case "open": {
        if (!params.file) return true;
        const { path, subpath } = splitSubpath(params.file);
        const file = findFile(app, path);
        if (!file) {
          new Notice(`File "${params.file}" not found.`);
          callback(app, params, "x-error", { errorCode: "NotFound", errorMessage: `File not found: ${params.file}` });
          return true;
        }
        const content = params.content ?? "";
        if (content && (truthy(params.append) || truthy(params.prepend))) {
          await app.vault.process(file, (text) => mergeContent(text, content, truthy(params.prepend) ? "prepend" : "append"));
        }
        if (!truthy(params.silent)) await openFileIn(app, file, params, subpath ? { eState: { subpath } } : {});
        callback(app, params, "x-success", successValues(app, file));
        return true;
      }
      case "hook-get-address":
        new Notice("The hook-get-address link is for the Hook desktop app and is not supported in the browser. Use “Copy Obsidian URL” instead.");
        callback(app, params, "x-error", { errorCode: "NotSupported", errorMessage: "hook-get-address is not supported" });
        return true;
      case "new":
        await handleNew(app, params);
        return true;
      case "daily":
      case "unique": {
        const plugin = action === "daily" ? "daily-notes" : "zk-prefixer";
        if (!app.internalPlugins.getEnabledPluginById(plugin)) {
          new Notice(action === "daily" ? "Turn on the Daily notes core plugin to use this link." : "Turn on the Unique note creator core plugin to use this link.");
          return true;
        }
        if (!app.commands.executeCommandById(plugin)) {
          new Notice(`The ${action === "daily" ? "Daily notes" : "Unique note creator"} plugin did not handle this link.`);
          return true;
        }
        await nextFileOpen(app, 3000);
        await applyToActiveNote(app, params);
        return true;
      }
      case "search": {
        const search = app.internalPlugins.getEnabledPluginById("global-search") as { openGlobalSearch?: (q: string) => void } | null;
        if (search?.openGlobalSearch) search.openGlobalSearch(params.query ?? "");
        else if (!app.commands.executeCommandById("global-search:open")) new Notice("Turn on the Search core plugin to use this link.");
        return true;
      }
      case "choose-vault":
        app.vaultSwitcher?.open();
        return true;
      case "show-plugin": {
        const { PluginBrowserModal } = await import("./community-store");
        app.setting.open();
        app.setting.openTabById("community-plugins");
        new PluginBrowserModal(app, params.id ?? null).open();
        return true;
      }
      case "show-theme": {
        const { ThemeBrowserModal } = await import("./theme-store");
        new ThemeBrowserModal(app, undefined, params.name ?? null).open();
        return true;
      }
      case "debug-info":
        openDebugInfo(app);
        return true;
      default:
        new Notice(`Unsupported link action "${action}".`);
        return true;
    }
  } catch (e) {
    console.error(`obsidian:// ${action} failed`, e);
    new Notice(`Could not handle the link: ${(e as Error).message}`);
    callback(app, params, "x-error", { errorCode: "Error", errorMessage: (e as Error).message });
    return true;
  }
}

/** Reads an obsidian:// link from the page URL (hash or `?uri=`), if any, and removes it. */
export function takeUriFromLocation(): string | null {
  const url = new URL(location.href);
  let uri: string | null = null;
  const fromQuery = url.searchParams.get("uri");
  if (fromQuery && /^(?:web\+)?obsidian:/i.test(fromQuery)) {
    uri = fromQuery;
    url.searchParams.delete("uri");
  } else if (url.hash.length > 1) {
    const raw = url.hash.slice(1);
    const candidate = /^(?:web\+|web%2B)?obsidian(?::|%3A)/i.test(raw) && !/^(?:web\+)?obsidian:/i.test(raw) ? decode(raw) : raw;
    if (/^(?:web\+)?obsidian:\/\//i.test(candidate)) {
      uri = candidate;
      url.hash = "";
    }
  }
  if (uri) history.replaceState(history.state, "", url.toString());
  return uri;
}

export function installUriHandling(app: App): () => void {
  const run = () => {
    const uri = takeUriFromLocation();
    if (uri) void handleUri(app, uri);
  };
  const onHash = () => run();
  whenLayoutReady(app, () => {
    run();
    window.addEventListener("hashchange", onHash);
  });
  // `web+obsidian:` is claimed by the manifest's `protocol_handlers` when installed,
  // and from Settings → General → App in a browser tab (pwa/uri-handler.ts):
  // registering on every load made browsers prompt again and again.
  return () => window.removeEventListener("hashchange", onHash);
}
