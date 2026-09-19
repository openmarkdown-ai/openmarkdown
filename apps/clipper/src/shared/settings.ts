/**
 * Extension settings and templates, in `chrome.storage.local`.
 *
 * Shapes follow Obsidian Web Clipper (github.com/obsidianmd/obsidian-clipper,
 * MIT) so exported templates and property types move between the two.
 */
import type { ClipBehavior, ConsentState, VaultRef } from "../../../../packages/app/src/companion/protocol";

export type PropertyType = "text" | "multitext" | "number" | "checkbox" | "date" | "datetime";
export const PROPERTY_TYPES: PropertyType[] = ["text", "multitext", "number", "checkbox", "date", "datetime"];

export interface TemplateProperty {
  id: string;
  name: string;
  value: string;
  type: PropertyType;
}

export interface Template {
  id: string;
  name: string;
  behavior: ClipBehavior;
  noteNameFormat: string;
  path: string;
  noteContentFormat: string;
  properties: TemplateProperty[];
  triggers: string[];
  /** Target vault id for this template ("" = the default vault). */
  vault?: string;
  context?: string;
}

export interface PropertyTypeDef {
  name: string;
  type: PropertyType;
  defaultValue?: string;
}

export type HighlightBehavior = "highlight-inline" | "replace-content" | "no-highlights";

export interface KnownVault extends VaultRef {
  origin: string;
}

export interface Settings {
  /** Web app origins, e.g. "http://localhost:5200". The bridge runs only there. */
  appOrigins: string[];
  /** Origin clips are sent to when no app tab is open. */
  defaultAppOrigin: string;
  /** Vault id ("" = whichever vault the app opens). */
  defaultVault: string;
  knownVaults: KnownVault[];
  /** Output format for `date` properties that do not format themselves. */
  dateFormat: string;
  /** Output format for `datetime` properties that do not format themselves. */
  datetimeFormat: string;
  propertyTypes: PropertyTypeDef[];
  highlightBehavior: HighlightBehavior;
  silentOpen: boolean;
  bridge: {
    enabled: boolean;
    consent: Record<string, Exclude<ConsentState, "ask">>;
    maxResponseMB: number;
  };
  /** App origin → hosts its web viewer may frame (see `set-framing-hosts`). */
  framingHosts: Record<string, string[]>;
  /**
   * Web Clipper's Interpreter: prompt variables (`{{"…"}}`) are kept and filled by
   * the app's AI when the clip arrives. Off: they are removed, as in Web Clipper.
   */
  interpreterEnabled: boolean;
  /** Web Clipper's `defaultPromptContext`; empty uses `DEFAULT_PROMPT_CONTEXT`. A template's own context wins. */
  defaultPromptContext: string;
}

/** Web Clipper's built-in prompt context: the page HTML without navigation, scripts, styles and most attributes. */
export const DEFAULT_PROMPT_CONTEXT =
  '{{fullHtml|remove_html:("#navbar,.footer,#footer,header,footer,style,script")|strip_tags:("script,h1,h2,h3,h4,h5,h6,meta,a,ol,ul,li,p,em,strong,i,b,s,strike,u,sup,sub,img,video,audio,math,table,cite,td,th,tr,caption")|strip_attr:("alt,src,href,id,content,property,name,datetime,title")}}';

/** The hosted app's origin. The app itself is served at `${PRODUCTION_ORIGIN}/app/`; the origin root is the landing page. */
export const PRODUCTION_ORIGIN = "https://openmarkdown.ai";

