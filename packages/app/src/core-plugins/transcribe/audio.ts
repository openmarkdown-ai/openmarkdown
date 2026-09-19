/**
 * Audio preparation for long recordings: decode once to 16 kHz mono (what
 * Whisper reads), cut into chunks at quiet moments, and hand each chunk to the
 * engine as a small WAV. Chunks give real progress, a cancel that takes
 * effect between chunks, and a cache that survives a cancelled run.
 */
import { planChunks, type ChunkPlan } from "./format";

export const SAMPLE_RATE = 16_000;

export interface DecodedAudio {
  samples: Float32Array;
  duration: number;
}

/** Null when the browser cannot decode the file (the engine then gets the original bytes in one piece). */
export async function decodeAudio(data: ArrayBuffer): Promise<DecodedAudio | null> {
  const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Offline) return null;
  try {
    // decodeAudioData detaches the buffer it is given.
    const probe = new Offline(1, 1, SAMPLE_RATE);
    const decoded = await probe.decodeAudioData(data.slice(0));
    if (!decoded.length) return null;
    const frames = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
    const ctx = new Offline(1, frames, SAMPLE_RATE);
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(ctx.destination);
    src.start();
    const rendered = await ctx.startRendering();
    return { samples: rendered.getChannelData(0), duration: rendered.duration };
  } catch {
    return null;
  }
}

/** The quietest 200 ms window between `from` and `to` seconds, as its centre. */
export function quietestMoment(samples: Float32Array, from: number, to: number): number {
  const win = Math.floor(SAMPLE_RATE * 0.2);
  const a = Math.max(0, Math.floor(from * SAMPLE_RATE));
  const b = Math.min(samples.length - win, Math.floor(to * SAMPLE_RATE));
  let best = -1;
  let bestEnergy = Infinity;
  for (let i = a; i <= b; i += win / 2) {
    let e = 0;
    for (let j = i; j < i + win; j += 4) e += samples[j]! * samples[j]!;
    if (e < bestEnergy) {
      bestEnergy = e;
      best = i;
    }
  }
  return best < 0 ? (from + to) / 2 : (best + win / 2) / SAMPLE_RATE;
}

export function chunkAudio(audio: DecodedAudio, targetSeconds: number): ChunkPlan[] {
  return planChunks(audio.duration, targetSeconds, Math.min(15, targetSeconds / 5), (f, t) => quietestMoment(audio.samples, f, t));
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function sliceChunk(audio: DecodedAudio, chunk: ChunkPlan): Blob {
  return encodeWav(audio.samples.subarray(Math.floor(chunk.start * SAMPLE_RATE), Math.min(audio.samples.length, Math.ceil(chunk.end * SAMPLE_RATE))));
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
