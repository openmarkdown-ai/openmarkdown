/**
 * createMarkdownEditor — builds the editor with Obsidian's DOM:
 *
 *   div.markdown-source-view.cm-s-obsidian.mod-cm6[.is-live-preview][.is-readable-line-width][.is-folding]
 *     div.cm-editor
 *       div.cm-scroller
 *         div.cm-sizer
 *           (inline title element, when the host passes one)
 *           div.metadata-container        (Properties, filled by host.renderProperties)
 *           div.cm-contentContainer
 *             (div.cm-gutters)
 *             div.cm-content
 *
 * Stock CM6 puts `.cm-content` directly in `.cm-scroller`; we move it into the
 * sizer after construction and redirect the one CM6 code path that inserts
 * relative to it (the gutters), so gutters land inside `.cm-contentContainer`.
 */
import { Compartment, EditorState, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, keymap, lineNumbers, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import type { EditorHost, EditorConfig } from "./host";
import { DEFAULT_EDITOR_CONFIG, readConfig } from "./host";
import { configFacet, hostFacet } from "./facets";
import { ofmLanguage } from "./syntax/language";
import { syntaxClasses } from "./syntax/highlight";
import {
  editorEditorField,
  editorInfoField,
  editorLivePreviewField,
  livePreviewState,
  setEditorInfo,
  setEditorView,
  setLivePreview,
} from "./fields";
import { livePreview, frontmatterInfo } from "./live-preview";
import { folding } from "./live-preview/fold";
import { listIndentation } from "./live-preview/indent";
import { CMEditor } from "./editor";
import { EDITOR_COMMANDS, editorKeymap } from "./commands";
import { tableKeys } from "./table-toolbar";
import { smartListKeymap } from "./lists";
import { autoPairBrackets, autoPairMarkdown, clipboardHandlers } from "./input";
import { linkSuggest } from "./suggest";
import { vimMode } from "./vim";
import { writingFeatures } from "./features";

export interface CreateEditorOptions {
  /** Bind EDITOR_COMMANDS' default hotkeys inside CM6 (default true). Pass false when the app's hotkey manager runs them. */
  keymap?: boolean;
  /** Element placed first in `.cm-sizer` (the view's `.inline-title`). */
  inlineTitleEl?: HTMLElement;
  /** Extensions for this editor only (in addition to `host.extraExtensions()`). */
  extensions?: Extension[];
  /** Initial mode; defaults to `getConfig("livePreview")`. */
  livePreview?: boolean;
}

export interface MarkdownEditorHandle {
  view: EditorView;
  editor: CMEditor;
  /** `.markdown-source-view` */
  containerEl: HTMLElement;
  /** `.cm-sizer` */
  sizerEl: HTMLElement;
  /** `.metadata-container` inside the sizer (the Properties widget's host element). */
  metadataEl: HTMLElement;
  setMode(livePreview: boolean): void;
  isLivePreview(): boolean;
  /** Re-read every setting and `host.extraExtensions()`. */
  reconfigure(): void;
  /** Replace the document (e.g. loading another file); clears undo history by default. */
  setText(text: string, clearHistory?: boolean): void;
  /** Refresh editorInfoField (after the host's file/view changed). */
  refreshInfo(): void;
  destroy(): void;
}

function readAllConfig(host: EditorHost): EditorConfig {
  const out = { ...DEFAULT_EDITOR_CONFIG };
  for (const key of Object.keys(DEFAULT_EDITOR_CONFIG) as (keyof EditorConfig)[]) {
    (out as Record<string, unknown>)[key] = readConfig(host, key);
  }
  return out;
}

export function createMarkdownEditor(
  parent: HTMLElement,
  host: EditorHost,
  initialText: string,
  opts: CreateEditorOptions = {},
): MarkdownEditorHandle {
  const doc = parent.ownerDocument;
  const containerEl = doc.createElement("div");
  containerEl.className = "markdown-source-view cm-s-obsidian mod-cm6";
  parent.appendChild(containerEl);

  const configCompartment = new Compartment();
  const vimCompartment = new Compartment();
  const gutterCompartment = new Compartment();
  const featureCompartment = new Compartment();
  const extraCompartment = new Compartment();

  let config = readAllConfig(host);
  let handle: MarkdownEditorHandle;

  const info = () =>
    host.getInfo?.() ?? {
      app: host.app,
      get file() {
        return host.getFile();
      },
      get editor() {
        return handle?.editor;
      },
    };

  const configExtensions = (c: EditorConfig): Extension => [
    hostFacet.of(host),
    configFacet.of(c),
    EditorState.tabSize.of(c.tabSize),
    indentUnit.of(c.useTab ? "\t" : " ".repeat(Math.max(1, c.tabSize))),
    EditorView.contentAttributes.of({
      spellcheck: c.spellcheck ? "true" : "false",
      autocorrect: c.spellcheck ? "on" : "off",
      autocapitalize: c.spellcheck ? "on" : "off",
      translate: "no",
      dir: c.rightToLeft ? "rtl" : "ltr",
    }),
  ];

  const featureExtensions = (c: EditorConfig): Extension => [
    c.foldHeading || c.foldIndent ? folding() : [],
    c.autoPairBrackets ? autoPairBrackets() : [],
  ];

  const safeExtra = (): Extension => {
    try {
      return host.extraExtensions();
    } catch (e) {
      console.error("Editor extension failed", e);
      return [];
    }
  };

  const makeExtensions = (c: EditorConfig, lp: boolean, existingView?: EditorView): Extension[] => [
    vimCompartment.of(c.vimMode ? vimMode() : []),
    configCompartment.of(configExtensions(c)),
    editorInfoField.init(() => info()),
    existingView ? editorEditorField.init(() => existingView) : editorEditorField,
    editorLivePreviewField.init(() => lp),
    livePreviewState,
    ofmLanguage(),
    history(),
    drawSelection(),
    dropCursor(),
    // Obsidian: Alt/Option+click adds a cursor (Mod+click too, as in CM);
    // Shift+Alt+drag makes a rectangular selection.
    EditorView.clickAddsSelectionRange.of((e) => e.altKey || (/Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey)),
    rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey }),
    crosshairCursor({ key: "Alt" }),
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    syntaxClasses(),
    livePreview(),
    listIndentation,
    gutterCompartment.of(c.showLineNumber ? lineNumbers() : []),
    featureCompartment.of(featureExtensions(c)),
    autoPairMarkdown(),
    clipboardHandlers(),
    linkSuggest(),
    writingFeatures(),
    smartListKeymap(tableKeys.tab, tableKeys.shiftTab, tableKeys.enter, tableKeys.shiftEnter),
    opts.keymap === false ? [] : Prec.high(keymap.of(editorKeymap((v) => (v === handle?.view ? handle.editor : new CMEditor(v, containerEl))))),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        try {
          host.onDocChanged?.(u.state.doc.toString());
        } catch (e) {
          console.error(e);
        }
      }
      if (u.selectionSet || u.focusChanged) host.onSelectionChanged?.();
      if (
        u.docChanged ||
        u.state.field(editorLivePreviewField) !== u.startState.field(editorLivePreviewField) ||
        u.state.facet(configFacet) !== u.startState.facet(configFacet)
      ) {
        syncProperties();
        syncRootClasses();
      }
    }),
    ...(opts.extensions ?? []),
    extraCompartment.of(safeExtra()),
  ];

  const view = new EditorView({
    state: EditorState.create({ doc: initialText, extensions: makeExtensions(config, opts.livePreview ?? config.livePreview) }),
    parent: containerEl,
  });

  // ---- Obsidian's DOM: .cm-sizer > (.inline-title) .metadata-container .cm-contentContainer > .cm-content
  const scroller = view.scrollDOM;
  const sizerEl = doc.createElement("div");
  sizerEl.className = "cm-sizer";
  const contentContainer = doc.createElement("div");
  contentContainer.className = "cm-contentContainer";
  const metadataEl = doc.createElement("div");
  metadataEl.className = "metadata-container";
  metadataEl.hidden = true;
  scroller.insertBefore(sizerEl, view.contentDOM);
  if (opts.inlineTitleEl) sizerEl.appendChild(opts.inlineTitleEl);
  sizerEl.appendChild(metadataEl);
  sizerEl.appendChild(contentContainer);
  // Gutters created before the move sit in the scroller; bring them along.
  for (const g of Array.from(scroller.querySelectorAll(":scope > .cm-gutters"))) contentContainer.appendChild(g);
  contentContainer.appendChild(view.contentDOM);
  const nativeInsertBefore = scroller.insertBefore;
  scroller.insertBefore = function <T extends Node>(this: HTMLElement, node: T, child: Node | null): T {
    if (child === view.contentDOM) return contentContainer.insertBefore(node, child);
    if (child && child.parentNode === contentContainer) return contentContainer.insertBefore(node, child);
    return nativeInsertBefore.call(this, node, child) as T;
  };

  const editor = new CMEditor(view, containerEl);
  view.dispatch({ effects: setEditorView.of(view) });

  // ---- Properties (frontmatter) rendered above the content
  let lastYaml: string | null = null;
  let propertiesMode = "";
  function syncProperties() {
    const state = view.state;
    const lp = state.field(editorLivePreviewField);
    const c = state.facet(configFacet);
    const fm = frontmatterInfo(state);
    const show = lp && c.propertiesInDocument === "visible" && !!fm;
    metadataEl.hidden = !show;
    containerEl.classList.toggle("show-properties", show);
    if (!show) {
      if (propertiesMode !== "hidden") {
        metadataEl.replaceChildren();
        lastYaml = null;
      }
      propertiesMode = "hidden";
      return;
    }
    if (fm!.yaml === lastYaml && propertiesMode === "shown") return;
    lastYaml = fm!.yaml;
    propertiesMode = "shown";
    metadataEl.replaceChildren();
    try {
      host.renderProperties(metadataEl, fm!.yaml, (newYaml) => {
        const cur = frontmatterInfo(view.state);
        const body = newYaml.replace(/\n+$/, "");
        lastYaml = body;
        if (cur) {
          view.dispatch({ changes: { from: cur.contentFrom, to: cur.contentTo, insert: body ? body + "\n" : "" }, userEvent: "input.properties" });
        } else {
          view.dispatch({ changes: { from: 0, insert: `---\n${body}\n---\n` }, userEvent: "input.properties" });
        }
      });
    } catch (e) {
      console.error("Properties render failed", e);
    }
  }

  function syncRootClasses() {
    const c = view.state.facet(configFacet);
    const lp = view.state.field(editorLivePreviewField);
    containerEl.classList.toggle("is-live-preview", lp);
    containerEl.classList.toggle("is-readable-line-width", c.readableLineLength);
    containerEl.classList.toggle("is-folding", c.foldHeading || c.foldIndent);
    containerEl.classList.toggle("is-rtl", c.rightToLeft);
    containerEl.classList.toggle("show-indentation-guide", c.showIndentGuide);
  }

  syncRootClasses();
  syncProperties();

  handle = {
    view,
    editor,
    containerEl,
    sizerEl,
    metadataEl,
    setMode(lp: boolean) {
      if (view.state.field(editorLivePreviewField) === lp) return;
      view.dispatch({ effects: setLivePreview.of(lp) });
    },
    isLivePreview() {
      return view.state.field(editorLivePreviewField);
    },
    reconfigure() {
      const next = readAllConfig(host);
      const effects = [configCompartment.reconfigure(configExtensions(next)), featureCompartment.reconfigure(featureExtensions(next)), extraCompartment.reconfigure(safeExtra())];
      if (next.vimMode !== config.vimMode) effects.push(vimCompartment.reconfigure(next.vimMode ? vimMode() : []));
      if (next.showLineNumber !== config.showLineNumber) effects.push(gutterCompartment.reconfigure(next.showLineNumber ? lineNumbers() : []));
      config = next;
      view.dispatch({ effects });
      if (next.showLineNumber) for (const g of Array.from(scroller.querySelectorAll(":scope > .cm-gutters"))) contentContainer.insertBefore(g, view.contentDOM);
    },
    setText(text: string, clearHistory = true) {
      if (!clearHistory) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
        return;
      }
      // A fresh state drops undo history; keep the current configuration.
      const lp = view.state.field(editorLivePreviewField);
      config = readAllConfig(host);
      view.setState(EditorState.create({ doc: text, extensions: makeExtensions(config, lp, view) }));
      // setState re-creates plugins (gutters may be re-inserted); keep the DOM shape.
      for (const g of Array.from(scroller.querySelectorAll(":scope > .cm-gutters"))) contentContainer.insertBefore(g, view.contentDOM);
      if (view.contentDOM.parentNode !== contentContainer) contentContainer.appendChild(view.contentDOM);
      lastYaml = null;
      propertiesMode = "";
      syncRootClasses();
      syncProperties();
    },
    refreshInfo() {
      view.dispatch({ effects: setEditorInfo.of(info()) });
    },
    destroy() {
      view.destroy();
      containerEl.remove();
    },
  };
  return handle;
}

export { EDITOR_COMMANDS };
