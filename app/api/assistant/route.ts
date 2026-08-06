import { NextRequest, NextResponse } from "next/server";
import {
  extractImagePrompt,
  normalizeLLMAction,
  snapshotIds,
  type AssistantAction,
  type AssistantBrain,
  type LLMLearnItem,
} from "@/lib/assistantBrain";
import { completeCloud, completeCloudMeta, completeWithProvider } from "@/lib/serverLLM";
import {
  isHardExhaustion,
  isTransientRateLimit,
  parseRetrySeconds,
  reportFailure,
  reportTransient,
  resolveKey,
  type ResolveResult,
} from "@/lib/geminiKeys";
import { Timeline } from "@/lib/timeline";
import { getLearnedFacts } from "@/lib/lessonStore";
import {
  execute as executeCatalogSkill,
  fuzzyFind as catalogFuzzyFind,
  listCatalog,
  listForPrompt,
  bestMatch,
} from "@/lib/skillCatalog";
import { commitBrain, loadBrain } from "@/lib/brainStore";
import { metaEngine } from "@/lib/metaLearning";
import { buildStudyNote } from "@/lib/noteBuilder";
import { extractVideoId, fetchVideoTranscript, isYouTubeUrl } from "@/lib/youtube";
import { generateImage } from "@/lib/generateImage";
import { fetchCharacterRefWeb, resolveCharacterRef } from "@/lib/characters";
import { sanitizeTexts } from "@/lib/promptSanitizer";
import {
  initAdmin,
  getSettings,
  isAutonomyOn,
  isAiStopped,
  createPending,
  approvePending,
  rejectPending,
  resolveProjectPath,
  readFileText,
  countRead,
  changesLeft,
  appendAudit,
} from "@/lib/adminOps";
import { answerAbilityQuery } from "@/lib/serverAbility";
import { launchApp, openViaShell, SAFE_URL } from "@/lib/launcher";
import { executeSkill } from "@/lib/skillRunner";
import { getSystemContext } from "@/lib/systemContext";
import { N8N_ACTIONS, buildN8nPayload, n8nActionsPrompt } from "@/lib/n8n/config";
import { triggerN8nWebhook } from "@/lib/n8n/client";
import { startStudy } from "@/lib/studyJobs";
import { fetchPageContent } from "@/lib/pageVision";
import { isExplicitTask, composeFinalReply } from "@/lib/intentGuards";
import { recordProvider } from "@/lib/providerStats";
import { getUserPreset, type ModelPreset } from "@/lib/userSettings";

/**
 * Server-side assistant core (LOCALHOST-only). The Telegram bot POSTs user
 * text here; this route runs the SAME brain + LLM pipeline as the browser,
 * against the durable brain.json on disk (lib/brainStore.ts):
 *
 *   1. load the latest brain from disk
 *   2. brain.process(text) — known rules/intents answer instantly
 *   3. unknown → completeCloud(buildSystemPrompt(query) + text)
 *   4. apply learn / run actions (learn-url, image, launch, run-skill, weather)
 *   5. commit brain.json with the lossless merge (concurrent browser + bot)
 *
 * This keeps the web UI and the Telegram bot on the same knowledge — and lets
 * the bot really execute PC actions, not just echo the intent.
 */

export const runtime = "nodejs";

let adminReady: Promise<void> | null = null;
function ensureAdmin(): Promise<void> {
  adminReady ??= initAdmin();
  return adminReady;
}

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

/** How to call the LLM chain for this request (which Gemini key, if any). */
export type CloudOpts = { geminiKey?: string; skipGemini?: boolean; model?: string; provider?: "gemini" | "ollama"; preset?: ModelPreset };

/** Stronger model for the skill executor loop (flash-lite derails on the JSON contract). */
const EXECUTOR_MODEL = "gemini-3.5-flash";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Retry TRANSIENT 429 rate limits (a per-minute RPM window usually frees up
 * within seconds). A retry only fires when the error carries a parseable
 * server-side wait; a hard daily quota or our own client-side burst guard
 * falls through immediately. `parseRetrySeconds` understands Google's formats
 * («Please retry in 30s», «Please try again in 28m6.528s») so we never do the
 * old blind 7s+15s dead-wait on an unparsed message.
 */
async function with429Retry(fn: () => Promise<string>): Promise<string> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const wait = parseRetrySeconds(msg);
      // Only a SHORT server-side wait is worth sleeping mid-request; a long
      // window (≥30s) means "fall through to the next provider now" — the key
      // gets a cooldown and recovers on its own between requests. A transient
      // 503 «high demand» carries no wait hint, so it gets one short retry.
      if (attempt < 2 && isTransientRateLimit(msg)) {
        const backoff =
          wait !== null && wait <= 20
            ? Math.min(wait * 1000 + 1000, 20_000)
            : /\b503\b|high demand|overloaded/i.test(msg)
              ? 2_000
              : null;
        if (backoff !== null) {
          attempt += 1;
          await sleep(backoff);
          continue;
        }
      }
      throw err;
    }
  }
}

/** Classify a gemini failure and update the key pool accordingly. */
async function reportGeminiFailure(
  chatKey: string,
  key: string,
  isOwner: boolean,
  err: unknown,
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  if (isHardExhaustion(msg)) {
    await reportFailure(chatKey, key, isOwner);
  } else if (isTransientRateLimit(msg)) {
    await reportTransient(chatKey, key, isOwner, parseRetrySeconds(msg));
  }
}

