import { NextRequest, NextResponse } from "next/server";
import {
  isHardExhaustion,
  isTransientRateLimit,
  parseRetrySeconds,
  reportFailure,
  reportTransient,
  resolveKey,
} from "@/lib/geminiKeys";

/**
 * Transcribes a short audio clip (Telegram voice/audio) via Gemini
 * (LOCALHOST-only). Accepts `{ mime, data }` where `data` is base64 audio.
 * Voice notes from Telegram are `audio/ogg` and rarely exceed a few hundred KB.
 */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const TRANS_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.1-flash-lite";
const MAX_B64_LEN = 15 * 1024 * 1024;

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const data = typeof body?.data === "string" ? body.data.trim() : "";
  const mime = typeof body?.mime === "string" && body.mime ? body.mime : "audio/ogg";

  if (!data) return NextResponse.json({ error: "empty audio data" }, { status: 400 });
  if (data.length > MAX_B64_LEN) return NextResponse.json({ error: "audio too large" }, { status: 413 });
  if (!/^[A-Za-z0-9+/=]+$/.test(data)) return NextResponse.json({ error: "data is not base64" }, { status: 400 });

  const keyRes = await resolveKey("transcribe", true);
  if (keyRes.provider !== "gemini" || !keyRes.key) {
    return NextResponse.json({ error: keyRes.note ?? "no usable gemini key" }, { status: 503 });
  }

  let res: Response;
  try {
    res = await fetch(`${GEMINI_URL}/${TRANS_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": keyRes.key },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inlineData: { mimeType: mime, data } },
              {
                text: "Распознай речь в этом аудио и верни дословную русскую расшифровку. Верни ТОЛЬКО текст, без пояснений, кавычек и заголовков.",
              },
            ],
          },
        ],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    return NextResponse.json({ error: `gemini request failed: ${(e as Error).message}` }, { status: 502 });
  }

  const payload = (await res.json().catch(() => null)) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  } | null;

  if (!res.ok) {
    const message = payload?.error?.message ?? `HTTP ${res.status}`;
    if (isHardExhaustion(message)) {
      await reportFailure("transcribe", keyRes.key, true);
    } else if (isTransientRateLimit(message)) {
      await reportTransient("transcribe", keyRes.key, true, parseRetrySeconds(message));
    }
    return NextResponse.json({ error: message }, { status: res.status === 429 ? 429 : 502 });
  }

  const text = (payload?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) return NextResponse.json({ error: "empty transcription" }, { status: 422 });

  return NextResponse.json({ text });
}
