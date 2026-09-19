/**
 * The base of the built-in setting tabs (General, Editor, Appearance …).
 *
 * Every option reads and writes `app.vault.getConfig`/`setConfig`; the vault
 * raises `config-changed`, and the app applies the change live (body classes,
 * `workspace.updateOptions()`, `customCss.applyAppearance()`). Rows are built
 * with the public `Setting`/`SettingGroup` components, so themes and plugins
 * see the same DOM as in a plugin's own tab.
 */
import type { App } from "../obsidian/app";
import { Setting, SettingGroup } from "../obsidian/ui/setting";
import { SettingTab } from "../obsidian/ui/setting-tab";

export abstract class AppSettingTab extends SettingTab {
  constructor(app: App, id: string, name: string, icon: string) {
    super(app);
    this.id = id;
    this.name = name;
    this.icon = icon;
  }

  /** Build the tab's rows into `containerEl` (already emptied). */
  abstract render(containerEl: HTMLElement): void;

  override display(): void {
    this.containerEl.empty();
    try {
      this.render(this.containerEl);
    } catch (e) {
      console.error(`Settings tab "${this.id}" failed to render`, e);
    }
    // The settings search filters rendered rows; re-apply it after a re-render.
    (this.app.setting as { applySearch?: () => void } | null)?.applySearch?.();
  }

  override hide(): void {
    super.hide();
  }

  /** Re-render in place, keeping the scroll position. */
  rerender(): void {
    const scroller = this.containerEl.parentElement;
    const top = scroller?.scrollTop ?? 0;
    this.display();
    if (scroller) scroller.scrollTop = top;
  }

  // ---- row helpers --------------------------------------------------------------------

  getConfig<T = unknown>(key: string): T {
    return this.app.vault.getConfig(key) as T;
  }

  setConfig(key: string, value: unknown): void {
    this.app.vault.setConfig(key, value);
  }

  group(containerEl: HTMLElement, heading?: string): SettingGroup {
    const g = new SettingGroup(containerEl);
    if (heading) g.setHeading(heading);
    return g;
  }

  row(group: SettingGroup, name: string, desc?: string | DocumentFragment): Setting {
    const s = new Setting(group.listEl).setName(name);
    if (desc !== undefined) s.setDesc(desc);
    return s;
  }

  toggle(group: SettingGroup, name: string, desc: string | DocumentFragment, key: string, after?: (value: boolean) => void): Setting {
    return this.row(group, name, desc).addToggle((t) =>
      t.setValue(!!this.getConfig(key)).onChange((v) => {
        this.setConfig(key, v);
        after?.(v);
      }),
    );
  }

  dropdown(
    group: SettingGroup,
    name: string,
    desc: string | DocumentFragment,
    key: string,
    options: Record<string, string>,
    after?: (value: string) => void,
  ): Setting {
    return this.row(group, name, desc).addDropdown((d) =>
      d
        .addOptions(options)
        .setValue(String(this.getConfig(key) ?? ""))
        .onChange((v) => {
          this.setConfig(key, v);
          after?.(v);
        }),
    );
  }
}

/** A description with a trailing link or emphasis, built without innerHTML. */
export function descFragment(parts: (string | { text: string; href?: string; code?: boolean; strong?: boolean })[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const part of parts) {
    if (typeof part === "string") {
      frag.appendText(part);
    } else if (part.href) {
      frag.createEl("a", { text: part.text, href: part.href, attr: { target: "_blank", rel: "noopener" } });
    } else if (part.code) {
      frag.createEl("code", { text: part.text });
    } else {
      frag.createEl("strong", { text: part.text });
    }
  }
  return frag;
}
