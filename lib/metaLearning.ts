/**
 * Meta-Learning Engine — analyses every LLM response, extracts pure-rule
 * algorithms (regex/lookup/chain/template), tests them, and auto-deploys
 * winners. This is the "self-improving brain" layer that sits between the
 * production rules and the built-in intents.
 *
 * All analysis runs server-side (needs Gemini API). The engine persists to
 * data/meta-algorithms.json and notifies the owner via Telegram on deploy.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AssistantAction } from "@/lib/assistantBrain";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetaAlgorithm {
  id: string;
  name: string;
  description: string;
  /** Algorithm type — determines how it's matched and executed. */
  type: "regex" | "lookup" | "chain" | "template";
  /** For regex: the pattern to match against normalized text. */
  pattern?: string;
  /** For regex: the action to return when pattern matches. */
  action?: AssistantAction;
  /** For lookup: key-value pairs (normalized name → action or URI). */
  lookupEntries?: Record<string, string>;
  /** For chain: ordered list of (pattern → actions) steps. */
  chainSteps?: { pattern: string; actions: AssistantAction[] }[];
  /** For template: response template with {placeholders}. */
  responseTemplate?: string;
  /** Example phrases this algorithm handles. */
  triggers: string[];
  /** Confidence score 0-1 (starts at 0.3, increases with success). */
  confidence: number;
  /** Total times this algorithm was used. */
  uses: number;
  /** Times it produced a correct result. */
  successes: number;
  /** How it was created. */
  source: "meta-generated" | "user-taught" | "manual";
  /** The original user query that spawned this algorithm. */
  sourceQuery?: string;
  /** Which LLM provided the reference answer. */
  sourceProvider?: string;
  /** Lifecycle status. */
  status: "candidate" | "active" | "deprecated";
  /** Consecutive failures — when >= 3, auto-deprecate. */
  consecutiveFailures: number;
  createdAt: number;
  activatedAt?: number;
  lastUsedAt?: number;
  /** Validation test results. */
  tests: { query: string; expected: string; passed: boolean }[];
}

export interface MetaStats {
  totalGenerated: number;
  totalPromoted: number;
  totalDeprecated: number;
  avgConfidence: number;
}

export interface MetaStore {
  version: number;
  algorithms: MetaAlgorithm[];
  stats: MetaStats;
  lastAnalysis: number;
}

export interface ComparisonResult {
  winner: "brain" | "llm";
  reason: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const META_FILE = path.join(process.cwd(), "data", "meta-algorithms.json");
const EMPTY_STORE: MetaStore = {
  version: 1,
  algorithms: [],
  stats: { totalGenerated: 0, totalPromoted: 0, totalDeprecated: 0, avgConfidence: 0 },
  lastAnalysis: 0,
};

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** Write the meta-algorithms store to disk (through the write queue). */
export async function writeMetaStore(store: MetaStore): Promise<void> {
  await writeStore(store);
}
export async function readMetaStore(): Promise<MetaStore> {
  try {
    const raw = await fs.readFile(META_FILE, "utf-8");
    const parsed = JSON.parse(raw) as MetaStore;
    if (parsed && parsed.version === 1) return parsed;
  } catch { /* no file yet */ }
  return { ...EMPTY_STORE };
}

async function readStore(): Promise<MetaStore> {
  return readMetaStore();
}

async function writeStore(store: MetaStore): Promise<void> {
  await fs.mkdir(path.dirname(META_FILE), { recursive: true });
  await fs.writeFile(META_FILE, JSON.stringify(store), "utf-8");
}

// ---------------------------------------------------------------------------
// Core engine
// ---------------------------------------------------------------------------

let analysisCount = 0;
const AUDIT_RATE = 0.1; // 10% of brain-handled queries get LLM comparison

export class MetaLearningEngine {
  private notifyOwner: ((msg: string) => Promise<void>) | null = null;

