/**
 * Local image generation via ComfyUI (server-side only).
 *
 * ComfyUI runs locally on the user's GPU (http://127.0.0.1:8188) with a
 * text-to-image checkpoint (SDXL-Turbo by default). This module:
 *   1. fast-probes whether ComfyUI is reachable (cached, like the Ollama probe)
 *   2. loads comfy/text2img.json (an API-format workflow template), injects the
 *      prompt/size/seed, and POSTs it to /prompt
 *   3. polls /history/{prompt_id} until the image is done, then downloads it.
 *
 * This is the "unlimited, free, local" tier of the image cascade:
 *   Gemini (best, quota-limited) → local ComfyUI (free, unlimited) → Pollinations.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface LocalImage {
  b64: string;
  mime: string;
}

const COMFY_URL = process.env.COMFY_URL || "http://127.0.0.1:8188";
const COMFY_CHECKPOINT = process.env.COMFY_CHECKPOINT || "sd_xl_turbo_1.0_fp16.safetensors";
const PROBE_TTL = 15_000;

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
export async function generateImageLocal(prompt: string, opts?: { width?: number; height?: number; seed?: number }): Promise<LocalImage> {
  const width = opts?.width ?? 1024;
  const height = opts?.height ?? 1024;
  const seed = opts?.seed ?? Math.floor(Math.random() * 1_000_000_000);

  // The template has unquoted numeric placeholders (__WIDTH__, __HEIGHT__,
  // __SEED__), so it's NOT valid JSON until they're substituted. Replace on the
  // raw text first (keeping string placeholders quoted, numbers bare), then
  // parse. Injected strings are JSON-escaped so quotes/newlines can't break it.
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
  const template = await fs.readFile(path.join(process.cwd(), "comfy", "text2img.json"), "utf8");
  const raw = template
    .replaceAll("__CHECKPOINT__", esc(COMFY_CHECKPOINT))
    .replaceAll("__PROMPT__", esc(prompt))
    .replaceAll("__NEGATIVE__", "")
    .replaceAll("__WIDTH__", String(width))
    .replaceAll("__HEIGHT__", String(height))
    .replaceAll("__SEED__", String(seed));
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

  // Poll /history until the job is done (or fails). ~1s cadence, 180s cap.
  const deadline = Date.now() + 180_000;
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
        return { b64: buf.toString("base64"), mime };
      }
    }
  }
  throw new Error("comfyui generation timed out");
}
