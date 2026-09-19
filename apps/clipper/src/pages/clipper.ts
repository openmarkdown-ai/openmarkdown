/**
 * The clipper: the toolbar popup, and the same page as the side panel
 * (Chromium) or sidebar (Firefox). Captures the active tab, builds the note
 * with the engine, lets the user edit it, and sends it to the web app.
 *
 * Layout and behaviour follow Obsidian Web Clipper's popup (MIT).
 */
import DOMPurify from "dompurify";
import type { ClipBehavior } from "../../../../packages/app/src/companion/protocol";
import { capturePage, type PageCapture } from "../shared/capture";
import { assembleNote, buildClip, ensureEngine, type ClipDraft } from "../shared/clip";
import type { ClipIntent, DeliverResult, RuntimeMessage } from "../shared/messages";
import {
  getHighlights,
  getSettings,
  getTemplates,
  pageKey,
  PROPERTY_TYPES,
  setHighlights,
  type PropertyType,
  type Settings,
  type Template,
} from "../shared/settings";
import { BEHAVIORS, findMatchingTemplate, isDaily, sanitizeFileName } from "../shared/templates";
import { brandMark, button, downloadText, h, icon, iconButton, PRODUCT_NAME } from "./dom";
import "./ui.css";
import "./clipper.css";

const params = new URLSearchParams(location.search);
const MODE = document.body.dataset.mode === "sidepanel" || params.get("mode") === "sidepanel" ? "sidepanel" : "popup";
const FIREFOX = __FIREFOX__;

interface State {
  settings: Settings;
  templates: Template[];
  tabId: number | null;
  page: PageCapture | null;
  template: Template | null;
  draft: ClipDraft | null;
  ignoreSelection: boolean;
  view: "preview" | "markdown";
  busy: boolean;
}

const state: State = {
  settings: null as unknown as Settings,
  templates: [],
  tabId: null,
  page: null,
  template: null,
  draft: null,
  ignoreSelection: false,
  view: "preview",
  busy: false,
};

// ---- skeleton -------------------------------------------------------------------

const app = document.getElementById("app")!;
const banner = h("div", { class: "banner", role: "status", hidden: true });
const templateSelect = h("select", { class: "oa-select", id: "template", "aria-label": "Template" });
const nameInput = h("input", { class: "oa-input", id: "note-name", type: "text", spellcheck: "false" });
const folderInput = h("input", { class: "oa-input", id: "folder", type: "text", spellcheck: "false", placeholder: "Vault root" });
const vaultSelect = h("select", { class: "oa-select", id: "vault" });
const behaviorSelect = h("select", { class: "oa-select", id: "behavior" });
for (const b of BEHAVIORS) behaviorSelect.append(h("option", { value: b.value, text: b.label }));
const propsList = h("div", { class: "props", id: "properties" });
const highlightsLine = h("div", { class: "highlights-line", hidden: true });
const preview = h("div", { class: "preview markdown", id: "preview" });
const markdownArea = h("textarea", { class: "oa-textarea mono", id: "markdown", spellcheck: "false", hidden: true });
const segPreview = h("button", { type: "button", role: "tab", "aria-selected": "true", text: "Preview" });
const segMarkdown = h("button", { type: "button", role: "tab", "aria-selected": "false", text: "Markdown" });
const addButton = button("Add to vault", () => void addToVault(), "primary");
addButton.classList.add("oa-btn--md", "add");
addButton.id = "add-to-vault";
const copyButton = iconButton("copy", "Copy Markdown", () => void copyMarkdown());
copyButton.id = "copy-markdown";
const downloadButton = iconButton("download", "Download .md", () => downloadNote());
downloadButton.id = "download-md";
const highlighterButton = iconButton("highlighter", "Highlighter (Alt+Shift+H)", () => void toggleScript("content/highlighter.js"));
highlighterButton.id = "toggle-highlighter";
const readerButton = iconButton("bookOpen", "Reader view (Alt+Shift+R)", () => void toggleScript("content/reader.js"));
readerButton.id = "toggle-reader";
const sidePanelButton = iconButton("panelRight", "Open in side panel", () => void openSidePanel());
const settingsButton = iconButton("settings", "Templates and settings", () => void chrome.runtime.openOptionsPage());
const loading = h("div", { class: "loading", text: "Reading the page…" });