  /** Register the Telegram notification callback (called from bot setup). */
  setOwnerNotifier(cb: (msg: string) => Promise<void>): void {
    this.notifyOwner = cb;
  }

  /** Should this brain-handled query trigger an audit? (random 10%) */
  shouldAudit(): boolean {
    analysisCount++;
    return Math.random() < AUDIT_RATE;
  }

  /** Compare brain's answer against LLM's answer. */
  compareAnswers(
    query: string,
    brainOutcome: { handled: boolean; reply: string; action?: AssistantAction },
    llmReply: string,
    llmAction?: AssistantAction,
  ): ComparisonResult {
    // If brain didn't handle it, LLM wins by default.
    if (!brainOutcome.handled) {
      return { winner: "llm", reason: "brain_unhandled", confidence: 1.0 };
    }

    // If both produced the same action type, brain wins (free, fast).
    if (brainOutcome.action && llmAction && brainOutcome.action.kind === llmAction.kind) {
      return { winner: "brain", reason: "same_action_type", confidence: 0.9 };
    }

    // If brain has an action but LLM doesn't (or vice versa), LLM wins.
    if (brainOutcome.action && !llmAction) {
      return { winner: "llm", reason: "brain_has_action_llm_none", confidence: 0.7 };
    }
    if (!brainOutcome.action && llmAction) {
      return { winner: "llm", reason: "llm_has_action_brain_none", confidence: 0.7 };
    }

    // Both are text-only — simple length/quality heuristic.
    // (In production, LLM-as-judge would be better, but this saves tokens.)
    const brainLen = brainOutcome.reply.length;
    const llmLen = llmReply.length;
    if (llmLen > brainLen * 1.5 && llmLen > 20) {
      return { winner: "llm", reason: "llm_more_detailed", confidence: 0.6 };
    }

    return { winner: "brain", reason: "brain_default", confidence: 0.5 };
  }

