/**
 * App-level commands with Obsidian's ids, names and default hotkeys
 * (docs/research/obsidian-features.md §8.1, §8.2). Plugin-owned ids
 * (`file-explorer:*`, `editor:*`, `markdown:*` …) belong to their plugins.
 *
 * Some default hotkeys (Mod+W, Mod+T, Mod+Shift+T, Ctrl+Tab, Mod+1…9) are
 * reserved by browsers in a normal tab and never reach the page; they work
 * when the app runs as an installed PWA window. They stay bound so a user's
 * `hotkeys.json` means the same thing everywhere.
 */
import type { Command, Hotkey } from "obsidian";
import type { App } from "../obsidian/app";
import { Modal } from "../obsidian/ui/modal";
import { Notice } from "../obsidian/ui/notice";
import { isMacPlatform } from "../obsidian/ui/keymap";
import { ButtonComponent } from "../obsidian/ui/setting";
import { FuzzySuggestModal } from "../obsidian/ui/suggest";
import { apiVersion, Platform } from "../obsidian/util";
import type { WorkspaceLeaf } from "../obsidian/workspace/leaf";
import { WorkspaceTabs } from "../obsidian/workspace/items";
import { APP_VERSION, PRODUCT_NAME } from "../product";
import { HELP_URL, copyText } from "./helpers";
import { zoomBy, setZoomIndex, ZOOM_STEPS } from "./zoom";

function hk(modifiers: Hotkey["modifiers"], key: string): Hotkey {
  return { modifiers, key };
}

function activeLeaf(app: App): WorkspaceLeaf | null {
  const leaf = app.workspace?.activeLeaf ?? null;
  return leaf && leaf.parent ? leaf : null;
}

function activeTabs(app: App): WorkspaceTabs | null {
  const leaf = activeLeaf(app);
  if (leaf?.parent instanceof WorkspaceTabs) return leaf.parent;
  const group = app.workspace?.activeTabGroup;
  return group && group.parent ? group : null;
}

function selectTab(app: App, tabs: WorkspaceTabs, index: number) {
  const leaf = tabs.children[index] as WorkspaceLeaf | undefined;
  if (!leaf) return;
  tabs.selectTab(leaf);
  app.workspace.setActiveLeaf(leaf, { focus: true });
}

