/**
 * Command normalization helpers — pure, dependency-free (no `@/` imports) so
 * both the server launcher and the self-test can use them directly.
 *
 * `splitLaunchChain` turns «открой стим и запусти кс 2» into two sequential
 * launch targets instead of one app named "стим и запусти кс 2". Applied by
 * parseAction and by normalizeLLMAction as a safety net under the LLM.
 *
 * `steamAliasName` maps common spoken names («кс 2», «контра») to the real
 * Steam library title so games are launched via steam://run/<appid> instead of
 * the Windows Start-menu search (which often surfaces the Xbox app).
 */

/** Conjunction + repeated-verb separators that break one phrase into a chain. */
const CHAIN_SEPARATOR =
  /\s+(?:и\s+затем|и\s+потом|затем|потом|после чего|после этого|и\s+при этом|заодно)\s+|\s*[;,]\s*|\s+и\s+(?=запусти|запустить|открой|открыть|включи|включить|поставь|поставить|напиши|написать|откройте|запустите|включите)\s*/i;

const SPOKEN_VERB = /^(?:запусти|запустить|запустите|открой|открыть|откройте|включи|включить|включите|поставь|поставить|напиши|написать|сделай|сделать|загрузи|загрузить)\s+/i;

/**
 * Split a compound launch phrase into individual launch targets.
 * Returns 1..n parts; a single part is returned as-is (no split).
 */
export function splitLaunchChain(appName: string): string[] {
  const raw = String(appName ?? "").trim();
  if (!raw) return [];
  const parts = raw
    .split(CHAIN_SEPARATOR)
    .map((p) => p.trim().replace(SPOKEN_VERB, "").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [raw];
}

/** Whether a launch phrase should be treated as a multi-step chain. */
export function isCompoundCommand(appName: string): boolean {
  return splitLaunchChain(appName).length > 1;
}

/**
 * Map a spoken game name to a canonical Steam library title, so fuzzy matching
 * against the installed library succeeds. Keys are normalized (lowercase, ё→е).
 */
const STEAM_ALIASES: Record<string, string> = {
  "кс": "Counter-Strike 2",
  "кс 2": "Counter-Strike 2",
  "кс2": "Counter-Strike 2",
  "cs": "Counter-Strike 2",
  "cs 2": "Counter-Strike 2",
  "cs2": "Counter-Strike 2",
  "контра": "Counter-Strike 2",
  "контра 2": "Counter-Strike 2",
  "контр страйк": "Counter-Strike 2",
  "контр страйк 2": "Counter-Strike 2",
  "дота": "Dota 2",
  "дота 2": "Dota 2",
  "dota": "Dota 2",
  "dota 2": "Dota 2",
  "майнкрафт": "Minecraft",
  "майнкрафт джава": "Minecraft",
  "minecraft": "Minecraft",
  "гаррис мод": "Garry's Mod",
  "гари мод": "Garry's Mod",
  "gmod": "Garry's Mod",
  "team fortress": "Team Fortress 2",
  "tf2": "Team Fortress 2",
  "героус оф зе сторм": "Dota 2",
};

/** Normalized lowercase key (Cyrillic-aware, ё→е, collapse whitespace). */
export function normKey(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Best canonical Steam title for a spoken name, or null when no alias hits. */
export function steamAliasName(name: string): string | null {
  const key = normKey(name);
  if (!key) return null;
  const direct = STEAM_ALIASES[key];
  if (direct) return direct;
  // Whole-word token match («запусти кс 2» → «кс 2» still in the phrase).
  for (const [alias, title] of Object.entries(STEAM_ALIASES)) {
    const re = new RegExp(`(?:^|[^a-zа-яё0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-zа-яё0-9])`, "i");
    if (re.test(key)) return title;
  }
  return null;
}
