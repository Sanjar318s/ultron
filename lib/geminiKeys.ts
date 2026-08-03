/**
 * Gemini key pool for the Telegram brain.
 *
 * Env: GEMINI_KEYS_POOL (comma-separated). The FIRST TWO keys belong to the
 * owner (rotation: key #1 → key #2 → unlimited local qwen3). The remaining
 * keys form the free pool handed out to Telegram users first-come (one key
 * per user for life). When no GEMINI_KEYS_POOL is set, the owner falls back
 * to GEMINI_API_KEY and the user pool is empty.
 *
 * Durable state lives in data/gemini-keys.json (gitignored): exhaustion
 * timestamps, per-user assignments, restore markers and pending note
 * messages. Free-tier quota resets at midnight Pacific; an exhausted key
 * becomes usable again after that. 429 / RESOURCE_EXHAUSTED calls mark a key
 * exhausted via reportFailure().
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "gemini-keys.json");

export type GeminiKeyState = "ok" | "exhausted" | "restored";

export interface ResolveResult {
  key?: string;
  /** One-shot user-facing message about a quota transition (null usually). */
  note?: string;
  state: GeminiKeyState;
  provider: "gemini" | "local";
}

interface KeyRecord {
  key: string;
  firstUsedAt: number;
  lastUsedAt: number;
  exhaustedAt: number | null;
  restoredAt: number | null;
}

interface UserKeyRecord extends KeyRecord {
  assignedTo: string | null;
}

interface KeyStateFile {
  owner: KeyRecord[];
  users: UserKeyRecord[];
}

let loadedState: KeyStateFile | null = null;

function envPool(): string[] {
  const raw = (process.env.GEMINI_KEYS_POOL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fallback = process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY] : [];
  const keys = raw.length > 0 ? raw : fallback;
  const seen = new Set<string>();
  return keys.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
}

function blankState(): KeyStateFile {
  const pool = envPool();
  const ownerKeys = pool.slice(0, 2);
  const userPoolKeys = pool.slice(2);
  return {
    owner: ownerKeys.map((key) => ({
      key,
      firstUsedAt: 0,
      lastUsedAt: 0,
      exhaustedAt: null,
      restoredAt: null,
    })),
    users: userPoolKeys.map((key) => ({
      key,
      assignedTo: null,
      firstUsedAt: 0,
      lastUsedAt: 0,
      exhaustedAt: null,
      restoredAt: null,
    })),
  };
}

async function loadState(): Promise<KeyStateFile> {
  if (loadedState) return loadedState;
  let saved: Partial<KeyStateFile> = {};
  try {
    saved = JSON.parse(await fs.readFile(STATE_FILE, "utf8")) as Partial<KeyStateFile>;
  } catch {
    // first run — build from env
  }
  const fresh = blankState();
  const mergeOwner = (rec: KeyRecord) => {
    const prev = (saved.owner ?? []).find((r) => r.key === rec.key);
    if (!prev) return rec;
    return {
      ...rec,
      firstUsedAt: prev.firstUsedAt ?? 0,
      lastUsedAt: prev.lastUsedAt ?? 0,
      exhaustedAt: prev.exhaustedAt ?? null,
      restoredAt: prev.restoredAt ?? null,
    };
  };
  const mergeUser = (rec: UserKeyRecord) => {
    const prev = (saved.users ?? []).find((r) => r.key === rec.key);
    if (!prev) return rec;
    return {
      ...rec,
      assignedTo: prev.assignedTo ?? null,
      firstUsedAt: prev.firstUsedAt ?? 0,
      lastUsedAt: prev.lastUsedAt ?? 0,
      exhaustedAt: prev.exhaustedAt ?? null,
      restoredAt: prev.restoredAt ?? null,
    };
  };
  loadedState = {
    owner: fresh.owner.map(mergeOwner),
    users: fresh.users.map(mergeUser),
  };
  return loadedState;
}

async function saveState(): Promise<void> {
  if (!loadedState) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(loadedState, null, 2), "utf8");
}

/** Pacific local time parts for a timestamp. */
function pacificParts(ms: number): { date: string; time: string } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ms));
  return { date, time };
}

/** First instant (after ms) that is midnight Pacific time. */
function nextPacificMidnight(ms: number): number {
  const base = pacificParts(ms).date;
  const start = new Date(ms).getTime();
  for (let min = 0; min <= 48 * 60; min += 5) {
    const c = start + min * 60_000;
    const p = pacificParts(c);
    if (p.date !== base && p.time.startsWith("00:00")) return c;
  }
  return start + 24 * 60 * 60 * 1000;
}

