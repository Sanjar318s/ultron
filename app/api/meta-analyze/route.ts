import { NextRequest, NextResponse } from "next/server";
import { metaEngine } from "@/lib/metaLearning";
import { loadBrain } from "@/lib/brainStore";
import { completeCloud } from "@/lib/serverLLM";
import type { AssistantAction } from "@/lib/assistantBrain";

/**
 * Meta-learning analysis endpoint (LOCALHOST-only). The browser sends
 * interaction data after LLM responses, and the server runs the full
 * meta-analysis pipeline: compare → generate → test → promote → notify.
 */

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

// Wire up the owner notifier: send Telegram messages when algorithms are promoted/deprecated.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID; // numeric chat id of the owner

if (TELEGRAM_BOT_TOKEN && OWNER_CHAT_ID) {
  metaEngine.setOwnerNotifier(async (msg) => {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text: msg, parse_mode: "HTML" }),
        }
      );
      if (!res.ok) console.warn("[meta-analyze] Telegram notify failed:", await res.text());
    } catch (e) {
      console.warn("[meta-analyze] Telegram notify error:", e);
    }
  });
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  const brainReply = typeof body?.brainReply === "string" ? body.brainReply : "";
  const brainHandled = body?.brainHandled === true;
  const llmReply = typeof body?.llmReply === "string" ? body.llmReply : "";
  const llmAction = (body?.llmAction as AssistantAction) ?? null;
  const brainAction = (body?.brainAction as AssistantAction) ?? null;

  if (!query) {
    return NextResponse.json({ error: "missing query" }, { status: 400 });
  }

  try {
    const brain = await loadBrain();

    const llmComplete = async (msgs: { role: string; content: string }[]): Promise<string> => {
      const result = await completeCloud(msgs as Parameters<typeof completeCloud>[0], {});
      return result;
    };

    // If no llmReply provided (brain-handled query), actually call LLM for comparison.
    let effectiveLlmReply = llmReply;
    if (!effectiveLlmReply && query) {
      try {
        effectiveLlmReply = await llmComplete([
          { role: "system", content: "Ты — ассистент. Ответь на вопрос кратко и точно." },
          { role: "user", content: query },
        ]);
      } catch { /* LLM unavailable, skip */ }
    }

    await metaEngine.analyzeInteraction(
      query,
      brainHandled ? { handled: true, reply: brainReply, action: brainAction ?? undefined } : null,
      effectiveLlmReply || brainReply,
      llmAction,
      llmComplete,
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[meta-analyze] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** GET: list all meta-algorithms (for /algorithms command). */
export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { readMetaStore } = await import("@/lib/metaLearning");
  const store = await readMetaStore();
  return NextResponse.json(store);
}

/** PATCH: update algorithm status (activate/deactivate). */
export async function PATCH(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { id?: string; status?: string } | null;
  if (!body?.id || !body?.status) {
    return NextResponse.json({ error: "missing id or status" }, { status: 400 });
  }

  try {
    const { readMetaStore } = await import("@/lib/metaLearning");
    const store = await readMetaStore();
    const algo = store.algorithms.find(a => a.id === body.id);
    if (!algo) return NextResponse.json({ error: "not found" }, { status: 404 });

    algo.status = body.status as "active" | "deprecated" | "candidate";
    if (body.status === "active") {
      algo.activatedAt = Date.now();
      algo.consecutiveFailures = 0;
    }

    // Persist via the engine's write queue.
    const { writeMetaStore } = await import("@/lib/metaLearning");
    await writeMetaStore(store);

    return NextResponse.json({ ok: true, algo: { id: algo.id, name: algo.name, status: algo.status } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