/** `obsidian://open?vault=…&file=…`, encoded as Obsidian writes it. */
export function obsidianUrlFor(app: App, path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(app.vault.getName())}&file=${encodeURIComponent(path.replace(/\.md$/, ""))}`;
}

export function buildCommands(app: App): Command[] {
  const mac = isMacPlatform();
  const fileCheck = (fn: (file: NonNullable<ReturnType<App["workspace"]["getActiveFile"]>>) => unknown) => (checking: boolean) => {
    const file = app.workspace?.getActiveFile();
    if (!file) return false;
    if (!checking) void fn(file);
    return true;
  };
  const leafCheck = (fn: (leaf: WorkspaceLeaf) => unknown) => (checking: boolean) => {
    const leaf = activeLeaf(app);
    if (!leaf) return false;
    if (!checking) void fn(leaf);
    return true;
  };

  const commands: Command[] = [
    // ---- app ------------------------------------------------------------------------------
    { id: "app:open-settings", name: "Open settings", icon: "lucide-settings", hotkeys: [hk(["Mod"], ",")], callback: () => app.setting.open() },
    { id: "app:open-vault", name: "Manage vaults", icon: "lucide-vault", callback: () => app.vaultSwitcher?.open() },
    { id: "app:switch-vault", name: "Change vault...", icon: "lucide-vault", callback: () => void new VaultSuggestModal(app).openWithVaults() },
    {
      id: "app:open-another-vault",
      name: "Open vault...",
      icon: "lucide-vault",
      callback: () => {
        const url = new URL(location.href);
        url.search = "?choose=1";
        url.hash = "";
        window.open(url.toString(), "_blank");
      },
    },
    {
      id: "app:open-sandbox-vault",
      name: "Open sandbox vault",
      icon: "lucide-box",
      callback: () => app.vaultSwitcher?.switchTo("demo"),
    },
    { id: "app:toggle-left-sidebar", name: "Toggle left sidebar", icon: "lucide-sidebar-left", callback: () => app.workspace.leftSplit.toggle() },
    { id: "app:toggle-right-sidebar", name: "Toggle right sidebar", icon: "lucide-sidebar-right", callback: () => app.workspace.rightSplit.toggle() },
    { id: "app:toggle-ribbon", name: "Toggle ribbon", icon: "lucide-panel-left", callback: () => app.vault.setConfig("showRibbon", app.vault.getConfig("showRibbon") === false) },
    {
      id: "app:go-back",
      name: "Navigate back",
      icon: "lucide-arrow-left",
      hotkeys: [hk(["Mod", "Alt"], "ArrowLeft")],
      checkCallback: (checking) => {
        const leaf = activeLeaf(app);
        if (!leaf || leaf.history.backHistory.length === 0) return false;
        if (!checking) void leaf.history.back();
        return true;
      },
    },
    {
      id: "app:go-forward",
      name: "Navigate forward",
      icon: "lucide-arrow-right",
      hotkeys: [hk(["Mod", "Alt"], "ArrowRight")],
      checkCallback: (checking) => {
        const leaf = activeLeaf(app);
        if (!leaf || leaf.history.forwardHistory.length === 0) return false;
        if (!checking) void leaf.history.forward();
        return true;
      },
    },
    { id: "app:delete-file", name: "Delete current file", icon: "lucide-trash-2", checkCallback: fileCheck((file) => app.fileManager.promptForDeletion(file)) },
    { id: "app:reload", name: "Reload app without saving", icon: "lucide-refresh-cw", callback: () => location.reload() },
    { id: "app:show-debug-info", name: "Show debug info", icon: "lucide-bug", callback: () => new DebugInfoModal(app).open() },
    { id: "app:open-help", name: "Open help", icon: "lucide-help-circle", hotkeys: [hk([], "F1")], callback: () => window.open(HELP_URL, "_blank", "noopener") },
    {
      id: "app:toggle-default-new-pane-mode",
      name: "Toggle default mode for new tabs",
      icon: "lucide-book-open",
      callback: () => {
        const next = app.vault.getConfig("defaultViewMode") === "preview" ? "source" : "preview";
        app.vault.setConfig("defaultViewMode", next);
        new Notice(`New tabs will now open in ${next === "preview" ? "reading view" : "editing view"}.`);
      },
    },

    // ---- workspace / tabs ---------------------------------------------------------------
    {
      id: "workspace:close",
      name: "Close current tab",
      icon: "lucide-x",
      hotkeys: [hk(["Mod"], "W")],
      checkCallback: leafCheck((leaf) => {
        // A pinned tab is unpinned by the first close (1.9).
        if (leaf.pinned) leaf.setPinned(false);
        else leaf.detach();
      }),
    },
    {
      id: "workspace:close-others",
      name: "Close all other tabs",
      icon: "lucide-x-circle",
      checkCallback: leafCheck((leaf) => {
        const others: WorkspaceLeaf[] = [];
        app.workspace.iterateRootLeaves((l) => {
          if (l !== leaf && !l.pinned) others.push(l);
        });
        for (const l of others) l.detach();
      }),
    },
    {
      id: "workspace:close-tab-group",
      name: "Close this tab group",
      icon: "lucide-x-square",
      checkCallback: (checking) => {
        const tabs = activeTabs(app);
        if (!tabs) return false;
        if (!checking) for (const l of tabs.children.slice() as WorkspaceLeaf[]) if (!l.pinned) l.detach();
        return true;
      },
    },
    {
      id: "workspace:close-others-tab-group",
      name: "Close others in tab group",
      icon: "lucide-x-circle",
      checkCallback: (checking) => {
        const tabs = activeTabs(app);
        const leaf = activeLeaf(app);
        if (!tabs || !leaf) return false;
        if (!checking) for (const l of tabs.children.slice() as WorkspaceLeaf[]) if (l !== leaf && !l.pinned) l.detach();
        return true;
      },
    },
    {
      id: "workspace:close-window",
      name: "Close window",
      icon: "lucide-x",
      hotkeys: [hk(["Mod", "Shift"], "W")],
      callback: () => {
        window.close();
        // Browsers only let a page close a window a script opened.
        window.setTimeout(() => new Notice("The browser does not let this page close its own window."), 100);
      },
    },
    { id: "workspace:split-vertical", name: "Split right", icon: "lucide-separator-vertical", checkCallback: leafCheck(() => app.workspace.splitActiveLeaf("vertical")) },
    { id: "workspace:split-horizontal", name: "Split down", icon: "lucide-separator-horizontal", checkCallback: leafCheck(() => app.workspace.splitActiveLeaf("horizontal")) },
    { id: "workspace:toggle-pin", name: "Toggle pin", icon: "lucide-pin", checkCallback: leafCheck((leaf) => leaf.togglePinned()) },
    {
      id: "workspace:new-tab",
      name: "New tab",
      icon: "lucide-plus",
      hotkeys: [hk(["Mod"], "T")],
      callback: async () => {
        const leaf = app.workspace.getLeaf("tab");
        await leaf.setViewState({ type: "empty", state: {} });
        app.workspace.setActiveLeaf(leaf, { focus: true });
      },
    },
    {
      id: "workspace:new-window",
      name: "New window",
      icon: "lucide-app-window",
      callback: () => {
        const url = new URL(location.href);
        url.hash = "";
        window.open(url.toString(), "_blank");
      },
    },
    { id: "workspace:undo-close-pane", name: "Undo close tab", icon: "lucide-undo-2", hotkeys: [hk(["Mod", "Shift"], "T")], callback: () => void app.workspace.undoCloseTab() },
    {
      id: "workspace:next-tab",
      name: "Go to next tab",
      icon: "lucide-arrow-right",
      hotkeys: [hk(["Ctrl"], "Tab"), mac ? hk(["Mod", "Shift"], "]") : hk(["Ctrl"], "PageDown")],
      checkCallback: (checking) => {
        const tabs = activeTabs(app);
        if (!tabs || tabs.children.length < 2) return false;
        if (!checking) selectTab(app, tabs, (tabs.currentTab + 1) % tabs.children.length);
        return true;
      },
    },
    {
      id: "workspace:previous-tab",
      name: "Go to previous tab",
      icon: "lucide-arrow-left",
      hotkeys: [hk(["Ctrl", "Shift"], "Tab"), mac ? hk(["Mod", "Shift"], "[") : hk(["Ctrl"], "PageUp")],
      checkCallback: (checking) => {
        const tabs = activeTabs(app);
        if (!tabs || tabs.children.length < 2) return false;
        if (!checking) selectTab(app, tabs, (tabs.currentTab - 1 + tabs.children.length) % tabs.children.length);
        return true;
      },
    },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(
      (n): Command => ({
        id: `workspace:goto-tab-${n}`,
        name: `Go to tab #${n}`,
        icon: "lucide-arrow-right",
        hotkeys: [hk(["Mod"], String(n))],
        checkCallback: (checking) => {
          const tabs = activeTabs(app);
          if (!tabs || tabs.children.length < n) return false;
          if (!checking) selectTab(app, tabs, n - 1);
          return true;
        },
      }),
    ),
    {
      id: "workspace:goto-last-tab",
      name: "Go to last tab",
      icon: "lucide-arrow-right",
      hotkeys: [hk(["Mod"], "9")],
      checkCallback: (checking) => {
        const tabs = activeTabs(app);
        if (!tabs || !tabs.children.length) return false;
        if (!checking) selectTab(app, tabs, tabs.children.length - 1);
        return true;
      },
    },
    {
      id: "workspace:toggle-stacked-tabs",
      name: "Toggle stacked tabs",
      icon: "lucide-layers",
      checkCallback: (checking) => {
        const tabs = activeTabs(app);
        if (!tabs) return false;
        if (!checking) tabs.setStacked(!tabs.isStacked);
        return true;
      },
    },
    {
      id: "workspace:copy-path",
      name: "Copy file path",
      icon: "lucide-clipboard-copy",
      checkCallback: fileCheck(async (file) => new Notice((await copyText(file.path)) ? "Path copied to your clipboard." : "Could not copy to the clipboard.")),
    },
    {
      id: "workspace:copy-url",
      name: "Copy Obsidian URL",
      icon: "lucide-link",
      checkCallback: fileCheck(async (file) => new Notice((await copyText(obsidianUrlFor(app, file.path))) ? "URL copied to your clipboard." : "Could not copy to the clipboard.")),
    },
    { id: "workspace:open-in-new-window", name: "Open current tab in new window", icon: "lucide-picture-in-picture-2", checkCallback: leafCheck((leaf) => app.workspace.duplicateLeaf(leaf, "window")) },
    { id: "workspace:move-to-new-window", name: "Move current tab to new window", icon: "lucide-picture-in-picture-2", checkCallback: leafCheck((leaf) => app.workspace.moveLeafToPopout(leaf)) },
    {
      id: "workspace:edit-file-title",
      name: "Rename file",
      icon: "lucide-pencil",
      hotkeys: [hk([], "F2")],
      checkCallback: (checking) => {
        const leaf = activeLeaf(app);
        const view = leaf?.view as unknown as { file?: unknown; containerEl?: HTMLElement; titleEl?: HTMLElement; startTitleRename?: () => void } | undefined;
        if (!view?.file) return false;
        if (checking) return true;
        const inline = view.containerEl?.querySelector<HTMLElement>(".inline-title");
        if (inline && inline.offsetParent !== null) {
          inline.focus();
          const range = document.createRange();
          range.selectNodeContents(inline);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        } else if (typeof view.startTitleRename === "function") {
          view.startTitleRename();
        } else {
          view.titleEl?.click();
        }
        return true;
      },
    },

    // ---- theme -------------------------------------------------------------------------------
    { id: "theme:use-dark", name: "Use dark mode", icon: "lucide-moon", callback: () => app.customCss.setTheme("obsidian") },
    { id: "theme:use-light", name: "Use light mode", icon: "lucide-sun", callback: () => app.customCss.setTheme("moonstone") },
    { id: "theme:toggle-light-dark", name: "Toggle light/dark mode", icon: "lucide-sun-moon", callback: () => app.customCss.setTheme(app.customCss.isDarkMode() ? "moonstone" : "obsidian") },
    { id: "theme:switch", name: "Change theme...", icon: "lucide-palette", callback: () => new ThemeSuggestModal(app).open() },

    // ---- window zoom (CSS zoom: the browser owns real page zoom) -----------------------------------
    { id: "window:zoom-in", name: "Zoom in", icon: "lucide-zoom-in", callback: () => zoomBy(app, 1) },
    { id: "window:zoom-out", name: "Zoom out", icon: "lucide-zoom-out", callback: () => zoomBy(app, -1) },
    { id: "window:reset-zoom", name: "Reset zoom", icon: "lucide-search", callback: () => setZoomIndex(app, ZOOM_STEPS.indexOf(100)) },
  ];
  return commands;
}