const nameField = h("label", { class: "field" }, h("span", { class: "oa-label", text: "Note name" }), nameInput);
const folderField = h("label", { class: "field" }, h("span", { class: "oa-label", text: "Folder" }), folderInput);
const form = h(
  "div",
  { class: "form", hidden: true },
  h("label", { class: "field" }, h("span", { class: "oa-label", text: "Template" }), templateSelect),
  nameField,
  h("div", { class: "row" }, folderField, h("label", { class: "field" }, h("span", { class: "oa-label", text: "Vault" }), vaultSelect)),
  h("label", { class: "field" }, h("span", { class: "oa-label", text: "When adding" }), behaviorSelect),
  h(
    "section",
    { class: "section" },
    h("div", { class: "section-head" }, h("p", { class: "eyebrow", text: "Properties" }), iconButton("plus", "Add property", () => addProperty())),
    propsList,
  ),
  highlightsLine,
  h(
    "section",
    { class: "section" },
    h("div", { class: "section-head" }, h("p", { class: "eyebrow", text: "Content" }), h("div", { class: "segmented", role: "tablist" }, segPreview, segMarkdown)),
    preview,
    markdownArea,
  ),
);

const tools = h("div", { class: "tools" }, highlighterButton, readerButton);
if (MODE === "popup" && !FIREFOX) tools.append(sidePanelButton);
tools.append(settingsButton);

app.append(
  h("header", { class: "top" }, brandMark(), tools),
  h("main", { class: "body" }, banner, loading, form),
  h("footer", { class: "actions" }, addButton, copyButton, downloadButton),
);

function showBanner(kind: "error" | "ok" | "info" | null, text = "") {
  banner.hidden = !kind;
  banner.className = `banner banner--${kind ?? "info"}`;
  banner.textContent = text;
}

function setBusy(busy: boolean) {
  state.busy = busy;
  addButton.disabled = busy || !state.draft;
  copyButton.disabled = !state.draft;
  downloadButton.disabled = !state.draft;
}

// ---- form <-> draft -------------------------------------------------------------------

function renderTemplates() {
  templateSelect.replaceChildren(...state.templates.map((t) => h("option", { value: t.id, text: t.name })));
  if (state.template) templateSelect.value = state.template.id;
}

/** Option values are `<origin>#<vault id>`; "" means the vault open in whichever app tab answers. */
function renderVaults() {
  const vaults = state.settings.knownVaults;
  const multipleOrigins = new Set(vaults.map((v) => v.origin)).size > 1;
  vaultSelect.replaceChildren(
    h("option", { value: "", text: "Vault open in the app" }),
    ...vaults.map((v) => h("option", { value: `${v.origin}#${v.id}`, text: multipleOrigins ? `${v.name} (${new URL(v.origin).host})` : v.name })),
  );
  const wanted = state.template?.vault || state.settings.defaultVault;
  const match = wanted ? (vaults.find((v) => v.id === wanted && v.origin === state.settings.defaultAppOrigin) ?? vaults.find((v) => v.id === wanted)) : undefined;
  vaultSelect.value = match ? `${match.origin}#${match.id}` : "";
}

