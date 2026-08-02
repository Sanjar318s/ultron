import { NextRequest, NextResponse } from "next/server";
import {
  InstalledApp,
  dedupeApps,
  isReasonableApp,
  matchAppScore,
  normForMatch,
  scanInstalledApps,
} from "@/lib/installedApps";

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const q = req.nextUrl.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const apps: InstalledApp[] = dedupeApps((await scanInstalledApps()).filter((a) => isReasonableApp(a.name)));

  if (q) {
    const qn = normForMatch(q);
    const scored = apps
      .map((a) => ({ name: a.name, score: matchAppScore(qn, a.name) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    return NextResponse.json({ count: apps.length, matches: scored });
  }

  return NextResponse.json({
    count: apps.length,
    apps: apps.slice(0, 200).map((a) => a.name),
  });
}
