/**
 * Note builder — turns raw page text or a video transcript into a StudyNote.
 * Framework-agnostic (works in the browser and on the Node server): callers
 * inject their own LLM via `complete`.
 *
 * For regular pages a single compression pass is enough. For videos the text
 * is split into ~12k-char chunks, each chunk is compressed into a chapter, and
 * a final pass builds the global note — so EVERYTHING said in the video is
 * captured in `chapters` + `fullText`, not just the opening lines.
 */

export interface NoteChapter {
  title: string;
  summary: string;
  /** Offset in the source (seconds) when the transcript carries timestamps. */
  atSec?: number;
}

export interface BuiltNote {
  topic: string;
  summary: string;
  keyPoints: string[];
  chapters?: NoteChapter[];
  /** Full source text (video transcript) for deep recall. */
  fullText?: string;
  source?: string;
}

export interface NoteChatMsg {
  role: "system" | "user";
  content: string;
}

export type CompleteFn = (messages: NoteChatMsg[]) => Promise<string>;

// 8k chars: large enough for a meaningful chapter, small enough that qwen3's
// forced-JSON mode reliably returns {"title","summary"} (12k prompts make it
// fall back to a canned {"status","data"} schema).
const CHUNK_CHARS = 8_000;
const MAX_CHAPTERS = 14;
const MAX_FULL_TEXT = 260_000;

/** Split text into sentence-aware chunks of ~chunkChars characters. */
export function chunkText(text: string, chunkChars = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let rest = text.replace(/\r\n?/g, "\n").trim();
  while (rest.length > chunkChars) {
    let cut = rest.lastIndexOf("\n", chunkChars);
    if (cut < chunkChars * 0.5) cut = rest.lastIndexOf(". ", chunkChars);
    if (cut < chunkChars * 0.5) cut = rest.lastIndexOf(" ", chunkChars);
    if (cut <= 0) cut = chunkChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Pull the first JSON object out of a model reply; tolerate extra text. */
export function extractJson(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (obj && typeof obj === "object") return obj as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim().slice(0, 200))
    : [];
}

/** Deterministic fallback note from page title + first meaningful sentences. */
function fallbackNote(text: string, title: string | undefined, url: string | undefined) {
  const junk = /^(jump to|main menu|navigation|search|wikipedia|contents|current events|random article|help|tools|pages|views|what links|the article|image|from wikipedia)/i;
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 50 && s.length <= 600 && !junk.test(s));
  let topic = (title ?? "").replace(/\s*-\s*Wikipedia$/i, "").trim();
  if (!topic || /^https?:/i.test(topic)) {
    topic = (sentences[0] || "").split(/[.!?]/)[0].slice(0, 100) || (url ?? "").slice(0, 100);
  }
  return {
    topic: topic.slice(0, 100) || (url ?? "").slice(0, 100),
    summary: sentences[0] || text.slice(0, 400),
    keyPoints: sentences.slice(1, 5).map((s) => s.slice(0, 200)),
  };
}

async function chapterFromChunk(complete: CompleteFn, chunk: string, index: number, total: number): Promise<NoteChapter> {
  const system = "Ты — аналитик-резюмёр субтитров. Твой ответ всегда ОДИН валидный JSON-объект и ничего больше — ни пояснений, ни markdown, ни текста до или после.";
  const example =
    'Пример правильного ответа: {"title":"Как работают алгоритмы","summary":"В фрагменте объясняется, как рекомендательные алгоритмы подбирают контент, влияют на покупки и почему они ошибаются."}';
  const base = [
    `Ты — аналитик субтитров видео. Разбери фрагмент ${index + 1} из ${total} и извлеки из НЕГО ВСЁ существенное содержание.`,
    'Это субтитры — перескажи, О ЧЁМ ГОВОРИТСЯ в фрагменте. Даже если это диалог, сценка или шутка — изложи её содержание, не комментируй и не оценивай сам текст.',
    `Ответь СТРОГО одним JSON-объектом без markdown, без пояснений: {"title":"короткое название раздела (3–7 слов)","summary":"сжатый, но полный пересказ фрагмента в 2–4 предложениях — сохрани все ключевые факты, цифры и имена"}`,
    example,
    `Фрагмент субтитров:\n${chunk}`,
  ];
  const attempt = async (stricter: boolean): Promise<{ title: string; summary: string } | null> => {
    const lines = stricter
      ? [...base.slice(0, 1), "НЕЛЬЗЯ: комментировать текст, давать советы, рассуждать о смысле или возвращать что-либо кроме {title, summary}.", ...base.slice(1)]
      : base;
    const raw = await complete([
      { role: "system", content: system },
      { role: "user", content: lines.join("\n\n") },
    ]);
    const parsed = extractJson(raw);
    const title = str(parsed?.title);
    const summary = str(parsed?.summary);
    if (title && summary && summary.length >= 30) return { title, summary };
    return null;
  };
  try {
    let res = await attempt(false);
    if (!res) res = await attempt(true);
    if (!res) res = await attempt(true);
    return {
      title: (res?.title ?? `Часть ${index + 1}`).slice(0, 80),
      summary: res?.summary ?? chunk.slice(0, 400),
    };
  } catch {
    return { title: `Часть ${index + 1}`, summary: chunk.slice(0, 400) };
  }
}

