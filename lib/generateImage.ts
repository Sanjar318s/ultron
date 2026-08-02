/**
 * Image generation — shared by the /api/image route (browser) and the
 * server-side assistant core (/api/assistant).
 *
 * Cascade:
 *   1. Gemini image model (gemini-3.1-flash-image) — best quality, but the
 *      free-tier quota is often exhausted.
 *   2. Local ComfyUI (SDXL-Turbo) — free and unlimited, runs on this machine.
 *   3. Pollinations.ai — keyless, registration-free fallback.
 */

import { generateImageLocal, isLocalImageAvailable } from "./localImage";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const IMAGE_MODEL = "gemini-3.1-flash-image";

export interface GeneratedImage {
  b64: string;
  mime: string;
}

export interface GenerateImageOptions {
  /** Caption text drawn on the image (local tier only). */
  text?: string;
  /** Hidden EN tags injected ONLY into the local ComfyUI prompt. */
  localTags?: string[];
}

async function generateGemini(prompt: string, key: string): Promise<GeneratedImage> {
  const res = await fetch(`${GEMINI_URL}/${IMAGE_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const detail =
      typeof data?.error === "object" && data.error && "message" in (data.error as Record<string, unknown>)
        ? ((data.error as Record<string, unknown>).message as string)
        : res.statusText;
    throw new Error(detail || `HTTP ${res.status}`);
  }
  const candidates = data?.candidates as
    | { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[]
    | undefined;
  const imagePart = candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData?.data) throw new Error("model returned no image");
  return { b64: imagePart.inlineData.data, mime: imagePart.inlineData.mimeType ?? "image/png" };
}

/** Keyless fallback: Pollinations.ai — free, no registration, returns JPEG. */
async function generatePollinations(prompt: string): Promise<GeneratedImage> {
  const enhanced = `${prompt.trim()}, highly detailed, professional photography, vibrant saturated colors, sharp focus, studio lighting, 8k quality`;
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(enhanced.slice(0, 500))}` +
    `?width=1280&height=1280&nologo=true&model=flux&enhance=true&seed=${Math.floor(Math.random() * 1e9)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`pollinations ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`pollinations returned no image: ${text || contentType}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error("pollinations returned an empty image");
  const mime = contentType.includes("png") ? "image/png" : contentType.includes("webp") ? "image/webp" : "image/jpeg";
  return { b64: buf.toString("base64"), mime };
}

export async function generateImage(prompt: string, opts?: GenerateImageOptions): Promise<GeneratedImage> {
  const key = process.env.GEMINI_API_KEY;
  if (key) {
    try {
      return await generateGemini(prompt, key);
    } catch (err) {
      console.warn("[image] gemini failed, falling back to local comfy:", (err as Error).message);
    }
  } else {
    console.warn("[image] no gemini key — skipping gemini");
  }
  try {
    if (await isLocalImageAvailable()) {
      return await generateImageLocal(prompt, {
        text: opts?.text,
        inject: opts?.localTags,
      });
    }
  } catch (err) {
    console.warn("[image] local comfy failed, falling back to pollinations:", (err as Error).message);
  }
  return generatePollinations(prompt);
}
