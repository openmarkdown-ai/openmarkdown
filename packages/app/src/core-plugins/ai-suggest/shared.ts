/**
 * Helpers shared by the AI assist plugins (suggestions, plain-language
 * queries, periodic reviews): reaching `app.ai`, engine labels, JSON answers,
 * one-undo-step writes, and the vault facts prompts are grounded in.
 */
import { AiUnavailableError, type AiFeature, type AiService, type EngineInfo, type GenerateRequest, type GenerateResult } from "../../ai/types";
import { Component } from "../../obsidian/events";
import { MarkdownView } from "../../obsidian/markdown/markdown-view";
import { MarkdownRenderer } from "../../obsidian/markdown/renderer";
import { setIcon } from "../../obsidian/ui/icons";
import { getFrontMatterInfo, parseYaml, stringifyYaml } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";

export type Capability = "generate" | "embed" | "transcribe" | "vision";

export function aiOf(app: any): AiService | null {
  const ai = app?.ai as AiService | undefined;
  return ai && typeof ai.isAvailable === "function" ? ai : null;
}

export function aiAvailable(app: any, feature: AiFeature, capability: Capability = "generate"): boolean {
  try {
    return !!aiOf(app)?.isAvailable(feature, capability);
  } catch {
    return false;
  }
}

const PROVIDER_NAMES: Record<string, string> = {
  "chrome-builtin": "Chrome",
  transformers: "Transformers.js",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "lm-studio": "LM Studio",
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  google: "Google Gemini",
  "openai-compatible": "your server",
};

/** "On this device", "Ollama on this computer", "Sent to Anthropic". */
export function engineLabel(engine: EngineInfo | null): string {
  if (!engine) return "No AI engine";
  const name = PROVIDER_NAMES[engine.provider] ?? engine.provider;
  if (engine.location === "device") return "On this device";
  if (engine.location === "local-server") return engine.leavesDevice ? `Sent to ${name}` : `${name} on this computer`;
  return `Sent to ${name}`;
}

/** A small "where it runs" badge. */
export function renderEngineBadge(el: HTMLElement, engine: EngineInfo | null) {
  el.empty();
  el.addClass("ai-assist-engine");
  el.toggleClass("mod-leaves-device", !!engine?.leavesDevice);
  const icon = el.createSpan({ cls: "ai-assist-engine-icon" });
  setIcon(icon, engine?.leavesDevice ? "lucide-cloud" : engine?.location === "local-server" ? "lucide-server" : "lucide-cpu");
  el.createSpan({ cls: "ai-assist-engine-text", text: engineLabel(engine) });
  if (engine?.model) el.setAttr("aria-label", `${engineLabel(engine)} · ${engine.model}`);
}

