/**
 * Vim key bindings (@replit/codemirror-vim), enabled by the `vimMode` setting.
 *
 * Obsidian exposes the Vim API as `window.CodeMirrorAdapter.Vim`; plugins such
 * as obsidian-vimrc-support call `Vim.map`, `Vim.defineEx` … through it.
 */
import type { Extension } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import { CodeMirror, Vim, getCM, vim } from "@replit/codemirror-vim";

let exposed = false;

export function exposeVimAdapter(): void {
  if (exposed || typeof window === "undefined") return;
  exposed = true;
  // Obsidian exposes the vim package's CodeMirror adapter class itself, whose
  // static `commands` plugins patch (Linter sets `commands.save`).
  const w = window as unknown as { CodeMirrorAdapter?: unknown };
  const adapter = CodeMirror as unknown as Record<string, unknown>;
  adapter.Vim = Vim;
  adapter.getCM = getCM;
  w.CodeMirrorAdapter = adapter;
}

/** The vim extension; must precede other keymaps, hence the highest precedence. */
export function vimMode(): Extension {
  exposeVimAdapter();
  return Prec.highest(vim({ status: false }));
}

export { Vim, getCM };
