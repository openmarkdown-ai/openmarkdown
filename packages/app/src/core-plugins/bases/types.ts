import type { BasesRegistry } from "../../obsidian/bases/api";
import type { FileRecordStore } from "./records";

/** What hosts and layouts need from the Bases plugin. */
export interface BasesPluginHost {
  app: any;
  store: FileRecordStore;
  registry: BasesRegistry;
}