function propertyRow(index: number): HTMLElement {
  const p = state.draft!.properties[index]!;
  const nameEl = h("input", { class: "oa-input prop-name", type: "text", value: p.name, "aria-label": "Property name", spellcheck: "false" });
  const typeEl = h("select", { class: "oa-select prop-type", "aria-label": "Property type" });
  for (const t of PROPERTY_TYPES) typeEl.append(h("option", { value: t, text: t }));
  typeEl.value = p.type;
  const valueEl =
    p.type === "checkbox"
      ? h("input", { class: "prop-check", type: "checkbox", checked: p.value === "true", "aria-label": p.name })
      : h("input", { class: "oa-input prop-value", type: "text", value: p.value, "aria-label": `${p.name} value`, spellcheck: "false" });
  nameEl.addEventListener("input", () => {
    p.name = nameEl.value;
    onDraftChanged(false);
  });
  typeEl.addEventListener("change", () => {
    p.type = typeEl.value as PropertyType;
    renderProperties();
    onDraftChanged(false);
  });
  valueEl.addEventListener(p.type === "checkbox" ? "change" : "input", () => {
    p.value = valueEl instanceof HTMLInputElement && valueEl.type === "checkbox" ? String(valueEl.checked) : (valueEl as HTMLInputElement).value;
    onDraftChanged(false);
  });
  const remove = iconButton("x", `Remove ${p.name}`, () => {
    state.draft!.properties.splice(index, 1);
    renderProperties();
    onDraftChanged(false);
  });
  return h("div", { class: "prop", "data-name": p.name }, nameEl, typeEl, valueEl, remove);
}

function renderProperties() {
  propsList.replaceChildren(...(state.draft?.properties ?? []).map((_, i) => propertyRow(i)));
  if (!state.draft?.properties.length) propsList.append(h("p", { class: "hint", text: "No properties." }));
}

function addProperty() {
  if (!state.draft) return;
  state.draft.properties.push({ name: "", value: "", type: "text" });
  renderProperties();
  (propsList.querySelector(".prop:last-child .prop-name") as HTMLInputElement | null)?.focus();
}

async function renderHighlightsLine() {
  if (!state.page) return;
  const list = await getHighlights(state.page.url);
  highlightsLine.hidden = !list.length;
  highlightsLine.replaceChildren(
    icon("highlighter", 14),
    h("span", { text: list.length === 1 ? "1 highlight on this page" : `${list.length} highlights on this page` }),
    button("Clear", () => void setHighlights(state.page!.url, []), "ghost"),
  );
}

let previewTimer = 0;
function renderPreview() {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(async () => {
    if (!state.draft) return;
    const engine = await ensureEngine();
    const sections = engine.render(state.draft.body, { strictLineBreaks: false });
    preview.innerHTML = DOMPurify.sanitize(sections.map((s) => s.html).join("\n"), { FORBID_TAGS: ["style", "form"], ADD_ATTR: ["target"] });
    for (const a of preview.querySelectorAll("a[href]")) a.setAttribute("target", "_blank");
  }, 120);
}

function onDraftChanged(bodyChanged: boolean) {
  if (!state.draft) return;
  if (bodyChanged) renderPreview();
  if (state.view === "markdown" && document.activeElement !== markdownArea) markdownArea.value = assembleNote(state.draft, state.settings).markdown;
}

function fillForm() {
  const d = state.draft!;
  renderTemplates();
  renderVaults();
  nameInput.value = d.noteName;
  folderInput.value = d.folder;
  behaviorSelect.value = d.behavior;
  const daily = isDaily(d.behavior);
  nameField.hidden = daily;
  folderField.hidden = daily;
  renderProperties();
  markdownArea.value = assembleNote(d, state.settings).markdown;
  renderPreview();
  if (d.errors.length) showBanner("error", `Template: ${d.errors.map((e) => e.message).join("; ")}`);
  else if (d.interpreter) showBanner("info", interpreterHint(d.interpreter.prompts));
}

nameInput.addEventListener("input", () => state.draft && (state.draft.noteName = nameInput.value));
folderInput.addEventListener("input", () => state.draft && (state.draft.folder = folderInput.value));
behaviorSelect.addEventListener("change", () => {
  if (!state.draft) return;
  state.draft.behavior = behaviorSelect.value as ClipBehavior;
  nameField.hidden = folderField.hidden = isDaily(state.draft.behavior);
});
templateSelect.addEventListener("change", () => {
  state.template = state.templates.find((t) => t.id === templateSelect.value) ?? state.template;
  void rebuild();
});

