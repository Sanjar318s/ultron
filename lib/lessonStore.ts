/**
 * Lesson store — accumulates successful Gemini exchanges so the system can
 * "learn from Gemini": batches them, distills reusable facts and image-style
 * rules, and feeds them back into the brain (learned-facts) and the
 * image-style skill (learned-styles). Server-side only.
 *
 * Storage is plain JSON under data/ (gitignored). Distillation itself lives
 * in the /api/learn route, which injects the LLM (`completeCloud`).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const LESSONS_FILE = path.join(DATA_DIR, "gemini-lessons.json");
const FACTS_FILE = path.join(DATA_DIR, "learned-facts.json");
const STYLES_FILE = path.join(DATA_DIR, "learned-styles.json");

export interface Lesson {
  id: string;
  ts: number;
  query: string;
  reply: string;
  distilled?: boolean;
}

const CAP = 500;

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function norm(q: string): string {
  return q.trim().toLowerCase().replace(/[^a-zа-яё0-9\s]/gi, " ").replace(/\s+/g, " ").slice(0, 120);
}

export async function addLesson(query: string, reply: string): Promise<number> {
  if (!query || !reply) return 0;
  const q = query.trim();
  if (q.length < 3 || reply.length < 2) return 0;
  const lessons = await readJson<Lesson[]>(LESSONS_FILE, []);
  const key = norm(q);
  if (key && lessons.some((l) => norm(l.query) === key && !l.distilled)) return lessons.length;
  lessons.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), query: q, reply: reply.slice(0, 3000) });
  if (lessons.length > CAP) lessons.splice(0, lessons.length - CAP);
  await writeJson(LESSONS_FILE, lessons);
  return lessons.length;
}

export async function pendingLessons(): Promise<Lesson[]> {
  const lessons = await readJson<Lesson[]>(LESSONS_FILE, []);
  return lessons.filter((l) => !l.distilled);
}

export async function markDistilled(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const lessons = await readJson<Lesson[]>(LESSONS_FILE, []);
  const idSet = new Set(ids);
  for (const l of lessons) if (idSet.has(l.id)) l.distilled = true;
  await writeJson(LESSONS_FILE, lessons);
}

async function dedupeAppend(file: string, items: string[]): Promise<void> {
  if (!items || items.length === 0) return;
  const existing = await readJson<string[]>(file, []);
  const seen = new Set(existing.map((s) => s.trim().toLowerCase()));
  let changed = false;
  for (const item of items) {
    const t = item.trim();
    if (t && !seen.has(t.toLowerCase())) {
      existing.push(t);
      seen.add(t.toLowerCase());
      changed = true;
    }
  }
  if (changed) await writeJson(file, existing);
}

export async function saveLearned(facts: string[], styles: string[]): Promise<void> {
  await dedupeAppend(FACTS_FILE, facts);
  await dedupeAppend(STYLES_FILE, styles);
}

export async function getLearnedStyles(): Promise<string[]> {
  return readJson<string[]>(STYLES_FILE, []);
}

export async function getLearnedFacts(): Promise<string[]> {
  return readJson<string[]>(FACTS_FILE, []);
}
