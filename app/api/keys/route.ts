import { NextRequest, NextResponse } from "next/server";
import { statusSnapshot } from "@/lib/geminiKeys";
import { providerSummary } from "@/lib/providerStats";

/**
 * Gemini key-pool status (LOCALHOST-only). The Telegram bot's «Статус» button
 * renders an owner/user quota panel from this. Also carries the factual
 * per-provider stats so /menu can show which model actually answers.
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
  const status = await statusSnapshot();
  return NextResponse.json({ ...status, providerStats: providerSummary() });
}
