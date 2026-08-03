import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AssistantBrain,
  extractImagePrompt,
  type BrainSnapshot,
  type LLMLearnItem,
  type AssistantAction,
} from "@/lib/assistantBrain";
import { completeCloud, completeWithProvider } from "@/lib/serverLLM";
import { generateImage } from "@/lib/generateImage";
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

/**
 * Server-side assistant core (LOCALHOST-only). The Telegram bot POSTs user
 * text here; this route runs the SAME brain + LLM pipeline as the browser,
 * against the durable brain.json on disk:
 *
 *   1. load brain.json → hydrate AssistantBrain
 *   2. brain.process(text) — known rules/intents answer instantly
 *   3. unknown → completeCloud(buildSystemPrompt(query) + text)
 *   4. apply learn / run actions (learn-url, image, launch, run-skill, weather)
 *   5. persist brain.json, return { reply, generate?, image?, provider? }
 *
 * This keeps the web UI and the Telegram bot on the same knowledge — and lets
 * the bot really execute PC actions, not just echo the intent.
 */

export const runtime = "nodejs";

const BRAIN_FILE = path.join(process.cwd(), "data", "brain.json");

let adminReady: Promise<void> | null = null;
function ensureAdmin(): Promise<void> {
  adminReady ??= initAdmin();
  return adminReady;
}

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

async function loadBrain(): Promise<AssistantBrain> {
  const brain = new AssistantBrain();
  try {
    const raw = await fs.readFile(BRAIN_FILE, "utf-8");
    const snapshot = JSON.parse(raw) as BrainSnapshot;
    brain.hydrate(snapshot);
  } catch {
    // No file yet — start with an empty brain.
  }
  return brain;
}

