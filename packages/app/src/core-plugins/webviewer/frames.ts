/**
 * Web panes (Custom Frames–style): named web apps that open in a tab or the
 * sidebar, with a command and optional ribbon icon each.
 *
 * Presets follow the Custom Frames plugin's list (ellpeck/ObsidianCustomFrames
 * `src/settings.ts`). A browser iframe honours X-Frame-Options and CSP
 * `frame-ancestors`, which Electron's <webview> ignores, so several of them
 * refuse to load here. `framing` records what each site sent when probed on
 * 2026-09-14 (curl, Chrome user agent, following redirects); sites change this.
 */

export interface FrameConfig {
  id: string;
  name: string;
  url: string;
  icon: string;
  openOnStartup: boolean;
  inSidebar: boolean;
  addRibbonIcon: boolean;
  zoom: number;
  /** Stored for the companion extension; a page cannot style a cross-origin frame. */
  customCss: string;
}

export interface FramePreset extends Omit<FrameConfig, "id" | "openOnStartup"> {
  key: string;
  framing: string | null;
}

export const FRAME_PRESETS: FramePreset[] = [
  { key: "detexify", name: "Detexify", url: "https://detexify.kirelabs.org/classify.html", icon: "lucide-type", inSidebar: true, addRibbonIcon: true, zoom: 0.95, customCss: "#classify--info-area,\n.adsbygoogle {\n\tdisplay: none !important\n}", framing: null },
  { key: "calendar", name: "Google Calendar", url: "https://calendar.google.com/calendar", icon: "lucide-calendar", inSidebar: false, addRibbonIcon: true, zoom: 1, customCss: "", framing: "X-Frame-Options: SAMEORIGIN (sign-in page: DENY)" },
  { key: "keep", name: "Google Keep", url: "https://keep.google.com", icon: "lucide-files", inSidebar: true, addRibbonIcon: false, zoom: 1, customCss: "", framing: "X-Frame-Options: SAMEORIGIN (sign-in page: DENY)" },
  { key: "tasks", name: "Google Tasks", url: "https://tasks.google.com/embed/?origin=https://calendar.google.com&fullWidth=1", icon: "lucide-list-checks", inSidebar: true, addRibbonIcon: false, zoom: 1, customCss: "", framing: "frame-ancestors https://calendar.google.com; X-Frame-Options: DENY" },
  { key: "todoist", name: "Todoist", url: "https://app.todoist.com/app", icon: "lucide-list-checks", inSidebar: true, addRibbonIcon: false, zoom: 1, customCss: "", framing: null },
  { key: "notion", name: "Notion", url: "https://www.notion.so/", icon: "lucide-box", inSidebar: false, addRibbonIcon: true, zoom: 1, customCss: "", framing: "frame-ancestors limited to Notion's own origins" },
  { key: "twitter", name: "X (Twitter)", url: "https://x.com", icon: "lucide-at-sign", inSidebar: true, addRibbonIcon: false, zoom: 1, customCss: "", framing: "X-Frame-Options: SAMEORIGIN and frame-ancestors limited to x.com / twitter.com" },
  { key: "readwise-daily-review", name: "Readwise Daily Review", url: "https://readwise.io/dailyreview", icon: "lucide-highlighter", inSidebar: true, addRibbonIcon: false, zoom: 1, customCss: ".fixed-nav {\n    display: none !important;\n}", framing: "X-Frame-Options: DENY and frame-ancestors 'self'" },
  { key: "excalidraw", name: "Excalidraw", url: "https://excalidraw.com", icon: "lucide-pen-tool", inSidebar: false, addRibbonIcon: false, zoom: 1, customCss: "", framing: null },
];

export function frameFromPreset(preset: FramePreset, existingIds: string[]): FrameConfig {
  let id = preset.key;
  for (let n = 2; existingIds.includes(id); n++) id = `${preset.key}-${n}`;
  const { key: _key, framing: _framing, ...rest } = preset;
  return { ...rest, id, openOnStartup: false };
}

export function customFrame(existingIds: string[]): FrameConfig {
  let n = 1;
  while (existingIds.includes(`frame-${n}`)) n++;
  return { id: `frame-${n}`, name: `Web pane ${n}`, url: "https://", icon: "lucide-globe", openOnStartup: false, inSidebar: false, addRibbonIcon: false, zoom: 1, customCss: "" };
}

/** What the probe found for a URL's host, if it matches a preset. */
export function knownFraming(url: string): string | null {
  try {
    const host = new URL(url).host;
    return FRAME_PRESETS.find((p) => new URL(p.url).host === host)?.framing ?? null;
  } catch {
    return null;
  }
}
