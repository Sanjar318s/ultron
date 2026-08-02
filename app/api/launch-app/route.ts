import { NextRequest, NextResponse } from "next/server";
import { launchApp, openViaShell, SAFE_URL } from "@/lib/launcher";

/**
 * Launches local apps and opens URLs in the default browser. The heavy
 * lifting (allowlist, installed-app scan, PowerShell Start-Process) lives in
 * lib/launcher.ts so the do-step endpoint reuses it.
 *
 * Security: raw spoken names are only ever matched, never interpolated into a
 * shell command. The endpoint is LOCALHOST-ONLY — never deploy to a public server.
 */
function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().toLowerCase() : "";
  const url = typeof body?.url === "string" ? body.url.trim() : "";

  if (url) {
    if (!SAFE_URL.test(url) || url.length > 512) {
      return NextResponse.json({ error: "invalid url" }, { status: 400 });
    }
    openViaShell(url);
    return NextResponse.json({ ok: true, opened: url });
  }

  const outcome = await launchApp(name);
  if (!outcome) {
    return NextResponse.json({ error: "unknown app" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, launched: outcome.launched, matched: outcome.matched });
}
