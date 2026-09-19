/**
 * Rename a tag across the vault (the Tags view's "Rename tag…", Tag Wrangler's
 * behaviour): `#old` becomes `#new`, nested tags follow (`#old/child` →
 * `#new/child`), and frontmatter `tags:` / `tag:` values are rewritten in
 * place whether they are block lists, flow lists or a plain string. Renaming
 * onto an existing tag merges the two; a note that ends up listing the same
 * tag twice keeps one. Code blocks, inline code and `%%comments%%` are left
 * alone. Each changed note gets a File recovery snapshot first and is written
 * with one `vault.process` call.
 */
import { ConfirmationModal, Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import { getAllTags } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";

export const TAG_WRANGLER_PLUGIN = "tag-wrangler";

const TAG_CHAR = "[^\\s#!\"$%&'()*+,.:;<=>?@\\[\\]^`{|}~\\\\]";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, "");
}

/** A usable tag name: no spaces or reserved punctuation, not only digits, no empty segments. */
export function isValidTagName(tag: string): boolean {
  const t = normalizeTag(tag);
  return t.length > 0 && new RegExp(`^${TAG_CHAR}+$`, "u").test(t) && !/^\d+$/.test(t) && !t.split("/").some((seg) => seg === "");
}

/** The renamed tag, or null when `tag` is neither `from` nor nested under it. */
export function mapTag(tag: string, from: string, to: string): string | null {
  const lower = tag.toLowerCase();
  const f = from.toLowerCase();
  if (lower === f) return to;
  if (lower.startsWith(f + "/")) return to + tag.slice(from.length);
  return null;
}

function renameInBodySegment(seg: string, from: string, to: string, counter: { n: number }): string {
  const re = new RegExp(`(^|[\\s(\\[{>,;!?"'])#(${TAG_CHAR}+)`, "gu");
  return seg.replace(re, (whole, pre: string, tag: string) => {
    const next = mapTag(tag, from, to);
    if (next === null || /^\d+$/.test(tag)) return whole;
    counter.n++;
    return `${pre}#${next}`;
  });
}