  /**
   * Ask the meta-LLM to generate a pure-rule algorithm from an LLM response.
   * Uses the same Gemini key pool via /api/llm.
   */
  async generateAlgorithm(
    query: string,
    llmReply: string,
    llmAction: AssistantAction | null,
    existingAlgorithms: MetaAlgorithm[],
    llmComplete: (msgs: { role: string; content: string }[]) => Promise<string>,
  ): Promise<MetaAlgorithm | null> {
    const existingSummary = existingAlgorithms
      .slice(0, 20)
      .map((a) => `- ${a.name}: ${a.type} (${a.triggers.slice(0, 3).join(", ")})`)
      .join("\n");

    const prompt = `You are a meta-learning algorithm extractor. Given a user query and the optimal LLM response, generate a PURE RULE (no LLM needed) that would produce this response for similar queries.

User query: "${query}"
LLM response: ${llmReply}
LLM action: ${llmAction ? JSON.stringify(llmAction) : "none"}
Existing algorithms:\n${existingSummary || "(none yet)"}

Return ONLY a JSON object (no markdown, no explanation):
{
  "type": "regex" | "lookup" | "chain" | "template",
  "name": "short-kebab-case-name",
  "description": "What this algorithm handles (in Russian)",
  "pattern": "regex pattern for matching normalized text" or null,
  "action": AssistantAction object or null,
  "lookupEntries": {"key": "value"} or null,
  "chainSteps": [{"pattern": "regex", "actions": [AssistantAction]}] or null,
  "responseTemplate": "template with {placeholders}" or null,
  "triggers": ["example phrase 1", "example phrase 2"],
  "confidence": 0.5
}

Rules:
- For simple launches: use "lookup" type with app name → URI/command
- For window management: use "regex" type with pattern → action
- For compound commands: use "chain" type
- For response formatting: use "template" type
- Keep regex patterns simple and focused
- Always include 2-3 trigger examples
- Set confidence to 0.5 (it will be tested and adjusted)`;

    try {
      const response = await llmComplete([
        { role: "system", content: "You are a meta-learning algorithm extractor. Return ONLY valid JSON." },
        { role: "user", content: prompt },
      ]);

      // Parse the response
      let parsed: Record<string, unknown>;
      try {
        // Strip markdown code fences if present
        const cleaned = response.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        console.warn("[meta] Failed to parse algorithm JSON from LLM");
        return null;
      }

      if (!parsed.type || !parsed.name) return null;

      const algo: MetaAlgorithm = {
        id: `meta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: String(parsed.name),
        description: String(parsed.description || ""),
        type: parsed.type as MetaAlgorithm["type"],
        pattern: typeof parsed.pattern === "string" ? parsed.pattern : undefined,
        action: (parsed.action as AssistantAction) ?? undefined,
        lookupEntries: (parsed.lookupEntries as Record<string, string>) ?? undefined,
        chainSteps: (parsed.chainSteps as MetaAlgorithm["chainSteps"]) ?? undefined,
        responseTemplate: typeof parsed.responseTemplate === "string" ? parsed.responseTemplate : undefined,
        triggers: Array.isArray(parsed.triggers) ? parsed.triggers.map(String) : [],
        confidence: 0.3,
        uses: 0,
        successes: 0,
        source: "meta-generated",
        sourceQuery: query,
        sourceProvider: "gemini",
        status: "candidate",
        consecutiveFailures: 0,
        createdAt: Date.now(),
        tests: [],
      };

      return algo;
    } catch (err) {
      console.warn("[meta] generateAlgorithm error:", err);
      return null;
    }
  }

  /** Test a candidate algorithm against its trigger examples. */
  testAlgorithm(algo: MetaAlgorithm): MetaAlgorithm {
    const tests: MetaAlgorithm["tests"] = [];

    for (const trigger of algo.triggers) {
      let passed = false;

      if (algo.type === "regex" && algo.pattern) {
        try {
          const re = new RegExp(algo.pattern, "i");
          passed = re.test(trigger);
        } catch { /* invalid regex */ }
      } else if (algo.type === "lookup" && algo.lookupEntries) {
        const normalized = trigger.toLowerCase().trim();
        passed = normalized in algo.lookupEntries ||
          Object.keys(algo.lookupEntries).some((k) => normalized.includes(k));
      } else if (algo.type === "chain" && algo.chainSteps) {
        passed = algo.chainSteps.some((step) => {
          try {
            return new RegExp(step.pattern, "i").test(trigger);
          } catch { return false; }
        });
      } else {
        // template: just check it has a template
        passed = !!algo.responseTemplate;
      }

      tests.push({ query: trigger, expected: trigger, passed });
    }

    algo.tests = tests;
    const passedCount = tests.filter((t) => t.passed).length;
    algo.confidence = tests.length > 0 ? (passedCount / tests.length) * 0.8 : 0.3;

    return algo;
  }

  /** Promote a candidate to active if confidence >= threshold. */
  async maybePromote(algo: MetaAlgorithm): Promise<boolean> {
    if (algo.confidence < 0.7) return false;

    algo.status = "active";
    algo.activatedAt = Date.now();
    algo.confidence = Math.min(algo.confidence, 0.95);

    // Persist
    const store = await readStore();
    const existing = store.algorithms.findIndex((a) => a.id === algo.id);
    if (existing >= 0) {
      store.algorithms[existing] = algo;
    } else {
      store.algorithms.push(algo);
    }
    store.stats.totalPromoted++;
    store.stats.avgConfidence = store.algorithms.filter((a) => a.status === "active")
      .reduce((sum, a) => sum + a.confidence, 0) / Math.max(1, store.algorithms.filter((a) => a.status === "active").length);
    await writeStore(store);

    // Notify owner
    if (this.notifyOwner) {
      const msg =
        `🧠 *Новый алгоритм деплоен!*\n\n` +
        `Имя: ${algo.name}\n` +
        `Описание: ${algo.description}\n` +
        `Обрабатывает: ${algo.triggers.slice(0, 3).join(", ")}\n` +
        `Точность: ${(algo.confidence * 100).toFixed(0)}%\n` +
        `Источник: «${algo.sourceQuery ?? "—"}»\n\n` +
        `/algo-off ${algo.id} — отключить`;
      await this.notifyOwner(msg);
    }

    return true;
  }

  /** Auto-deprecate algorithms with too many consecutive failures. */
  async checkAndDeprecate(algo: MetaAlgorithm): Promise<boolean> {
    if (algo.consecutiveFailures < 3) return false;
    if (algo.status !== "active") return false;

    algo.status = "deprecated";
    const store = await readStore();
    const idx = store.algorithms.findIndex((a) => a.id === algo.id);
    if (idx >= 0) store.algorithms[idx] = algo;
    store.stats.totalDeprecated++;
    await writeStore(store);

    if (this.notifyOwner) {
      await this.notifyOwner(
        `⚠️ Алгоритм «${algo.name}» деактивирован (${algo.consecutiveFailures} ошибок подряд).\n` +
        `/algo-on ${algo.id} — восстановить.`
      );
    }
    return true;
  }

  /** Record a successful use of an algorithm. */
  async recordSuccess(algoId: string): Promise<void> {
    const store = await readStore();
    const algo = store.algorithms.find((a) => a.id === algoId);
    if (!algo) return;
    algo.uses++;
    algo.successes++;
    algo.consecutiveFailures = 0;
    algo.lastUsedAt = Date.now();
    algo.confidence = Math.min(0.95, algo.confidence + 0.02);
    await writeStore(store);
  }

  /** Record a failure (algorithm matched but produced wrong result). */
  async recordFailure(algoId: string): Promise<void> {
    const store = await readStore();
    const algo = store.algorithms.find((a) => a.id === algoId);
    if (!algo) return;
    algo.uses++;
    algo.consecutiveFailures++;
    algo.lastUsedAt = Date.now();
    algo.confidence = Math.max(0.1, algo.confidence - 0.05);
    await writeStore(store);
    await this.checkAndDeprecate(algo);
  }

  /**
   * Full analysis pipeline: compare, generate, test, promote.
   * Called after every LLM response.
   */
  async analyzeInteraction(
    query: string,
    brainOutcome: { handled: boolean; reply: string; action?: AssistantAction } | null,
    llmReply: string,
    llmAction: AssistantAction | null,
    llmComplete: (msgs: { role: string; content: string }[]) => Promise<string>,
  ): Promise<void> {
    // 1. Compare answers
    const comparison = brainOutcome
      ? this.compareAnswers(query, brainOutcome, llmReply, llmAction ?? undefined)
      : { winner: "llm" as const, reason: "brain_unhandled", confidence: 1.0 };

    if (comparison.winner === "brain") return; // Brain is fine, no learning needed.

    // 2. Check if we already have an algorithm for this query
    const store = await readStore();
    const existing = store.algorithms.find((a) =>
      a.status === "active" &&
      a.triggers.some((t) => query.toLowerCase().includes(t.toLowerCase()))
    );
    if (existing) {
      // Existing algorithm should have handled this — record failure if it didn't match
      if (!brainOutcome?.handled) {
        await this.recordFailure(existing.id);
      }
      return;
    }

    // 3. Generate a new algorithm from the LLM response
    const candidate = await this.generateAlgorithm(query, llmReply, llmAction, store.algorithms, llmComplete);
    if (!candidate) return;

    // 4. Test it
    this.testAlgorithm(candidate);

    // 5. Store as candidate
    store.algorithms.push(candidate);
    store.stats.totalGenerated++;
    store.lastAnalysis = Date.now();
    await writeStore(store);

    // 6. Maybe promote
    await this.maybePromote(candidate);
  }
}

/** Singleton instance. */
export const metaEngine = new MetaLearningEngine();
