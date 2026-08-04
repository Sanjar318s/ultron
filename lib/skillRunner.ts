import type { AssistantBrain } from "./assistantBrain";
import { execute as executeCatalogSkill, listCatalog } from "./skillCatalog";

/**
 * Shared skill runner — executes a skill by its id on behalf of any caller
 * (the Telegram bot's skill cards, the /api/skills route, the assistant).
 *
 * Id conventions:
 *   - screen-learned skill  → its brain id (`sk…`, e.g. `skm5x2a3abc`)
 *   - SKILL.md catalog skill → `cat:<slug>` (e.g. `cat:pdf`)
 *
 * Screen skills run step-by-step through /api/do-step (desktop actions).
 * Catalog skills run through the sandboxed LLM-in-the-loop executor and need
 * a `complete` callback (the caller injects its LLM chain).
 */

export interface RunSkillOptions {
  /** Injected LLM for catalog-skill rounds. Ignored for screen skills. */
  complete: (messages: Array<{ role: "user" | "assistant" | "system"; content: string }>) => Promise<string>;
  chatId: string;
}

export interface RunSkillResult {
  reply: string;
  /** Catalog skill that requires owner approval and was NOT run. */
  needsApproval?: { description: string };
}

export async function runSkillById(
  brain: AssistantBrain,
  id: string,
  baseUrl: string,
  opts: RunSkillOptions,
): Promise<RunSkillResult> {
  if (id.startsWith("cat:")) {
    const slug = id.slice(4);
    const cat = (await listCatalog()).find((s) => s.slug === slug);
    if (!cat) return { reply: `Навык «${slug}» не найден в каталоге.` };
    const res = await executeCatalogSkill(cat, cat.name, { chatId: opts.chatId, complete: opts.complete });
    return {
      reply: res.reply,
      ...(res.needsApproval ? { needsApproval: res.needsApproval } : {}),
    };
  }

  const skill = brain.skillList.find((s) => s.id === id);
  if (!skill || skill.steps.length === 0) return { reply: "Навык не найден." };
  let ran = 0;
  for (const step of skill.steps) {
    ran += 1;
    const res = await fetch(`${baseUrl}/api/do-step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: step.action, params: step.params }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { reply: `Навык «${skill.name}»: шаг ${ran}/${skill.steps.length} не удался — ${body?.error ?? res.status}.` };
    }
  }
  return { reply: `Навык «${skill.name}» выполнен (${ran} шагов).` };
}

/** Screen-skill shortcut (no LLM needed). */
export async function executeSkill(brain: AssistantBrain, skillId: string, baseUrl: string): Promise<string> {
  const res = await runSkillById(brain, skillId, baseUrl, {
    complete: async () => "",
    chatId: "system",
  });
  return res.reply;
}
