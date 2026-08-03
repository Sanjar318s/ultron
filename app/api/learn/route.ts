import { NextRequest, NextResponse } from "next/server";
import { addLesson, pendingLessons, markDistilled, saveLearned } from "@/lib/lessonStore";
import { completeCloud } from "@/lib/serverLLM";
import { resolveKey } from "@/lib/geminiKeys";

export const runtime = "nodejs";

/**
 * "Учёба у Gemini": the browser/voice assistant reports successful Gemini
 * exchanges here; they accumulate in data/gemini-lessons.json. When enough
 * pile up (≥ 4, and at most once per 30 min) the route distills them into
 * reusable facts (fed back into the system prompt) and image-style rules
 * (injected into the image-style SKILL.md body). Localhost-only.
 */

const DISTILL_MIN_PENDING = 4;
const DISTILL_COOLDOWN_MS = 30 * 60_000;

let lastDistillAt = 0;
let distillRunning = false;

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as unknown;
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function maybeDistill(): Promise<void> {
  if (distillRunning) return;
  const now = Date.now();
  if (now - lastDistillAt < DISTILL_COOLDOWN_MS) return;
  const pending = await pendingLessons();
  if (pending.length < DISTILL_MIN_PENDING) return;

  distillRunning = true;
  lastDistillAt = now;
  try {
    const resolved = await resolveKey("", true);
    if (resolved.state !== "ok" || !resolved.key) return;

    const sample = pending.slice(-12);
    const dump = sample
      .map((l, i) => `${i + 1}. ВОПРОС: ${l.query}\n   ОТВЕТ: ${l.reply.slice(0, 800)}`)
      .join("\n\n");
    const prompt = [
      "Ниже — успешные диалоги ассистента (вопрос пользователя + принятый ответ).",
      "Выдели устойчивые, переиспользуемые знания:",
      '- "facts" — короткие факты/предпочтения пользователя (имя, город, техника, привычки), которые стоит помнить всегда (до 4, каждый ≤ 120 символов).',
      '- "styles" — стилевые правила для генерации картинок (только если диалог касался изображений/стилей; иначе пустой массив; до 4, каждый ≤ 160 символов).',
      "Верни СТРОГО один JSON: {\"facts\":[],\"styles\":[]}.",
      "DIАЛОГИ:\n" + dump,
    ].join("\n");
    const raw = await completeCloud(
      [
        { role: "system", content: "Ты — учитель-дистиллятор знаний. Отвечай только JSON." },
        { role: "user", content: prompt },
      ],
      { geminiKey: resolved.key },
    );
    const parsed = parseJsonObject(raw);
    if (!parsed) return;
    const facts = Array.isArray(parsed.facts) ? (parsed.facts as string[]).filter((s) => typeof s === "string") : [];
    const styles = Array.isArray(parsed.styles) ? (parsed.styles as string[]).filter((s) => typeof s === "string") : [];
    await saveLearned(facts, styles);
    await markDistilled(sample.map((l) => l.id));
  } catch (err) {
    console.warn("[learn] distill failed:", err);
  } finally {
    distillRunning = false;
  }
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const query = typeof body?.query === "string" ? body.query : "";
  const reply = typeof body?.reply === "string" ? body.reply : "";
  if (!query) return NextResponse.json({ error: "missing query" }, { status: 400 });

  const count = await addLesson(query, reply);
  void maybeDistill();
  return NextResponse.json({ ok: true, total: count });
}

export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const pending = await pendingLessons();
  return NextResponse.json({ pending: pending.length });
}
