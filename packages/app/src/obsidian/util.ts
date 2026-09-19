/**
 * The free functions exported by the `obsidian` module.
 *
 * Several of these look trivial and are not: `normalizePath` decides whether
 * two plugins writing "Notes//a.md" and "Notes/a.md" touch the same file, and
 * `parseLinktext` decides where a heading subpath starts. They follow the
 * observable behaviour of Obsidian's own implementations, not what the names
 * suggest.
 */
import DOMPurify from "dompurify";
import jsYaml from "js-yaml";
import moment from "moment";
import { getEngine } from "@vault/engine";
import type {
  CachedMetadata,
  FrontMatterInfo,
  Reference,
  ReferenceCache,
  SearchMatches,
  SearchResult,
  SearchResultContainer,
} from "obsidian";

export { moment };

/**
 * The Obsidian version this app reports. It tracks the current public
 * release rather than the npm type package (1.13.1), because plugins gate on
 * `minAppVersion` against the app, and several now require 1.13.x releases
 * whose API additions are covered here.
 */
export let apiVersion = "1.13.7";

export function normalizePath(path: string): string {
  path = path.replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "");
  if (path === "") path = "/";
  return path.replace(/ | /g, " ").normalize("NFC");
}

export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const i = linktext.indexOf("#");
  if (i === -1) return { path: linktext, subpath: "" };
  return { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}

export function getLinkpath(linktext: string): string {
  return parseLinktext(linktext).path;
}

