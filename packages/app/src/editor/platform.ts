/** Minimal platform checks the editor needs (the app's `Platform` has the full set). */
const nav = typeof navigator !== "undefined" ? navigator : null;

export const Platform = {
  isMacOS: !!nav && /Mac|iPhone|iPad|iPod/.test(nav.platform || nav.userAgent),
  /** Obsidian's "Mod": Cmd on macOS, Ctrl elsewhere. */
  isModEvent(evt: MouseEvent | KeyboardEvent): boolean {
    return Platform.isMacOS ? evt.metaKey : evt.ctrlKey;
  },
};