/** The Markdown tab edits the whole note; frontmatter edits flow back into the properties only on the next build. */
markdownArea.addEventListener("input", () => {
  if (!state.draft) return;
  const text = markdownArea.value;
  const m = /^---\n[\s\S]*?\n---\n/.exec(text);
  state.draft.body = m ? text.slice(m[0].length) : text;
  renderPreview();
});

function setView(view: "preview" | "markdown") {
  state.view = view;
  segPreview.setAttribute("aria-selected", String(view === "preview"));
  segMarkdown.setAttribute("aria-selected", String(view === "markdown"));
  preview.hidden = view !== "preview";
  markdownArea.hidden = view !== "markdown";
  if (view === "markdown" && state.draft) markdownArea.value = assembleNote(state.draft, state.settings).markdown;
}
segPreview.addEventListener("click", () => setView("preview"));
segMarkdown.addEventListener("click", () => setView("markdown"));

// ---- page capture and build -------------------------------------------------------------

async function targetTabId(): Promise<number | null> {
  const fromParam = Number(params.get("tab"));
  if (fromParam) return fromParam;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function takeIntent(tabId: number): Promise<ClipIntent | null> {
  const key = `intent:${tabId}`;
  const got = await chrome.storage.session.get(key);
  const intent = got[key] as ClipIntent | undefined;
  if (!intent) return null;
  await chrome.storage.session.remove(key);
  return Date.now() - intent.at < 60_000 ? intent : null;
}

async function fetchLink(url: string): Promise<PageCapture> {
  const load = async () => {
    const res = await fetch(url, { credentials: "omit", redirect: "follow" });
    if (!res.ok) throw new Error(`The link answered ${res.status}.`);
    return { url: res.url || url, title: "", html: await res.text(), selectionHtml: "", selectionText: "" };
  };
  try {
    return await load();
  } catch (e) {
    const origin = new URL(url).origin;
    const allowed = await chrome.permissions.contains({ origins: [`${origin}/*`] });
    if (allowed) throw e;
    // Reading another site needs its permission; ask on a click (a user gesture).
    return new Promise((resolve, reject) => {
      showBanner("info", `To clip this link, allow the extension to read ${origin}.`);
      const allow = button(`Allow ${new URL(url).host}`, async () => {
        if (await chrome.permissions.request({ origins: [`${origin}/*`] })) {
          allow.remove();
          showBanner(null);
          load().then(resolve, reject);
        }
      });
      banner.append(h("div", { class: "banner-actions" }, allow));
    });
  }
}

async function rebuild() {
  if (!state.page || !state.template) return;
  try {
    const highlights = await getHighlights(state.page.url);
    state.draft = await buildClip(state.page, state.template, { settings: state.settings, highlights, ignoreSelection: state.ignoreSelection });
    showBanner(null);
    fillForm();
    form.hidden = false;
  } catch (e) {
    showBanner("error", e instanceof Error ? e.message : String(e));
  } finally {
    loading.hidden = true;
    setBusy(false);
    void renderHighlightsLine();
  }
}

async function load() {
  setBusy(true);
  loading.hidden = false;
  form.hidden = true;
  showBanner(null);
  [state.settings, state.templates] = await Promise.all([getSettings(), getTemplates()]);
  state.tabId = await targetTabId();
  if (state.tabId === null) {
    loading.hidden = true;
    showBanner("error", "No page to clip.");
    return;
  }
  try {
    const intent = await takeIntent(state.tabId);
    state.ignoreSelection = intent?.mode === "page";
    state.page = intent?.mode === "link" && intent.linkUrl ? await fetchLink(intent.linkUrl) : await capturePage(state.tabId);
    const engine = await ensureEngine();
    const extracted = engine.extract(state.page.html, state.page.url);
    state.template = findMatchingTemplate(state.templates, state.page.url, extracted.schemaOrgData) ?? state.templates[0]!;
    await rebuild();
  } catch (e) {
    loading.hidden = true;
    const msg = e instanceof Error ? e.message : String(e);
    showBanner(
      "error",
      /Cannot access|cannot be scripted|Missing host permission|not allowed/i.test(msg)
        ? "This page cannot be clipped. Browser pages and the extension store do not allow extensions; on other pages, open the clipper from the toolbar button."
        : msg,
    );
  }
}

function interpreterHint(prompts: number): string {
  return `${prompts === 1 ? "1 prompt variable" : `${prompts} prompt variables`} will be filled by ${PRODUCT_NAME}'s AI when you add the note. If AI is off there, they stay as {{"…"}}.`;
}

// ---- actions ------------------------------------------------------------------------------

function currentNote() {
  const d = state.draft!;
  d.noteName = nameInput.value;
  d.folder = folderInput.value;
  d.behavior = behaviorSelect.value as ClipBehavior;
  return assembleNote(d, state.settings);
}

async function addToVault() {
  if (!state.draft || state.busy) return;
  setBusy(true);
  addButton.textContent = "Adding…";
  try {
    const note = currentNote();
    const [origin, vaultId] = vaultSelect.value ? [vaultSelect.value.slice(0, vaultSelect.value.indexOf("#")), vaultSelect.value.slice(vaultSelect.value.indexOf("#") + 1)] : [undefined, undefined];
    const msg: RuntimeMessage = { kind: "deliver-clip", clip: { path: note.path, content: note.content, behavior: state.draft.behavior, interpreter: note.interpreter }, origin, vaultId };
    if (note.interpreter) addButton.textContent = "Filling prompts…";
    const r = (await chrome.runtime.sendMessage(msg)) as DeliverResult;
    if (r.ok && r.interpreter?.message) showBanner("info", `Added to ${r.path ?? "the vault"}. ${r.interpreter.message}`);
    else if (r.ok && r.interpreter?.prompts) showBanner("ok", `Added to ${r.path ?? "the vault"}. Filled ${r.interpreter.filled} prompt variable${r.interpreter.filled === 1 ? "" : "s"} · ${r.interpreter.engine ?? "AI"}.`);
    else if (r.ok) showBanner("ok", `Added to ${r.path ?? "the vault"}.`);
    else showBanner("error", r.error ?? "The app did not accept the clip.");
  } catch (e) {
    showBanner("error", e instanceof Error ? e.message : String(e));
  } finally {
    addButton.textContent = "Add to vault";
    setBusy(false);
  }
}

async function copyMarkdown() {
  if (!state.draft) return;
  await navigator.clipboard.writeText(currentNote().markdown);
  showBanner("ok", "Markdown copied.");
}

function downloadNote() {
  if (!state.draft) return;
  const note = currentNote();
  downloadText(`${sanitizeFileName(state.draft.noteName)}.md`, note.markdown);
}

async function toggleScript(file: string) {
  if (state.tabId === null) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: [file] });
    if (file.includes("highlighter")) highlighterButton.classList.toggle("oa-icon-btn--selected");
    if (file.includes("reader")) readerButton.classList.toggle("oa-icon-btn--selected");
  } catch (e) {
    showBanner("error", e instanceof Error ? e.message : String(e));
  }
}

async function openSidePanel() {
  if (state.tabId === null) return;
  await chrome.sidePanel.open({ tabId: state.tabId });
  window.close();
}

// Highlights change while the highlighter runs: rebuild so {{content}} and {{highlights}} follow.
let highlightTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && state.page && `highlights:${pageKey(state.page.url)}` in changes) {
    window.clearTimeout(highlightTimer);
    highlightTimer = window.setTimeout(() => void rebuild(), 250);
  }
  if (area === "session" && state.tabId !== null && `intent:${state.tabId}` in changes && changes[`intent:${state.tabId}`]!.newValue) void load();
  if (area === "local" && ("templates" in changes || "settings" in changes)) {
    void Promise.all([getSettings(), getTemplates()]).then(([s, t]) => {
      state.settings = s;
      state.templates = t;
      renderTemplates();
      renderVaults();
    });
  }
});

if (MODE === "sidepanel") {
  chrome.tabs.onActivated.addListener(() => void load());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "complete" && tabId === state.tabId) void load();
  });
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void addToVault();
});

document.documentElement.dataset.mode = MODE;
void load();