/** Body lines outside fenced code, with inline code and comments skipped. */
function renameInBody(body: string, from: string, to: string, counter: { n: number }): string {
  const lines = body.split("\n");
  let fence: string | null = null;
  let inComment = false;
  let inMath = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length && line.trim() === fenceMatch[1]) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      inMath = !inMath;
      continue;
    }
    if (inMath) continue;
    // Split into text / `code` / %%comment%% pieces; only text is rewritten.
    let out = "";
    let pos = 0;
    const tokenRe = /(`+)[\s\S]*?\1|%%/g;
    let textStart = 0;
    let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(line))) {
      if (m[0] === "%%") {
        if (!inComment) {
          out += renameInBodySegment(line.slice(textStart, m.index), from, to, counter);
          textStart = m.index;
          inComment = true;
        } else {
          out += line.slice(textStart, m.index + 2);
          textStart = m.index + 2;
          inComment = false;
        }
        continue;
      }
      if (inComment) continue;
      out += renameInBodySegment(line.slice(textStart, m.index), from, to, counter) + m[0];
      textStart = m.index + m[0].length;
    }
    pos = textStart;
    out += inComment ? line.slice(pos) : renameInBodySegment(line.slice(pos), from, to, counter);
    lines[i] = out;
  }
  return lines.join("\n");
}

/** Rewrites the `tags:`/`tag:` value lines of a frontmatter block. */
function renameInFrontmatter(yaml: string, from: string, to: string, counter: { n: number }): string {
  const lines = yaml.split("\n");
  const token = new RegExp(`(^|[\\s\\[,'"-])(#?)(${escapeRe(from)}(?:/${TAG_CHAR}*)?)(?=$|[\\s,\\]'"])`, "giu");
  for (let i = 0; i < lines.length; i++) {
    const key = /^(tags?)\s*:(.*)$/i.exec(lines[i]!);
    if (!key) continue;
    let end = i + 1;
    while (end < lines.length && (/^\s+\S/.test(lines[end]!) || /^\s*-\s/.test(lines[end]!) || /^\s*-$/.test(lines[end]!))) end++;
    const rewrite = (s: string) =>
      s.replace(token, (whole, pre: string, hash: string, tag: string) => {
        const next = mapTag(tag, from, to);
        if (next === null) return whole;
        counter.n++;
        return `${pre}${hash}${next}`;
      });
    const valueStart = lines[i]!.indexOf(":") + 1;
    let first = lines[i]!.slice(0, valueStart) + rewrite(lines[i]!.slice(valueStart));
    // Flow list or string on the key line: drop duplicates created by a merge.
    const flow = /^(\s*[^:]+:\s*\[)(.*)(\]\s*)$/.exec(first);
    if (flow) {
      const seen = new Set<string>();
      const items = flow[2]!.split(",").filter((item) => {
        const k = item.trim().replace(/^["']|["']$/g, "").replace(/^#/, "").toLowerCase();
        if (!k) return true;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      first = flow[1] + items.join(",") + flow[3];
    }
    lines[i] = first;
    const seen = new Set<string>();
    const kept: string[] = [];
    for (let j = i + 1; j < end; j++) {
      const line = rewrite(lines[j]!);
      const item = /^\s*-\s*["']?#?([^"'\s]+)["']?\s*$/.exec(line);
      if (item) {
        const k = item[1]!.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
      }
      kept.push(line);
    }
    lines.splice(i + 1, end - i - 1, ...kept);
    i += kept.length;
  }
  return lines.join("\n");
}

/** Renames `from` (and its nested tags) to `to` in one note's text. */
export function renameTagInText(text: string, from: string, to: string): { text: string; count: number } {
  from = normalizeTag(from);
  to = normalizeTag(to);
  const counter = { n: 0 };
  const fm = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  let head = "";
  let body = text;
  if (fm) {
    const yamlStart = fm[0].indexOf("\n") + 1;
    const yaml = fm[1]!;
    const renamed = renameInFrontmatter(yaml, from, to, counter);
    head = fm[0].slice(0, yamlStart) + renamed + fm[0].slice(yamlStart + yaml.length);
    body = text.slice(fm[0].length);
  }
  body = renameInBody(body, from, to, counter);
  return { text: head + body, count: counter.n };
}

/** Notes whose tags include `tag` or a tag nested under it. */
export function filesWithTag(app: any, tag: string): TFile[] {
  const t = normalizeTag(tag);
  return (app.vault.getMarkdownFiles() as TFile[]).filter((f) => {
    const cache = app.metadataCache.getFileCache(f);
    const tags = cache ? (getAllTags(cache) ?? []) : [];
    return tags.some((x) => mapTag(normalizeTag(x), t, t) !== null);
  });
}

export async function renameTag(app: any, from: string, to: string): Promise<{ files: number; count: number }> {
  from = normalizeTag(from);
  to = normalizeTag(to);
  let files = 0;
  let count = 0;
  const recovery = app.internalPlugins?.getEnabledPluginById?.("file-recovery");
  for (const file of filesWithTag(app, from)) {
    const before: string = await app.vault.read(file);
    const planned = renameTagInText(before, from, to);
    if (!planned.count || planned.text === before) continue;
    try {
      await recovery?.forceAdd?.(file.path, before);
    } catch (e) {
      console.error("Rename tag: could not snapshot", file.path, e);
    }
    let n = 0;
    await app.vault.process(file, (current: string) => {
      const r = renameTagInText(current, from, to);
      n = r.count;
      return r.text;
    });
    if (n) {
      files++;
      count += n;
    }
  }
  return { files, count };
}

export class RenameTagModal extends Modal {
  constructor(
    app: any,
    private tag: string,
  ) {
    super(app);
    this.modalEl.addClass("vault-rename-tag-modal");
  }

  override onOpen(): void {
    const from = normalizeTag(this.tag);
    this.setTitle(`Rename #${from}`);
    let value = from;
    const nested = Object.keys((this.app as any).metadataCache.getTags() ?? {}).filter((t) => normalizeTag(t).toLowerCase().startsWith(from.toLowerCase() + "/")).length;
    const n = filesWithTag(this.app, from).length;
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `Renames the tag in ${n} note${n === 1 ? "" : "s"}${nested ? `, including ${nested} nested tag${nested === 1 ? "" : "s"}` : ""}. Frontmatter tags are updated too.`,
    });
    const submit = async () => {
      const to = normalizeTag(value);
      if (!to || to === from) {
        this.close();
        return;
      }
      if (!isValidTagName(to)) {
        new Notice(`“#${to}” is not a valid tag. Tags cannot contain spaces or punctuation other than - _ /, and cannot be only numbers.`);
        return;
      }
      const tags = Object.keys((this.app as any).metadataCache.getTags() ?? {}).map(normalizeTag);
      const exists = to.toLowerCase() !== from.toLowerCase() && tags.some((t) => t.toLowerCase() === to.toLowerCase() || t.toLowerCase().startsWith(to.toLowerCase() + "/"));
      const run = async () => {
        const { files, count } = await renameTag(this.app, from, to);
        new Notice(`Renamed #${from} to #${to}: ${count} change${count === 1 ? "" : "s"} in ${files} note${files === 1 ? "" : "s"}.`);
      };
      this.close();
      if (exists) {
        const confirm = new ConfirmationModal(this.app);
        confirm.setTitle("Merge tags?");
        confirm.setContent(`#${to} already exists. Renaming #${from} will merge the two tags. File recovery keeps the previous version of each note.`);
        confirm.addButton((b) => b.setButtonText("Merge").setCta().onClick(() => void run()));
        confirm.addCancelButton();
        confirm.open();
      } else await run();
    };
    new Setting(this.contentEl).setName("New name").addText((t) => {
      t.setValue(from).onChange((v) => (value = v));
      t.inputEl.addClass("vault-rename-tag-input");
      t.inputEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" && !evt.isComposing) {
          evt.preventDefault();
          void submit();
        }
      });
      window.setTimeout(() => t.inputEl.select(), 0);
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Rename").setCta().onClick(() => void submit()))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
