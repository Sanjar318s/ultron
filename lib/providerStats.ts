/**
 * Factual provider statistics: which model actually answered, per day and per
 * chat. Lets /menu report the real fallback source instead of the pool state,
 * and answers «через что ответил?» honestly.
 *
 * Runtime state lives in data/provider-stats.json (gitignored, like the rest
 * of /data). Reads/writes are synchronous so a single Next.js process stays
 * consistent without a mutex.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ProviderStats {
  byDate: Record<string, Record<string, number>>;
  last: Record<string, string>;
}

const FILE = path.join(process.cwd(), "data", "provider-stats.json");

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadProviderStats(): ProviderStats {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Partial<ProviderStats>;
    return {
      byDate: raw.byDate && typeof raw.byDate === "object" ? raw.byDate : {},
      last: raw.last && typeof raw.last === "object" ? raw.last : {},
    };
  } catch {
    return { byDate: {}, last: {} };
  }
}

export function saveProviderStats(stats: ProviderStats): void {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(stats, null, 2));
}

/** Record one answered request. Pure merge for testability. */
export function mergeProviderRecord(
  stats: ProviderStats,
  provider: string,
  chatId: string,
  date: string,
): ProviderStats {
  const day = { ...(stats.byDate[date] ?? {}) };
  day[provider] = (day[provider] ?? 0) + 1;
  return {
    byDate: { ...stats.byDate, [date]: day },
    last: { ...stats.last, [chatId]: provider },
  };
}

/** Persist a response provider for a chat. */
export function recordProvider(provider: string, chatId: string): void {
  const stats = mergeProviderRecord(loadProviderStats(), provider, String(chatId ?? "anon"), todayKey());
  saveProviderStats(stats);
}

/** Today's per-provider counts + the last provider per chat. */
export function providerSummary(): { today: Record<string, number>; last: Record<string, string> } {
  const stats = loadProviderStats();
  return {
    today: stats.byDate[todayKey()] ?? {},
    last: stats.last,
  };
}
