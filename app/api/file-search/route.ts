import { NextRequest, NextResponse } from "next/server";
import { searchFiles, openFile, openFolder, googleImagesUrl } from "@/lib/fileSearch";
import { openViaShell } from "@/lib/launcher";

/**
 * File search API (LOCALHOST-only). Searches common user directories for
 * files matching a multilingual query. Returns matches or opens the best
 * result. Falls back to Google Images when nothing is found locally.
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
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, 200) : "";
  const autoOpen = body?.autoOpen !== false; // default true

  if (!query) {
    return NextResponse.json({ error: "missing query" }, { status: 400 });
  }

  try {
    const matches = await searchFiles(query);

    if (matches.length > 0 && autoOpen) {
      // Open the most recent matching file
      const best = matches[0];
      if (best.isDir) {
        await openFolder(best.path);
      } else {
        await openFile(best.path);
      }
      return NextResponse.json({
        ok: true,
        opened: best.name,
        path: best.path,
        total: matches.length,
        matches: matches.slice(0, 10),
      });
    }

    if (matches.length > 0) {
      return NextResponse.json({
        ok: true,
        total: matches.length,
        matches: matches.slice(0, 10),
      });
    }

    // Nothing found locally — return Google Images URL
    const imgUrl = googleImagesUrl(query);
    return NextResponse.json({
      ok: false,
      localMatches: 0,
      fallbackUrl: imgUrl,
      message: `Локально файл «${query}» не найден. Открываю поиск в Google Картинках.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const query = url.searchParams.get("q") ?? "";
  if (!query) {
    return NextResponse.json({ error: "missing ?q=" }, { status: 400 });
  }
  try {
    const matches = await searchFiles(query);
    return NextResponse.json({ matches: matches.slice(0, 20) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
