/**
 * Skill lesson store — cross-run memory for SKILL.md skills.
 *
 * Companion to the sandbox executor: every failure mode execute() detects
 * (blocked command, unverified file claim, stuck loop, done-refusal, exhausted
 * rounds) is recorded as a compact structured lesson. The next run of the same
 * skill injects these lessons into its system prompt, so the executor starts
 * with the mistakes of previous runs instead of repeating them.
 *
 * Deliberately deterministic and LLM-free: lessons are facts, not prose. They
 * live in data/skill-lessons.json (gitignored, like meta-algorithms.json) —
 * the committed skills/<slug>/SKILL.md is never touched.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const LESSONS_FILE = path.join(process.cwd(), "data", "skill-lessons.json");

interface SkillLesson {
  text: string;
  at: number;
}

interface LessonStore {
  version: 1;
  lessons: Record<string, SkillLesson[]>;
}

/** Per-skill cap so old noise never crowds the injected prompt. */
const MAX_LESSONS_PER_SKILL = 12;

let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readStore(): Promise<LessonStore> {
  try {
    const raw = await fs.readFile(LESSONS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as LessonStore;
    if (parsed && parsed.version === 1 && parsed.lessons) return parsed;
  } catch {
    // no file yet — empty store
  }
  return { version: 1, lessons: {} };
}

async function writeStore(store: LessonStore): Promise<void> {
  await fs.mkdir(path.dirname(LESSONS_FILE), { recursive: true });
  await fs.writeFile(LESSONS_FILE, JSON.stringify(store), "utf-8");
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Record one structured lesson for a skill. Fire-and-forget (never blocks the
 * executor's return path); writes serialize through the queue. Identical text
 * is deduplicated; the store is capped at MAX_LESSONS_PER_SKILL, evicting the
 * oldest lessons first.
 */
export function recordLesson(slug: string, text: string): void {
  const clean = String(text ?? "").trim();
  if (!slug || !clean) return;
  const key = norm(clean);
  void enqueue(async () => {
    const store = await readStore();
    const list = store.lessons[slug] ?? [];
    if (list.some((l) => norm(l.text) === key)) return;
    list.push({ text: clean, at: Date.now() });
    if (list.length > MAX_LESSONS_PER_SKILL) list.splice(0, list.length - MAX_LESSONS_PER_SKILL);
    store.lessons[slug] = list;
    await writeStore(store);
  }).catch(() => {});
}

/**
 * Compact lessons block for the executor system prompt; "" when nothing is
 * stored for the skill.
 */
export async function lessonsForPrompt(slug: string): Promise<string> {
  if (!slug) return "";
  const store = await readStore();
  const list = store.lessons[slug];
  if (!list || list.length === 0) return "";
  return `\n\n## Грабли из прошлых запусков\n${list.map((l) => `- ${l.text}`).join("\n")}`;
}

/** Test helpers. */
export async function storedLessons(slug: string): Promise<string[]> {
  const store = await readStore();
  return (store.lessons[slug] ?? []).map((l) => l.text);
}

export async function clearLessons(slug: string): Promise<void> {
  await enqueue(async () => {
    const store = await readStore();
    if (store.lessons[slug]) {
      delete store.lessons[slug];
      await writeStore(store);
    }
  });
}

/** Await the pending write queue (determinism for tests). */
export async function flushSkillLessons(): Promise<void> {
  await writeQueue;
}