async function saveBrain(brain: AssistantBrain): Promise<void> {
  await fs.mkdir(path.dirname(BRAIN_FILE), { recursive: true });
  await fs.writeFile(BRAIN_FILE, JSON.stringify(brain.snapshot()), "utf-8");
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

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Caption the user wants drawn on the image («с текстом "Привет"» …). */
function extractCaptionText(raw: string): string | undefined {
  const m = raw.match(/(?:с текстом|с надписью|с подписью|надпись|подпись)\s*(?:["«']?)([^»"'»«\n]{1,60})/i);
  return m?.[1]?.trim() || undefined;
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

async function fetchInternal(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

/** Run a screen-learned skill step by step via /api/do-step. */
async function executeSkill(brain: AssistantBrain, skillId: string, baseUrl: string): Promise<string> {
  const skill = brain.skillList.find((s) => s.id === skillId);
  if (!skill || skill.steps.length === 0) return "Навык не найден.";
  let ran = 0;
  for (const step of skill.steps) {
    ran += 1;
    const res = await fetchInternal(baseUrl, "/api/do-step", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: step.action, params: step.params }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return `Навык «${skill.name}»: шаг ${ran}/${skill.steps.length} не удался — ${body?.error ?? res.status}.`;
    }
  }
  return `Навык «${skill.name}» выполнен (${ran} шагов).`;
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
): Promise<string> {
  const res = await fetchInternal(baseUrl, `/api/search?q=${encodeURIComponent(action.query)}`);
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
): Promise<{ reply: string; image?: { b64: string; mime: string } }> {
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
      return { reply: await executeSkill(brain, action.skillId, baseUrl) };
    }

    case "search": {
      return { reply: await handleSearchAction(brain, action, baseUrl) };
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

    case "learn-url":
    case "image":
      // Handled by the caller (learn-url) / only produced by LLM escalation (image).
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

  // Admin control messages from the bot (approve/reject buttons).
  if (body?.action === "approve" && typeof body.id === "string") {
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
  const outcome = brain.process(text);

  // Brain resolved it locally (rule / intent / launch confirm).
  if (outcome.handled) {
    await saveBrain(brain);

    // Learn a URL server-side (Telegram path).
    if (outcome.action?.kind === "learn-url") {
      try {
        const res = await fetch(outcome.action.url, {
          signal: AbortSignal.timeout(30_000),
          cache: "no-store",
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
          redirect: "follow",
        });
        if (!res.ok) {
          console.log("[learn-url] fetch fail", res.status, res.statusText, "url:", res.url, "req:", outcome.action.url);
          throw new Error(`HTTP ${res.status}`);
        }
        const html = await res.text();
        const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
        const pageText = stripHtml(html).slice(0, 60_000);
        const notePrompt = [
          "Сожми текст в структурированную заметку для личной базы знаний. Отвечай СТРОГО одним JSON-объектом без markdown, без пояснений и без обёрток:",
          '{"topic":"короткая тема (5–8 слов)","summary":"суть в 3–5 предложениях","keyPoints":["2–5 тезисов"]}',
          `Текст:\n${pageText}`,
        ].join("\n\n");
        let summary: string;
        let parsed = null;
        try {
          summary = await completeCloud([
            { role: "system", content: "Ты — аналитик-резюмёр. Твой ответ всегда один JSON-объект и ничего больше." },
            { role: "user", content: notePrompt },
          ]);
          parsed = parseJSONObject(summary);
          if (!parsed) {
            summary = await completeCloud([
              { role: "system", content: "Ты — аналитик-резюмёр. Твой ответ всегда один JSON-объект и ничего больше." },
              { role: "user", content: `Сожми текст в заметку: {"topic":"5–8 слов","summary":"3–5 предложений","keyPoints":["тезисы"]}\n\n${pageText.slice(0, 20_000)}` },
            ]);
            parsed = parseJSONObject(summary);
          }
        } catch {
          parsed = null;
        }
        // Deterministic fallback when the model won't emit JSON: build the note
        // from the page title + first meaningful sentences (works for code
        // files whose header comment is prose, and for wiki lead paragraphs).
        if (!parsed) {
          const junk = /^(jump to|main menu|navigation|search|wikipedia|contents|current events|random article|help|tools|pages|views|what links|the article|image|from wikipedia)/i;
          const sentences = pageText
            .split(/(?<=[.!?])\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length >= 50 && s.length <= 600 && !junk.test(s));
          let topic = pageTitle.replace(/\s*-\s*Wikipedia$/i, "").trim();
          if (!topic || /^https?:/i.test(topic)) topic = (sentences[0] || "").split(/[.!?]/)[0].slice(0, 100) || outcome.action.url.slice(0, 100);
          const summary = sentences[0] || pageText.slice(0, 400);
          const keyPoints = sentences.slice(1, 5).map((s) => s.slice(0, 200));
          parsed = { topic: topic.slice(0, 100), summary, keyPoints };
        }
        const topic =
          typeof parsed?.topic === "string" && parsed.topic.trim()
            ? parsed.topic.trim().slice(0, 100)
            : outcome.action.url.slice(0, 100);
        const noteSummary =
          typeof parsed?.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : pageText.slice(0, 400);
        const keyPoints = Array.isArray(parsed?.keyPoints)
          ? parsed.keyPoints.filter((k): k is string => typeof k === "string").map((k) => k.trim().slice(0, 200))
          : [];
        const existing = brain.findNoteBySource(outcome.action.url);
        if (existing) brain.forgetNote(existing.id);
        brain.addNote({ topic, summary: noteSummary, keyPoints: keyPoints.slice(0, 5), source: outcome.action.url });
        await saveBrain(brain);
        return NextResponse.json({ reply: `Изучил: «${topic}».`, provider: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ reply: `Не удалось изучить страницу: ${message}.`, provider: null });
      }
    }

    // Real actions (launch / run-skill / weather / orb / search) — execute
    // and reply. Search+learn mutates the brain, so persist afterwards.
    if (outcome.action) {
      const executed = await executeHandledAction(brain, outcome.action, baseUrl);
      await saveBrain(brain);
      const reply = executed.image
        ? executed.reply || "Изображение готово."
        : executed.reply || outcome.reply;
      return NextResponse.json({ reply, image: executed.image, provider: null });
    }

    return NextResponse.json({ reply: outcome.reply, provider: null });
  }

  // Capability query («навыки», «навык X», «чего тебе не хватает», «чему ты
  // научился») — run the LLM analysis (or reuse the cache), persist, answer.
  if (outcome.needsAbilityAnalysis) {
    const reply = await answerAbilityQuery(brain, outcome.abilityQuery ?? "list", outcome.abilityName);
    await saveBrain(brain);
    return NextResponse.json({ reply, provider: null });
  }

  // Unknown → ask the best available local/cloud model, with recent dialog
  // history as context so follow-ups («сделай его сочнее») stay in topic.
  try {
    let k = 0;
    const systemContent = brain.buildSystemPrompt(visibleText) + (await autonomySystemNote());
    const messages = [
      { role: "system" as const, content: systemContent },
      ...history.map((h) => ({
        role: h.role as "user" | "assistant",
        content: h.role === "user" ? sanitized.visibles[k++] : h.content,
      })),
      { role: "user" as const, content: visibleText },
    ];
    const result = await completeCloud(messages);
    const parsed = parseJSONObject(result);

    const reply =
      typeof parsed?.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : "Выполнено.";
    const generate =
      typeof parsed?.generate === "string" && parsed.generate.trim() ? parsed.generate.trim() : undefined;

    const added =
      parsed?.learn && Array.isArray(parsed.learn) ? brain.learnFromLLM(parsed.learn as LLMLearnItem[]) : 0;
    const finalReply = added > 0 ? `${reply} Запомнил.` : reply;

    // LLM proposed an action.
    let image: { b64: string; mime: string } | undefined;
    let actionReply: string | undefined;
    if (parsed?.action && typeof parsed.action === "object") {
      const a = parsed.action as {
        type?: unknown;
        prompt?: unknown;
        text?: unknown;
        skill?: unknown;
        city?: unknown;
        app?: unknown;
        query?: unknown;
        learn?: unknown;
      };
      if (a.type === "image" && typeof a.prompt === "string" && a.prompt.trim()) {
        try {
          image = await generateImage(a.prompt.trim(), {
            text: typeof a.text === "string" && a.text.trim() ? a.text.trim() : extractCaptionText(visibleText),
            localTags,
          });
          actionReply = "Изображение готово.";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          actionReply = `Не удалось сгенерировать изображение: ${message}.`;
        }
      } else if (a.type === "weather" && typeof a.city === "string" && a.city.trim()) {
        const w = await fetchInternal(baseUrl, `/api/weather?city=${encodeURIComponent(a.city.trim())}`);
        const data = (await w.json().catch(() => null)) as {
          city?: string;
          temp?: number;
          feelsLike?: number;
          humidity?: number;
          condition?: string;
          error?: string;
        } | null;
        if (w.ok && data?.city) {
          const feels = data.feelsLike !== undefined ? ` Ощущается как ${data.feelsLike}°.` : "";
          actionReply = `Сейчас в ${data.city}: ${data.temp}°, ${data.condition ?? ""}.${feels}`;
        } else {
          actionReply = `Не удалось узнать погоду: ${data?.error ?? w.status}.`;
        }
      } else if (a.type === "launch" && typeof a.app === "string" && a.app.trim()) {
        const name = a.app.trim().toLowerCase();
        const outcome = await launchApp(name, undefined, { focus: true });
        actionReply = outcome
          ? outcome.url
            ? `Открываю ${outcome.url} в браузере.`
            : `Запускаю «${outcome.matched}».`
          : `Не удалось найти приложение «${name}».`;
      } else if (a.type === "search" && typeof a.query === "string" && a.query.trim()) {
        actionReply = await handleSearchAction(
          brain,
          { query: a.query.trim(), learn: a.learn === true },
          baseUrl,
        );
      } else if (a.type === "run-skill" && typeof a.skill === "string") {
        const skill = brain.findSkill(a.skill);
        if (skill) {
          skill.uses += 1;
          skill.lastUsedAt = Date.now();
          await saveBrain(brain);
          actionReply = await executeSkill(brain, skill.id, baseUrl);
        } else {
          actionReply = `Не нашёл навык «${a.skill}». Скажите «какие уроки» — покажу список.`;
        }
      }
    }

    // LLM-admin (autonomy): read executes inline; changes require the owner's
    // explicit «да» via the Telegram bot (approve/reject buttons).
    let needsApproval: { id: string; description: string } | undefined;
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

    await saveBrain(brain);
    return NextResponse.json({
      reply: actionReply ?? finalReply,
      generate,
      image,
      provider: "server",
      needsApproval,
    });
  } catch (err) {
    console.warn("[assistant] llm escalation failed:", err);
    await saveBrain(brain);
    // All models down but the phrase was an explicit image request → fall
    // back to the keyless generator so «нарисуй …» still works.
    const fallbackPrompt = extractImagePrompt(visibleText);
    if (fallbackPrompt) {
      try {
        const image = await generateImage(fallbackPrompt, {
          text: extractCaptionText(visibleText),
          localTags,
        });
        return NextResponse.json({ reply: "Изображение готово.", image, provider: null });
      } catch (imgErr) {
        const message = imgErr instanceof Error ? imgErr.message : String(imgErr);
        return NextResponse.json({ reply: `Не удалось сгенерировать изображение: ${message}.`, provider: null });
      }
    }
    return NextResponse.json({ reply: brain.unknownReply(), provider: null });
  }
}
