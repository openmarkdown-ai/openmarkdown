/**
 * Single-file mode: files launched from the operating system that are not in a
 * vault this browser can open. The vault is in memory; every save goes back to
 * the original file (see `LaunchedFilesAdapter`). A bar says so, and offers to
 * open the file's vault (when it is in a known folder vault that needs access
 * again) or another vault.
 */
import type { App } from "../obsidian/app";
import { setIcon } from "../obsidian/ui/icons";
import { whenLayoutReady } from "../settings/helpers";
import type { LaunchedFilesAdapter } from "./launch";
import { setPendingOpen } from "./launch";

export function installSingleFileMode(app: App, info: { containing: { id: string; name: string; paths: string[] } | null }) {
  const adapter = app.vault.adapter as unknown as LaunchedFilesAdapter;
  document.body.addClass("vault-single-file");
  whenLayoutReady(app, async () => {
    const paths = adapter.launchedPaths?.() ?? [];
    let first = true;
    for (const path of paths) {
      const file = app.vault.getFileByPath(path);
      if (!file) continue;
      const leaf = first ? app.workspace.getLeaf(false) : app.workspace.getLeaf("tab");
      first = false;
      await leaf.openFile(file, { active: true });
    }
    // A single file has no folders to browse.
    app.workspace.leftSplit?.collapse?.();

    const bar = createDiv({ cls: "vault-single-file-bar", attr: { role: "note" } });
    app.dom.appContainerEl.prepend(bar);
    setIcon(bar.createDiv({ cls: "vault-single-file-bar-icon" }), "lucide-file-text");
    const names = paths.map((p) => p.split("/").pop()).join(", ");
    bar.createDiv({ cls: "vault-single-file-bar-text", text: `Editing ${names} on its own. Changes are saved to the file.` });
    const actions = bar.createDiv({ cls: "vault-single-file-bar-actions" });
    if (info.containing) {
      const c = info.containing;
      const open = actions.createEl("button", { cls: "mod-cta", text: `Open in “${c.name}”` });
      open.addEventListener("click", () => {
        setPendingOpen(c.id, c.paths);
        const url = new URL(location.href);
        url.search = "";
        url.searchParams.set("vault", c.id);
        location.href = url.toString();
      });
    }
    const other = actions.createEl("button", { text: "Open a vault" });
    other.addEventListener("click", () => app.vaultSwitcher?.open());
  });
}
