/**
 * Options: templates (create, edit, duplicate, delete, reorder, import and
 * export in Web Clipper's JSON), general settings, and the network bridge.
 */
import type { ClipBehavior } from "../../../../packages/app/src/companion/protocol";
import type { RuntimeMessage } from "../shared/messages";
import {
  defaultTemplate,
  DEFAULT_SETTINGS,
  DEFAULT_PROMPT_CONTEXT,
  getSettings,
  getTemplates,
  newId,
  normalizeOrigin,
  originMatchPattern,
  PROPERTY_TYPES,
  saveSettings,
  saveTemplates,
  type HighlightBehavior,
  type PropertyType,
  type Settings,
  type Template,
} from "../shared/settings";
import { BEHAVIORS, exportFileName, exportTemplate, importTemplatesText, isDaily } from "../shared/templates";
import { brandMark, button, downloadText, h, iconButton, PRODUCT_NAME } from "./dom";
import "./ui.css";
import "./options.css";

const FIREFOX = __FIREFOX__;

let settings: Settings;
let templates: Template[] = [];
let selectedId: string | null = null;
let section: "templates" | "general" | "bridge" | "about" = "templates";

const root = document.getElementById("app")!;
const nav = h("nav", { class: "side-nav", "aria-label": "Settings" });
const content = h("main", { class: "content" });
const toast = h("div", { class: "toast banner", role: "status", hidden: true });

root.append(h("header", { class: "top" }, brandMark(), h("span", { class: "top-title", text: "Clipper settings" })), h("div", { class: "layout" }, nav, content), toast);

function flash(kind: "ok" | "error", text: string) {
  toast.className = `toast banner banner--${kind}`;
  toast.textContent = text;
  toast.hidden = false;
  window.clearTimeout((flash as unknown as { t: number }).t);
  (flash as unknown as { t: number }).t = window.setTimeout(() => (toast.hidden = true), kind === "error" ? 6000 : 2500);
}

let saveTimer = 0;
function persistTemplates(immediate = false) {
  window.clearTimeout(saveTimer);
  const run = () => void saveTemplates(templates);
  if (immediate) run();
  else saveTimer = window.setTimeout(run, 300);
}

async function persistSettings(patch: Partial<Settings>) {
  settings = await saveSettings(patch);
  const msg: RuntimeMessage = { kind: "settings-changed" };
  await chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---- navigation ------------------------------------------------------------------------

function renderNav() {
  const items: [typeof section, string][] = [
    ["templates", "Templates"],
    ["general", "General"],
    ["bridge", "Network bridge"],
    ["about", "About"],
  ];
  nav.replaceChildren(
    ...items.map(([id, label]) => {
      const b = h("button", { type: "button", class: "nav-item", "aria-current": section === id ? "page" : undefined, "data-section": id, text: label });
      b.addEventListener("click", () => {
        section = id;
        location.hash = id;
        render();
      });
      return b;
    }),
  );
}

function render() {
  renderNav();
  if (section === "templates") renderTemplates();
  else if (section === "general") renderGeneral();
  else if (section === "bridge") void renderBridge();
  else renderAbout();
}

// ---- templates -------------------------------------------------------------------------

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "oa-label", text: label }), control, hint ? h("p", { class: "hint", text: hint }) : null);
}

