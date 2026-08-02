/**
 * Prompt sanitizer — hides "restricted" RU vocabulary from the LLM so it can
 * build a high-quality English image prompt without refusing, then re-injects
 * the hidden concepts as English tags at the LOCAL image generator tier.
 *
 * The LLM sees only `visible` (and sanitized history) — it never refuses and
 * the base prompt keeps its quality. The brain then appends the collected
 * EN tags to the ComfyUI prompt via composeFullPrompt(). Tags never go to
 * the Gemini/Pollinations tiers (they moderate and would refuse).
 *
 * History is sanitized too, and tags accumulate across recent turns, so a
 * follow-up («сделай прозрачнее») keeps the hidden context of the session.
 */

export interface SanitizeResult {
  /** Text safe to show the LLM (restricted RU phrases removed). */
  visible: string;
  /** English tags to re-inject into the local generator prompt. */
  tags: string[];
}

/** Concept map: RU word-forms → English SDXL tag(s). Ordered by intent. */
const RULE_TAGS: Array<{ ru: string[]; en: string }> = [
  { ru: ["голая", "голую", "голый", "голым", "голой", "голые", "голыми", "голых", "обнажённая", "обнажённый", "обнажённую", "обнаженн"], en: "nude, naked" },
  { ru: ["сиськи", "сиську", "сиську", "сисек", "грудь", "груди", "грудью", "грудями"], en: "breasts, big breasts" },
  { ru: ["жопа", "жопу", "жопы", "жопой", "жопе", "попа", "попку", "попы", "попкой", "зад", "задом", "ягодиц"], en: "buttocks, round ass" },
  { ru: ["раком"], en: "from behind, doggystyle" },
  { ru: ["трахнуть", "трахаться", "трахается", "трахает", "трахни", "секс", "секса", "сексе", "сексуальный", "сексуальную", "сексуальной", "сексуальное", "сексуальные"], en: "sexual, sex scene" },
  { ru: ["минет", "отсос"], en: "oral sex" },
  { ru: ["член", "члена", "членом", "пенис", "хуй", "хуя", "хер"], en: "penis, erect penis" },
  { ru: ["пизда", "пизду", "вагина", "вагину", "киска", "киску", "киски", "киской"], en: "vagina, shaved pussy" },
  { ru: ["анал", "анальный", "анальную", "анально"], en: "anal" },
  { ru: ["эротичн"], en: "erotic" },
  { ru: ["лизать", "лижет", "лизни", "облизывать", "облизывает"], en: "licking" },
  { ru: ["сперма", "кончить", "кончает"], en: "cum, cumshot" },
  { ru: ["порно", "порнуха", "порнографич"], en: "porn, pornstar" },
  { ru: ["прелюдия", "предварительные"], en: "foreplay" },
  { ru: ["взрослая", "взрослый"], en: "mature, adult" },
];

/** Whole-word match for Cyrillic (JS \b is ASCII-only, so build manually). */
function wordRe(words: string[]): RegExp {
  return new RegExp(`(^|[^\\p{L}])(${words.join("|")})(?=$|[^\\p{L}])`, "giu");
}

/** Strip restricted RU phrases from `raw`, collecting their EN tags. */
export function sanitize(raw: string): SanitizeResult {
  let visible = raw.replace(/\s+/g, " ").trim();
  const tags: string[] = [];
  for (const rule of RULE_TAGS) {
    const replaced = visible.replace(wordRe(rule.ru), "$1");
    if (replaced !== visible) {
      visible = replaced.replace(/\s{2,}/g, " ");
      if (rule.en && !tags.includes(rule.en)) tags.push(rule.en);
    }
  }
  return { visible: visible.trim(), tags };
}

/** Sanitize a batch of messages, accumulating tags across all of them. */
export function sanitizeTexts(raws: string[]): { visibles: string[]; tags: string[] } {
  const tags: string[] = [];
  const visibles = raws.map((r) => {
    const s = sanitize(r);
    for (const t of s.tags) if (!tags.includes(t)) tags.push(t);
    return s.visible;
  });
  return { visibles, tags };
}

/** Append hidden EN tags to the LLM-built prompt for the local generator. */
export function composeFullPrompt(base: string, tags: string[]): string {
  const clean = base.trim().replace(/,\s*$/, "");
  if (tags.length === 0) return clean;
  return `${clean}, ${tags.join(", ")}`;
}
