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
  if (!text) {
    return NextResponse.json({ error: "missing text" }, { status: 400 });
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
          headers: { "User-Agent": "Mozilla/5.0 (Ultron Orb reader)" },
          redirect: "follow",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const pageText = stripHtml(html).slice(0, 100_000);
        const notePrompt = [
          "Ты — аналитик. Сожми статью в структурированную заметку для личной базы знаний. Верни СТРОГО один JSON-объект без markdown:",
          '{"topic":"короткая тема (5–8 слов)","summary":"суть в 3–5 предложениях","keyPoints":["2–5 тезисов"]}',
          `Текст:\n${pageText}`,
        ].join("\n\n");
        const summary = await completeCloud([{ role: "user", content: notePrompt }]);
        const parsed = parseJSONObject(summary);
        const topic =
          typeof parsed?.topic === "string" && parsed.topic.trim()
            ? parsed.topic.trim().slice(0, 100)
            : outcome.action.url.slice(0, 100);
        const noteSummary =
          typeof parsed?.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : pageText.slice(0, 400);
        const keyPoints = Array.isArray(parsed?.keyPoints)
          ? parsed.keyPoints.filter((k): k is string => typeof k === "string").map((k) => k.trim().slice(0, 200))
          : [];
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
    const messages = [
      { role: "system" as const, content: brain.buildSystemPrompt(text) },
      ...history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
      { role: "user" as const, content: text },
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
        skill?: unknown;
        city?: unknown;
        app?: unknown;
        query?: unknown;
        learn?: unknown;
      };
      if (a.type === "image" && typeof a.prompt === "string" && a.prompt.trim()) {
        try {
          image = await generateImage(a.prompt.trim());
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
        actionReply = outcome ? `Запускаю «${name}».` : `Не удалось найти приложение «${name}».`;
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

    await saveBrain(brain);
    return NextResponse.json({
      reply: actionReply ?? finalReply,
      generate,
      image,
      provider: "server",
    });
  } catch (err) {
    console.warn("[assistant] llm escalation failed:", err);
    await saveBrain(brain);
    // All models down but the phrase was an explicit image request → fall
    // back to the keyless generator so «нарисуй …» still works.
    const fallbackPrompt = extractImagePrompt(text);
    if (fallbackPrompt) {
      try {
        const image = await generateImage(fallbackPrompt);
        return NextResponse.json({ reply: "Изображение готово.", image, provider: null });
      } catch (imgErr) {
        const message = imgErr instanceof Error ? imgErr.message : String(imgErr);
        return NextResponse.json({ reply: `Не удалось сгенерировать изображение: ${message}.`, provider: null });
      }
    }
    return NextResponse.json({ reply: brain.unknownReply(), provider: null });
  }
}
