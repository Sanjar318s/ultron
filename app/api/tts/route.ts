import { NextRequest, NextResponse } from "next/server";
import { synthesizeSpeech, type EdgeVoiceName, VOICES } from "@/lib/edgeTts";

/**
 * POST /api/tts — Text-to-Speech via Edge TTS (Microsoft).
 * Accepts { text, voice?, rate?, pitch?, volume? } → returns audio/mpeg.
 *
 * Voice names: "ru-RU-DmitryNeural" (male), "ru-RU-SvetlanaNeural" (female).
 * Or use shortcuts: "male" / "female".
 */

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";

  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }
  if (text.length > 10_000) {
    return NextResponse.json({ error: "text too long (max 10000)" }, { status: 400 });
  }

  // Resolve voice: accept shortcuts "male"/"female" or full Edge voice name.
  let voice: EdgeVoiceName = VOICES.male;
  const rawVoice = typeof body?.voice === "string" ? body.voice.trim() : "";
  if (rawVoice === "male" || rawVoice === "ru-RU-DmitryNeural") {
    voice = VOICES.male;
  } else if (rawVoice === "female" || rawVoice === "ru-RU-SvetlanaNeural") {
    voice = VOICES.female;
  } else if (rawVoice) {
    // Accept any valid Edge voice name (for future extensibility).
    voice = rawVoice as EdgeVoiceName;
  }

  const rate = typeof body?.rate === "string" ? body.rate : undefined;
  const pitch = typeof body?.pitch === "string" ? body.pitch : undefined;
  const volume = typeof body?.volume === "string" ? body.volume : undefined;

  try {
    const audioBuf = await synthesizeSpeech(text, { voice, rate, pitch, volume });
    return new NextResponse(new Uint8Array(audioBuf), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=1800",
        "Content-Length": String(audioBuf.length),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[tts] synthesis error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** GET /api/tts — list available voices. */
export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const { listEdgeVoices } = await import("@/lib/edgeTts");
    const allVoices = await listEdgeVoices();
    // Return only Russian voices to keep it small.
    const ru = allVoices.filter(v => v.Locale.startsWith("ru"));
    return NextResponse.json({ voices: ru });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