export const DEFAULT_SETTINGS: Settings = {
  appOrigins: ["http://localhost:5200", "http://localhost", PRODUCTION_ORIGIN],
  defaultAppOrigin: "http://localhost:5200",
  defaultVault: "",
  knownVaults: [],
  framingHosts: {},
  dateFormat: "YYYY-MM-DD",
  datetimeFormat: "YYYY-MM-DDTHH:mm:ssZ",
  propertyTypes: [
    { name: "title", type: "text" },
    { name: "source", type: "text" },
    { name: "author", type: "multitext" },
    { name: "published", type: "date" },
    { name: "created", type: "date" },
    { name: "description", type: "text" },
    { name: "tags", type: "multitext" },
  ],
  highlightBehavior: "highlight-inline",
  silentOpen: false,
  bridge: { enabled: false, consent: {}, maxResponseMB: 32 },
  interpreterEnabled: true,
  defaultPromptContext: "",
};

export function newId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * The Web Clipper's default template, as it ships (obsidian-clipper,
 * `src/managers/template-manager.ts`, MIT).
 */
export function defaultTemplate(): Template {
  const p = (name: string, value: string, type: PropertyType): TemplateProperty => ({ id: newId(), name, value, type });
  return {
    id: "default",
    name: "Default",
    behavior: "create",
    noteNameFormat: "{{title}}",
    path: "Clippings",
    noteContentFormat: "{{content}}",
    properties: [
      p("title", "{{title}}", "text"),
      p("source", "{{url}}", "text"),
      p("author", '{{author|split:", "|wikilink|join}}', "multitext"),
      p("published", "{{published}}", "date"),
      p("created", "{{date}}", "date"),
      p("description", "{{description}}", "text"),
      p("tags", "clippings", "multitext"),
    ],
    triggers: [],
  };
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  const s = (settings ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...s, bridge: { ...DEFAULT_SETTINGS.bridge, ...(s.bridge ?? {}) } };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getTemplates(): Promise<Template[]> {
  const { templates } = await chrome.storage.local.get("templates");
  if (Array.isArray(templates) && templates.length) return templates as Template[];
  return [defaultTemplate()];
}

export async function saveTemplates(templates: Template[]): Promise<void> {
  await chrome.storage.local.set({ templates });
}

/** `http://localhost:5200/x` → `http://localhost:5200`; invalid → null. */
export function normalizeOrigin(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Does `origin` belong to a configured app origin? An entry without a port
 * (`http://localhost`) matches every port on that host, as a match pattern does.
 */
export function isAppOrigin(origin: string, appOrigins: string[]): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  return appOrigins.some((entry) => {
    try {
      const e = new URL(entry);
      if (e.protocol !== u.protocol || e.hostname !== u.hostname) return false;
      return e.port === "" ? true : e.port === u.port;
    } catch {
      return false;
    }
  });
}

/**
 * The page to open when a clip must reach an app origin with no app tab open.
 * The hosted app lives under `/app/` (the origin root is the landing page);
 * any other origin, such as the dev server on :5200, serves the app at its root.
 * Tabs are still recognised by origin alone, so `/app/` needs no special case there.
 */
export function appEntryUrl(origin: string): URL {
  const u = new URL(origin);
  return new URL(u.origin === PRODUCTION_ORIGIN ? "/app/" : "/", u.origin);
}

/** Match patterns for an origin. Firefox match patterns cannot carry a port. */
export function originMatchPattern(origin: string, firefox: boolean): string {
  const u = new URL(origin);
  const host = firefox || u.port === "" ? u.hostname : `${u.hostname}:${u.port}`;
  return `${u.protocol}//${host}/*`;
}

export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

export interface StoredHighlight {
  id: string;
  text: string;
  html: string;
  /** Surrounding text, to find the passage again when the page reloads. */
  prefix: string;
  suffix: string;
  createdAt: number;
}

export async function getHighlights(url: string): Promise<StoredHighlight[]> {
  const key = `highlights:${pageKey(url)}`;
  const got = await chrome.storage.local.get(key);
  return (got[key] as StoredHighlight[] | undefined) ?? [];
}

export async function setHighlights(url: string, highlights: StoredHighlight[]): Promise<void> {
  const key = `highlights:${pageKey(url)}`;
  if (highlights.length) await chrome.storage.local.set({ [key]: highlights });
  else await chrome.storage.local.remove(key);
}
