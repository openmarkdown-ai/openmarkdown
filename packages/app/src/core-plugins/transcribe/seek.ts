/**
 * Timestamp links seek without the Media plugin. When Media is on it owns
 * these clicks (and opens its player pane); when it is off, a click on
 * `[[rec.webm#t=01:23|01:23]]` seeks the recording's embed in the same note,
 * or opens the recording in a tab and seeks that.
 */
import { EditorView } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { parseLinktext } from "../../obsidian/util";
import { clickableTokenAt } from "../../editor/live-preview/links";
import { editorLivePreviewField } from "../../editor/fields";
import { hostFacet, sourcePathOf } from "../../editor/facets";
import type { TFile } from "../../obsidian/vault/files";
import { parseTempFrag } from "../media/timefrag";
import type { Plugin } from "../../obsidian/plugin";
import { communityPluginEnabled } from "../smart-paste/network";

export const MEDIA_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "oga", "flac", "3gp", "opus", "aac", "mp4", "webm", "ogv", "mov", "mkv", "m4v"];

function mediaPluginHandles(app: any): boolean {
  // Media (or Media Extended, which Media steps aside for) opens its player pane instead.
  return !!app.internalPlugins?.getEnabledPluginById?.("media") || communityPluginEnabled(app, "media-extended");
}

function target(app: any, href: string, sourcePath: string): { file: TFile; time: number } | null {
  const { path, subpath } = parseLinktext(href);
  const frag = parseTempFrag(subpath);
  if (!frag || frag.start < 0 || !path) return null;
  const file: TFile | null = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
  if (!file || !MEDIA_EXTENSIONS.includes(file.extension.toLowerCase())) return null;
  return { file, time: frag.start };
}

const stripQuery = (src: string) => src.replace(/[?#].*$/, "");

function seekElement(el: HTMLMediaElement, time: number) {
  const go = () => {
    el.currentTime = time;
    void el.play().catch(() => {});
  };
  if (el.readyState >= 1) go();
  else el.addEventListener("loadedmetadata", go, { once: true });
}

export async function seekRecording(app: any, file: TFile, time: number, scope: Element | null): Promise<void> {
  const want = stripQuery(app.vault.getResourcePath(file));
  // A note open in reading view also holds its (hidden) editor, with its own embed: prefer the one on screen.
  const find = (root: ParentNode | null | undefined) => {
    const all = root ? Array.from(root.querySelectorAll<HTMLMediaElement>("audio, video")).filter((m) => stripQuery(m.currentSrc || m.src) === want) : [];
    return all.find((m) => m.getClientRects().length > 0) ?? all[0];
  };
  const inNote = find(scope);
  if (inNote) {
    seekElement(inNote, time);
    return;
  }
  const leaf = app.workspace.getLeaf("tab");
  await leaf.openFile(file, { active: true });
  const el = find(leaf.view?.containerEl);
  if (el) seekElement(el, time);
}

export function installSeekFallback(plugin: Plugin) {
  const app: any = plugin.app;
  plugin.registerDomEvent(
    document,
    "click",
    (evt: MouseEvent) => {
      if (evt.button !== 0 || mediaPluginHandles(app)) return;
      const a = (evt.target as HTMLElement | null)?.closest?.<HTMLAnchorElement>("a.internal-link");
      if (!a || a.closest(".cm-editor") || !a.closest(".markdown-rendered, .markdown-preview-view, .markdown-embed, .popover")) return;
      const href = a.getAttr("data-href") ?? a.getAttr("href") ?? "";
      const scope = a.closest(".workspace-leaf-content");
      const sourcePath = (scope && (app.workspace.getLeavesOfType("markdown") as any[]).find((l) => l.view?.containerEl === scope)?.view?.file?.path) || app.workspace.getActiveFile()?.path || "";
      const t = target(app, href, sourcePath);
      if (!t) return;
      evt.preventDefault();
      evt.stopPropagation();
      evt.stopImmediatePropagation();
      void seekRecording(app, t.file, t.time, scope);
    },
    true,
  );
  plugin.registerEditorExtension(
    Prec.high(
      EditorView.domEventHandlers({
        mousedown: (evt, view) => {
          if (evt.button !== 0 || mediaPluginHandles(app)) return false;
          const el = (evt.target as HTMLElement | null)?.closest?.(".cm-underline, .cm-hmd-internal-link") as HTMLElement | null;
          if (!el || !view.contentDOM.contains(el)) return false;
          const lp = view.state.field(editorLivePreviewField, false);
          if (!(lp && el.closest(".cm-underline")) && !(evt.metaKey || evt.ctrlKey)) return false;
          const tok = clickableTokenAt(view.state, view.posAtDOM(el));
          if (!tok || tok.type !== "internal-link") return false;
          const t = target(app, tok.text, sourcePathOf(view.state.facet(hostFacet)));
          if (!t) return false;
          evt.preventDefault();
          void seekRecording(app, t.file, t.time, view.dom.closest(".workspace-leaf-content"));
          return true;
        },
      }),
    ),
  );
}