function renderTemplates() {
  const list = h("ul", { class: "template-list", id: "template-list" });
  templates.forEach((t, i) => {
    const item = h("li", { class: "template-item", draggable: "true", "aria-selected": String(t.id === selectedId), "data-id": t.id });
    const name = h("button", { type: "button", class: "template-name", text: t.name || "Untitled" });
    name.addEventListener("click", () => {
      selectedId = t.id;
      renderTemplates();
    });
    const up = iconButton("arrowUp", `Move ${t.name} up`, () => move(i, -1));
    const down = iconButton("arrowDown", `Move ${t.name} down`, () => move(i, 1));
    up.disabled = i === 0;
    down.disabled = i === templates.length - 1;
    item.append(name, up, down);
    item.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/x-template-index", String(i)));
    item.addEventListener("dragover", (e) => e.preventDefault());
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer?.getData("text/x-template-index"));
      if (Number.isNaN(from) || from === i) return;
      const [moved] = templates.splice(from, 1);
      templates.splice(i, 0, moved!);
      persistTemplates(true);
      renderTemplates();
    });
    list.append(item);
  });

  const fileInput = h("input", { type: "file", accept: ".json,application/json", multiple: true, hidden: true, id: "import-file" });
  fileInput.addEventListener("change", async () => {
    for (const f of Array.from(fileInput.files ?? [])) await importText(await f.text());
    fileInput.value = "";
  });

  const sidebar = h(
    "div",
    { class: "templates-side" },
    h("div", { class: "section-head" }, h("p", { class: "eyebrow", text: "Templates" })),
    list,
    h(
      "div",
      { class: "template-actions" },
      button("New template", () => newTemplate(), "secondary", "plus"),
      button("Import", () => fileInput.click(), "ghost", "upload"),
      fileInput,
    ),
    h("p", { class: "hint", text: "The first template whose trigger matches the page is used; otherwise the first in the list. Drop exported .json files here to import." }),
  );
  sidebar.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  sidebar.addEventListener("drop", async (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    for (const f of Array.from(e.dataTransfer.files)) await importText(await f.text());
  });

  const selected = templates.find((t) => t.id === selectedId) ?? templates[0];
  selectedId = selected?.id ?? null;
  content.replaceChildren(h("div", { class: "templates" }, sidebar, selected ? templateEditor(selected) : h("div", { class: "empty", text: "No templates." })));
}

async function importText(text: string) {
  try {
    const imported = importTemplatesText(text, templates.map((t) => t.name));
    templates.push(...imported);
    selectedId = imported[imported.length - 1]?.id ?? selectedId;
    persistTemplates(true);
    renderTemplates();
    flash("ok", imported.length === 1 ? `Imported “${imported[0]!.name}”.` : `Imported ${imported.length} templates.`);
  } catch (e) {
    flash("error", (e as Error).message);
  }
}

function move(i: number, by: number) {
  const j = i + by;
  if (j < 0 || j >= templates.length) return;
  [templates[i], templates[j]] = [templates[j]!, templates[i]!];
  persistTemplates(true);
  renderTemplates();
}

function newTemplate() {
  const t: Template = { ...defaultTemplate(), id: newId(), name: uniqueName("New template") };
  templates.push(t);
  selectedId = t.id;
  persistTemplates(true);
  renderTemplates();
}

