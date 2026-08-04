import { NextRequest, NextResponse } from "next/server";
import { loadBrain, commitBrain } from "@/lib/brainStore";
import { listCatalog } from "@/lib/skillCatalog";
import { snapshotIds } from "@/lib/assistantBrain";
import { runSkillById } from "@/lib/skillRunner";
import { completeCloud } from "@/lib/serverLLM";
import { resolveKey } from "@/lib/geminiKeys";

/**
 * Skills (LOCALHOST-only). The Telegram bot's /skills command uses this to
 * render a real list instead of an LLM-generated reply.
 * GET  → screen-learned skills (+id) and the SKILL.md catalog registry.
 * POST → { action: "run", id, chatId?, isOwner? } executes a skill by id
 *        (screen id or `cat:<slug>`).
 */

export const runtime = "nodejs";

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

function baseUrlOf(req: NextRequest): string {
  return `http://${req.headers.get("host") ?? "localhost:3000"}`;
}

export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brain = await loadBrain();
  const screen = brain.skillList.map((s) => ({
    id: s.id,
    name: s.name,
    goal: s.goal,
    steps: s.steps.length,
    stepList: s.steps.map((st) => st.text ?? st.action),
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

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = typeof body?.action === "string" ? body.action : "";
  const id = typeof body?.id === "string" ? body.id : "";
  if ((action !== "run" && action !== "forget") || !id) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }

  const brain = await loadBrain();
  const baseIds = snapshotIds(brain.snapshot());

  if (action === "forget") {
    if (id.startsWith("cat:")) {
      return NextResponse.json({ ok: false, reply: "Каталог-навыки удаляются только с диска." });
    }
    const gone = brain.forgetSkill(id);
    if (!gone) {
      return NextResponse.json({ ok: false, reply: "Навык не найден." });
    }
    await commitBrain(brain, baseIds);
    return NextResponse.json({ ok: true, reply: `Навык «${gone.name}» удалён.` });
  }

  const chatId = typeof body?.chatId === "string" ? body.chatId : "anon";
  const isOwner = body?.isOwner === true;

  // Resolve an LLM for catalog-skill rounds, mirroring the assistant route.
  const gemini = await resolveKey(chatId, isOwner);
  const opts = gemini.provider === "gemini" ? { geminiKey: gemini.key } : { skipGemini: true };

  const res = await runSkillById(brain, id, baseUrlOf(req), {
    chatId,
    complete: (msgs) => completeCloud(msgs as Parameters<typeof completeCloud>[0], opts),
  });

  if (res.needsApproval) {
    // Non-safe catalog skill: the approval flow lives in /api/assistant, so
    // tell the caller to go through a plain request instead of duplicating it.
    return NextResponse.json({
      ok: false,
      reply: `${res.reply} Запустите его обычным сообщением — владельцу придёт запрос на одобрение.`,
    });
  }

  await commitBrain(brain, baseIds);
  return NextResponse.json({ ok: true, reply: res.reply });
}
