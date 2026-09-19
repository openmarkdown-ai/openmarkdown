/**
 * Whisper transcription on transformers.js with the four faults every product
 * hits corrected (ported from openapps/opensubs/apps/web/src/lib/asr.ts, where
 * each rule was measured on real recordings; see the comments there):
 *
 * 1. transformers.js has no language detection: without a language it
 *    silently transcribes as English. The language token Whisper predicts
 *    after `<|startoftranscript|>` is read per 4-second cell.
 * 2. Silence votes for a random language. Lone disagreeing cells are
 *    smoothed away, quiet cells inherit their neighbours, and a language
 *    holding under 4% of the recording and under 25 s is dropped.
 * 3. The pipeline drops spans without an error when overlapping windows fail
 *    to reconcile. Audible gaps are re-read on their own; a long segment with
 *    almost no text is a smear, not slow speech, and is removed first.
 * 4. One `<|zh|>`, two scripts: output flips between Simplified and
 *    Traditional. Chinese text is normalised to Simplified unless Traditional
 *    was asked for, and never when kana or Hangul show it is not Chinese.
 *
 * Runs inside the worker. Times are seconds from the start of the audio given.
 */
import { TS_PAIRS } from "./hanzi";

const SR = 16000;
const CHUNK_LENGTH_S = 30;
const STRIDE_LENGTH_S = 5;
const DETECT_WINDOW_S = 4;
const REFINE_WINDOW_S = 4;
const REFINE_STEP_S = 2;
const REFINE_SPAN_S = 4;
const SNAP_RADIUS_S = 0.75;
const SNAP_QUIET_RATIO = 0.4;
const LEAD_OUT_S = 3;
const MAX_SEGMENT_S = 12;
const MIN_CHARS_PER_SECOND = 2;
const GAP_S = 4;
const MAX_GAP_S = 60;
const MAX_REFILLS = 30;
const REFILL_SECONDS_EACH = 20;
const MAX_REFILL_ROUNDS = 4;
const GAP_SPEECH_RATIO = 0.15;
/** A cell this much quieter than the recording's average is silence, and votes for nothing. */
const QUIET_CELL_RATIO = 0.15;
const MINOR_SHARE = 0.04;
const MINOR_SECONDS = 25;

export interface Segment {
  start: number;
  end: number;
  text: string;
}

interface Run {
  from: number;
  to: number;
  language: string;
}

type Transcriber = ((audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string; chunks?: { text: string; timestamp: [number | null, number | null] }[] }>) & {
  model: { generation_config: { lang_to_id?: Record<string, number>; decoder_start_token_id: number; suppress_tokens?: number[] }; generate(options: Record<string, unknown>): Promise<unknown> };
  processor(audio: Float32Array): Promise<{ input_features: unknown }>;
};

export interface WhisperOptions {
  language?: string;
  englishOnly: boolean;
  signal?: { aborted: boolean };
  onProgress?: (fraction: number) => void;
}

function checkAbort(signal?: { aborted: boolean }) {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}

