import { AssistantBrain, type AbilityQuery, type AbilityResult } from "./assistantBrain";
import { completeCloud } from "./serverLLM";

/**
 * Server-side capability analysis. Answers a «навыки» / «навык X» /
 * «чего тебе не хватает» / «чему ты научился» query:
 *
 *   - fresh cached analysis → answer immediately;
 *   - stale/missing → ask the LLM to derive capabilities from the brain's
 *     knowledge (see AssistantBrain.buildAbilityAnalysisPrompt), persist the
 *     result and answer. Falls back to the stale cache when the LLM is down.
 */

/**
 * Deterministic safety net: drop every `missing` topic that is already covered
 * by the brain's notes/facts. The LLM is told to do this too, but models
 * occasionally list learned topics as "missing" anyway — this guarantees they
 * never do.
 */
function pruneMissingAgainstKnowledge(brain: AssistantBrain, results: AbilityResult[]): AbilityResult[] {
  const knowledge = brain.noteList
    .flatMap((n) => [n.topic, n.summary, ...n.keyPoints])
    .concat(brain.snapshot().facts)
    .map((s) => s.toLowerCase())
    .join("\n");
  return results.map((a) => {
    const missing = a.missing.filter((m) => {
      const mq = m.toLowerCase();
      if (!mq) return false;
      return !knowledge.includes(mq);
    });
    return { ...a, missing, percent: missing.length === 0 ? 100 : a.percent };
  });
}

export async function answerAbilityQuery(
  brain: AssistantBrain,
  query: AbilityQuery,
  name?: string,
): Promise<string> {
  if (brain.isAbilityAnalysisFresh()) {
    return brain.abilityAnswer(query, name);
  }

  try {
    const content = await completeCloud([
      { role: "system", content: brain.buildAbilityAnalysisPrompt() },
      { role: "user", content: "Проанализируй, какими способностями я обладаю, и что мне не хватает." },
    ]);
    const results = brain.parseAbilityAnalysis(content);
    if (results.length > 0) {
      brain.setAbilityAnalysis(pruneMissingAgainstKnowledge(brain, results));
      return brain.abilityAnswer(query, name);
    }
  } catch (err) {
    console.warn("[ability] llm analysis failed:", err);
  }

  // LLM unreachable or returned nothing usable — stale cache is better than nothing.
  const stale = brain.abilityList;
  if (stale.length > 0) {
    return brain.abilityAnswer(query, name);
  }
  return "Не могу проанализировать способности без связи с моделью. Дайте мне знания («изучи <ссылка>») и попробуйте снова.";
}
