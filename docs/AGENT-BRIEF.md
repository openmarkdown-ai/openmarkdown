# Brief for agents building app features

You are adding features to a browser-first, open-source Markdown vault app that
implements Obsidian's plugin API for real, so that Obsidian vaults, community
plugins and themes work unmodified. Repo root:
`/Users/dariuskohsg/Downloads/sharing_folder/openapps/openmarkdown`.

## Read first

1. `docs/ARCHITECTURE.md` — layout, rules, conventions.
2. `docs/research/obsidian-features.md` — what Obsidian does, feature by feature
   (settings keys and defaults §6, commands and ids §8, core plugins §3, Bases §4,
   Canvas §5, workspace §7). Your feature must match it.
3. `docs/research/dom-and-css.md` — Obsidian's DOM class names and CSS
   variables (being written; if missing, check again later — use the class names
   you know from Obsidian meanwhile).
4. `node_modules/obsidian/obsidian.d.ts` — the API contract.

## What exists (read the code, it is the documentation)

| Area | File(s) |
|---|---|
| App + startup | `packages/app/src/obsidian/app.ts` (`app.vault`, `app.workspace`, `app.metadataCache`, `app.fileManager`, `app.commands`, `app.hotkeyManager`, `app.internalPlugins`, `app.plugins`, `app.customCss`, `app.viewRegistry`, `app.embedRegistry`, `app.metadataTypeManager`, `app.dragManager`, `app.statusBar`, `app.setting`) |
| Base classes | `obsidian/events.ts` (Events, Component), `obsidian/plugin.ts` (Plugin) |
| Files | `obsidian/vault/{vault,files,adapter,file-manager,metadata-cache}.ts` |
| Rust engine | `packages/engine/src/index.ts` — `getEngine()`, and `app.metadataCache.index` (search, backlinks, graph, tags, linktext, rename edits) |
| Workspace | `obsidian/workspace/{workspace,leaf,items,view}.ts` (ItemView/FileView/TextFileView, tabs, sidedocks, ribbon) |
| Reading view | `obsidian/markdown/renderer.ts` (`MarkdownRenderer.render`, post-processors, embeds, `installInteractions`) |
| UI components | `obsidian/ui/*` (icons `setIcon`, Notice, Modal, Menu, Setting + all components, SuggestModal/FuzzySuggestModal/AbstractInputSuggest/EditorSuggest, HoverPopover, Keymap/Scope, SettingTab/PluginSettingTab, tooltip) |
| Editor | `packages/app/src/editor/*` (CodeMirror 6; `Editor` API) |
| Core plugins | `packages/app/src/core-plugins/index.ts` + `group-*.ts`; `obsidian/app-internals/internal-plugins.ts` (`CorePluginDefinition`) |
| Utilities | `obsidian/util.ts` (moment, debounce, normalizePath, parseLinktext, prepareFuzzySearch, renderResults, parseYaml …) |

## How a core plugin is written

```ts
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";

class FileExplorerPlugin extends Plugin {
  instance!: any;            // set by the host before onload: { id, name, options, saveOptions() }
  async onload() {
    this.registerView("file-explorer", (leaf) => new FileExplorerView(leaf, this));
    this.addCommand({ id: "file-explorer:open", name: "Files: Show file explorer", callback: … });
    this.instance.revealInFolder = (file) => …;   // publish methods plugins call on `instance`
  }
}

export const fileExplorer: CorePluginDefinition = {
  id: "file-explorer", name: "Files", description: "…", defaultOn: true,
  defaultOptions: {},
  create: (app) => new FileExplorerPlugin(app, { id: "file-explorer", name: "Files", version: "", minAppVersion: "", author: "", description: "" }),
};
```

- **Ids are Obsidian's.** Plugin ids, view types (`file-explorer`, `search`,
  `bookmarks`, `backlink`, `outgoing-link`, `tag`, `outline`, `graph`,
  `localgraph`, `canvas`, `bases`, `all-properties`, `file-properties`,
  `footnotes`, `webviewer` …), command ids (`§8.2`), and settings keys. Real
  vaults' `workspace.json`, `hotkeys.json` and `<plugin>.json` files, and
  community plugins, reference them.
- **Core plugin commands are not prefixed**: pass the full id (e.g.
  `"switcher:open"`) and the display name as Obsidian shows it.
- Options persist through `this.instance.options` + `this.instance.saveOptions()`
  to `.obsidian/<id>.json`.
- Settings tab: `this.addSettingTab(new MySettingTab(app, this))`.
- Everything registered through `this.register*` / `this.add*` is removed when
  the plugin is disabled. Do the same for DOM listeners (`registerDomEvent`).
- **DOM and CSS are Obsidian's** (class names from the research doc) so themes
  apply. Colours only through Obsidian CSS variables. Styles go in the CSS file
  named in your task.
- Strict TypeScript; `import type` for types. No UI framework.

## Checking your work

- Typecheck: `npx tsc -p packages/app --noEmit` from the repo root. Other
  agents' folders may have errors mid-edit; none may be in yours.
- Run it: once `packages/engine/src/wasm-gen/vault_wasm.js` and
  `packages/app/src/obsidian/markdown/markdown-view.ts` exist, start Vite from
  `apps/web` on **your own port** (`npx vite --port <port> --strictPort`) and
  drive `http://localhost:<port>/?vault=demo` with Playwright (`npx playwright`
  is installed at the repo root; `npx playwright install chromium` if needed).
  Screenshot, **open the screenshots with the Read tool**, and fix what looks
  wrong. Until then, typecheck and reason carefully.
- Never edit files outside your ownership list; if you need a change elsewhere,
  describe it in your final reply (file, what, why).
- Do not copy code or CSS from the proprietary Obsidian app. Do not inspect
  `/Applications/Obsidian.app`.
