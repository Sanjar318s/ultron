import { NextRequest, NextResponse } from "next/server";
import { resolveAndAct, type ClickMode } from "@/lib/aiClick";

/**
 * Vision-driven desktop action (LOCALHOST-only). Body: { prompt, mode }.
 * Takes a screenshot, asks Gemini where to click (relative 0..1), and
 * performs the action. This is the engine behind captcha solving and
 * "кликни на …" instructions.
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
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const mode = typeof body?.mode === "string" ? body.mode : "click";
  if (!prompt) {
    return NextResponse.json({ error: "missing prompt" }, { status: 400 });
  }
  if (mode !== "click" && mode !== "grid" && mode !== "drag") {
    return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  }

  const baseUrl = `http://${req.headers.get("host") ?? "localhost:3000"}`;
  try {
    const res = await resolveAndAct(prompt, mode as ClickMode, baseUrl);
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
