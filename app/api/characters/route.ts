import { NextRequest, NextResponse } from "next/server";
import { listCharacterRefs, registerCharacterRef } from "@/lib/characters";

/**
 * Character-reference registry (LOCALHOST-only).
 *   GET  /api/characters            → list stored character refs
 *   POST /api/characters            → register a manual reference
 *        body: { name, b64, mode?: "style"|"face", aliases?: string[] }
 * The Telegram bot sends photos here when the owner captions them
 * «запомни как <имя>» so future generations can steer by that face.
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
  return NextResponse.json({ refs: await listCharacterRefs() });
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const b64 = typeof body?.b64 === "string" ? body.b64 : "";
  if (!name || !b64) {
    return NextResponse.json({ error: "missing name or b64" }, { status: 400 });
  }
  const mode = body?.mode === "face" ? "face" : "style";
  const aliases = Array.isArray(body?.aliases)
    ? (body.aliases as unknown[]).filter((a): a is string => typeof a === "string").map((a) => a.trim()).filter(Boolean)
    : [];
  try {
    const ref = await registerCharacterRef(name, Buffer.from(b64, "base64"), {
      mode,
      aliases,
      source: "manual",
    });
    return NextResponse.json({ ok: true, file: ref.file, name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
