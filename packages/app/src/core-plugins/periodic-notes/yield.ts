/**
 * Built-in features that replace a community plugin keep that plugin's
 * command ids (so `hotkeys.json` keeps working) and step aside when it is
 * enabled. Community plugins load after core plugins and register the same
 * ids, replacing ours; this keeps ours out of their way on unload and brings
 * ours back when theirs unloads.
 */
import type { Command } from "obsidian";
import type { Plugin } from "../../obsidian/plugin";

export function isCommunityPluginEnabled(app: any, id: string): boolean {
  return !!app.plugins?.enabledPlugins?.has?.(id) || !!app.plugins?.plugins?.[id];
}

export function addYieldingCommands(plugin: Plugin, communityId: string, commands: Command[]) {
  const app = (plugin as any).app;
  const registry = app.commands;
  const add = () => {
    for (const cmd of commands) if (!registry.commands[cmd.id]) registry.addCommand(cmd);
  };
  add();
  plugin.registerEvent(
    app.plugins.on("plugin-unloaded", (id: string) => {
      if (id === communityId) add();
    }),
  );
  plugin.register(() => {
    for (const cmd of commands) if (registry.commands[cmd.id] === cmd) registry.removeCommand(cmd.id);
  });
}
