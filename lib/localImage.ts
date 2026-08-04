/**
 * Local image generation via ComfyUI (server-side only).
 *
 * ComfyUI runs locally on the user's GPU (http://127.0.0.1:8188) with an
 * SDXL text-to-image checkpoint (RealVisXL V5.0 by default; Animagine XL 4.0
 * for anime-style prompts). This module:
 *   1. fast-probes whether ComfyUI is reachable (cached, like the Ollama probe)
 *   2. loads an API-format workflow template (comfy/text2img.json, or
 *      comfy/ref2img.json / comfy/faceid2img.json when a reference image is
 *      provided), injects prompt/size/seed (+ IPAdapter reference), POSTs it
 *      to /prompt
 *   3. polls /history/{prompt_id} until the image is done, then downloads it.
 *
 * This is the "unlimited, free, local" tier of the image cascade:
 *   Gemini (best, quota-limited) → local ComfyUI (free, unlimited) → Pollinations.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { composeFullPrompt } from "./promptSanitizer";
import { overlayText } from "./textOverlay";

export interface LocalImage {
  b64: string;
  mime: string;
}

export interface LocalImageOptions {
  width?: number;
  height?: number;
  seed?: number;
  /** Caption drawn on a bottom banner (local tier only — Pillow overlay). */
  text?: string;
  /** Hidden EN tags re-injected from the sanitizer — LOCAL prompt only. */
  inject?: string[];
  /** Reference image (basename inside ComfyUI input/refs/) that steers the
   *  result. "style" → IPAdapter (anime/art characters), "face" → FaceID
   *  (real people). */
  reference?: { file: string; mode: "style" | "face" };
  /** IPAdapter weight override (defaults: style 0.7, face 0.85). */
  weight?: number;
}

const COMFY_URL = process.env.COMFY_URL || "http://127.0.0.1:8188";
const COMFY_CHECKPOINT = process.env.COMFY_CHECKPOINT || "RealVisXL_V5.0_fp16.safetensors";
const COMFY_ANIME_CHECKPOINT = process.env.COMFY_ANIME_CHECKPOINT || "animagine-xl-4.0.safetensors";
const COMFY_UPSCALE_MODEL = process.env.COMFY_UPSCALE_MODEL || "4x-UltraSharp.pth";
const PROBE_TTL = 15_000;

/** Anime/manhua requests pick the dedicated anime checkpoint (Animagine XL).
 *  Matches on the RU/EN words the assistant hears most often. */
export function isAnimePrompt(prompt: string): boolean {
  const p = prompt.toLowerCase();
  const words = [
    "аниме", "anime", "манга", "manga", "маньхуа", "manhwa", "манхуа", "манхва",
    "вей у сянь", "вейвус", "wei wuxian", "каваи", "кавай", "мультяшн", "cell",
  ];
  return words.some((w) => p.includes(w));
}

let probeState: { reachable: boolean; checkedAt: number } = { reachable: false, checkedAt: 0 };

