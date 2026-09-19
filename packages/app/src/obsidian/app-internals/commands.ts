/**
 * app.commands and app.hotkeyManager.
 *
 * Command ids are `<plugin id>:<command id>`, and core commands keep
 * Obsidian's ids (`editor:toggle-bold`, `app:open-settings` …) because plugins
 * call `executeCommandById` with them and users' `hotkeys.json` files key on
 * them.
 */
import type { Command, Hotkey } from "obsidian";
import { hotkeyToString, matchesHotkey } from "../ui/keymap";

export class Commands {
  commands: Record<string, Command> = {};
  editorCommands: Record<string, Command> = {};

  constructor(private app: any) {}

  addCommand(command: Command) {
    this.commands[command.id] = command;
    if (command.editorCallback || command.editorCheckCallback) this.editorCommands[command.id] = command;
    if (command.hotkeys) this.app.hotkeyManager.addDefaultHotkeys(command.id, command.hotkeys);
  }

  removeCommand(id: string) {
    delete this.commands[id];
    delete this.editorCommands[id];
    this.app.hotkeyManager.removeDefaultHotkeys(id);
  }

  findCommand(id: string): Command | undefined {
    return this.commands[id];
  }

  private editorContext(): { editor: any; info: any } | null {
    const info = this.app.workspace.activeEditor;
    if (!info?.editor) return null;
    // An editor command only applies while the editor is showing, not in reading view.
    if (typeof info.getMode === "function" && info.getMode() !== "source") return null;
    return { editor: info.editor, info };
  }

  // internal: whether the command is currently runnable
  isAvailable(cmd: Command): boolean {
    try {
      if (cmd.checkCallback) return !!cmd.checkCallback(true);
      if (cmd.editorCheckCallback) {
        const ctx = this.editorContext();
        return !!ctx && !!cmd.editorCheckCallback(true, ctx.editor, ctx.info);
      }
      if (cmd.editorCallback) return !!this.editorContext();
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  listCommands(): Command[] {
    return Object.values(this.commands).filter((c) => this.isAvailable(c) && !(c.mobileOnly && !document.body.hasClass("is-mobile")));
  }

  executeCommand(cmd: Command, evt?: Event): boolean {
    if (evt) this.app.lastEvent = evt;
    try {
      if (cmd.checkCallback) {
        if (!cmd.checkCallback(true)) return false;
        cmd.checkCallback(false);
        return true;
      }
      if (cmd.editorCheckCallback) {
        const ctx = this.editorContext();
        if (!ctx || !cmd.editorCheckCallback(true, ctx.editor, ctx.info)) return false;
        cmd.editorCheckCallback(false, ctx.editor, ctx.info);
        return true;
      }
      if (cmd.editorCallback) {
        const ctx = this.editorContext();
        if (!ctx) return false;
        void cmd.editorCallback(ctx.editor, ctx.info);
        return true;
      }
      if (cmd.callback) {
        void cmd.callback();
        return true;
      }
    } catch (e) {
      console.error(`Command "${cmd.id}" failed`, e);
    }
    return false;
  }

  executeCommandById(id: string, evt?: Event): boolean {
    const cmd = this.commands[id];
    return cmd ? this.executeCommand(cmd, evt) : false;
  }
}

export class HotkeyManager {
  defaultKeys: Record<string, Hotkey[]> = {};
  customKeys: Record<string, Hotkey[]> = {};
  bakedHotkeys: { hotkey: Hotkey; id: string }[] = [];
  private dirty = true;

  constructor(private app: any) {}

  async load() {
    const data = await this.app.vault.readConfigJson("hotkeys.json");
    this.customKeys = data && typeof data === "object" ? data : {};
    this.dirty = true;
  }

  async save() {
    await this.app.vault.writeConfigJson("hotkeys.json", this.customKeys);
  }

  addDefaultHotkeys(id: string, keys: Hotkey[]) {
    this.defaultKeys[id] = keys;
    this.dirty = true;
  }

  removeDefaultHotkeys(id: string) {
    delete this.defaultKeys[id];
    this.dirty = true;
  }

  getDefaultHotkeys(id: string): Hotkey[] | undefined {
    return this.defaultKeys[id];
  }

  getHotkeys(id: string): Hotkey[] | undefined {
    return this.customKeys[id];
  }

  setHotkeys(id: string, keys: Hotkey[]) {
    this.customKeys[id] = keys;
    this.dirty = true;
    void this.save();
  }

  removeHotkeys(id: string) {
    delete this.customKeys[id];
    this.dirty = true;
    void this.save();
  }

  /** The hotkeys in force for a command: custom ones replace defaults entirely. */
  getEffective(id: string): Hotkey[] {
    return this.customKeys[id] ?? this.defaultKeys[id] ?? [];
  }

  bake() {
    this.bakedHotkeys = [];
    const ids = new Set([...Object.keys(this.defaultKeys), ...Object.keys(this.customKeys)]);
    for (const id of ids) for (const hotkey of this.getEffective(id)) this.bakedHotkeys.push({ hotkey, id });
    this.dirty = false;
  }

  printHotkeyForCommand(id: string): string {
    const keys = this.getEffective(id);
    return keys.length ? hotkeyToString(keys[0]!) : "";
  }

  /** Returns true when a command ran, so the caller can prevent the default action. */
  onTrigger(evt: KeyboardEvent): boolean {
    if (this.dirty) this.bake();
    for (const { hotkey, id } of this.bakedHotkeys) {
      if (!matchesHotkey(evt, hotkey)) continue;
      const cmd = this.app.commands.findCommand(id);
      if (!cmd) continue;
      if (evt.repeat && !cmd.repeatable) return true;
      if (this.app.commands.executeCommand(cmd, evt)) return true;
    }
    return false;
  }

  // internal: conflicts for the settings UI
  findConflicts(hotkey: Hotkey, exceptId?: string): string[] {
    if (this.dirty) this.bake();
    const key = hotkeyToString(hotkey);
    return this.bakedHotkeys.filter((b) => b.id !== exceptId && hotkeyToString(b.hotkey) === key).map((b) => b.id);
  }
}