/** Free-tier quota: exhausted until the first Pacific midnight after exhaustion. */
function isExhausted(rec: KeyRecord, now: number): boolean {
  if (!rec.exhaustedAt) return false;
  if (now >= nextPacificMidnight(rec.exhaustedAt)) {
    rec.exhaustedAt = null;
    rec.restoredAt = now;
    return false;
  }
  return true;
}

/** Pick the best currently-usable key for a chat; emits one-shot notes. */
export async function resolveKey(chatId: string, isOwner: boolean): Promise<ResolveResult> {
  const st = await loadState();
  const now = Date.now();

  if (isOwner) {
    let chosen: KeyRecord | null = null;
    for (const rec of st.owner) {
      if (!isExhausted(rec, now)) {
        chosen = rec;
        break;
      }
    }
    if (!chosen) {
      return {
        state: "exhausted",
        note: "Все ваши Gemini-лимиты исчерпаны — переключаюсь на безлимитный локальный qwen3.",
        provider: "local",
      };
    }
    const notes: string[] = [];
    const first = st.owner[0];
    if (chosen !== first && first.exhaustedAt) notes.push("Подключился ключ №2.");
    if (chosen.restoredAt) notes.push("Ваши Pro-лимиты восстановлены.");
    chosen.lastUsedAt = now;
    await saveState();
    return {
      key: chosen.key,
      note: notes.length > 0 ? notes.join(" ") : undefined,
      state: "ok",
      provider: "gemini",
    };
  }

  let rec = st.users.find((u) => u.assignedTo === chatId);
  if (rec && isExhausted(rec, now)) {
    const free = st.users.find((u) => u.assignedTo === null && !isExhausted(u, now));
    if (free) {
      free.assignedTo = chatId;
      free.firstUsedAt = free.firstUsedAt || now;
      free.lastUsedAt = now;
      await saveState();
      return { key: free.key, note: "Мы заменили ваш лимит.", state: "ok", provider: "gemini" };
    }
    return {
      state: "exhausted",
      note: "Для вас нет свободных ключей — работаю на безлимитном локальном qwen3.",
      provider: "local",
    };
  }
  if (!rec) {
    const free = st.users.find((u) => u.assignedTo === null);
    if (free) {
      free.assignedTo = chatId;
      free.firstUsedAt = now;
      free.lastUsedAt = now;
      await saveState();
      return { key: free.key, state: "ok", provider: "gemini" };
    }
    return {
      state: "exhausted",
      note: "Для вас нет свободных ключей — работаю на безлимитном локальном qwen3.",
      provider: "local",
    };
  }
  const notes: string[] = [];
  if (rec.restoredAt) notes.push("Ваши Pro-лимиты восстановлены.");
  rec.lastUsedAt = now;
  await saveState();
  return {
    key: rec.key,
    note: notes.length > 0 ? notes.join(" ") : undefined,
    state: "ok",
    provider: "gemini",
  };
}

/** Mark a key exhausted after a 429 / RESOURCE_EXHAUSTED response. */
export async function reportFailure(chatId: string, key: string, isOwner: boolean): Promise<void> {
  const st = await loadState();
  const list = isOwner ? st.owner : st.users;
  const rec = list.find((r) => r.key === key);
  if (!rec) return;
  if (!rec.exhaustedAt) rec.exhaustedAt = Date.now();
  await saveState();
}

/** True when the exhausted-key error likely means a quota hit. */
export function isQuotaError(message: string): boolean {
  const m = String(message);
  return /429|RESOURCE_EXHAUSTED|quota|limit|RATE_LIMIT/i.test(m);
}

export interface GeminiStatus {
  owner: Array<{ index: number; active: boolean; exhausted: boolean }>;
  usersFree: number;
  usersExhausted: number;
  usersAssigned: number;
}

/** Compact status for the Telegram «Статус ключей» panel. */
export async function statusSnapshot(): Promise<GeminiStatus> {
  const st = await loadState();
  const now = Date.now();
  return {
    owner: st.owner.map((r, i) => ({
      index: i + 1,
      active: r.key.length > 0,
      exhausted: isExhausted(r, now),
    })),
    usersFree: st.users.filter((u) => u.assignedTo === null).length,
    usersExhausted: st.users.filter((u) => u.assignedTo !== null && isExhausted(u, now)).length,
    usersAssigned: st.users.filter((u) => u.assignedTo !== null).length,
  };
}

/** Reset the in-memory cache (used by tests/restarts). */
export function __resetGeminiKeysCache(): void {
  loadedState = null;
}
