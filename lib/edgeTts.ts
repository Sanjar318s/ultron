import { Communicate, type CommunicateOptions } from "edge-tts-universal";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Voice registry
// ---------------------------------------------------------------------------

export const VOICES = {
  male: "ru-RU-DmitryNeural",
  female: "ru-RU-SvetlanaNeural",
} as const;

export type VoiceId = keyof typeof VOICES;
export type EdgeVoiceName = (typeof VOICES)[VoiceId];

export interface EdgeTTSOptions {
  voice?: EdgeVoiceName;
  rate?: string;   // e.g. "-10%", "+20%"
  pitch?: string;  // e.g. "-5Hz", "+10Hz"
  volume?: string; // e.g. "+0%", "-20%"
}

const DEFAULTS: Required<EdgeTTSOptions> = {
  voice: VOICES.male,
  rate: "-10%",
  pitch: "-5Hz",
  volume: "+0%",
};

// ---------------------------------------------------------------------------
// In-memory LRU cache (Map preserves insertion order)
// ---------------------------------------------------------------------------

interface CacheEntry {
  buf: Buffer;
  ts: number;
}

const CACHE = new Map<string, CacheEntry>();
const CACHE_MAX = 500;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function cacheKey(text: string, opts: Required<EdgeTTSOptions>): string {
  const raw = `${opts.voice}|${opts.rate}|${opts.pitch}|${opts.volume}|${text}`;
  return createHash("sha256").update(raw).digest("hex");
}

function cacheGet(key: string): Buffer | null {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) {
    CACHE.delete(key);
    return null;
  }
  // Move to end (most recently used)
  CACHE.delete(key);
  CACHE.set(key, e);
  return e.buf;
}

function cacheSet(key: string, buf: Buffer): void {
  if (CACHE.size >= CACHE_MAX) {
    // Evict oldest (first entry)
    const first = CACHE.keys().next().value;
    if (first !== undefined) CACHE.delete(first);
  }
  CACHE.set(key, { buf, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// Core synthesis
// ---------------------------------------------------------------------------

/**
 * Synthesize speech via Edge TTS. Returns an MP3 Buffer.
 * Results are cached in memory for 30 minutes.
 */
export async function synthesizeSpeech(
  text: string,
  opts?: EdgeTTSOptions,
): Promise<Buffer> {
  const o = { ...DEFAULTS, ...opts };
  const key = cacheKey(text, o);
  const cached = cacheGet(key);
  if (cached) return cached;

  const communicate = new Communicate(text, {
    voice: o.voice,
    rate: o.rate,
    pitch: o.pitch,
    volume: o.volume,
  } satisfies CommunicateOptions);

  const chunks: Buffer[] = [];
  for await (const chunk of communicate.stream()) {
    if (chunk.type === "audio" && chunk.data) {
      chunks.push(chunk.data);
    }
  }

  if (chunks.length === 0) {
    throw new Error("Edge TTS returned no audio data");
  }

  const buf = Buffer.concat(chunks);
  cacheSet(key, buf);
  return buf;
}

/**
 * List available Edge TTS voices (cached for 24 hours).
 */
let voicesCache: { voices: Awaited<ReturnType<typeof import("edge-tts-universal").listVoices>>; ts: number } | null = null;

export async function listEdgeVoices() {
  if (voicesCache && Date.now() - voicesCache.ts < 24 * 60 * 60 * 1000) {
    return voicesCache.voices;
  }
  const { listVoices } = await import("edge-tts-universal");
  const voices = await listVoices();
  voicesCache = { voices, ts: Date.now() };
  return voices;
}