/**
 * Executor factory with pin-once semantics: the skill loop should run on a
 * SINGLE provider end-to-end, or round N (a weak model) silently undoes
 * rounds 1..N-1. Prefer the local unlimited model (ollama / qwen3:14b) for
 * deterministic latency; gemini is the quality fallback (transient 429s set a
 * short cooldown instead of killing the key). If the pinned provider dies
 * mid-run, the pin is cleared so the next provider gets a chance instead of
 * throwing «all providers unavailable» while ollama is still healthy.
 */
function makeExecutorComplete(cloudOpts: CloudOpts, chatKey?: string, isOwner?: boolean, timeline?: Timeline) {
  const failed: Set<string> = new Set();
  let pin: "gemini" | "ollama" | undefined;
  const order: Array<"gemini" | "ollama"> = ["ollama", "gemini"];
  return async (msgs: Parameters<typeof completeCloud>[0]): Promise<string> => {
    for (const p of order) {
      if (pin) {
        if (p !== pin) continue;
      } else if (failed.has(p)) {
        continue;
      }
      timeline?.mark(`executor:${p}:attempt`);
      try {
        const out = await with429Retry(() =>
          completeCloud(msgs, { ...cloudOpts, model: EXECUTOR_MODEL, provider: p }),
        );
        timeline?.mark(`executor:${p}:ok`);
        if (!pin) console.log(`[skill-executor] pinned ${p}`);
        pin = p;
        return out;
      } catch (err) {
        timeline?.mark(`executor:${p}:fail`);
        failed.add(p);
        if (pin === p) pin = undefined;
        if (p === "gemini" && chatKey && cloudOpts.geminiKey) {
          await reportGeminiFailure(chatKey, cloudOpts.geminiKey, !!isOwner, err);
        }
        console.warn(`[skill-executor] ${p} failed, switching:`, err);
      }
    }
    throw new Error("все провайдеры исполнителя недоступны");
  };
}

/** Executor contexts for catalog skills awaiting owner approval (safe:false). */
const skillRunContexts = new Map<string, { slug: string; name: string; chatId: string }>();

/** A file produced by a skill run, ready for the Telegram bot to upload. */
export interface WireFile {
  rel: string;
  name: string;
  size: number;
  mime: string;
}

/** Dispatch a run-skill request: screen-learned skill wins, else SKILL.md catalog. */
async function runSkillDispatch(
  brain: AssistantBrain,
  name: string,
  userText: string,
  baseUrl: string,
  chatKey: string,
  cloudOpts: CloudOpts,
  timeline?: Timeline,
): Promise<{ reply: string; needsApproval?: { id: string; description: string }; files?: WireFile[]; verified?: boolean }> {
  const screen = brain.findSkill(name);
  if (screen) {
    return { reply: await executeSkill(brain, screen.id, baseUrl) };
  }
  // The LLM picks the skill name, but it's weak at choosing (gemini quota /
  // ollama). Resolve against the ORIGINAL user text instead, where the
  // description+aliases overlap is decisive (data vs python).
  const byQuery = await bestMatch(userText || name);
  const cat =
    byQuery.skill && (byQuery.score >= 0.3 || !(await catalogFuzzyFind(name)))
      ? byQuery.skill
      : await catalogFuzzyFind(name);
  if (cat) {
    if (!cat.safe) {
      const info = await createPending("run", { cmd: `skill:${cat.slug}`, chatId: chatKey });
      skillRunContexts.set(info.id, { slug: cat.slug, name: cat.name, chatId: chatKey });
      return {
        reply: `Навык «${cat.name}» требует одобрения владельца.`,
        needsApproval: { id: info.id, description: info.description },
      };
    }
    const res = await executeCatalogSkill(cat, userText || name, {
      chatId: chatKey,
      complete: makeExecutorComplete(cloudOpts, chatKey, undefined, timeline),
    });
    return { reply: res.reply, files: res.artifacts, verified: res.verified };
  }
  return { reply: `Не нашёл навык «${name}». Скажите «какие уроки» — покажу список.` };
}

/** Pull the first JSON object out of a model reply; tolerate extra text. */
function parseJSONObject(content: string): Record<string, unknown> | null {
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

/**
 * Parse JSON from LLM response with one retry on failure. If the first parse
 * fails, asks the LLM to fix formatting and retries once.
 */
async function parseWithRetry(
  content: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  cloudOpts: CloudOpts,
): Promise<Record<string, unknown> | null> {
  const first = parseJSONObject(content);
  if (first) return first;

  // Retry: ask LLM to fix the formatting
  try {
    const retryMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      ...messages,
      { role: "user", content: `Исправь форматирование и верни строго валидный JSON. Вот твой предыдущий ответ:\n${content.slice(0, 2000)}` },
    ];
    const retryResult = await completeCloud(retryMessages, cloudOpts);
    return parseJSONObject(retryResult);
  } catch {
    return null;
  }
}

