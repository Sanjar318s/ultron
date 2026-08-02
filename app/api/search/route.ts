import { NextRequest, NextResponse } from "next/server";
import { completeCloudWithSearch } from "@/lib/serverLLM";

/**
 * Web search (LOCALHOST-only). «найди X» / «изучи <тема>» call this to get a
 * grounded answer + source URLs. Uses Gemini's Grounding with Google Search
 * (GEMINI_SEARCH_MODEL, default gemini-3.6-flash), then a keyless Wikipedia
 * fallback (RU → EN), then best-available model knowledge. No browser
 * scraping.
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
  const q = req.nextUrl.searchParams.get("q");
  if (!q || !q.trim()) {
    return NextResponse.json({ error: "bad query" }, { status: 400 });
  }
  try {
    const { answer, sources } = await completeCloudWithSearch(q.trim());
    return NextResponse.json({ answer, sources });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[search] failed:", message);
    return NextResponse.json({ error: "search failed" }, { status: 502 });
  }
}
