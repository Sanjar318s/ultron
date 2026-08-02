import { NextRequest, NextResponse } from "next/server";
import { generateImage } from "@/lib/generateImage";

/**
 * Image generation (LOCALHOST-only). Primary model is Gemini's image model;
 * when its free quota is exhausted the keyless Pollinations.ai fallback
 * kicks in, so image requests keep working without billing. Thin wrapper
 * around lib/generateImage; the API key is read server-side and never reaches
 * the browser.
 */

export const runtime = "nodejs";

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "missing prompt" }, { status: 400 });
  }
  try {
    const image = await generateImage(prompt);
    return NextResponse.json(image);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
