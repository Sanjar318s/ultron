/**
 * Request complexity classifier — decides how many system Gemini keys a task
 * may engage and whether it is a file-creation task at all.
 *
 * Pure heuristic, no LLM call: cheap and deterministic so the tier decision
 * never spends the very quota it is protecting. Heavy signals (file formats,
 * «создай файл», images, long text) raise the score; light signals (greeting,
 * short question) lower it. The score maps to a tier:
 *
 *   tier 0 (easy)   → 2 system keys  (TIER_KEY_COUNTS[0])
 *   tier 1 (medium) → 4 system keys
 *   tier 2 (heavy)  → 6 system keys
 *
 * `isFileTask` marks anything that will produce a file/artifact (skills,
 * documents, images). Only those paths ever touch the system key pool; plain
 * chat keeps using the caller's own (user) key.
 */

export interface Complexity {
  /** 0 = easy, 1 = medium, 2 = heavy. */
  tier: 0 | 1 | 2;
  /** Raw weighted score (unbounded) — useful for logs and future thresholds. */
  score: number;
  /** True when the request clearly produces a file/artifact. */
  isFileTask: boolean;
  /** True when the request is too heavy even for the full system pool. */
  tooHeavy: boolean;
}

/** Raised when the request is beyond what all 6 system keys could deliver. */
export const TOO_HEAVY_SCORE = 40;

/** Each signal carries a weight; a row is scored when ANY of its terms hit. */
const HEAVY: Array<{ w: number; terms: string[] }> = [
  { w: 10, terms: ["pdf", "docx", "xlsx", "pptx", "csv"] },
  { w: 8, terms: ["картинк", "изображен", "рисунк", "фото", "иллюстрац", "иконк", "логотип"] },
  { w: 7, terms: ["график", "диаграмм", "схем", "таблиц"] },
  { w: 7, terms: ["шаблон", "резюме", "отчёт", "документ", "презентац"] },
  { w: 6, terms: ["создай файл", "создать файл", "сделай файл", "сделать файл", "запиши в файл", "сохрани в файл"] },
  { w: 5, terms: ["файл", "скрипт", "программ", "код", "парс", "анализ"] },
  { w: 4, terms: ["сайт", "страниц", "crawl", "scrape", "собери", "найди в интернете"] },
  { w: 3, terms: ["и картинками", "с картинками", "и изображениями", "красивым оформлением", "полноценный", "подробный", "детальный"] },
  { w: 2, terms: ["напиши", "составь", "подготовь", "сгенерируй", "сделай", "создай", "нарисуй"] },
];

/** Length-based heavy signal (long requests usually mean real work). */
const LONG_TEXT = 600;
const LONG_TEXT_WEIGHT = 5;

const LIGHT: Array<{ w: number; terms: string[] }> = [
  { w: 3, terms: ["привет", "здравств", "добрый день", "добрый вечер", "доброе утро", "приветствую", "хай", "hello", "hi"] },
  { w: 2, terms: ["кто ты", "что ты умеешь", "какие навыки", "что ты", "спасибо", "как дела"] },
];

/** Normalized lowercase text (RU/EN, case-insensitive, word-boundary-safe). */
function norm(text: string): string {
  return ` ${String(text).toLowerCase()} `;
}

function hasAny(text: string, terms: string[]): boolean {
  for (const t of terms) {
    if (text.includes(t)) return true;
  }
  return false;
}

export function classifyComplexity(text: string): Complexity {
  const t = norm(text);
  let score = 0;
  for (const s of HEAVY) {
    if (hasAny(t, s.terms)) score += s.w;
  }
  if (text.trim().length > LONG_TEXT) score += LONG_TEXT_WEIGHT;
  for (const s of LIGHT) {
    if (hasAny(t, s.terms)) score -= s.w;
  }
  score = Math.max(score, 0);

  const tier: 0 | 1 | 2 = score >= 16 ? 2 : score >= 8 ? 1 : 0;
  const fileHit =
    hasAny(t, HEAVY[0].terms) ||
    hasAny(t, HEAVY[1].terms) ||
    hasAny(t, HEAVY[2].terms) ||
    hasAny(t, HEAVY[3].terms) ||
    hasAny(t, HEAVY[4].terms) ||
    hasAny(t, ["файл", "скрипт", "программ"]);

  return {
    tier,
    score,
    isFileTask: fileHit,
    tooHeavy: score >= TOO_HEAVY_SCORE,
  };
}
