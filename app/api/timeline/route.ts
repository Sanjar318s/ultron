import { NextRequest, NextResponse } from "next/server";
import { getRecentTimelines } from "@/lib/timeline";

export const runtime = "nodejs";

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

/** Recent per-request phase timelines (diagnostics, LOCALHOST-only). */
export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit")) || 20, 1), 50);
  return NextResponse.json({ timelines: getRecentTimelines(limit) });
}
