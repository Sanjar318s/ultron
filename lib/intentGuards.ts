/**
 * Pure intent/guard helpers for the assistant brain. Framework-agnostic, no
 * `@/` imports so scripts/self-test.mjs can unit-test it directly.
 *
 * Every matcher accepts raw OR already-normalized text (norm() is applied
 * defensively and is idempotent).
 *
 * The critical rule behind P1: a bare word like «дата» must NOT trigger the
 * date intent, because «датасет» / «дата сет» would be swallowed before the
 * LLM ever sees the request. Date/time intents require EXPLICIT question
 * phrasing («какое сегодня число», «который час»).
 */

export function norm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function todayRu(): string {
  return new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
}

function nowRu(): string {
  return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Current-date intent: matches ONLY explicit question phrases. A bare «дата»
 * is intentionally ignored so «дай мне пример датасета» isn't answered with
 * today's date. Returns the reply text or null.
 */
export function matchDateIntent(raw: string): string | null {
  const t = norm(raw);
  const dateRe =
    /(?:какое|какая|какой)\s+(?:сегодня\s+)?(?:число|дата|день(?:\s+недели)?)|какое\s+сейчас\s+(?:число|дата)|день\s+недели/iu;
  return dateRe.test(t) ? `Сегодня ${todayRu()}.` : null;
}

/**
 * Current-time intent: explicit phrases only (bare «время» can appear in
 * statements like «в любое время», so it is not a trigger).
 */
export function matchTimeIntent(raw: string): string | null {
  const t = norm(raw);
  const timeRe =
    /(?:который час|сколько (?:сейчас )?(?:времени|время)|какое (?:сейчас )?время|сколько время)/iu;
  return timeRe.test(t) ? `Сейчас ${nowRu()}.` : null;
}

/**
 * Imperative task verbs (morpheme-anchored, Cyrillic-safe via (?!\p{L})).
 */
const TASK_VERB_RE =
  /(?:постро(?:й|ить)|нарису(?:й|ть)|напиш(?:и|ть)|созда(?:й|ть)|сдела(?:й|ть)|вычисл(?:и|ть)|рассчита(?:й|ть)|посчита(?:й|ть)|проанализиру(?:й|ть)|просканиру(?:й|ть)|запиш(?:и|ть)|прочита(?:й|ть)|реш(?:и|ить)|преобразу(?:й|ть)|конвертиру(?:й|ть)|провер(?:ь|ить)|запуст(?:и|ть)|сохран(?:и|ть)|скин(?:ь|уть)|удал(?:и|ить)|покаж(?:и|ать)|перевед(?:и|ти)|отправ(?:ь|ить)|сгенериру(?:й|ть)|сверста(?:й|ть)|подготов(?:ь|ить)|распаку(?:й|ет)|заархивиру(?:й|ть))(?!\p{L})/iu;

/**
 * File/document work keywords. Kept narrow to avoid opening the gate on
 * everyday chat («что такое код», «покажи таблицу умножения»).
 */
const FILE_KEYWORD_RE =
  /(?:^|[^\p{L}])(?:pdf|docx|xlsx|pptx|csv|json|png|jpg|jpeg|txt|zip)(?:$|[^\p{L}])|(?:файл\w*|документ\w*|резюме|таблиц\w*|график\w*|скрипт\w*|отчё?т\w*|архив\w*|скриншот\w*|датасет\w*|эксель|ворд|презентац\w*|расчё?т\w*|анализ\w*)/iu;

/**
 * P2 guard: a run-skill (sandbox executor) may only fire on an EXPLICIT task —
 * either an imperative verb or a file/document keyword. This stops the weak
 * local model from turning «что это значит?» / «это задача» into PC actions.
 */
export function isExplicitTask(raw: string): boolean {
  const t = norm(raw);
  return TASK_VERB_RE.test(t) || FILE_KEYWORD_RE.test(t);
}

/**
 * P4 trigger: factual / statistical / current-event questions that must be
 * answered from a live web search instead of model memory. Conservative on
 * purpose — «сколько будет 2+2» must NOT search. Returns the search query or
 * null.
 */
const FACT_QUERY_RE =
  /(?:сколько\s+(?:людей|человек|население|жителей|умерло|погибло|родилось|жив(?:е|ё)т|было|стало|стоит|зарабатыва\w*)|статистик\w*|курс\s+(?:доллара|рубля|евро|биткоина|валюты|нефти)|цены\s+на|новости|прогноз\s+(?:на|по)|в\s+20\d{2}\s+году|какая\s+сфера\s+в\s+20\d{2}|сейчас\s+(?:происходит|происходят)|актуальн\w*|последн\w*\s+(?:новости|события|данные|сводк\w*))/iu;

export function matchFactQuery(raw: string): string | null {
  const t = norm(raw);
  return FACT_QUERY_RE.test(t) ? t : null;
}

/**
 * P5: compose the final user-facing reply. Long-term memory (learnFromLLM)
 * persists separately to data/brain.json — nothing is appended to chat text.
 * Kept as a named function so the contract is unit-testable.
 */
export function composeFinalReply(reply: string, _learned: number): string {
  return reply;
}
