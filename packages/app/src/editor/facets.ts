/**
 * Facets shared by the editor's extensions: the host and the resolved config.
 * Both are provided once per editor by create.ts (inside compartments, so a
 * `reconfigure()` swaps them).
 */
import { Facet } from "@codemirror/state";
import type { EditorConfig, EditorHost } from "./host";
import { DEFAULT_EDITOR_CONFIG } from "./host";

export const hostFacet = Facet.define<EditorHost, EditorHost | null>({
  combine: (values) => values[values.length - 1] ?? null,
});

export const configFacet = Facet.define<EditorConfig, EditorConfig>({
  combine: (values) => values[values.length - 1] ?? DEFAULT_EDITOR_CONFIG,
});

/** Source path of the file being edited ("" when unknown). */
export function sourcePathOf(host: EditorHost | null): string {
  return host?.getFile()?.path ?? "";
}
