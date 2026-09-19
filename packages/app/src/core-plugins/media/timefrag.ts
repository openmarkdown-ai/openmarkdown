/**
 * Media fragments and timestamp links, in Media Extended's exact format so
 * notes stay portable between OpenMarkdown and Obsidian with that plugin:
 *
 *   web:   [01:23](https://www.youtube.com/watch?v=ID&t=83#t=01:23.47)
 *   vault: [[clip.mp4#t=01:23.47|01:23]]   (or a Markdown link per `useMarkdownLinks`)
 *
 * `#t=` accepts `S[.ms]`, `MM:SS[.ms]`, `H:MM:SS[.ms]`, `start,end`, `,end`
 * and `e` for the end, plus the flags `loop mute play noctrl controls vol=`.
 */

export interface TempFragment {
  /** -1 when not given */
  start: number;
  /** -1 when not given; Infinity for `e` */
  end: number;
}

const NPT_SEC = /^\d+(?:\.\d+)?$/;
const NPT_MMSS = /^([0-5]?\d):([0-5]\d(?:\.\d+)?)$/;
const NPT_HHMMSS = /^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/;

function convertTime(raw: string): number | null {
  const s = raw.replace(/^npt:/, "");
  if (NPT_SEC.test(s)) return Number(s);
  let m = NPT_MMSS.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = NPT_HHMMSS.exec(s);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return null;
}

/** `#t=1:23,1:45&loop` → { start: 83, end: 105 }; null when there is no temporal fragment. */
export function parseTempFrag(hash: string | undefined | null): TempFragment | null {
  if (!hash) return null;
  const query = new URLSearchParams(hash.replace(/^#+/, ""));
  const t = query.get("t");
  if (!t) return null;
  const m = /^([\w:.]*)(?:,([\w:.]+))?$/.exec(t);
  if (!m) return null;
  const startRaw = m[1] || null;
  const endRaw = m[2] ?? null;
  let start: number | null = -1;
  let end: number | null = -1;
  if (startRaw) start = convertTime(startRaw);
  if (endRaw) end = endRaw === "e" ? Infinity : convertTime(endRaw);
  if (!startRaw && !endRaw) return null;
  if (start === null || end === null) return null;
  return { start, end };
}

export interface MediaFlags {
  loop: boolean;
  mute: boolean;
  play: boolean;
  controls: boolean;
  volume?: number;
}

export function parseMediaFlags(hash: string | undefined | null): MediaFlags {
  const q = new URLSearchParams((hash ?? "").replace(/^#+/, ""));
  const vol = q.get("vol");
  return {
    loop: q.has("loop"),
    mute: q.has("mute"),
    play: q.has("play"),
    controls: !q.has("noctrl"),
    volume: vol !== null && Number.isFinite(Number(vol)) ? Math.max(0, Math.min(100, Number(vol))) : undefined,
  };
}

const pad2 = (n: number) => (n < 10 ? "0" + n : String(n));

/** Link text: `HH:mm:ss` with a leading `00:` removed (`01:23`, `1:02:03` → `01:02:03`). */
export function formatDuration(seconds: number): string {
  if (seconds === 0) return "00:00";
  const total = Math.floor(Math.round(seconds * 1000) / 1000);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`.replace(/^00:/, "");
}

function fillZero(time: number, digits = 2): string {
  let main: string;
  let frac: string | undefined;
  if (Number.isInteger(time)) main = String(time);
  else [main, frac] = time.toFixed(digits).split(".") as [string, string];
  if (main.length === 1) main = "0" + main;
  return frac ? `${main}.${frac}` : main;
}

function durationToFrag(seconds: number): string {
  if (!(seconds >= 0)) throw new Error("duration must be positive");
  if (seconds === Infinity) return "e";
  const ms = Math.round(seconds * 1000);
  const hours = Math.floor(ms / 3_600_000) % 24;
  const minutes = Math.floor(ms / 60_000) % 60;
  const secs = (ms % 60_000) / 1000;
  if (hours > 0) return [hours, fillZero(minutes), fillZero(secs)].join(":");
  if (minutes > 0) return [fillZero(minutes), fillZero(secs)].join(":");
  if (secs > 0) return secs.toFixed(2);
  throw new Error("duration must be positive");
}

/** `{start: 83.47, end: -1}` → `t=01:23.47`. */
export function toTempFragString(frag: TempFragment): string | null {
  const { start, end } = frag;
  if (start >= 0 && end < 0) return `t=${durationToFrag(start)}`;
  if (start < 0 && end > 0) return Number.isFinite(end) ? `t=,${durationToFrag(end)}` : null;
  if (start > 0 && end > 0) return `t=${durationToFrag(start)},${durationToFrag(end)}`;
  return null;
}

/** YouTube's own `t=` query: `83`, `1h2m3s`, `2m`. */
export function parseYoutubeTime(t: string | null): number {
  if (!t) return NaN;
  const n = Number(t);
  if (!Number.isNaN(n)) return n;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || !(m[1] || m[2] || m[3])) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** Start time (seconds) a URL asks for: `#t=` first, then YouTube's `t`/`start` query. 0 when none. */
export function startTimeOf(url: string): number {
  try {
    const u = new URL(url);
    const frag = parseTempFrag(u.hash);
    if (frag && frag.start >= 0) return frag.start;
    const yt = parseYoutubeTime(u.searchParams.get("t") ?? u.searchParams.get("start"));
    return Number.isFinite(yt) && yt > 0 ? yt : 0;
  } catch {
    const i = url.indexOf("#");
    const frag = i >= 0 ? parseTempFrag(url.slice(i)) : null;
    return frag && frag.start >= 0 ? frag.start : 0;
  }
}

/**
 * The web timestamp link Media Extended writes. YouTube URLs are printed as
 * `https://www.youtube.com/watch?v=ID&t=<whole seconds>`; other URLs keep
 * their address without a hash.
 */
export function webTimestampLink(sourceUrl: string, time: number, youtubeId: string | null): string {
  const text = formatDuration(time);
  const frag: TempFragment | null = time > 0 ? { start: time, end: -1 } : null;
  const hash = frag ? `#${toTempFragString(frag)}` : "";
  let printed: string;
  if (youtubeId) {
    const u = new URL("https://www.youtube.com/watch");
    u.search = new URLSearchParams({ v: youtubeId }).toString();
    try {
      const list = new URL(sourceUrl).searchParams.get("list");
      if (list) u.searchParams.set("list", list);
    } catch {
      /* keep */
    }
    if (frag) u.searchParams.set("t", time.toFixed(0));
    printed = u.href;
  } else {
    printed = sourceUrl.replace(/#.*$/, "");
  }
  return `[${text}](${printed}${hash})`;
}
