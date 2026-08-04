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

/** Tail qualifiers that describe HOW a target should run, not what it is.
 *  «запусти кс 2 стим открыт» → «кс 2». Applied repeatedly from the end. */
const TAIL_QUALIFIERS = [
  /\s+(?:стим|steam)\s+(?:уже\s+)?(?:открыт|запущен|включ[её]н)\s*$/i,
  /\s+(?:уже\s+)?(?:открыт|запущен|включ[её]н)\s*$/i,
  /\s+(?:в|через|на)\s+(?:стим|steam|браузер)\s*$/i,
  /\s+из\s+стима\s*$/i,
  /\s+(?:в|через)\s+(?:яндекс\s*музык\p{L}*|музык\p{L}*|спотифай|spotify)\s*$/iu,
];

/**
 * Strip trailing qualifiers from a launch target so the remaining string is a
 * clean app/site/game name. Returns the trimmed name (never empty for a
 * non-empty input — only the qualifier tail is removed).
 */
export function stripLaunchQualifiers(name: string): string {
  let s = String(name ?? "").trim();
  let prev: string;
  do {
    prev = s;
    for (const re of TAIL_QUALIFIERS) s = s.replace(re, "").trim();
  } while (s !== prev);
  return s;
}

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

/**
 * Extract the track/album name from a music phrase. Accepts full commands
 * («поставь песню салам в яндекс музыке» → «салам») and bare noun phrases
 * from split chains («песню салам» → «салам»). Returns null when the phrase
 * is not a music request.
 */
export function musicSearchQuery(phrase: string): string | null {
  const s = String(phrase ?? "").trim();
  if (!s) return null;
  const full = s.match(
    /(?:поставь|включи|поставить|включить|запусти|запустить|найди|найти|покажи)\s+(?:песню|песня|трек|музыку|музыка|композицию|мелодию|альбом)\s+(.+?)\s*(?:в\s+(?:яндекс\s*музык\p{L}*|музык\p{L}*|спотифай|spotify))?$/iu,
  );
  if (full) return full[1].trim();
  const bare = s.match(/^(?:песню|песня|трек|музыку|музыка|композицию|мелодию|альбом)\s+(.+)$/i);
  return bare?.[1]?.trim() ?? null;
}
