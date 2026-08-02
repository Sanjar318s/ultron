import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AssistantBrain, type BrainSnapshot } from "@/lib/assistantBrain";

/**
 * Durable brain storage (LOCALHOST-only). The assistant's learned rules,
 * facts, notes and screen-recorded skills are persisted to a JSON file on
 * disk so they survive clearing the browser's localStorage. localStorage
 * remains only a cache; this endpoint is the source of truth.
 *
 * PUT MERGES the incoming brain with what's on disk (union by identity) so a
 * browser with a stale localStorage copy can never wipe knowledge learned via
 * the Telegram bot (and vice versa).
 */

const BRAIN_FILE = path.join(process.cwd(), "data", "brain.json");
const MAX_BYTES = 5 * 1024 * 1024;

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

async function readSnapshot(): Promise<BrainSnapshot | null> {
  try {
    const raw = await fs.readFile(BRAIN_FILE, "utf-8");
    const parsed = JSON.parse(raw) as BrainSnapshot;
    if (parsed && parsed.version === 1) return parsed;
  } catch {
    // No file / corrupt — start empty.
  }
  return null;
}

export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const snapshot = await readSnapshot();
  return NextResponse.json({ brain: snapshot });
}

export async function PUT(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const body = (await req.json()) as { brain?: unknown };
    const incoming = body.brain as BrainSnapshot | null;
    if (!incoming || incoming.version !== 1) {
      return NextResponse.json({ error: "bad brain" }, { status: 400 });
    }

    // Merge on-disk knowledge into the incoming snapshot (union), so neither
    // writer can destroy the other's learned material.
    const existing = await readSnapshot();
    let merged: BrainSnapshot = incoming;
    if (existing) {
      const brain = new AssistantBrain();
      brain.mergeFrom(existing);
      brain.mergeFrom(incoming);
      merged = brain.snapshot();
    }

    const payload = JSON.stringify(merged);
    if (payload.length > MAX_BYTES) {
      return NextResponse.json({ error: "too large" }, { status: 413 });
    }
    await fs.mkdir(path.dirname(BRAIN_FILE), { recursive: true });
    await fs.writeFile(BRAIN_FILE, payload, "utf-8");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
