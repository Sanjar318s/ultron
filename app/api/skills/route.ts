import { NextRequest, NextResponse } from "next/server";
import { loadBrain } from "@/lib/brainStore";
import { listCatalog } from "@/lib/skillCatalog";

/**
 * Skills overview (LOCALHOST-only). The Telegram bot's /skills command uses
 * this to render a real list instead of an LLM-generated reply.
 * Returns screen-learned skills + the SKILL.md catalog registry.
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
  const brain = await loadBrain();
  const screen = brain.skillList.map((s) => ({
    name: s.name,
    goal: s.goal,
    steps: s.steps.length,
    uses: s.uses,
  }));
  const catalog = (await listCatalog()).map((s) => ({
    slug: s.slug,
    name: s.name,
    description: s.description,
    safe: s.safe,
  }));
  return NextResponse.json({ screen, catalog });
}
