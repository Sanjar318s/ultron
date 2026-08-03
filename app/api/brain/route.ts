import { NextRequest, NextResponse } from "next/server";
import { AssistantBrain, type BrainIdSet, type BrainSnapshot } from "@/lib/assistantBrain";
import { commitBrain, readBrainSnapshot } from "@/lib/brainStore";

/**
 * Durable brain storage (LOCALHOST-only). The assistant's learned rules,
 * facts, notes and screen-recorded skills are persisted to a JSON file on
 * disk so they survive clearing the browser's localStorage. data/brain.json is
 * the single source of truth shared with the Telegram bot.
 *
 * PUT applies the lossless sync protocol (see lib/brainStore.ts): the browser
 * sends its full state plus the base id-set it last observed, and the server
 * merges in only knowledge the browser has never seen — so a stale localStorage
 * copy can never wipe knowledge learned via Telegram (and vice versa), while
 * deliberate forgets are still respected.
 */

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const snapshot = await readBrainSnapshot();
  return NextResponse.json({ brain: snapshot });
}

export async function PUT(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const body = (await req.json()) as { brain?: unknown; base?: BrainIdSet | null };
    const incoming = body.brain as BrainSnapshot | null;
    if (!incoming || incoming.version !== 1) {
      return NextResponse.json({ error: "bad brain" }, { status: 400 });
    }
    const brain = new AssistantBrain();
    brain.hydrate(incoming);
    await commitBrain(brain, body.base ?? null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
