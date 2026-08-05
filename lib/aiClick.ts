import { clickAt, dragTo } from "./desktopInput";

/**
 * Vision-driven desktop clicking (LOCALHOST-only): capture the screen, ask
 * Gemini (via /api/llm) where to click, then execute through desktopInput.
 * Coordinates are RELATIVE 0..1 — the screenshot route downscales, but the
 * fractions map 1:1 to the real screen.
 *
 * Modes:
 *   click — one left-click at the requested target («нажми на капчу»).
 *   grid  — click every cell that matches («выбери все светофоры»).
 *   drag  — drag from a start point to an end point (slider captchas).
 */

export type ClickMode = "click" | "grid" | "drag";

export interface ClickPoint {
  x: number;
  y: number;
}

export interface ResolvedClick {
  kind: ClickMode;
  points: ClickPoint[];
  drag?: { x1: number; y1: number; x2: number; y2: number };
  raw: string;
}

const SYSTEM_PROMPT = [
  "You see a screenshot of the user's desktop. Coordinates are RELATIVE 0..1:",
  "x=0 is the left edge, x=1 the right edge, y=0 the top edge, y=1 the bottom edge.",
  "Reply with ONLY one JSON object. No markdown, no commentary.",
].join(" ");

const MODE_INSTRUCTIONS: Record<ClickMode, string> = {
  click:
    'Find where the user wants to LEFT-CLICK and return {"x":0..1,"y":0..1}. If the target is not visible on screen, return {"error":"not_found"}.',
  grid:
    'The user wants to click ALL matching cells (e.g. a captcha grid). Return {"points":[{"x":..,"y":..}, ...]} with the center of every matching cell. If none match, return {"points":[]}.',
  drag:
    'The user wants to DRAG (e.g. a slider). Return {"x1":..,"y1":..,"x2":..,"y2":..} — start and end points in relative coords. If the target is not visible, return {"error":"not_found"}.',
};

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(candidate.slice(start, end + 1));
      if (obj && typeof obj === "object") return obj as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  // Accept relative (0..1) AND absolute pixel coordinates — resolveAndAct
  // normalizes pixels via the screenshot dimensions right after parsing.
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toPoint(o: unknown): ClickPoint | null {
  if (typeof o !== "object" || o === null) return null;
  const x = num((o as { x?: unknown }).x);
  const y = num((o as { y?: unknown }).y);
  return x !== null && y !== null ? { x, y } : null;
}

/** Parse the model's answer into concrete coordinates; null if unusable. */
export function parseClickReply(text: string, mode: ClickMode): ResolvedClick | null {
  const obj = extractJsonObject(text);
  if (obj && obj.error) throw new Error(String(obj.error));
  if (!obj) return null;

  if (mode === "drag") {
    const x1 = num(obj.x1);
    const y1 = num(obj.y1);
    const x2 = num(obj.x2);
    const y2 = num(obj.y2);
    if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
      return { kind: mode, points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], drag: { x1, y1, x2, y2 }, raw: text };
    }
    return null;
  }

  if (mode === "grid") {
    if (Array.isArray(obj.points)) {
      const points = obj.points.map(toPoint).filter((p): p is ClickPoint => p !== null);
      if (points.length > 0) return { kind: mode, points, raw: text };
    }
    if (Array.isArray(obj)) {
      const points = obj.map(toPoint).filter((p): p is ClickPoint => p !== null);
      if (points.length > 0) return { kind: mode, points, raw: text };
    }
    return null;
  }

  // click
  const p = toPoint(obj);
  if (p) return { kind: mode, points: [p], raw: text };
  return null;
}

export interface AIClickResult {
  reply: string;
  points: ClickPoint[];
  raw: string;
}

/** Normalize pixel coordinates (Gemini often returns pixels, not 0..1)
 *  using the downscaled screenshot dimensions returned by /api/screenshot. */
function normalizePoints(points: ClickPoint[], width: number, height: number): ClickPoint[] {
  if (!width || !height) return points;
  return points.map((p) => ({
    x: p.x > 1 ? p.x / (width - 1) : p.x,
    y: p.y > 1 ? p.y / (height - 1) : p.y,
  }));
}

/** Capture screen → ask vision → execute the click(s). */
export async function resolveAndAct(
  prompt: string,
  mode: ClickMode,
  baseUrl: string,
): Promise<AIClickResult> {
  const shotRes = await fetch(`${baseUrl}/api/screenshot`, { signal: AbortSignal.timeout(30_000) });
  const shot = (await shotRes.json().catch(() => null)) as
    | { b64?: string; mime?: string; error?: string; width?: number; height?: number }
    | null;
  if (!shotRes.ok || !shot?.b64) {
    throw new Error(`не удалось сделать скриншот: ${shot?.error ?? shotRes.status}`);
  }

  const userText = `${prompt}\n\n${MODE_INSTRUCTIONS[mode]}`;
  const llmRes = await fetch(`${baseUrl}/api/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "gemini",
      temperature: 0,
      maxTokens: 1024,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText.slice(0, 1500) },
            { type: "image", mimeType: shot.mime ?? "image/jpeg", data: shot.b64 },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const data = (await llmRes.json().catch(() => null)) as { content?: string; error?: string } | null;
  if (!llmRes.ok || !data?.content) {
    throw new Error(`vision не ответил: ${data?.error ?? llmRes.status}`);
  }

  const resolved = parseClickReply(data.content, mode);
  if (!resolved) {
    throw new Error(`модель не дала координаты: ${data.content.slice(0, 160)}`);
  }

  resolved.points = normalizePoints(resolved.points, shot.width ?? 0, shot.height ?? 0);
  if (resolved.drag) {
    const norm = normalizePoints([{ x: resolved.drag.x1, y: resolved.drag.y1 }], shot.width ?? 0, shot.height ?? 0);
    const normEnd = normalizePoints([{ x: resolved.drag.x2, y: resolved.drag.y2 }], shot.width ?? 0, shot.height ?? 0);
    resolved.drag = { x1: norm[0].x, y1: norm[0].y, x2: normEnd[0].x, y2: normEnd[0].y };
  }

  if (mode === "drag" && resolved.drag) {
    await dragTo(resolved.drag.x1, resolved.drag.y1, resolved.drag.x2, resolved.drag.y2);
    return {
      reply: `Перетащил с (${resolved.drag.x1.toFixed(3)}, ${resolved.drag.y1.toFixed(3)}) на (${resolved.drag.x2.toFixed(3)}, ${resolved.drag.y2.toFixed(3)}).`,
      points: resolved.points,
      raw: resolved.raw,
    };
  }

  for (const p of resolved.points) {
    await clickAt(p.x, p.y, "single");
    await new Promise((r) => setTimeout(r, 600));
  }
  const n = resolved.points.length;
  return {
    reply:
      n === 1
        ? `Кликнул в (${resolved.points[0].x.toFixed(3)}, ${resolved.points[0].y.toFixed(3)}).`
        : `Кликнул в ${n} точек: ${resolved.points.map((p) => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`).join(", ")}.`,
    points: resolved.points,
    raw: resolved.raw,
  };
}