function loudness(audio: Float32Array, from: number, to: number): number {
  const a = Math.max(0, Math.round(from * SR));
  const b = Math.min(audio.length, Math.round(to * SR));
  if (b <= a) return 0;
  let sum = 0;
  let n = 0;
  for (let i = a; i < b; i += 16) {
    sum += audio[i]! * audio[i]!;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

async function detectWindow(pipe: Transcriber, window: Float32Array, idToLang: Map<number, string>): Promise<string | null> {
  const { input_features } = await pipe.processor(window);
  const out = (await pipe.model.generate({ inputs: input_features, max_new_tokens: 1, decoder_input_ids: [pipe.model.generation_config.decoder_start_token_id] })) as any;
  const first = out?.sequences?.[0] ?? out?.[0];
  const ids = first?.tolist?.() as (number | bigint)[] | undefined;
  if (!ids?.length) return null;
  return idToLang.get(Number(ids[ids.length - 1])) ?? null;
}

/** Erases a single cell that disagrees with the two around it, at the edges too. */
export function smoothLabels(labels: string[]): string[] {
  for (let i = 1; i < labels.length - 1; i++) if (labels[i] !== labels[i - 1] && labels[i - 1] === labels[i + 1]) labels[i] = labels[i - 1]!;
  if (labels.length >= 3) {
    if (labels[0] !== labels[1] && labels[1] === labels[2]) labels[0] = labels[1]!;
    const n = labels.length;
    if (labels[n - 1] !== labels[n - 2] && labels[n - 2] === labels[n - 3]) labels[n - 1] = labels[n - 2]!;
  }
  return labels;
}

/** Quiet cells (null) take the label of the nearest voiced cell; a language with a tiny share is folded into its neighbours. */
export function settleLabels(labels: (string | null)[], cellSeconds: number): string[] {
  const out = labels.slice();
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    let d = 1;
    while (d < out.length) {
      const left = labels[i - d];
      const right = labels[i + d];
      if (left) {
        out[i] = left;
        break;
      }
      if (right) {
        out[i] = right;
        break;
      }
      d++;
    }
  }
  const filled = out.map((l) => l ?? "en");
  smoothLabels(filled);
  const counts = new Map<string, number>();
  for (const l of filled) counts.set(l, (counts.get(l) ?? 0) + 1);
  const total = filled.length;
  const minor = new Set([...counts].filter(([, n]) => n / total < MINOR_SHARE && n * cellSeconds < MINOR_SECONDS).map(([l]) => l));
  if (minor.size && minor.size < counts.size) {
    for (let i = 0; i < filled.length; i++) {
      if (!minor.has(filled[i]!)) continue;
      let d = 1;
      while (d < filled.length) {
        const left = filled[i - d];
        const right = filled[i + d];
        if (left && !minor.has(left)) {
          filled[i] = left;
          break;
        }
        if (right && !minor.has(right)) {
          filled[i] = right;
          break;
        }
        d++;
      }
    }
  }
  return filled;
}

function quietestNear(audio: Float32Array, centre: number, radius: number): number {
  const frame = Math.round(0.1 * SR);
  const from = Math.max(0, centre - radius);
  const to = Math.min(audio.length - frame, centre + radius);
  if (to <= from) return Math.max(0, Math.min(centre, audio.length));
  let quietest = centre;
  let lowest = Infinity;
  let total = 0;
  let frames = 0;
  for (let at = from; at <= to; at += frame) {
    let energy = 0;
    for (let i = at; i < at + frame; i += 4) energy += audio[i]! * audio[i]!;
    total += energy;
    frames++;
    if (energy < lowest - 1e-9) {
      lowest = energy;
      quietest = at;
    }
  }
  const mean = frames ? total / frames : 0;
  if (!(lowest < mean * SNAP_QUIET_RATIO)) return Math.max(0, Math.min(centre, audio.length));
  return quietest + Math.round(frame / 2);
}

async function languageRuns(pipe: Transcriber, audio: Float32Array, opts: WhisperOptions, progress: (f: number) => void): Promise<Run[]> {
  const langToId = pipe.model?.generation_config?.lang_to_id;
  if (!langToId) return [{ from: 0, to: audio.length, language: "en" }];
  const idToLang = new Map(Object.entries(langToId).map(([token, id]) => [id, token.replace(/[<|>]/g, "")]));
  const cell = DETECT_WINDOW_S * SR;
  const cells = Math.max(1, Math.ceil(audio.length / cell));
  const overall = loudness(audio, 0, audio.length / SR);
  const labels: (string | null)[] = [];
  for (let i = 0; i < cells; i++) {
    checkAbort(opts.signal);
    const from = i * cell;
    const to = Math.min((i + 1) * cell, audio.length);
    const quiet = loudness(audio, from / SR, to / SR) < overall * QUIET_CELL_RATIO;
    labels.push(quiet ? null : await detectWindow(pipe, audio.slice(from, to), idToLang));
    progress((i + 1) / cells);
  }
  const settled = settleLabels(labels, DETECT_WINDOW_S);
  const runs: Run[] = [];
  for (const [i, language] of settled.entries()) {
    const to = Math.min((i + 1) * cell, audio.length);
    const last = runs[runs.length - 1];
    if (last && last.language === language) last.to = to;
    else runs.push({ from: i * cell, to, language });
  }
  const refineWindow = REFINE_WINDOW_S * SR;
  for (let i = 1; i < runs.length; i++) {
    checkAbort(opts.signal);
    const after = runs[i]!.language;
    const span = REFINE_SPAN_S * SR;
    const lo = Math.max(runs[i - 1]!.from, runs[i]!.from - span);
    const hi = Math.min(runs[i]!.to - refineWindow, runs[i]!.from + span);
    let lastBefore: number | null = null;
    let firstAfter: number | null = null;
    for (let at = lo; at <= hi; at += REFINE_STEP_S * SR) {
      const heard = await detectWindow(pipe, audio.slice(at, at + refineWindow), idToLang);
      if (heard === after) {
        firstAfter = at;
        break;
      }
      lastBefore = at;
    }
    const estimate = firstAfter === null ? runs[i]!.from : lastBefore === null ? firstAfter + refineWindow / 2 : (lastBefore + firstAfter) / 2 + refineWindow / 2;
    const cut = quietestNear(audio, Math.max(runs[i - 1]!.from + 1, Math.min(estimate, runs[i]!.to - 1)), SNAP_RADIUS_S * SR);
    runs[i - 1]!.to = cut;
    runs[i]!.from = cut;
  }
  return runs.filter((r) => r.to > r.from);
}

function readable(text: string): string {
  return text.replace(/�/g, "").replace(/\s+/g, " ").trim();
}

function windowsFor(samples: number): number {
  const window = SR * CHUNK_LENGTH_S;
  const jump = window - 2 * SR * STRIDE_LENGTH_S;
  let offset = 0;
  let count = 0;
  for (;;) {
    count++;
    if (offset + window >= samples) return count;
    offset += jump;
  }
}

async function fillGaps(segments: Segment[], runs: Run[], audio: Float32Array, pipe: Transcriber, opts: WhisperOptions): Promise<void> {
  const overall = loudness(audio, 0, audio.length / SR);
  if (!(overall > 0)) return;
  let budget = Math.min(MAX_REFILLS, Math.ceil(audio.length / SR / REFILL_SECONDS_EACH));
  for (let round = 0; round < MAX_REFILL_ROUNDS && budget > 0; round++) {
    segments.sort((a, b) => a.start - b.start);
    const found: Segment[] = [];
    for (const run of runs) {
      const from = run.from / SR;
      const to = run.to / SR;
      let cursor = from;
      const inside = segments.filter((s) => s.start >= from - 0.5 && s.start < to);
      for (const seg of [...inside, { start: to, end: to, text: "" }]) {
        const gap = seg.start - cursor;
        if (budget > 0 && gap >= GAP_S && gap <= MAX_GAP_S && loudness(audio, cursor, seg.start) > overall * GAP_SPEECH_RATIO) {
          budget--;
          checkAbort(opts.signal);
          const again = await pipe(audio.slice(Math.round(cursor * SR), Math.round(seg.start * SR)), {
            return_timestamps: true,
            chunk_length_s: CHUNK_LENGTH_S,
            stride_length_s: STRIDE_LENGTH_S,
            no_repeat_ngram_size: 6,
            ...(opts.englishOnly ? {} : { language: run.language, task: "transcribe" }),
          });
          for (const chunk of again.chunks ?? []) {
            const text = readable(chunk.text);
            const [begin, end] = chunk.timestamp;
            if (!text || typeof begin !== "number") continue;
            const covers = (typeof end === "number" && end > begin ? end : begin) - begin;
            if (covers > MAX_SEGMENT_S && text.length / covers < MIN_CHARS_PER_SECOND) continue;
            const start = cursor + begin;
            if (start >= seg.start) continue;
            found.push({ start, end: Math.min(seg.start, cursor + (typeof end === "number" && end > begin ? end : begin + 1)), text });
          }
        }
        cursor = Math.max(cursor, seg.end);
      }
    }
    if (!found.length) break;
    segments.push(...found);
  }
  segments.sort((a, b) => a.start - b.start);
}

let table: Map<string, string> | null = null;
const NOT_CHINESE = /[぀-ヿㇰ-ㇿ가-힯ᄀ-ᇿ]/;

/** Traditional → Simplified, one character for one; untouched when kana or Hangul show the text is not Chinese. */
export function toSimplified(text: string): string {
  if (!/[㐀-鿿豈-﫿]/.test(text) || NOT_CHINESE.test(text)) return text;
  if (!table) {
    table = new Map();
    for (let i = 0; i + 1 < TS_PAIRS.length; i += 2) table.set(TS_PAIRS[i]!, TS_PAIRS[i + 1]!);
  }
  let out = "";
  for (const ch of text) out += table.get(ch) ?? ch;
  return out;
}

export async function transcribeWhisper(pipe: Transcriber, audio: Float32Array, opts: WhisperOptions): Promise<{ text: string; segments: Segment[]; language?: string }> {
  const hint = opts.language?.toLowerCase();
  const named = hint ? hint.split("-")[0]! : null;
  const detectShare = named || opts.englishOnly ? 0 : 0.2;
  const report = (f: number) => opts.onProgress?.(Math.min(1, f));
  const runs: Run[] = opts.englishOnly || named ? [{ from: 0, to: audio.length, language: named ?? "en" }] : await languageRuns(pipe, audio, opts, (f) => report(f * detectShare));

  const windows = runs.reduce((n, r) => n + windowsFor(Math.min(r.to + LEAD_OUT_S * SR, audio.length) - r.from), 0);
  let finished = 0;
  const streamer = {
    put() {},
    end() {
      finished++;
      report(detectShare + (finished / Math.max(windows, 1)) * (0.95 - detectShare));
    },
  };

  const segments: Segment[] = [];
  let spokenUpTo = 0;
  for (const run of runs) {
    checkAbort(opts.signal);
    const readTo = Math.min(run.to + LEAD_OUT_S * SR, audio.length);
    const result = await pipe(audio.slice(run.from, readTo), {
      streamer,
      return_timestamps: true,
      chunk_length_s: CHUNK_LENGTH_S,
      stride_length_s: STRIDE_LENGTH_S,
      no_repeat_ngram_size: 6,
      ...(opts.englishOnly ? {} : { language: run.language, task: "transcribe" }),
    });
    const offset = run.from / SR;
    const cut = run.to / SR;
    for (const chunk of result.chunks ?? []) {
      const text = readable(chunk.text);
      const [chunkStart, chunkEnd] = chunk.timestamp;
      if (!text || typeof chunkStart !== "number") continue;
      const start = offset + chunkStart;
      if (start >= cut) continue;
      const end = offset + (typeof chunkEnd === "number" && chunkEnd > chunkStart ? chunkEnd : chunkStart + Math.max(0.3, text.length * 0.06));
      if (end <= spokenUpTo) continue;
      segments.push({ start, end, text });
      spokenUpTo = Math.max(spokenUpTo, end);
    }
  }

  // A long segment with almost no words is a smear over audio the model lost; remove it so the gap is re-read.
  const kept = segments.filter((s) => s.end - s.start <= MAX_SEGMENT_S || s.text.length / (s.end - s.start) >= MIN_CHARS_PER_SECOND);
  checkAbort(opts.signal);
  await fillGaps(kept, runs, audio, pipe, opts);

  const traditional = !!hint && hint.startsWith("zh") && /hant|tw|hk|mo/.test(hint);
  const languageAt = (t: number) => runs.find((r) => t * SR < r.to)?.language ?? runs[runs.length - 1]?.language ?? "en";
  for (const s of kept) if (!traditional && languageAt(s.start) === "zh") s.text = toSimplified(s.text);

  // Time order and no overlaps.
  for (let i = 1; i < kept.length; i++) {
    if (kept[i]!.start < kept[i - 1]!.end) {
      kept[i]!.start = kept[i - 1]!.end;
      kept[i]!.end = Math.max(kept[i]!.end, kept[i]!.start);
    }
  }
  report(1);
  const spoken = new Map<string, number>();
  for (const r of runs) spoken.set(r.language, (spoken.get(r.language) ?? 0) + (r.to - r.from));
  const dominant = [...spoken].sort((a, b) => b[1] - a[1])[0]?.[0];
  const cjk = /^(zh|ja|ko|th|lo|my|km)$/.test(dominant ?? "");
  return { text: kept.map((s) => s.text).join(cjk ? "" : " ").trim(), segments: kept, language: hint ?? dominant };
}
