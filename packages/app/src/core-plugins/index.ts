/**
 * The registry of built-in plugins. Each group file exports its definitions;
 * the order here is the load order.
 *
 * Obsidian's own core plugins are listed in Settings → Core plugins. Features
 * OpenMarkdown adds are marked pre-installed by `preinstalled.ts` and listed in
 * Settings → Community plugins, where they can be uninstalled.
 */
import type { CorePluginDefinition } from "../obsidian/app-internals/internal-plugins";
import { markdownCore } from "./markdown-core";
import { definitions as navigation } from "./group-navigation";
import { definitions as knowledge } from "./group-knowledge";
import { definitions as writing } from "./group-writing";
import { definitions as visual } from "./group-visual";
import { definitions as device } from "./group-device";
import { PREINSTALLED, withPreinstalled } from "./preinstalled";

// The Markdown view registers first: saved layouts reopen notes as soon as
// the plugins have loaded.
const definitions: CorePluginDefinition[] = [markdownCore, ...navigation, ...knowledge, ...writing, ...visual, ...device].map(withPreinstalled);

export function registerCorePlugins(app: any) {
  for (const def of definitions) app.internalPlugins.register(def);
}

/** Obsidian's core plugins and the always-on app internals. */
export function coreDefinitions(): readonly CorePluginDefinition[] {
  return definitions.filter((d) => !d.preinstalled);
}

/** OpenMarkdown's pre-installed (uninstallable) plugins. */
export function preinstalledDefinitions(): readonly CorePluginDefinition[] {
  return definitions.filter((d) => d.preinstalled);
}

export { PREINSTALLED };