/** Fast reachability check against ComfyUI's /system_stats, cached 15s. */
export async function isLocalImageAvailable(): Promise<boolean> {
  const now = Date.now();
  if (now - probeState.checkedAt < PROBE_TTL) return probeState.reachable;
  probeState.checkedAt = now;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${COMFY_URL}/system_stats`, { signal: ctrl.signal });
    clearTimeout(timer);
    probeState.reachable = res.ok;
  } catch {
    probeState.reachable = false;
  }
  return probeState.reachable;
}

/** Pull a completed image out of the ComfyUI /history response. */
function firstImageOutput(history: Record<string, unknown> | null, promptId: string): { filename: string; subfolder: string; type: string } | null {
  const entry = history?.[promptId] as
    | { outputs?: Record<string, { images?: { filename?: string; subfolder?: string; type?: string }[] }> }
    | undefined;
  if (!entry?.outputs) return null;
  for (const node of Object.values(entry.outputs)) {
    const img = node?.images?.[0];
    if (img?.filename) return { filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" };
  }
  return null;
}

/**
 * Generate an image with the local ComfyUI. Throws when ComfyUI is unreachable,
 * the workflow fails, or the image can't be fetched — the caller falls back.
 */
export async function generateImageLocal(prompt: string, opts?: LocalImageOptions): Promise<LocalImage> {
  const width = opts?.width ?? 1024;
  const height = opts?.height ?? 1024;
  const seed = opts?.seed ?? Math.floor(Math.random() * 1_000_000_000);

  // Hidden RU→EN tags (sanitizer) go ONLY into the local ComfyUI prompt — the
  // Gemini/Pollinations tiers never see them.
  const finalPrompt = opts?.inject?.length ? composeFullPrompt(prompt, opts.inject) : prompt;

  // Reference-driven generations use the IPAdapter/FaceID templates and pick
  // the anime checkpoint for anime-ish prompts (Animagine is a tag model, so
  // its quality tags are prepended).
  const ref = opts?.reference;
  const anime = isAnimePrompt(finalPrompt);
  const templateName = !ref ? "text2img.json" : ref.mode === "face" ? "faceid2img.json" : "ref2img.json";
  const checkpoint = anime ? COMFY_ANIME_CHECKPOINT : COMFY_CHECKPOINT;
  const ipadapterWeight = opts?.weight ?? (ref?.mode === "face" ? 0.85 : 0.7);
  const animePrefix = anime ? "masterpiece, best quality, very aesthetic, absurdres, anime style, " : "";

  // The template has unquoted numeric placeholders (__WIDTH__, __HEIGHT__,
  // __SEED__), so it's NOT valid JSON until they're substituted. Replace on the
  // raw text first (keeping string placeholders quoted, numbers bare), then
  // parse. Injected strings are JSON-escaped so quotes/newlines can't break it.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
  const template = await fs.readFile(path.join(process.cwd(), "comfy", templateName), "utf8");
  const raw = template
    .replaceAll("__CHECKPOINT__", esc(checkpoint))
    .replaceAll("__PROMPT__", esc(animePrefix + finalPrompt))
    .replaceAll("__NEGATIVE__", "")
    .replaceAll("__WIDTH__", String(width))
    .replaceAll("__HEIGHT__", String(height))
    .replaceAll("__UPSCALE_MODEL__", esc(COMFY_UPSCALE_MODEL))
    .replaceAll("__UPSCALE_W__", String(width * 2))
    .replaceAll("__UPSCALE_H__", String(height * 2))
    .replaceAll("__SEED__", String(seed))
    .replaceAll("__REFERENCE__", ref ? esc(`refs/${ref.file}`) : "")
    .replaceAll("__IPADAPTER_WEIGHT__", String(ipadapterWeight));
  const workflow = JSON.parse(raw) as Record<string, unknown>;

  const promptRes = await fetch(`${COMFY_URL}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: `ultron-${Date.now()}` }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!promptRes.ok) {
    const text = await promptRes.text().catch(() => "");
    throw new Error(`comfyui prompt ${promptRes.status}: ${text.slice(0, 300)}`);
  }
  const queued = (await promptRes.json()) as { prompt_id?: string };
  if (!queued.prompt_id) throw new Error("comfyui returned no prompt_id");

  // Poll /history until the job is done (or fails). ~1s cadence, 10 min cap
  // (28 steps + 2× upscale on an 8GB card can take a while).
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const historyRes = await fetch(`${COMFY_URL}/history/${queued.prompt_id}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!historyRes.ok) continue;
    const history = (await historyRes.json()) as Record<string, unknown> | null;
    const entry = history?.[queued.prompt_id] as
      | { status?: { status_str?: string; messages?: unknown[] } }
      | undefined;
    const statusStr = entry?.status?.status_str;
    if (statusStr === "error") {
      // messages is a list of [timestamp, payload] tuples; an execution_error
      // payload carries the exception text in data.exception_message.
      const errTuple = (entry?.status?.messages ?? []).find((m) => {
        const payload = Array.isArray(m) && m[1] ? (m[1] as { message?: string }) : undefined;
        return payload?.message === "execution_error";
      });
      const errData = Array.isArray(errTuple) && errTuple[1]
        ? ((errTuple[1] as { data?: { exception_message?: string } }).data ?? {})
        : {};
      throw new Error(`comfyui execution error: ${errData.exception_message ?? "unknown"}`);
    }
    if (statusStr === "success") {
      const img = firstImageOutput(history, queued.prompt_id);
      if (img) {
        const viewUrl =
          `${COMFY_URL}/view?filename=${encodeURIComponent(img.filename)}` +
          (img.subfolder ? `&subfolder=${encodeURIComponent(img.subfolder)}` : "") +
          `&type=${encodeURIComponent(img.type)}`;
        const viewRes = await fetch(viewUrl, { signal: AbortSignal.timeout(30_000) });
        if (!viewRes.ok) throw new Error(`comfyui view ${viewRes.status}`);
        const buf = Buffer.from(await viewRes.arrayBuffer());
        const contentType = viewRes.headers.get("content-type") ?? "";
        const mime = contentType.includes("png") ? "image/png" : contentType.includes("webp") ? "image/webp" : "image/jpeg";
        const result = { b64: buf.toString("base64"), mime };
        // Caption overlay (best-effort; returns the image untouched on failure).
        if (opts?.text) return overlayText(result.b64, opts.text);
        return result;
      }
    }
  }
  throw new Error("comfyui generation timed out");
}
