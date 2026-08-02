import { NextRequest, NextResponse } from "next/server";

/**
 * Fetch a web page and return its readable text (LOCALHOST-only). Used by the
 * «изучи <url>» flow: the server downloads the page, strips HTML and returns
 * plain text for the LLM to turn into a StudyNote. The browser never talks to
 * arbitrary hosts directly — everything funnels through this proxy.
 */

export const runtime = "nodejs";

const MAX_TEXT = 100_000;
const TIMEOUT_MS = 30_000;

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = req.nextUrl.searchParams.get("url");
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "bad url" }, { status: 400 });
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (Ultron Orb reader)" },
      redirect: "follow",
    });
    if (!res.ok) {
      return NextResponse.json({ error: `HTTP ${res.status}` }, { status: 502 });
    }
    const html = await res.text();
    const title =
      html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim().slice(0, 200) ?? url;
    const text = stripHtml(html).slice(0, MAX_TEXT);
    if (text.length < 40) {
      return NextResponse.json({ error: "empty page" }, { status: 422 });
    }
    return NextResponse.json({ title, text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