const JSON_NOTE_SYSTEM = "Ты — аналитик-резюмёр. Твой ответ всегда один JSON-объект и ничего больше.";

/**
 * Build a StudyNote-shaped object from raw text. `isVideo` switches to the
 * chunked full-coverage pipeline that stores every part of the content.
 */
export async function buildStudyNote(opts: {
  text: string;
  title?: string;
  url?: string;
  isVideo?: boolean;
  complete: CompleteFn;
}): Promise<BuiltNote> {
  const text = (opts.text ?? "").replace(/\r\n?/g, "\n").trim();

  if (opts.isVideo) {
    const chunks = chunkText(text).slice(0, MAX_CHAPTERS);
    const chapters: NoteChapter[] = [];
    for (let i = 0; i < chunks.length; i++) {
      chapters.push(await chapterFromChunk(opts.complete, chunks[i], i, chunks.length));
    }
    const chaptersText = chapters.map((c, i) => `${i + 1}. ${c.title}\n${c.summary}`).join("\n\n");
    const fallback = {
      topic: (opts.title ?? opts.url ?? "видео").slice(0, 100),
      summary: chapters.map((c) => c.summary).join(" "),
      keyPoints: chapters.map((c) => `${c.title}: ${c.summary}`).slice(0, 8),
    };
    let topic = fallback.topic;
    let summary = fallback.summary;
    let keyPoints: string[] = [];
    try {
      const prompt = [
        "Ты посмотрел видео целиком. Ниже — сжатые пересказы всех его частей:",
        chaptersText,
        "Составь итоговую заметку для личной базы знаний. СЖАТО, но ПОЛНО опиши всё, о чём говорится в видео, покрывая каждый раздел. Не выдумывай того, чего в видео нет.",
        'Ответь СТРОГО одним JSON-объектом без markdown: {"topic":"короткая тема видео (5–8 слов)","summary":"суть ВСЕГО видео в 4–7 предложениях, охватывая каждый раздел","keyPoints":["4–8 ключевых тезисов/фактов из разных частей видео"]}',
      ].join("\n\n");
      const raw = await opts.complete([
        { role: "system", content: JSON_NOTE_SYSTEM },
        { role: "user", content: prompt },
      ]);
      const parsed = extractJson(raw);
      if (parsed) {
        topic = str(parsed.topic, fallback.topic).slice(0, 100);
        summary = str(parsed.summary, fallback.summary);
        keyPoints = strList(parsed.keyPoints);
      }
    } catch {
      // keep fallbacks
    }
    if (keyPoints.length === 0) keyPoints = fallback.keyPoints;
    return {
      topic,
      summary: summary.slice(0, 2000),
      keyPoints: keyPoints.slice(0, 8),
      chapters,
      fullText: text.slice(0, MAX_FULL_TEXT),
      source: opts.url,
    };
  }

  // Regular page: single compression pass.
  const fallback = fallbackNote(text, opts.title, opts.url);
  let topic = fallback.topic;
  let summary = fallback.summary;
  let keyPoints = fallback.keyPoints;
  try {
    const prompt = [
      'Сожми текст в структурированную заметку для личной базы знаний: {"topic":"короткая тема (5–8 слов)","summary":"суть в 3–5 предложениях","keyPoints":["2–5 ключевых тезисов"]}',
      `Заголовок: ${opts.title ?? ""}\nURL: ${opts.url ?? ""}\n\nТекст:\n${text.slice(0, 30_000)}`,
    ].join("\n\n");
    const raw = await opts.complete([
      { role: "system", content: JSON_NOTE_SYSTEM },
      { role: "user", content: prompt },
    ]);
    const parsed = extractJson(raw);
    if (parsed) {
      topic = str(parsed.topic, fallback.topic).slice(0, 100);
      summary = str(parsed.summary, fallback.summary);
      keyPoints = strList(parsed.keyPoints);
    }
  } catch {
    // keep fallbacks
  }
  return { topic, summary, keyPoints: keyPoints.slice(0, 5), source: opts.url };
}