/** Normalises a heading for matching: special characters become spaces, runs collapse. */
export function stripHeading(heading: string): string {
  return heading
    .replace(/[!"#$%&()*+,.:;<=>?@^`{|}~\/\[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Removes the character combinations that would break a `[[Note#heading]]` link. */
export function stripHeadingForLink(heading: string): string {
  return heading
    .replace(/[#|^\\%]|\[\[|\]\]|:/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Debouncer<T extends unknown[], V> {
  (...args: [...T]): Debouncer<T, V>;
  cancel(): Debouncer<T, V>;
  run(): V | void;
}

export function debounce<T extends unknown[], V>(
  cb: (...args: [...T]) => V,
  timeout = 0,
  resetTimer = false,
): Debouncer<T, V> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: T | null = null;
  const fire = (): V | void => {
    timer = null;
    if (!pendingArgs) return;
    const args = pendingArgs;
    pendingArgs = null;
    return cb(...args);
  };
  const debounced = function (...args: [...T]) {
    pendingArgs = args as T;
    if (timer && resetTimer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!timer) timer = setTimeout(fire, timeout);
    return debounced;
  } as Debouncer<T, V>;
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
    return debounced;
  };
  debounced.run = () => {
    if (timer) clearTimeout(timer);
    return fire();
  };
  return debounced;
}

// ---- binary helpers ---------------------------------------------------------

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const s = atob(base64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

export function arrayBufferToHex(data: ArrayBuffer): string {
  return Array.from(new Uint8Array(data), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes.buffer;
}

export function getBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

// ---- network ----------------------------------------------------------------

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any;
  text: string;
}

export type RequestUrlResponsePromise = Promise<RequestUrlResponse> & {
  arrayBuffer: Promise<ArrayBuffer>;
  json: Promise<any>;
  text: Promise<string>;
};

/**
 * A transport that can reach hosts which do not send CORS headers. Obsidian's
 * `requestUrl` runs in Electron's main process and is never subject to CORS;
 * a web page is. The companion browser extension registers itself here, and so
 * can an optional user-configured proxy. Without one, plain `fetch` is used and
 * a CORS refusal surfaces as the error the plugin would see for a network fault.
 */
export interface RequestTransport {
  name: string;
  request(p: Required<Pick<RequestUrlParam, "url" | "method">> & RequestUrlParam): Promise<{
    status: number;
    headers: Record<string, string>;
    body: ArrayBuffer;
  }>;
}

let transport: RequestTransport | null = null;

export function setRequestTransport(t: RequestTransport | null) {
  transport = t;
}

export function getRequestTransport(): RequestTransport | null {
  return transport;
}

async function doRequest(param: RequestUrlParam | string): Promise<RequestUrlResponse> {
  const p: RequestUrlParam = typeof param === "string" ? { url: param } : param;
  const method = (p.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(p.headers ?? {}) };
  if (p.contentType) headers["Content-Type"] = p.contentType;

  let status: number;
  let resHeaders: Record<string, string> = {};
  let body: ArrayBuffer;

  const viaFetch = async () => {
    const res = await fetch(p.url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : p.body });
    status = res.status;
    res.headers.forEach((v, k) => (resHeaders[k.toLowerCase()] = v));
    body = await res.arrayBuffer();
  };

  if (transport) {
    try {
      const r = await transport.request({ ...p, url: p.url, method, headers });
      status = r.status;
      resHeaders = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
      body = r.body;
    } catch (e) {
      await viaFetch();
    }
  } else {
    await viaFetch();
  }

  const buffer = body!;
  let textCache: string | undefined;
  const response: RequestUrlResponse = {
    status: status!,
    headers: resHeaders,
    arrayBuffer: buffer,
    get text() {
      return (textCache ??= new TextDecoder().decode(buffer));
    },
    get json() {
      return JSON.parse(this.text);
    },
  };
  if (p.throw !== false && status! >= 400) {
    const err = new Error(`Request failed, status ${status!}`) as Error & { status: number; headers: Record<string, string> };
    err.status = status!;
    err.headers = resHeaders;
    throw err;
  }
  return response;
}

export function requestUrl(param: RequestUrlParam | string): RequestUrlResponsePromise {
  const promise = doRequest(param) as RequestUrlResponsePromise;
  Object.defineProperties(promise, {
    arrayBuffer: { get: () => promise.then((r) => r.arrayBuffer) },
    json: { get: () => promise.then((r) => r.json) },
    text: { get: () => promise.then((r) => r.text) },
  });
  return promise;
}

export async function request(param: RequestUrlParam | string): Promise<string> {
  return (await requestUrl(param)).text;
}

// ---- platform ---------------------------------------------------------------

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const isMobile = isIOS || isAndroid;

/**
 * `isDesktopApp` and `isMobileApp` are both false: this is neither Electron nor
 * Capacitor, and plugins use those two flags to decide whether Node or native
 * bridges exist. `isDesktop`/`isMobile` describe the layout, which is what the
 * rest of the flags are used for.
 */
export const Platform = {
  isDesktop: !isMobile,
  isMobile,
  isDesktopApp: false,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: isMobile && Math.min(screen.width, screen.height) < 600,
  isTablet: isMobile && Math.min(screen.width, screen.height) >= 600,
  isMacOS: /Macintosh|Mac OS X/.test(ua) && !isIOS,
  isWin: /Windows/.test(ua),
  isLinux: /Linux/.test(ua) && !isAndroid,
  isSafari: /^((?!chrome|android).)*safari/i.test(ua),
  resourcePathPrefix: "vault-resource://",
  // internal: plugins probe these
  isWeb: true,
};

export function getLanguage(): string {
  try {
    return localStorage.getItem("language") || "en";
  } catch {
    return "en";
  }
}

export function requireApiVersion(version: string): boolean {
  const a = apiVersion.split(".").map(Number);
  const b = version.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

// ---- yaml & frontmatter -----------------------------------------------------

export function parseYaml(yaml: string): any {
  return jsYaml.load(yaml, { schema: jsYaml.JSON_SCHEMA }) ?? null;
}

export function stringifyYaml(obj: any): string {
  return jsYaml.dump(obj, { lineWidth: -1, noRefs: true, schema: jsYaml.JSON_SCHEMA });
}

export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const none = { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  const m = /^---\r?\n/.exec(content);
  if (!m) return none;
  const from = m[0].length;
  const endRe = /(^|\r?\n)(---|\.\.\.)[ \t]*(\r?\n|$)/g;
  endRe.lastIndex = from - 1;
  let end: RegExpExecArray | null;
  while ((end = endRe.exec(content))) {
    const fenceStart = end.index + end[1]!.length;
    if (fenceStart < from) continue;
    return {
      exists: true,
      frontmatter: content.slice(from, fenceStart),
      from,
      to: fenceStart,
      contentStart: end.index + end[0].length,
    };
  }
  return none;
}

function frontmatterKeyMatch(frontmatter: any, key: string | RegExp): string[] {
  if (!frontmatter || typeof frontmatter !== "object") return [];
  if (typeof key === "string") return key in frontmatter ? [key] : [];
  return Object.keys(frontmatter).filter((k) => key.test(k));
}

export function parseFrontMatterEntry(frontmatter: any | null, key: string | RegExp): any | null {
  const keys = frontmatterKeyMatch(frontmatter, key);
  return keys.length ? frontmatter[keys[0]!] : null;
}

export function parseFrontMatterStringArray(frontmatter: any | null, key: string | RegExp, nospaces = false): string[] | null {
  const out: string[] = [];
  for (const k of frontmatterKeyMatch(frontmatter, key)) {
    const v = frontmatter[k];
    const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(nospaces ? /[,\s]+/ : /,/) : v == null ? [] : [v];
    for (const item of items) {
      if (item === null || item === undefined) continue;
      const s = String(item).trim();
      if (s) out.push(s);
    }
  }
  return out.length ? out : null;
}

export function parseFrontMatterTags(frontmatter: any | null): string[] | null {
  const tags = parseFrontMatterStringArray(frontmatter, /^tags?$/i, true);
  return tags ? tags.map((t) => (t.startsWith("#") ? t : "#" + t)) : null;
}

export function parseFrontMatterAliases(frontmatter: any | null): string[] | null {
  return parseFrontMatterStringArray(frontmatter, /^alias(es)?$/i);
}

export function getAllTags(cache: CachedMetadata): string[] | null {
  const tags: string[] = [];
  const fm = parseFrontMatterTags(cache.frontmatter ?? null);
  if (fm) tags.push(...fm);
  for (const t of cache.tags ?? []) tags.push(t.tag);
  return tags.length ? tags : null;
}

export function iterateRefs(refs: Reference[], cb: (ref: Reference) => boolean | void): boolean {
  for (const r of refs) if (cb(r)) return true;
  return false;
}

export function iterateCacheRefs(cache: CachedMetadata, cb: (ref: ReferenceCache) => boolean | void): boolean {
  if (cache.links && iterateRefs(cache.links, cb as (r: Reference) => boolean | void)) return true;
  if (cache.embeds && iterateRefs(cache.embeds, cb as (r: Reference) => boolean | void)) return true;
  if (cache.frontmatterLinks && iterateRefs(cache.frontmatterLinks, cb as (r: Reference) => boolean | void)) return true;
  return false;
}

export function resolveSubpath(cache: CachedMetadata, subpath: string) {
  return getEngine().resolveSubpath(cache, subpath);
}

// ---- search helpers ---------------------------------------------------------

export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null {
  const engine = getEngine();
  return (text: string) => engine.fuzzy(query, text);
}

export function prepareSimpleSearch(query: string): (text: string) => SearchResult | null {
  const engine = getEngine();
  return (text: string) => engine.simpleSearch(query, text);
}

export function sortSearchResults(results: SearchResultContainer[]): void {
  results.sort((a, b) => b.match.score - a.match.score);
}

export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: SearchMatches | null, offset = 0): void {
  if (!matches || matches.length === 0) {
    el.appendChild(document.createTextNode(text));
    return;
  }
  let pos = 0;
  for (const [s0, e0] of matches) {
    const s = s0 - offset;
    const e = e0 - offset;
    if (e <= 0 || s >= text.length) continue;
    const start = Math.max(s, pos);
    if (start > pos) el.appendChild(document.createTextNode(text.slice(pos, start)));
    const span = document.createElement("span");
    span.className = "suggestion-highlight";
    span.textContent = text.slice(start, Math.min(e, text.length));
    el.appendChild(span);
    pos = Math.min(e, text.length);
  }
  if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
}

export function renderResults(el: HTMLElement, text: string, result: SearchResult, offset = 0): void {
  renderMatches(el, text, result.matches, offset);
}

// ---- html -------------------------------------------------------------------

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    ADD_ATTR: ["target", "data-href", "data-heading", "data-callout", "data-callout-fold", "data-callout-metadata", "data-line", "data-task", "data-footnote-id", "src", "alt", "tabindex"],
    ADD_TAGS: ["iframe"],
    FORBID_TAGS: ["style", "script"],
  }) as DocumentFragment;
}

export function htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment): string {
  let source: string;
  if (typeof html === "string") source = html;
  else if (html instanceof Document) source = html.documentElement.outerHTML;
  else if (html instanceof DocumentFragment) {
    const div = document.createElement("div");
    div.appendChild(html.cloneNode(true));
    source = div.innerHTML;
  } else source = html.outerHTML;
  return getEngine().htmlToMarkdown(source, undefined);
}

export function parsePropertyId(propertyId: string): { type: "note" | "file" | "formula"; name: string } {
  const i = propertyId.indexOf(".");
  const prefix = i === -1 ? "" : propertyId.slice(0, i);
  if (prefix === "file" || prefix === "formula" || prefix === "note") {
    return { type: prefix, name: propertyId.slice(i + 1) };
  }
  return { type: "note", name: propertyId };
}