/** Pulls a JSON value out of a model answer (tolerates code fences and prose around it). */
export function parseJsonAnswer(text: string): any {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const start = t.search(/[[{]/);
    if (start < 0) return null;
    const open = t[start];
    const end = t.lastIndexOf(open === "{" ? "}" : "]");
    if (end <= start) return null;
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/** Asks for consent, then generates. Returns null when the user declined. */
export async function generate(app: any, req: GenerateRequest, capability: Capability = "generate"): Promise<GenerateResult | null> {
  const ai = aiOf(app);
  if (!ai || !ai.isAvailable(req.feature, capability)) throw new AiUnavailableError("disabled", "AI is off for this feature. Turn it on in Settings → AI.");
  if (!(await ai.ensureConsent(req.feature, capability))) return null;
  return ai.generate(req);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  return String(e);
}

export function isAbort(e: unknown): boolean {
  return (e as { name?: string })?.name === "AbortError";
}

/** The Markdown view editing `file`, if one is open. */
export function viewFor(app: any, file: TFile): MarkdownView | null {
  const active = app.workspace.getActiveViewOfType(MarkdownView) as MarkdownView | null;
  if (active?.file === file) return active;
  for (const leaf of app.workspace.getLeavesOfType("markdown") as any[]) {
    if (leaf.view instanceof MarkdownView && leaf.view.file === file) return leaf.view;
  }
  return null;
}

/**
 * Rewrites a note as one undo step: through its open editor (the smallest
 * replaced range, one transaction) when there is one, else `vault.process`.
 * `fn` returns the new text, or null to leave the note alone. Resolves false
 * when nothing changed.
 */
export async function editNote(app: any, file: TFile, fn: (text: string) => string | null): Promise<boolean> {
  const view = viewFor(app, file);
  const editor = view?.editor;
  if (editor) {
    const before = editor.getValue();
    const after = fn(before);
    if (after === null || after === before) return false;
    let start = 0;
    const max = Math.min(before.length, after.length);
    while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
    let endB = before.length;
    let endA = after.length;
    while (endB > start && endA > start && before.charCodeAt(endB - 1) === after.charCodeAt(endA - 1)) {
      endB--;
      endA--;
    }
    editor.transaction({ changes: [{ from: editor.offsetToPos(start), to: editor.offsetToPos(endB), text: after.slice(start, endA) }] }, "ai-assist");
    await (view as any).save?.();
    return true;
  }
  let changed = false;
  await app.vault.process(file, (text: string) => {
    const next = fn(text);
    if (next === null || next === text) return text;
    changed = true;
    return next;
  });
  return changed;
}

/** `text` with its frontmatter changed by `fn` (same YAML handling as `processFrontMatter`). */
export function withFrontmatter(text: string, fn: (fm: Record<string, any>) => void): string {
  const info = getFrontMatterInfo(text);
  const data = info.exists ? (parseYaml(info.frontmatter) ?? {}) : {};
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("This note's properties aren't valid YAML, so nothing was changed.");
  fn(data);
  const yaml = Object.keys(data).length ? stringifyYaml(data) : "";
  if (info.exists) return yaml ? `---\n${yaml}---\n${text.slice(info.contentStart)}` : text.slice(info.contentStart);
  return yaml ? `---\n${yaml}---\n${text}` : text;
}

export interface PropertySchema {
  name: string;
  type: string;
  count: number;
  samples: string[];
}

/** The vault's property names with their types and a few example values. */
export function propertySchema(app: any, limit = 60): PropertySchema[] {
  const mtm = app.metadataTypeManager;
  mtm?.updatePropertyInfoCache?.();
  const all = (mtm?.getAllProperties?.() ?? {}) as Record<string, { name: string; type: string; count: number }>;
  const out: PropertySchema[] = [];
  for (const info of Object.values(all)) {
    let samples: string[] = [];
    try {
      samples = (app.metadataCache.getFrontmatterPropertyValuesForKey?.(info.name) ?? []).slice(0, 4).map((v: unknown) => String(v).slice(0, 40));
    } catch {
      samples = [];
    }
    out.push({ name: info.name, type: mtm.getAssignedType?.(info.name) ?? info.type, count: info.count, samples });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, limit);
}

/** Vault tags without `#`, most used first. */
export function vaultTags(app: any, limit = 150): string[] {
  const tags = (app.metadataCache.getTags?.() ?? {}) as Record<string, number>;
  return Object.entries(tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => t.replace(/^#/, ""));
}

export function vaultFolders(app: any, limit = 40): string[] {
  const out: string[] = [];
  for (const f of app.vault.getAllFolders?.(false) ?? []) {
    if (f.path && !f.path.startsWith(".")) out.push(f.path);
    if (out.length >= limit) break;
  }
  return out;
}

export function communityPluginEnabled(app: any, id: string): boolean {
  return !!app.plugins?.enabledPlugins?.has?.(id);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** Renders Markdown into an element, replacing what an earlier call rendered there. */
export class LivePreview {
  private child: Component | null = null;
  private seq = 0;

  constructor(
    private app: any,
    readonly el: HTMLElement,
  ) {}

  async render(markdown: string, sourcePath: string): Promise<void> {
    const seq = ++this.seq;
    this.child?.unload();
    const child = new Component();
    child.load();
    this.child = child;
    const holder = createDiv({ cls: "markdown-rendered" });
    await MarkdownRenderer.render(this.app, markdown, holder, sourcePath, child);
    if (seq !== this.seq) return;
    this.el.empty();
    this.el.appendChild(holder);
  }

  message(text: string) {
    this.seq++;
    this.child?.unload();
    this.child = null;
    this.el.empty();
    this.el.createDiv({ cls: "ai-assist-preview-message", text });
  }

  dispose() {
    this.seq++;
    this.child?.unload();
    this.child = null;
  }
}