/** Caption the user wants drawn on the image («с текстом "Привет"» …). */
function extractCaptionText(raw: string): string | undefined {
  const m = raw.match(/(?:с текстом|с надписью|с подписью|надпись|подпись)\s*(?:["«']?)([^»"'»«\n]{1,60})/i);
  return m?.[1]?.trim() || undefined;
}

/**
 * Clamp an LLM-built n8n payload: plain object, at most 20 keys, string values
 * capped at 400 chars. Blocks runaway/injected bodies while keeping numbers.
 */
function sanitizeN8nPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (Object.keys(out).length >= 20) break;
    if (typeof v === "string") out[k] = v.slice(0, 400);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/**
 * Resolve a reference image for the current request: a previously stored
 * character (by name/alias) wins; otherwise, when the LLM named an explicit
 * character/work (`ref`), fetch a reference from Wikimedia automatically.
 */
async function resolveImageReference(
  query: string,
  allowFetch: boolean,
): Promise<{ file: string; mode: "style" | "face" } | null> {
  const q = query.trim();
  if (!q) return null;
  const known = await resolveCharacterRef(q);
  if (known) return { file: known.ref.file, mode: known.ref.mode };
  if (!allowFetch) return null;
  const fetched = await fetchCharacterRefWeb(q).catch(() => null);
  return fetched ? { file: fetched.file, mode: fetched.mode } : null;
}

/** Extra system-prompt block enabling the LLM's autonomous admin mode. */
async function autonomySystemNote(): Promise<string> {
  const settings = await getSettings();
  if (!settings.autonomy || (await isAiStopped())) return "";
  return [
    "",
    "АВТОНОМИЯ: тебе доступны действия администратора в JSON-поле «admin». Форматы:",
    '{"admin":{"action":"read","file":"lib/xxx.ts"}} — прочитать файл (без одобрения; до 4 чтений за цикл).',
    '{"admin":{"action":"write","file":"путь","content":"полное новое содержимое"}} — записать файл (одобрение владельца).',
    '{"admin":{"action":"replace","file":"путь","old":"старый фрагмент","new":"новый фрагмент"}} — заменить фрагмент (одобрение).',
    '{"admin":{"action":"run","cmd":"команда"}} — выполнить команду в корне проекта (одобрение).',
    '{"admin":{"action":"build"}} — собрать проект (одобрение).',
    "Пути — относительные от корня проекта. Менять защищённые файлы (scripts/telegram-bot.mjs, app/api/*, lib/promptSanitizer.ts, lib/adminOps.ts, data/*) НЕЛЬЗЯ. read выполняется сразу, результат вернётся следующим сообщением; write/replace/run/build — только после явного «да» владельца. Лимит — до 3 изменений за сессию.",
  ].join("\n");
}

/** Learned-facts block injected from data/learned-facts.json (see lessonStore). */
async function learnedFactsSystemNote(): Promise<string> {
  try {
    const facts = await getLearnedFacts();
    if (facts.length === 0) return "";
    return `\n\nВЫУЧЕННЫЕ ФАКТЫ (учитывай в ответах, они уже подтверждены пользователем):\n${facts.map((f) => `- ${f}`).join("\n")}`;
  } catch {
    return "";
  }
}

async function fetchInternal(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

/**
 * «найди X» / «изучи <тема>» — real web search. Calls /api/search, returns
 * the grounded answer + sources. When the request asked to memorize the result
 * (learn), consults DeepSeek as a second advisor (if a key exists) and stores
 * the result as a StudyNote in the shared brain.
 */
async function handleSearchAction(
  brain: AssistantBrain,
  action: { query: string; learn?: boolean },
  baseUrl: string,
  cloudOpts: CloudOpts,
): Promise<string> {
  const res = await fetchInternal(baseUrl, `/api/search?q=${encodeURIComponent(action.query)}`, {
    headers: cloudOpts.geminiKey
      ? { "x-gemini-key": cloudOpts.geminiKey }
      : { "x-skip-gemini": "1" },
  });
  const data = (await res.json().catch(() => null)) as { answer?: string; sources?: string[] } | null;
  if (!res.ok || !data?.answer) {
    return `Не удалось найти информацию по запросу «${action.query}». Попробуйте иначе сформулировать.`;
  }
  const sources = Array.isArray(data.sources) ? data.sources : [];
  let reply = data.answer;
  if (sources.length > 0) {
    reply += `\n\nИсточники:\n${sources.map((s) => `• ${s}`).join("\n")}`;
  }

  if (action.learn) {
    let summary = data.answer;
    let keyPoints: string[] = [];
    // Second opinion from DeepSeek (self-development: the brain consults
    // another model and turns the findings into durable knowledge).
    try {
      const critique = await completeWithProvider(
        [
          {
            role: "system",
            content:
              "Ты — второй аналитик. По найденной информации составь структурированную заметку для личной базы знаний. Верни СТРОГО один JSON-объект без markdown: {\"summary\":\"суть в 3–5 предложениях\",\"keyPoints\":[\"2–5 тезисов\"]}",
          },
          { role: "user", content: data.answer },
        ],
        "deepseek",
      );
      const parsed = parseJSONObject(critique);
      if (parsed) {
        if (typeof parsed.summary === "string" && parsed.summary.trim()) {
          summary = parsed.summary.trim();
        }
        keyPoints = Array.isArray(parsed.keyPoints)
          ? parsed.keyPoints.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim().slice(0, 200))
          : [];
      }
    } catch (err) {
      console.warn("[assistant] deepseek consultation failed:", err);
    }
    if (keyPoints.length === 0) keyPoints = sources.slice(0, 5);
    brain.addNote({
      topic: action.query.slice(0, 100),
      summary,
      keyPoints: keyPoints.slice(0, 5),
      source: sources.join(", "),
    });
    return `Нашёл и изучил: «${action.query.slice(0, 100)}».\n\n${reply}`;
  }
  return reply;
}

/** Execute a handled action server-side and produce the final reply. */
async function executeHandledAction(
  brain: AssistantBrain,
  action: AssistantAction,
  baseUrl: string,
  ctx: { chatKey: string; cloudOpts: CloudOpts; userText?: string; timeline?: Timeline },
): Promise<{
  reply: string;
  image?: { b64: string; mime: string };
  needsApproval?: { id: string; description: string };
  files?: WireFile[];
  verified?: boolean;
}> {
  switch (action.kind) {
    case "launch": {
      if (action.url) {
        if (!SAFE_URL.test(action.url) || action.url.length > 512) {
          return { reply: "Недопустимая ссылка для открытия." };
        }
        openViaShell(action.url);
        return { reply: `Открываю ${action.url} в браузере.` };
      }
      const outcome = await launchApp(action.app, undefined, { focus: true });
      if (!outcome) return { reply: `Не удалось найти приложение «${action.app}».` };
      return { reply: `Запускаю «${action.app}».` };
    }

    case "run-skill": {
      const dispatched = await runSkillDispatch(
        brain,
        action.skillId,
        ctx.userText || action.skillId,
        baseUrl,
        ctx.chatKey,
        ctx.cloudOpts,
        ctx.timeline,
      );
      recordProvider("local", ctx.chatKey);
      return {
        reply: dispatched.reply,
        ...(dispatched.needsApproval ? { needsApproval: dispatched.needsApproval } : {}),
        ...(dispatched.files && dispatched.files.length ? { files: dispatched.files } : {}),
        ...(dispatched.verified !== undefined ? { verified: dispatched.verified } : {}),
      };
    }

    case "search": {
      recordProvider("search", ctx.chatKey);
      return { reply: await handleSearchAction(brain, action, baseUrl, ctx.cloudOpts) };
    }

    case "weather": {
      const res = await fetchInternal(baseUrl, `/api/weather?city=${encodeURIComponent(action.city)}`);
      const data = (await res.json().catch(() => null)) as {
        city?: string;
        temp?: number;
        feelsLike?: number;
        humidity?: number;
        condition?: string;
        error?: string;
      } | null;
      if (!res.ok || !data) {
        return { reply: `Не удалось узнать погоду: ${data?.error ?? res.status}.` };
      }
      const feels = data.feelsLike !== undefined ? ` Ощущается как ${data.feelsLike}°.` : "";
      return { reply: `Сейчас в ${data.city}: ${data.temp}°, ${data.condition ?? ""}.${feels}` };
    }

    case "learn-text": {
      const body = action.text.trim();
      if (body.length < 10) return { reply: "Слишком короткий текст для изучения." };
      const topic = body.slice(0, 90) + (body.length > 90 ? "…" : "");
      brain.addNote({ topic, summary: body.slice(0, 3000), keyPoints: [], source: "manual" });
      await commitBrain(brain, snapshotIds(brain.snapshot()));
      return { reply: `Запомнил: «${topic}».` };
    }

    case "learn-url":
    case "learn-site":
    case "learn-image":
    case "image":
      // Handled by the caller (learn-url/site/image) / only produced by LLM escalation (image).
      return { reply: "" };

    case "start-lesson":
      return { reply: "Запись урока работает через веб-интерфейс орба — запустите её там." };
    case "stop-lesson":
      return { reply: "Урок останавливается только в веб-интерфейсе орба." };

    // Visual orb commands are browser-side; be honest about it.
    case "zoom-in":
      return { reply: "Приблизить орб можно в веб-интерфейсе (колесо мыши или «+»)." };
    case "zoom-out":
      return { reply: "Отдалить орб можно в веб-интерфейсе (колесо мыши или «−»)." };
    case "reset":
      return { reply: "Сбросить вид орба можно в веб-интерфейсе («R»)." };
    case "gestures-on":
      return { reply: "Включить жесты можно в веб-интерфейсе (кнопка камеры)." };
    case "gestures-off":
      return { reply: "Выключить жесты можно в веб-интерфейсе (кнопка камеры)." };
    case "stop":
      return { reply: "Стоп (в веб-интерфейсе — пауза навыка)." };

    case "maximize": {
      const { maximizeWindow } = await import("@/lib/desktopInput");
      const ok = await maximizeWindow();
      return { reply: ok ? "Разворачиваю на весь экран." : "Не удалось найти окно." };
    }
    case "minimize": {
      const { minimizeWindow } = await import("@/lib/desktopInput");
      const ok = await minimizeWindow();
      return { reply: ok ? "Сворачиваю окно." : "Не удалось найти окно." };
    }
    case "close": {
      const { closeWindow } = await import("@/lib/desktopInput");
      const ok = await closeWindow();
      return { reply: ok ? "Закрываю окно." : "Не удалось найти окно." };
    }
    case "restore": {
      const { restoreWindow } = await import("@/lib/desktopInput");
      const ok = await restoreWindow();
      return { reply: ok ? "Восстанавливаю окно." : "Не удалось найти окно." };
    }
    case "toggle-maximize": {
      const { toggleMaximize } = await import("@/lib/desktopInput");
      const ok = await toggleMaximize();
      return { reply: ok ? "Переключаю размер окна." : "Не удалось найти окно." };
    }
    case "chain": {
      const MAX_CHAIN = 6;
      const actions = action.actions.slice(0, MAX_CHAIN);
      const results: string[] = [];
      for (let i = 0; i < actions.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 600));
        try {
          const r = await executeHandledAction(brain, actions[i], baseUrl, ctx);
          if (r.reply) results.push(r.reply);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push(`Ошибка шага ${i + 1}: ${msg}`);
        }
      }
      return { reply: results.join(" → ") || "Цепочка выполнена." };
    }
    case "file-search": {
      const { searchFiles, openFile, googleImagesUrl } = await import("@/lib/fileSearch");
      const { openViaShell: shell } = await import("@/lib/launcher");
      const matches = await searchFiles(action.query);
      if (matches.length > 0) {
        await openFile(matches[0].path);
        return { reply: `Нашёл ${matches.length} файл(ов). Открываю «${matches[0].name}».` };
      }
      const url = googleImagesUrl(action.query);
      shell(url);
      return { reply: `Локально ничего не нашёл. Открываю поиск в Google Картинках.` };
    }
    case "music-search": {
      const { playInYandexMusic } = await import("@/lib/musicPlayer");
      const res = await playInYandexMusic(action.query, baseUrl);
      return { reply: res.reply };
    }
    case "n8n_trigger": {
      const target = N8N_ACTIONS.find((a) => a.id === action.actionId);
      if (!target || !target.webhookUrl) {
        return { reply: `Ошибка: сценарий n8n «${action.actionId}» не найден или не настроен.` };
      }
      const payload = sanitizeN8nPayload(action.payload);
      const result = await triggerN8nWebhook(target.webhookUrl, buildN8nPayload(target.id, payload));
      if (!result.success) {
        return { reply: `Не удалось запустить сценарий n8n: ${result.error ?? "неизвестная ошибка"}.` };
      }
      return { reply: `Сценарий n8n «${target.name}» успешно запущен.` };
    }
  }
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text && body?.action !== "approve" && body?.action !== "reject") {
    return NextResponse.json({ error: "missing text" }, { status: 400 });
  }
  await ensureAdmin();
  const chatId = typeof body?.chatId === "string" ? body.chatId : "";
  const isOwner = body?.isOwner === true;
  const chatKey = chatId || "anon";
  const preset = getUserPreset(chatKey);
  const timeline = new Timeline("assistant", { chatKey, preset, isOwner });
  const gemini: ResolveResult = await resolveKey(chatKey, isOwner);
  timeline.mark("resolveKey");
  const cloudOpts: CloudOpts = {
    ...(gemini.provider === "gemini" ? { geminiKey: gemini.key } : { skipGemini: true }),
    preset,
  };

  // Admin control messages from the bot (approve/reject buttons).
  if (body?.action === "approve" && typeof body.id === "string") {
    // Catalog skill awaiting owner approval: run its sandboxed executor.
    const skillCtx = skillRunContexts.get(body.id);
    if (skillCtx) {
      skillRunContexts.delete(body.id);
      await rejectPending(body.id).catch(() => {});
      const cat = (await listCatalog()).find((s) => s.slug === skillCtx.slug);
      if (!cat) return NextResponse.json({ reply: "Навык не найден." });
      const g = await resolveKey(skillCtx.chatId, isOwner);
      const opts: CloudOpts = g.provider === "gemini" ? { geminiKey: g.key } : { skipGemini: true };
      const res = await executeCatalogSkill(cat, skillCtx.name, {
        chatId: skillCtx.chatId,
        complete: makeExecutorComplete(opts, skillCtx.chatId, isOwner),
      });
      return NextResponse.json({ reply: res.reply, ...(res.artifacts?.length ? { files: res.artifacts } : {}), ...(res.verified !== undefined ? { verified: res.verified } : {}) });
    }
    const result = await approvePending(body.id);
    return NextResponse.json({ reply: result.reply });
  }
  if (body?.action === "reject" && typeof body.id === "string") {
    const ok = await rejectPending(body.id);
    return NextResponse.json({ reply: ok ? "Отклонено." : "Заявка не найдена." });
  }
  // Conversation history (owned by the caller — the Telegram bot keeps a
  // per-chat queue). Sanitized and capped so a malformed payload can't
  // inject prompt text or blow up the request.
  const history = (
    Array.isArray(body?.history) ? body.history : []
  )
    .filter((h): h is { role?: unknown; content?: unknown } => typeof h === "object" && h !== null)
    .map((h) => ({
      role: h.role === "assistant" ? ("assistant" as const) : h.role === "user" ? ("user" as const) : null,
      content: typeof h.content === "string" ? h.content.trim().slice(0, 2000) : "",
    }))
    .filter((h): h is { role: "user" | "assistant"; content: string } => h.role !== null && h.content.length > 0)
    .slice(-12);
  // Sanitize "restricted" RU vocabulary out of the LLM-visible text (so it
  // builds a high-quality English image prompt without refusing) and collect
  // the hidden EN tags to re-inject at the LOCAL generator tier. Tags also
  // accumulate from recent user turns so follow-ups keep the context.
  const sanitized = sanitizeTexts([
    ...history.filter((h) => h.role === "user").map((h) => h.content),
    text,
  ]);
  const visibleText = sanitized.visibles[sanitized.visibles.length - 1];
  const localTags = sanitized.tags;
  const baseUrl = `http://${req.headers.get("host") ?? "localhost:3000"}`;

  const brain = await loadBrain();
  const baseIds = snapshotIds(brain.snapshot());
  const outcome = brain.process(text);

  // Brain resolved it locally (rule / intent / launch confirm).
  if (outcome.handled) {
    await commitBrain(brain, baseIds);

    // Record meta-algorithm success if the outcome came from a meta-algorithm.
    if (outcome.action) {
      const metaAlgos = brain.metaAlgorithmList;
      for (const algo of metaAlgos) {
        if (algo.status !== "active") continue;
        if (algo.action && JSON.stringify(algo.action) === JSON.stringify(outcome.action)) {
          metaEngine.recordSuccess(algo.id);
          break;
        }
      }
    }

    // Full-site crawl / image study → background job; the bot polls it.
    if (outcome.action?.kind === "learn-site" || outcome.action?.kind === "learn-image") {
      try {
        const job = await startStudy({
          chatId,
          isOwner,
          type: outcome.action.kind === "learn-site" ? "site" : "image",
          content: outcome.action.url,
        });
        timeline.finish({ stage: "handled", kind: "study" });
        return NextResponse.json({
          reply: outcome.reply,
          studyJobId: job.id,
          provider: null,
          ...(gemini.note ? { note: gemini.note } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        timeline.finish({ stage: "handled", kind: "study", failed: message.slice(0, 120) });
        return NextResponse.json({ reply: `Не удалось запустить изучение: ${message}.`, provider: null });
      }
    }

    // Learn a URL server-side (Telegram path). YouTube links use the full
    // transcript (chunked, everything said in the video); other pages get the
    // usual page-text compression.
    if (outcome.action?.kind === "learn-url") {
      try {
        let pageText = "";
        let pageTitle = "";
        let isVideo = false;
        let durationSec: number | undefined;
        const videoId = isYouTubeUrl(outcome.action.url) ? extractVideoId(outcome.action.url) : null;
        if (videoId) {
          const tr = await fetchVideoTranscript(videoId).catch(() => null);
          if (tr && tr.transcript.trim().length >= 40) {
            pageText = tr.transcript;
            pageTitle = tr.title ?? "";
            isVideo = true;
            durationSec = tr.durationSec;
          }
        }
        if (!isVideo) {
          const page = await fetchPageContent(outcome.action.url, { chatId, isOwner });
          pageText = page.text;
          pageTitle = page.title ?? "";
        }
        const note = await buildStudyNote({
          text: pageText.slice(0, 400_000),
          title: pageTitle || undefined,
          url: outcome.action.url,
          isVideo,
          complete: async (messages) =>
            completeCloud(
              messages.map((m) => ({ role: m.role, content: m.content })),
              cloudOpts,
            ),
        });
        const existing = brain.findNoteBySource(outcome.action.url);
        if (existing) brain.forgetNote(existing.id);
        brain.addNote({
          topic: note.topic,
          summary: note.summary,
          keyPoints: note.keyPoints,
          source: outcome.action.url,
          ...(isVideo ? { chapters: note.chapters, fullText: note.fullText } : {}),
        });
        await commitBrain(brain, baseIds);
        const chapterCount = note.chapters?.length ?? 0;
        const chWord = chapterCount === 1 ? "раздел" : chapterCount >= 2 && chapterCount <= 4 ? "раздела" : "разделов";
        const reply = isVideo
          ? `Изучил видео (${(pageText.length / 1000).toFixed(1)} тыс. символов, ${chapterCount} ${chWord}): «${note.topic}».`
          : `Изучил: «${note.topic}».`;
        timeline.finish({ stage: "handled", kind: "learn-url" });
        return NextResponse.json({ reply, provider: null, ...(gemini.note ? { note: gemini.note } : {}) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        timeline.finish({ stage: "handled", kind: "learn-url", failed: message.slice(0, 120) });
        return NextResponse.json({ reply: `Не удалось изучить страницу: ${message}.`, provider: null, ...(gemini.note ? { note: gemini.note } : {}) });
      }
    }

    // Real actions (launch / run-skill / weather / orb / search) — execute
    // and reply. Search+learn mutates the brain, so persist afterwards.
    if (outcome.action) {
      timeline.mark("action");
      const executed = await executeHandledAction(brain, outcome.action, baseUrl, {
        chatKey,
        cloudOpts,
        userText: text,
        timeline,
      });
      await commitBrain(brain, baseIds);
      const reply = executed.image
        ? executed.reply || "Изображение готово."
        : executed.reply || outcome.reply;
      timeline.finish({ stage: "handled", kind: outcome.action.kind });
      return NextResponse.json({ reply, image: executed.image, provider: null, ...(executed.needsApproval ? { needsApproval: executed.needsApproval } : {}), ...(gemini.note ? { note: gemini.note } : {}) });
    }

    timeline.finish({ stage: "handled", kind: "rule" });
    return NextResponse.json({ reply: outcome.reply, provider: null, ...(gemini.note ? { note: gemini.note } : {}) });
  }

  // Capability query («навыки», «навык X», «чего тебе не хватает», «чему ты
  // научился») — run the LLM analysis (or reuse the cache), persist, answer.
  if (outcome.needsAbilityAnalysis) {
    const reply = await answerAbilityQuery(brain, outcome.abilityQuery ?? "list", outcome.abilityName);
    await commitBrain(brain, baseIds);
    timeline.finish({ stage: "handled", kind: "ability" });
    return NextResponse.json({ reply, provider: null });
  }

  // Deterministic skill gate: when the user text strongly matches a sandbox
  // SKILL.md catalog skill AND the request is an imperative task, dispatch it
  // WITHOUT asking the LLM escalate (the escalate is too weak at choosing —
  // it parrots capabilities instead of returning run-skill JSON, so the
  // executor never fires). Long verbose requests dilute the fuzzy ratio
  // (measured 0.40 for a full plot request), and meta-questions about skills
  // score identically — so a bare threshold can't separate them: require a
  // leading task verb too. Only script skills (python/data) are gated;
  // knowledge skills (pdf/docx/image-style/…) keep going through the escalate,
  // which knows how to answer.
  const directSkill = await bestMatch(visibleText);
  const GATE_SKILLS = new Set(["python", "data"]);
  const TASK_VERB_RE =
    /^(?:постро(?:й|ить)|нарису(?:й|ть)|напиш(?:и|ть)|созда(?:й|ть)|сдела(?:й|ть)|вычисл(?:и|ть)|рассчита(?:й|ть)|посчита(?:й|ть)|проанализиру(?:й|ть)|просканиру(?:й|ть)|запиш(?:и|ть)|прочита(?:й|ть)|реш(?:и|ить)|преобразу(?:й|ть)|конвертиру(?:й|ть)|провер(?:ь|ить)|запуст(?:и|ить)|сохран(?:и|ить))(?!\p{L})/iu;
  if (
    directSkill.skill &&
    directSkill.score >= 0.3 &&
    GATE_SKILLS.has(directSkill.skill.slug) &&
    TASK_VERB_RE.test(visibleText.trim())
  ) {
    const dispatched = await runSkillDispatch(
      brain,
      directSkill.skill.name,
      visibleText,
      baseUrl,
      chatKey,
      cloudOpts,
      timeline,
    );
    await commitBrain(brain, baseIds);
    timeline.finish({ stage: "skill-gate", kind: directSkill.skill.slug });
    return NextResponse.json({
      reply: dispatched.reply,
      ...(dispatched.needsApproval ? { needsApproval: dispatched.needsApproval } : {}),
      ...(dispatched.files && dispatched.files.length ? { files: dispatched.files } : {}),
      ...(dispatched.verified !== undefined ? { verified: dispatched.verified } : {}),
      provider: null,
    });
  }

  // Unknown → ask the best available local/cloud model, with recent dialog
  // history as context so follow-ups («сделай его сочнее») stay in topic.
  try {
    let k = 0;
    const catalogList = await listForPrompt();
    const systemContent =
      brain.buildSystemPrompt(visibleText, { brief: body?.mode === "browser" }) +
      (catalogList
        ? `\n\nВНЕШНИЕ НАВЫКИ (SKILL.md):\n${catalogList}\nВерни action {"type":"run-skill","skill":"<точное имя>"} ТОЛЬКО когда запрос — ЯВНАЯ задача с файлами/документами (PDF/XLSX/DOCX/PPTX), системный отчёт, стиль изображения, запуск/написание Python-кода или вычисления, и сформулирован императивно («создай», «сделай», «построй», «рассчитай», «напиши»). Неоднозначные фразы («что это значит?», «это задача», вопросы-уточнения) НЕ запускают навыки — отвечай текстом.`
        : "") +
      (await autonomySystemNote()) +
      (await learnedFactsSystemNote()) +
      n8nActionsPrompt() +
      `\n\n${await getSystemContext()}` +
      `\n\nПРОЗРАЧНОСТЬ ИСТОЧНИКА: ты НЕ знаешь, какой API-провайдер (Gemini/Ollama) обрабатывает твой ответ — система укажет источник автоматически. Никогда не утверждай, что ответил через конкретный сервис или что использовал/не использовал Gemini.` +
      `\n\nТОЧНЫЕ ДАННЫЕ: никогда не выдумывай статистику, цифры, даты и факты об актуальных событиях. Если запрос требует таких данных — верни action {"type":"search","query":"<поисковый запрос>"}. Если данных нет и поиск неуместен — честно скажи, что не знаешь.`;
    const messages = [
      { role: "system" as const, content: systemContent },
      ...history.map((h) => ({
        role: h.role as "user" | "assistant",
        content: h.role === "user" ? sanitized.visibles[k++] : h.content,
      })),
      { role: "user" as const, content: visibleText },
    ];
    let result: string;
    let answerProvider = "ollama";
    try {
      timeline.mark("escalate");
      const cloudResult = await completeCloudMeta(messages, { ...cloudOpts, timeline });
      result = cloudResult.text;
      answerProvider = cloudResult.provider;
    } catch (err) {
      // Classify the failure: a transient rate limit only cools the key down,
      // a hard daily/token quota marks it exhausted until midnight.
      timeline.mark("escalate:fail");
      if (gemini.key) await reportGeminiFailure(chatKey, gemini.key, isOwner, err);
      throw err;
    }
    recordProvider(answerProvider, chatKey);
    timeline.mark("parse");
    const parsed = await parseWithRetry(result, messages, cloudOpts);
    timeline.mark("parse:done");

    const reply =
      typeof parsed?.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : "Выполнено.";
    const generate =
      typeof parsed?.generate === "string" && parsed.generate.trim() ? parsed.generate.trim() : undefined;

    const added =
      parsed?.learn && Array.isArray(parsed.learn) ? brain.learnFromLLM(parsed.learn as LLMLearnItem[]) : 0;
    // P5: memory persists to brain.json separately — nothing is appended to
    // the user-facing text (no more «Запомнил.» noise).
    const finalReply = composeFinalReply(reply, added);

    // LLM proposed an action. Images need the special local/ref pipeline and
    // stay inline; everything else (launch, chain, music-search, weather,
    // search, run-skill, window ops, file-search) normalizes through
    // normalizeLLMAction and runs in executeHandledAction — the same executor
    // the brain's local path uses, so chains and new actions work identically
    // from the LLM and the rule layer.
    let image: { b64: string; mime: string } | undefined;
    let actionReply: string | undefined;
    let needsApproval: { id: string; description: string } | undefined;
    let files: WireFile[] | undefined;
    let verified: boolean | undefined;
    if (parsed?.action != null) {
      const a = parsed.action as {
        type?: unknown;
        prompt?: unknown;
        text?: unknown;
        ref?: unknown;
      };
      if (
        typeof a === "object" &&
        a !== null &&
        a.type === "image" &&
        typeof a.prompt === "string" &&
        a.prompt.trim()
      ) {
        try {
          const explicitRef = typeof a.ref === "string" && a.ref.trim() ? a.ref.trim() : "";
          const reference = await resolveImageReference(explicitRef || visibleText, Boolean(explicitRef));
          image = await generateImage(
            a.prompt.trim(),
            {
              text: typeof a.text === "string" && a.text.trim() ? a.text.trim() : extractCaptionText(visibleText),
              localTags,
              forceLocal: gemini.provider !== "gemini",
              ...(reference ? { reference } : {}),
            },
            gemini.key,
          );
          actionReply = "Изображение готово.";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          actionReply = `Не удалось сгенерировать изображение: ${message}.`;
        }
      } else {
        const llmAction = normalizeLLMAction(parsed.action);
        if (llmAction) {
          // P2 gate: a run-skill the LLM proposed must be an EXPLICIT task.
          // Vague follow-ups («что это значит?», «это задача») must not spawn
          // PC/sandbox work — the model's plain-text reply stands instead.
          if (llmAction.kind === "run-skill" && !isExplicitTask(text)) {
            // Blocked: only the textual reply is shown, nothing executes.
          } else {
            timeline.mark("action");
            const executed = await executeHandledAction(brain, llmAction, baseUrl, { chatKey, cloudOpts, userText: text, timeline });
            if (executed.reply) actionReply = executed.reply;
            if (executed.needsApproval) needsApproval = executed.needsApproval;
            if (executed.image) image = executed.image;
            if (executed.files && executed.files.length) files = executed.files;
            if (executed.verified !== undefined) verified = executed.verified;
          }
        }
      }
    }

    // LLM-admin (autonomy): read executes inline; changes require the owner's
    // explicit «да» via the Telegram bot (approve/reject buttons).
    const admin = (parsed?.admin ?? null) as
      | {
          action?: unknown;
          file?: unknown;
          content?: unknown;
          old?: unknown;
          new?: unknown;
          cmd?: unknown;
        }
      | null;
    if (admin && typeof admin === "object") {
      const a = admin;
      const kind = typeof a.action === "string" ? a.action : "";
      const chatKey = chatId || "anon";
      if (kind === "read" && typeof a.file === "string") {
        const abs = resolveProjectPath(a.file);
        if (!abs) {
          actionReply = `admin: «${a.file}» — путь вне проекта.`;
        } else if (countRead(chatKey) > 4) {
          actionReply = "admin: лимит чтений (4) исчерпан. Предлагайте решение или запишите файл.";
        } else {
          try {
            const content = await readFileText(a.file);
            actionReply = `Содержимое «${a.file}»:\n\n${content.slice(0, 6000)}`;
            await appendAudit({ action: "llm-read", file: a.file, chatId });
          } catch (err) {
            actionReply = `admin: не удалось прочитать «${a.file}»: ${err instanceof Error ? err.message : String(err)}.`;
          }
        }
      } else if (kind === "write" || kind === "replace") {
        if (typeof a.file !== "string" || !a.file.trim()) {
          actionReply = "admin: укажите «file».";
        } else if ((await changesLeft()) <= 0) {
          actionReply = "admin: лимит изменений (3) за сессию исчерпан.";
        } else {
          const info = await createPending(kind, {
            file: a.file,
            content: typeof a.content === "string" ? a.content : undefined,
            oldText: typeof a.old === "string" ? a.old : undefined,
            newText: typeof a.new === "string" ? a.new : undefined,
            chatId,
          });
          needsApproval = { id: info.id, description: info.description };
          actionReply = `Требуется одобрение владельца: ${info.description}.`;
        }
      } else if (kind === "run" && typeof a.cmd === "string" && a.cmd.trim()) {
        if ((await changesLeft()) <= 0) {
          actionReply = "admin: лимит изменений (3) за сессию исчерпан.";
        } else {
          const info = await createPending("run", { cmd: a.cmd.trim(), chatId });
          needsApproval = { id: info.id, description: info.description };
          actionReply = `Требуется одобрение владельца: ${info.description}.`;
        }
      } else if (kind === "build") {
        const info = await createPending("build", { chatId });
        needsApproval = { id: info.id, description: info.description };
        actionReply = `Требуется одобрение владельца: ${info.description}.`;
      } else {
        actionReply = "admin: неизвестное действие.";
      }
    }

    await commitBrain(brain, baseIds);
    const providerOut = answerProvider ?? (admin ? "server" : "llm");
    timeline.finish({ stage: "escalate", provider: providerOut });
    return NextResponse.json({
      reply: actionReply ?? finalReply,
      generate,
      image,
      provider: providerOut,
      needsApproval,
      ...(files && files.length ? { files } : {}),
      ...(verified !== undefined ? { verified } : {}),
      ...(gemini.note ? { note: gemini.note } : {}),
    });
  } catch (err) {
    console.warn("[assistant] llm escalation failed:", err);
    timeline.finish({ stage: "escalate", failed: err instanceof Error ? err.message.slice(0, 150) : String(err) });
    await commitBrain(brain, baseIds);
    // All models down but the phrase was an explicit image request → fall
    // back to the keyless generator so «нарисуй …» still works.
    const fallbackPrompt = extractImagePrompt(visibleText);
    if (fallbackPrompt) {
      try {
        const reference = await resolveImageReference(visibleText, false);
        const image = await generateImage(
          fallbackPrompt,
          {
            text: extractCaptionText(visibleText),
            localTags,
            forceLocal: gemini.provider !== "gemini",
            ...(reference ? { reference } : {}),
          },
          gemini.key,
        );
        return NextResponse.json({ reply: "Изображение готово.", image, provider: null, ...(gemini.note ? { note: gemini.note } : {}) });
      } catch (imgErr) {
        const message = imgErr instanceof Error ? imgErr.message : String(imgErr);
        return NextResponse.json({ reply: `Не удалось сгенерировать изображение: ${message}.`, provider: null, ...(gemini.note ? { note: gemini.note } : {}) });
      }
    }
    const failReason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    const honestReply = `Извини, сейчас не могу ответить: все провайдеры временно недоступны (${failReason.replace(/^все провайдеры недоступны:\s*/i, "")}). Попробуй ещё раз через минуту.`;
    return NextResponse.json({ reply: honestReply, provider: null });
  }
}
