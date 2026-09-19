import type { CorePluginDefinition } from "../obsidian/app-internals/internal-plugins";
import { canvas } from "./canvas/index";
import { graph } from "./graph/index";
import { bases } from "./bases/index";

/** Core plugins in the "visual" group. */
export const definitions: CorePluginDefinition[] = [graph, canvas, bases];