export function registerAppCommands(app: App): string[] {
  const commands = buildCommands(app);
  for (const command of commands) app.commands.addCommand(command);
  return commands.map((c) => c.id);
}

// ---- modals used by the commands --------------------------------------------------------------

interface VaultChoice {
  id: string;
  name: string;
  kind?: string;
}

class VaultSuggestModal extends FuzzySuggestModal<VaultChoice> {
  private vaults: VaultChoice[] = [];

  constructor(app: App) {
    super(app);
    this.setPlaceholder("Type the name of a vault...");
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to open" },
      { command: "esc", purpose: "to dismiss" },
    ]);
  }

  async openWithVaults() {
    try {
      const { listVaults } = await import("../boot");
      this.vaults = (await listVaults()).map((v) => ({ id: v.id, name: v.name, kind: v.kind }));
    } catch {
      this.vaults = [];
    }
    this.vaults.push({ id: "demo", name: "Demo vault", kind: "demo" });
    this.open();
  }

  getItems(): VaultChoice[] {
    return this.vaults.filter((v) => v.id !== this.app.appId);
  }

  getItemText(item: VaultChoice): string {
    return item.name;
  }

  onChooseItem(item: VaultChoice): void {
    this.app.vaultSwitcher?.switchTo(item.id);
  }
}