function uniqueName(base: string): string {
  const names = new Set(templates.map((t) => t.name));
  if (!names.has(base)) return base;
  let i = 1;
  while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function templateEditor(t: Template): HTMLElement {
  const changed = () => persistTemplates();

  const name = h("input", { class: "oa-input", id: "tpl-name", type: "text", value: t.name });
  name.addEventListener("input", () => {
    t.name = name.value;
    changed();
    const btn = document.querySelector(`.template-item[data-id="${t.id}"] .template-name`);
    if (btn) btn.textContent = t.name || "Untitled";
  });

  const behavior = h("select", { class: "oa-select", id: "tpl-behavior" });
  for (const b of BEHAVIORS) behavior.append(h("option", { value: b.value, text: b.label }));
  behavior.value = t.behavior;

  const noteName = h("input", { class: "oa-input mono", id: "tpl-note-name", type: "text", value: t.noteNameFormat, spellcheck: "false" });
  noteName.addEventListener("input", () => ((t.noteNameFormat = noteName.value), changed()));
  const path = h("input", { class: "oa-input mono", id: "tpl-path", type: "text", value: t.path, spellcheck: "false" });
  path.addEventListener("input", () => ((t.path = path.value), changed()));
  const locationFields = h(
    "div",
    { class: "grid-2" },
    field("Note name", noteName, "Template syntax, e.g. {{title}} or {{date|date:\"YYYY-MM-DD\"}} {{title}}."),
    field(t.behavior.endsWith("specific") ? "Note location (folder)" : "Note location", path, "Folder, templated. Empty means the vault root."),
  );
  locationFields.hidden = isDaily(t.behavior);
  behavior.addEventListener("change", () => {
    t.behavior = behavior.value as ClipBehavior;
    locationFields.hidden = isDaily(t.behavior);
    changed();
  });

  const vault = h("select", { class: "oa-select", id: "tpl-vault" });
  vault.append(h("option", { value: "", text: "Default vault" }), ...settings.knownVaults.map((v) => h("option", { value: v.id, text: `${v.name} (${new URL(v.origin).host})` })));
  vault.value = t.vault ?? "";
  vault.addEventListener("change", () => ((t.vault = vault.value || undefined), changed()));

  const triggers = h("textarea", { class: "oa-textarea mono", id: "tpl-triggers", rows: 3, spellcheck: "false", placeholder: "https://example.com/\n/^https:\\/\\/www\\.imdb\\.com\\/title\\//\nschema:@Recipe" });
  triggers.value = t.triggers.join("\n");
  triggers.addEventListener("input", () => {
    t.triggers = triggers.value.split("\n").map((s) => s.trim()).filter(Boolean);
    changed();
  });

  const props = h("div", { class: "prop-editor", id: "tpl-properties" });
  const renderProps = () => {
    props.replaceChildren(
      ...t.properties.map((p, i) => {
        const pn = h("input", { class: "oa-input", type: "text", value: p.name, "aria-label": "Property name", spellcheck: "false" });
        pn.addEventListener("input", () => ((p.name = pn.value), changed()));
        const pt = h("select", { class: "oa-select", "aria-label": "Property type" });
        for (const ty of PROPERTY_TYPES) pt.append(h("option", { value: ty, text: ty }));
        pt.value = p.type;
        pt.addEventListener("change", () => ((p.type = pt.value as PropertyType), changed()));
        const pv = h("input", { class: "oa-input mono", type: "text", value: p.value, "aria-label": "Property value", spellcheck: "false" });
        pv.addEventListener("input", () => ((p.value = pv.value), changed()));
        const up = iconButton("arrowUp", "Move up", () => {
          if (i === 0) return;
          [t.properties[i - 1], t.properties[i]] = [t.properties[i]!, t.properties[i - 1]!];
          changed();
          renderProps();
        });
        up.disabled = i === 0;
        const del = iconButton("trash", `Remove ${p.name}`, () => {
          t.properties.splice(i, 1);
          changed();
          renderProps();
        });
        return h("div", { class: "prop-edit-row" }, pn, pt, pv, up, del);
      }),
      h(
        "div",
        {},
        button("Add property", () => {
          t.properties.push({ id: newId(), name: "", value: "", type: "text" });
          changed();
          renderProps();
        }, "ghost", "plus"),
      ),
    );
  };
  renderProps();

  const body = h("textarea", { class: "oa-textarea mono", id: "tpl-content", rows: 10, spellcheck: "false" });
  body.value = t.noteContentFormat;
  body.addEventListener("input", () => ((t.noteContentFormat = body.value), changed()));

  const context = h("textarea", { class: "oa-textarea mono", id: "tpl-context", rows: 2, spellcheck: "false", placeholder: settings.defaultPromptContext || DEFAULT_PROMPT_CONTEXT });
  context.value = t.context ?? "";
  context.addEventListener("input", () => ((t.context = context.value.trim() ? context.value : undefined), changed()));

  const actions = h(
    "div",
    { class: "editor-actions" },
    button("Duplicate", () => {
      const copy: Template = { ...structuredClone(t), id: newId(), name: uniqueName(`${t.name} copy`) };
      copy.properties = copy.properties.map((p) => ({ ...p, id: newId() }));
      templates.splice(templates.indexOf(t) + 1, 0, copy);
      selectedId = copy.id;
      persistTemplates(true);
      renderTemplates();
    }, "secondary", "copy"),
    button("Export", () => downloadText(exportFileName(t), exportTemplate(t), "application/json"), "secondary", "download"),
    button("Copy JSON", async () => {
      await navigator.clipboard.writeText(exportTemplate(t));
      flash("ok", "Template JSON copied.");
    }, "ghost"),
    button("Delete", () => {
      if (templates.length === 1) {
        flash("error", "Keep at least one template.");
        return;
      }
      if (!confirm(`Delete the template “${t.name}”?`)) return;
      templates = templates.filter((x) => x !== t);
      selectedId = templates[0]?.id ?? null;
      persistTemplates(true);
      renderTemplates();
    }, "danger", "trash"),
  );

  return h(
    "div",
    { class: "editor oa-card", id: "template-editor" },
    h("div", { class: "grid-2" }, field("Template name", name), field("Behavior", behavior)),
    locationFields,
    field("Vault", vault),
    field("Triggers", triggers, "One per line: a URL prefix, a /regular expression/, or schema:@Type, schema:@Type.key or schema:@Type.key=value."),
    h("div", { class: "field" }, h("span", { class: "oa-label", text: "Properties" }), props),
    field("Note content", body, "Variables such as {{content}}, {{selection}}, {{highlights}}, {{meta:property:og:title}}, {{schema:@Article:headline}} and {{selector:h1}}, with filters and {% if %}/{% for %} logic. Prompt variables such as {{\"a summary of the page\"}} are filled by the app's AI."),
    field("Prompt context", context, "What prompt variables are asked about, e.g. {{selectorHtml:article}} or {{content}}. Empty uses the default prompt context."),
    actions,
  );
}

// ---- general -------------------------------------------------------------------------------

function renderGeneral() {
  const origins = h("div", { class: "origin-list", id: "origins" });
  const renderOrigins = async () => {
    const rows = await Promise.all(
      settings.appOrigins.map(async (o) => {
        const granted = await chrome.permissions.contains({ origins: [originMatchPattern(o, FIREFOX)] }).catch(() => false);
        const remove = iconButton("x", `Remove ${o}`, async () => {
          const appOrigins = settings.appOrigins.filter((x) => x !== o);
          await persistSettings({ appOrigins, defaultAppOrigin: appOrigins.includes(settings.defaultAppOrigin) ? settings.defaultAppOrigin : (appOrigins[0] ?? "") });
          renderGeneral();
        });
        const allow = granted
          ? h("span", { class: "oa-badge", text: "Allowed" })
          : button("Allow", async () => {
              if (await chrome.permissions.request({ origins: [originMatchPattern(o, FIREFOX)] })) {
                await persistSettings({});
                renderGeneral();
              }
            }, "secondary");
        return h("div", { class: "origin-row" }, h("span", { class: "mono origin", text: o }), allow, remove);
      }),
    );
    origins.replaceChildren(...rows);
  };
  void renderOrigins();

  const newOrigin = h("input", { class: "oa-input mono", type: "url", placeholder: "https://notes.example.com", id: "new-origin" });
  const addOrigin = button("Add", async () => {
    const o = normalizeOrigin(newOrigin.value);
    if (!o) {
      flash("error", "Enter an http or https address.");
      return;
    }
    // Ask for the page permission first: it has to happen inside this click.
    const ok = await chrome.permissions.request({ origins: [originMatchPattern(o, FIREFOX)] }).catch(() => false);
    if (!settings.appOrigins.includes(o)) await persistSettings({ appOrigins: [...settings.appOrigins, o] });
    if (!ok) flash("error", "Without permission for that address the clipper cannot reach the app there.");
    renderGeneral();
  }, "secondary", "plus");

  const defaultOrigin = h("select", { class: "oa-select", id: "default-origin" });
  for (const o of settings.appOrigins) defaultOrigin.append(h("option", { value: o, text: o }));
  defaultOrigin.value = settings.defaultAppOrigin;
  defaultOrigin.addEventListener("change", () => void persistSettings({ defaultAppOrigin: defaultOrigin.value }).then(renderGeneral));

  const vault = h("select", { class: "oa-select", id: "default-vault" });
  vault.append(h("option", { value: "", text: "Whichever vault the app opens" }));
  for (const v of settings.knownVaults.filter((k) => k.origin === settings.defaultAppOrigin)) vault.append(h("option", { value: v.id, text: v.name }));
  vault.value = settings.defaultVault;
  vault.addEventListener("change", () => void persistSettings({ defaultVault: vault.value }));

  const dateFormat = h("input", { class: "oa-input mono", id: "date-format", type: "text", value: settings.dateFormat });
  dateFormat.addEventListener("change", () => void persistSettings({ dateFormat: dateFormat.value.trim() || DEFAULT_SETTINGS.dateFormat }));
  const datetimeFormat = h("input", { class: "oa-input mono", id: "datetime-format", type: "text", value: settings.datetimeFormat });
  datetimeFormat.addEventListener("change", () => void persistSettings({ datetimeFormat: datetimeFormat.value.trim() || DEFAULT_SETTINGS.datetimeFormat }));

  const hl = h("select", { class: "oa-select", id: "highlight-behavior" });
  for (const [v, l] of [
    ["highlight-inline", "Highlight passages inside the content"],
    ["replace-content", "Replace the content with the highlights"],
    ["no-highlights", "Ignore highlights"],
  ]) hl.append(h("option", { value: v!, text: l! }));
  hl.value = settings.highlightBehavior;
  hl.addEventListener("change", () => void persistSettings({ highlightBehavior: hl.value as HighlightBehavior }));

  const open = h("input", { type: "checkbox", id: "open-after", checked: !settings.silentOpen });
  open.addEventListener("change", () => void persistSettings({ silentOpen: !open.checked }));

  const interpreter = h("input", { type: "checkbox", id: "interpreter-enabled", checked: settings.interpreterEnabled !== false });
  interpreter.addEventListener("change", () => void persistSettings({ interpreterEnabled: interpreter.checked }));
  const promptContext = h("textarea", { class: "oa-textarea mono", id: "default-prompt-context", rows: 3, spellcheck: "false", placeholder: DEFAULT_PROMPT_CONTEXT });
  promptContext.value = settings.defaultPromptContext ?? "";
  promptContext.addEventListener("change", () => void persistSettings({ defaultPromptContext: promptContext.value.trim() }));

  const types = h("div", { class: "prop-editor", id: "property-types" });
  const renderTypes = () => {
    types.replaceChildren(
      ...settings.propertyTypes.map((p, i) => {
        const n = h("input", { class: "oa-input", type: "text", value: p.name, "aria-label": "Property name" });
        const t = h("select", { class: "oa-select", "aria-label": "Type" });
        for (const ty of PROPERTY_TYPES) t.append(h("option", { value: ty, text: ty }));
        t.value = p.type;
        const commit = () => {
          const next = settings.propertyTypes.slice();
          next[i] = { ...p, name: n.value.trim(), type: t.value as PropertyType };
          void persistSettings({ propertyTypes: next });
        };
        n.addEventListener("change", commit);
        t.addEventListener("change", commit);
        const del = iconButton("trash", `Remove ${p.name}`, async () => {
          await persistSettings({ propertyTypes: settings.propertyTypes.filter((_, j) => j !== i) });
          renderTypes();
        });
        return h("div", { class: "type-row" }, n, t, del);
      }),
      h("div", {}, button("Add property type", async () => {
        await persistSettings({ propertyTypes: [...settings.propertyTypes, { name: "", type: "text" }] });
        renderTypes();
      }, "ghost", "plus")),
    );
  };
  renderTypes();

  content.replaceChildren(
    h(
      "div",
      { class: "stack" },
      h(
        "section",
        { class: "oa-card panel" },
        h("p", { class: "eyebrow", text: "The app" }),
        h("h2", { text: `Where ${PRODUCT_NAME} runs.` }),
        h("p", { class: "lede", text: "Clips and network requests go only to these addresses. An address without a port covers every port on that host." }),
        origins,
        h("div", { class: "inline-add" }, newOrigin, addOrigin),
        h("div", { class: "grid-2" }, field("Send clips to", defaultOrigin), field("Default vault", vault, "Vaults appear here once the app has been open with the extension installed.")),
        h("label", { class: "oa-checkbox" }, open, "Open the note in the app after adding it"),
      ),
      h(
        "section",
        { class: "oa-card panel" },
        h("p", { class: "eyebrow", text: "Notes" }),
        h("h2", { text: "How clipped values are written." }),
        h("div", { class: "grid-2" }, field("Date format", dateFormat, "For date properties that do not set their own |date filter."), field("Date and time format", datetimeFormat)),
        field("Highlights", hl),
        h("div", { class: "field" }, h("span", { class: "oa-label", text: "Property types" }), types, h("p", { class: "hint", text: "A property's type decides how it is written to frontmatter: lists for multitext, bare values for numbers, dates and checkboxes." })),
      ),
      h(
        "section",
        { class: "oa-card panel", id: "interpreter" },
        h("p", { class: "eyebrow", text: "Interpreter" }),
        h("h2", { text: "Prompt variables." }),
        h("p", {
          class: "lede",
          text: `Templates can ask questions about the page with prompt variables, like {{"a three bullet summary"}} or {{"tags for this page"|split:", "}}. The extension has no model: ${PRODUCT_NAME} answers them with the AI engine you choose for the web clipper in its Settings → AI, and names that engine when the clip is added. With AI off there, the variables stay in the note as written.`,
        }),
        h("label", { class: "oa-checkbox" }, interpreter, "Keep prompt variables for the app to fill (off: remove them, as Web Clipper does with Interpreter off)"),
        field("Default prompt context", promptContext, "Sent with the prompts unless a template sets its own. Empty uses the whole page without navigation, scripts and styles. Try {{content}} to send less."),
      ),
    ),
  );
}

// ---- network bridge ---------------------------------------------------------------------------

async function renderBridge() {
  const granted = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  const on = settings.bridge.enabled && granted;
  const toggle = h("input", { type: "checkbox", id: "bridge-enabled", checked: on });
  toggle.addEventListener("change", async () => {
    if (toggle.checked) {
      // Requested here, inside the click, and only here.
      const ok = await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
      if (!ok) {
        toggle.checked = false;
        flash("error", "The bridge needs permission to reach any site. Nothing was changed.");
        return;
      }
      await persistSettings({ bridge: { ...settings.bridge, enabled: true } });
    } else {
      await persistSettings({ bridge: { ...settings.bridge, enabled: false } });
      await chrome.permissions.remove({ origins: ["<all_urls>"] }).catch(() => false);
      await persistSettings({});
    }
    void renderBridge();
  });

  const max = h("input", { class: "oa-input mono", type: "number", min: 1, max: 48, id: "bridge-max", value: settings.bridge.maxResponseMB });
  max.addEventListener("change", () => void persistSettings({ bridge: { ...settings.bridge, maxResponseMB: Math.min(48, Math.max(1, Number(max.value) || 32)) } }));

  const consents = Object.entries(settings.bridge.consent);
  const consentList = h(
    "div",
    { class: "origin-list", id: "consents" },
    ...(consents.length
      ? consents.map(([origin, state]) =>
          h(
            "div",
            { class: "origin-row" },
            h("span", { class: "mono origin", text: origin }),
            h("span", { class: "oa-badge", text: state === "granted" ? "Allowed" : "Refused" }),
            iconButton("x", `Forget ${origin}`, async () => {
              const next = { ...settings.bridge.consent };
              delete next[origin];
              await persistSettings({ bridge: { ...settings.bridge, consent: next } });
              void renderBridge();
            }),
          ),
        )
      : [h("p", { class: "hint", text: "No address has asked yet. The first request from each app address asks you." })]),
  );

  content.replaceChildren(
    h(
      "div",
      { class: "stack" },
      h(
        "section",
        { class: "oa-card panel" },
        h("p", { class: "eyebrow", text: "Network bridge" }),
        h("h2", { text: "Let plugins reach sites that block web pages." }),
        h("p", {
          class: "lede",
          text: `GitHub release downloads and many plugin APIs send no CORS headers, so a web page cannot read them. With the bridge on, ${PRODUCT_NAME} asks the extension to fetch them instead. Cookies are never sent, only your app addresses can use it, and each address asks you once.`,
        }),
        h("label", { class: "oa-checkbox big" }, toggle, "Turn on the network bridge"),
        h("p", { class: "hint", text: granted ? "Permission to reach any site: granted." : "Turning it on asks the browser for permission to reach any site." }),
        h("div", { class: "narrow" }, field("Largest response (MB)", max)),
      ),
      h("section", { class: "oa-card panel" }, h("p", { class: "eyebrow", text: "Addresses" }), h("h2", { text: "Who has asked." }), consentList),
    ),
  );
}

function renderAbout() {
  const manifest = chrome.runtime.getManifest();
  content.replaceChildren(
    h(
      "section",
      { class: "oa-card panel" },
      h("p", { class: "eyebrow", text: "About" }),
      h("h2", { text: `${manifest.name} ${manifest.version}.` }),
      h("p", { class: "lede", text: `Clips web pages into ${PRODUCT_NAME} and carries network requests for its plugins.` }),
      h("p", {
        text: "Templates, variables, filters and the import/export format are compatible with Obsidian Web Clipper (github.com/obsidianmd/obsidian-clipper, MIT), whose design this clipper follows. Extraction, Markdown conversion and the template language run in this extension's own WebAssembly engine.",
      }),
      h("p", { class: "hint", text: "Keyboard shortcuts can be changed on the browser's extension shortcuts page." }),
    ),
  );
}

// ---- boot ---------------------------------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("settings" in changes) void getSettings().then((s) => (settings = s));
});

void (async () => {
  [settings, templates] = await Promise.all([getSettings(), getTemplates()]);
  const hash = location.hash.slice(1);
  if (hash === "general" || hash === "bridge" || hash === "about" || hash === "templates") section = hash;
  render();
})();
