/**
 * Slash commands — type `/` at the start of a line or after whitespace to
 * pick an editor command. The `/query` text is removed before the command
 * runs; a space (or Escape) dismisses the list.
 */
import type { Command, Editor, EditorPosition, EditorSuggestContext, EditorSuggestTriggerInfo, SearchResult, TFile } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { hotkeyToString } from "../../obsidian/ui/keymap";
import { EditorSuggest } from "../../obsidian/ui/suggest";
import { prepareFuzzySearch, renderResults } from "../../obsidian/util";

interface CommandMatch {
  command: Command;
  match: SearchResult | null;
}

class SlashCommandSuggest extends EditorSuggest<CommandMatch> {
  constructor(private plugin: SlashCommandPlugin) {
    super(plugin.app);
    this.limit = 50;
    this.suggestEl.addClass("mod-slash-command");
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to use" },
      { command: "esc", purpose: "to dismiss" },
    ]);
  }

  onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const m = /(^|\s)\/([^\s/]*)$/.exec(before);
    if (!m) return null;
    const slash = m.index + m[1]!.length;
    // Not inside inline code or a code fence.
    if (((before.slice(0, slash).match(/`/g) ?? []).length & 1) === 1) return null;
    if (inCodeFence(editor, cursor.line)) return null;
    return { start: { line: cursor.line, ch: slash }, end: cursor, query: m[2]! };
  }

  getSuggestions(context: EditorSuggestContext): CommandMatch[] {
    const commands = this.plugin.availableCommands();
    const q = context.query.trim();
    if (!q) return commands.sort((a, b) => a.name.localeCompare(b.name)).map((command) => ({ command, match: null }));
    const search = prepareFuzzySearch(q);
    const out: CommandMatch[] = [];
    for (const command of commands) {
      const match = search(command.name);
      if (match) out.push({ command, match });
    }
    out.sort((a, b) => (b.match!.score - a.match!.score) || a.command.name.localeCompare(b.command.name));
    return out;
  }

  renderSuggestion(value: CommandMatch, el: HTMLElement): void {
    el.addClass("mod-complex");
    const content = el.createDiv({ cls: "suggestion-content" });
    const title = content.createDiv({ cls: "suggestion-title" });
    if (value.match) renderResults(title, value.command.name, value.match);
    else title.setText(value.command.name);
    const keys = (this.app as any).hotkeyManager?.getEffective?.(value.command.id) ?? [];
    if (keys.length) {
      const aux = el.createDiv({ cls: "suggestion-aux" });
      for (const hk of keys) aux.createEl("kbd", { cls: "suggestion-hotkey", text: hotkeyToString(hk) });
    }
  }

  selectSuggestion(value: CommandMatch, evt: MouseEvent | KeyboardEvent): void {
    const ctx = this.context;
    if (ctx) ctx.editor.replaceRange("", ctx.start, ctx.end);
    this.close();
    (this.app as any).commands.executeCommandById(value.command.id, evt);
  }
}

function inCodeFence(editor: Editor, line: number): boolean {
  let fence: string | null = null;
  for (let l = 0; l < line; l++) {
    const m = /^\s*(`{3,}|~{3,})/.exec(editor.getLine(l));
    if (!m) continue;
    if (fence === null) fence = m[1]!;
    else if (m[1]!.startsWith(fence[0]!) && m[1]!.length >= fence.length) fence = null;
  }
  return fence !== null;
}

export class SlashCommandPlugin extends Plugin {
  instance!: any;

  override onload() {
    this.registerEditorSuggest(new SlashCommandSuggest(this));
  }

  /** Commands that apply to the editor right now. */
  availableCommands(): Command[] {
    const commands = this.app.commands;
    return (Object.values(commands.editorCommands ?? {}) as Command[]).filter((c) => {
      if (c.id === "editor:context-menu") return false;
      if (c.mobileOnly && !document.body.hasClass("is-mobile")) return false;
      return commands.isAvailable ? commands.isAvailable(c) : true;
    });
  }
}

export const slashCommand: CorePluginDefinition = {
  id: "slash-command",
  name: "Slash commands",
  description: "Trigger commands in the editor by using the forward slash key.",
  icon: "lucide-slash",
  defaultOn: false,
  create: (app) =>
    new SlashCommandPlugin(app, { id: "slash-command", name: "Slash commands", version: "", minAppVersion: "", author: "", description: "Trigger commands in the editor by using the forward slash key." }),
};
