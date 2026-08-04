/**
 * Shared site resolution helpers. Pure and dependency-free so both the client
 * brain (assistantBrain.ts) and the server launcher (launcher.ts) can resolve
 * a spoken site name to a URL without duplicating the alias table.
 */

/** Common site aliases so «открой ютуб» opens the right page in the browser. */
export const SITE_ALIASES: Record<string, string> = {
  "ютуб": "https://www.youtube.com",
  "ютьюб": "https://www.youtube.com",
  youtube: "https://www.youtube.com",
  "гугл": "https://www.google.com",
  google: "https://www.google.com",
  вк: "https://vk.com",
  вконтакте: "https://vk.com",
  телеграм: "https://web.telegram.org",
  телеграмм: "https://web.telegram.org",
  telegram: "https://web.telegram.org",
  инстаграм: "https://www.instagram.com",
  инстаграмм: "https://www.instagram.com",
  инста: "https://www.instagram.com",
  instagram: "https://www.instagram.com",
  твиттер: "https://x.com",
  twitter: "https://x.com",
  википедия: "https://ru.wikipedia.org",
  wikipedia: "https://ru.wikipedia.org",
  яндекс: "https://ya.ru",
  yandex: "https://ya.ru",
  "яндекс музыка": "https://music.yandex.ru",
  "яндексмузыка": "https://music.yandex.ru",
  "музыка": "https://music.yandex.ru",
  "музыку": "https://music.yandex.ru",
  "музыки": "https://music.yandex.ru",
  "музыка яндекс": "https://music.yandex.ru",
  почта: "https://mail.google.com",
  gmail: "https://mail.google.com",
  авито: "https://www.avito.ru",
  avito: "https://www.avito.ru",
  озон: "https://www.ozon.ru",
  ozon: "https://www.ozon.ru",
  валдберис: "https://www.wildberries.ru",
  вайлдберриз: "https://www.wildberries.ru",
  wildberries: "https://www.wildberries.ru",
};

function toKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `word` appears in `key` as a standalone token (Cyrillic-aware). */
function hasWordToken(key: string, word: string): boolean {
  if (!word) return false;
  const re = new RegExp(`(?:^|[^a-zа-яё0-9])${escapeRe(word)}(?:$|[^a-zа-яё0-9])`, "i");
  return re.test(key);
}

/** Turn a spoken site name into a URL, or null if it isn't clearly a site. */
export function resolveSite(raw: string): string | null {
  const q = toKey(raw);
  if (!q) return null;
  const known = SITE_ALIASES[q];
  if (known) return known;
  if (q.startsWith("http")) return q;
  if (/^(www\.|[a-z0-9-]+(\.[a-z0-9-]+)+)/.test(q)) return `https://${q}`;
  return null;
}

/**
 * Find a known site alias anywhere in a phrase (whole-word). This is what makes
 * «ютуб через браузер на пк» resolve to YouTube even before the allowlist/LLM
 * mangles the target. Returns null when no alias is present.
 */
export function findSiteInPhrase(raw: string): string | null {
  const q = toKey(raw);
  if (!q) return null;
  const exact = SITE_ALIASES[q];
  if (exact) return exact;
  // Stem check FIRST so «яндекс музыку/музыкой/музыке» wins over the generic
  // «яндекс → ya.ru» token (aliases only cover a few inflections).
  if (q.includes("музык")) return "https://music.yandex.ru";
  for (const [alias, url] of Object.entries(SITE_ALIASES)) {
    if (hasWordToken(q, alias)) return url;
  }
  return null;
}

/** Fallback for «открой в браузере <что-то>» — search instead of a site. */
export function siteSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
}
