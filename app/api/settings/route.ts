import { NextRequest, NextResponse } from "next/server";
import {
  MODEL_PRESETS,
  DEFAULT_PRESET,
  getUserPreset,
  setUserPreset,
  type ModelPreset,
} from "@/lib/userSettings";

/**
 * Per-chat model presets (LOCALHOST-only). The Telegram bot reads the current
 * preset to render the ⚡/🧠/🏠 selector and persists a tap. The assistant
 * route reads the same file directly; this endpoint just exposes/sets it.
 */

export const runtime = "nodejs";

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const chatId = req.nextUrl.searchParams.get("chatId") ?? "anon";
  return NextResponse.json({
    preset: getUserPreset(chatId),
    default: DEFAULT_PRESET,
    presets: MODEL_PRESETS,
  });
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const chatId = typeof body?.chatId === "string" ? body.chatId : "anon";
  const preset = setUserPreset(chatId, (body?.preset ?? "") as ModelPreset);
  return NextResponse.json({ preset, chatId });
}