class ThemeSuggestModal extends FuzzySuggestModal<string> {
  constructor(app: App) {
    super(app);
    this.setPlaceholder("Choose a theme...");
  }

  getItems(): string[] {
    return ["", ...Object.keys(this.app.customCss.themes).sort((a, b) => a.localeCompare(b))];
  }

  getItemText(item: string): string {
    return item || "Default";
  }

  onChooseItem(item: string): void {
    void this.app.customCss.setCssTheme(item);
  }
}

export function debugInfo(app: App): string {
  const plugins = app.plugins;
  const enabled = Array.from(plugins.enabledPlugins).filter((id) => plugins.plugins[id]);
  const lines = [
    `SYSTEM INFO:`,
    `\t${PRODUCT_NAME} version: ${APP_VERSION}`,
    `\tAPI version: ${apiVersion}`,
    `\tUser agent: ${navigator.userAgent}`,
    `\tPlatform: ${Platform.isMobile ? "mobile" : "desktop"} browser`,
    `\tVault storage: ${app.vault.adapter.kind}`,
    `\tLanguage: ${document.documentElement.lang || navigator.language}`,
    ``,
    `APP SETTINGS:`,
    `\tBase theme: ${app.customCss.isDarkMode() ? "dark" : "light"} (${app.customCss.getTheme()})`,
    `\tCommunity theme: ${app.customCss.theme ? `${app.customCss.theme} v${app.customCss.themes[app.customCss.theme]?.version ?? "?"}` : "none"}`,
    `\tSnippets enabled: ${app.customCss.enabledSnippets.size}`,
    `\tRestricted mode: ${plugins.isEnabled() ? "off" : "on"}`,
    `\tPlugins installed: ${Object.keys(plugins.manifests).length}`,
    `\tPlugins enabled: ${enabled.length}`,
    ...enabled.map((id, i) => `\t\t${i + 1}: ${plugins.manifests[id]?.name ?? id} v${plugins.manifests[id]?.version ?? "?"}`),
    `\tCore plugins enabled: ${app.internalPlugins.getEnabledPlugins().length}`,
  ];
  return lines.join("\n");
}

class DebugInfoModal extends Modal {
  override onOpen(): void {
    this.setTitle("Debug info");
    this.modalEl.addClass("vault-debug-info-modal");
    const text = debugInfo(this.app);
    this.contentEl.createEl("pre", { cls: "vault-debug-info", text });
    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons)
      .setButtonText("Copy to clipboard")
      .setCta()
      .onClick(async () => {
        new Notice((await copyText(text)) ? "Debug info copied to clipboard." : "Could not copy to the clipboard.");
      });
  }
}

export function openDebugInfo(app: App): void {
  new DebugInfoModal(app).open();
}
