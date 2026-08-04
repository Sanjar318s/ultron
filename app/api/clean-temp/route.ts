import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { runCleanup } from "@/lib/tempCleanup";

/**
 * Best-effort temp cleanup (LOCALHOST-only). Cleans %TEMP% + C:\Windows\Temp,
 * skipping locked/in-use files instead of failing. Returns a structured result
 * so callers can render a positive report. Accepts `{ sandbox: "C:\\…" }` to
 * clean an arbitrary path instead (used by the self-test — never the real TEMP).
 */

const WINDOWS_TEMP = "C:\\Windows\\Temp";

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "expected JSON body" }, { status: 400 });
  const sandbox = typeof body.sandbox === "string" && body.sandbox ? body.sandbox : null;

  let paths: string[];
  if (sandbox) {
    if (!path.isAbsolute(sandbox)) return NextResponse.json({ error: "sandbox must be absolute" }, { status: 400 });
    paths = [sandbox];
  } else {
    paths = [process.env.TEMP ?? process.env.TMP ?? "", WINDOWS_TEMP].filter((p) => p);
  }
  if (paths.length === 0) return NextResponse.json({ error: "no temp path" }, { status: 500 });

  const result = await runCleanup(paths);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
