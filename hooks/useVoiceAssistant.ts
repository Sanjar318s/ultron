"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantBrain,
  extractImagePrompt,
  normalize,
  snapshotIds,
  type AssistantAction,
  type BrainSnapshot,
  type LLMLearnItem,
  type Skill,
  type SkillStep,
} from "@/lib/assistantBrain";
import { useVoiceCommands } from "@/hooks/useVoiceCommands";
import { createAssistantLLM } from "@/lib/llm";
import { getWebLLMStatus, loadWebLLMEngine, type WebLLMStatus } from "@/lib/llm/webllm";
import { ScreenLesson } from "@/lib/screenLearn";
import { buildStudyNote } from "@/lib/noteBuilder";
import type { ChatMessage, ProviderId } from "@/lib/llm/types";

export interface AssistantMessage {
  id: number;
  role: "user" | "ai";
  text: string;
  at: number;
  /** Base64 image shown instead of text (generated pictures). */
  image?: { b64: string; mime: string };
}

export interface AssistantHandlers {
  onAction?(action: AssistantAction): void;
}

interface LLMParsed {
  reply?: unknown;
  action?: unknown;
  learn?: unknown;
  /** Full long-form text requested by the user (article, code, plan…). */
  generate?: unknown;
}

export interface VoiceAssistantApi {
  supported: boolean;
  listening: boolean;
  speaking: boolean;
  /** Current TTS voice (male/female). */
  voiceId: "male" | "female";
  /** Switch TTS voice. */
  setVoice(id: "male" | "female"): void;
  teachMode: boolean;
  learnedCount: number;
  pcControl: boolean;
  messages: AssistantMessage[];
  /** Screen-learned skills. */
  skills: Skill[];
  /** Active screen lesson (null when nothing is being recorded). */
  lesson: { goal: string; frames: number } | null;
  /** Provider that answered the last LLM request (null = none yet / rules). */
  activeProvider: ProviderId | null;
  /** Provider preferred to answer first. */
  preferredProvider: ProviderId | null;
  webllm: WebLLMStatus;
  toggle(): void;
  stop(): void;
  toggleTeachMode(): void;
  togglePcControl(): void;
  send(text: string): void;
  /** Push an assistant message + speak it (used to report action results). */
  say(text: string): void;

  /**
   * Fire-and-forget a successful Gemini exchange to /api/learn so the
   * system can distill reusable facts/style rules ("учёба у Gemini").
   */
  learnFromGemini(query: string, reply: string): void;
  /**
   * Resolve a spoken app name (e.g. «майнкрафт») to the exact name in the
   * installed-apps list (e.g. "Minecraft") using the LLM. Returns null if
   * nothing can be resolved.
   */
  resolveLaunch(spoken: string): Promise<string | null>;
  /** Start recording a screen lesson for the given goal. */
  startLesson(goal: string): Promise<void>;
  /** Stop recording and ask Gemini to turn the frames into a skill. */
  stopLesson(): Promise<void>;
  /** Execute a learned skill step by step. */
  runSkill(skillId: string): Promise<void>;
  /** Forget a learned skill. */
  forgetSkill(id: string): void;
  clearLog(): void;
  forgetAll(): void;
  cycleProvider(): void;
  loadWebLLM(): Promise<void>;
}

/** Pull the first JSON object out of a model reply; tolerate extra text. */
function parseLLMContent(content: string): { text: string; parsed?: LLMParsed } {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (obj && typeof obj === "object") {
        const parsed = obj as LLMParsed;
        const reply =
          typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : "";
        return { text: reply, parsed };
      }
    } catch {
      // Not valid JSON — treat the whole thing as the reply.
    }
  }
  return { text: trimmed };
}

interface WeatherPayload {
  city: string;
  temp: number;
  feelsLike: number;
  humidity: number;
  windKmh: number;
  precipMm: number;
  isDay: boolean;
  condition: string;
}

function formatWeatherReply(w: WeatherPayload): string {
  const sign = w.temp > 0 ? "+" : "";
  let out = `Сейчас в ${w.city} ${sign}${w.temp}°, ${w.condition}.`;
  if (w.precipMm > 0) out += ` Осадки ${w.precipMm.toFixed(1)} мм.`;
  if (w.windKmh >= 10) out += ` Ветер ${w.windKmh} км/ч.`;
  out += ` Влажность ${w.humidity}%.`;
  return out;
}

/** Human description of a skill step (used for confirmations and the log). */
function describeStep(step: SkillStep): string {
  const pt = (v: unknown): string => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : "?";
  };
  switch (step.action) {
    case "launch":
      return `запустить «${String(step.params.app ?? "")}»`;
    case "url":
      return `открыть «${String(step.params.url ?? "")}»`;
    case "type":
      return `ввести «${String(step.params.text ?? "")}»`;
    case "smart-type":
      return `ввести «${String(step.params.text ?? "")}»${step.params.enter ? " и Enter" : ""}`;
    case "key":
      return `нажать ${String(step.params.key ?? "")}`;
    case "wait":
      return `подождать ${Math.round(Number(step.params.ms) || 0)} мс`;
    case "click":
      return `кликнуть (${pt(step.params.x)}, ${pt(step.params.y)})`;
    case "double-click":
      return `двойной клик (${pt(step.params.x)}, ${pt(step.params.y)})`;
    case "right-click":
      return `клик правой (${pt(step.params.x)}, ${pt(step.params.y)})`;
    case "move":
      return `навести курсор (${pt(step.params.x)}, ${pt(step.params.y)})`;
    case "drag":
      return `перетащить (${pt(step.params.x1)}, ${pt(step.params.y1)}) → (${pt(step.params.x2)}, ${pt(step.params.y2)})`;
    case "scroll":
      return `прокрутить ${String(step.params.dir ?? "")} на ${Number(step.params.lines) || 3}`;
    case "focus":
      return `сфокусировать окно «${String(step.params.title ?? step.params.app ?? "")}»`;
    case "clear":
      return `очистить поле`;
    case "copy":
      return `копировать (Ctrl+C)`;
    case "paste":
      return `вставить (Ctrl+V)`;
    case "maximize":
      return `развернуть окно на весь экран`;
    case "minimize":
      return `свернуть окно`;
    case "close":
      return `закрыть окно`;
    case "restore":
      return `восстановить окно`;
    case "toggle-maximize":
      return `переключить размер окна`;
  }
  return "выполнить действие";
}

/**
 * Wires the AssistantBrain to raw speech I/O and the LLM gateway. Every
 * recognized phrase (voice) or submitted line (text box) goes through the
 * brain first: known rules/commands are handled instantly and offline. If the
 * brain doesn't understand, the phrase escalates to the best available model
 * (WebLLM → Ollama → Gemini), whose JSON reply may carry an
 * action to run and facts/commands to memorize.
 */
export function useVoiceAssistant(handlers: AssistantHandlers): VoiceAssistantApi {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const brainRef = useRef<AssistantBrain | null>(null);
  if (brainRef.current === null) brainRef.current = new AssistantBrain();
  const brain = brainRef.current;

  const llm = useMemo(() => createAssistantLLM(), []);

  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [teachMode, setTeachMode] = useState(brain.teachMode);
  const [learnedCount, setLearnedCount] = useState(brain.memoryCount);
  const [pcControl, setPcControlState] = useState(brain.pcControlEnabled);
  const [skills, setSkills] = useState<Skill[]>(() => brain.skillList);
  const [lesson, setLesson] = useState<{ goal: string; frames: number } | null>(null);
  const [activeProvider, setActiveProvider] = useState<ProviderId | null>(null);
  const [preferredProvider, setPreferredProvider] = useState<ProviderId | null>(null);
  const [webllm, setWebllm] = useState<WebLLMStatus>(() => ({ ...getWebLLMStatus() }));
  const nextIdRef = useRef(1);
  const messagesRef = useRef<AssistantMessage[]>([]);
  const lessonRef = useRef<ScreenLesson | null>(null);
  const lessonTimerRef = useRef<number | null>(null);
  const runRef = useRef<{ cancelled: boolean } | null>(null);
  const confirmRef = useRef<{ skillId: string } | null>(null);

  const push = useCallback((role: AssistantMessage["role"], text: string, image?: AssistantMessage["image"]): number => {
    const id = nextIdRef.current++;
    const msg: AssistantMessage = { id, role, text, at: Date.now(), ...(image ? { image } : {}) };
    messagesRef.current = [...messagesRef.current.slice(-49), msg];
    setMessages(messagesRef.current);
    return id;
  }, []);

  const speakRef = useRef<(text: string) => void>(() => {});
  const voice = useVoiceCommands({ onHear: (t) => void handle(t) });
  speakRef.current = voice.speak;

  const handleWeather = useCallback(
    async (city: string) => {
      try {
        const res = await fetch(`/api/weather?city=${encodeURIComponent(city)}`);
        if (!res.ok) throw new Error(`weather ${res.status}`);
        const data = (await res.json()) as WeatherPayload;
        const reply = formatWeatherReply(data);
        push("ai", reply);
        speakRef.current(reply);
      } catch {
        const fallback = `Не удалось получить погоду в городе «${city}». Проверь название или повтори позже.`;
        push("ai", fallback);
        speakRef.current(fallback);
      }
    },
    [push],
  );

  /**
   * «найди X» / «изучи <тема>» — run the web-search + learn pipeline on the
   * server (/api/assistant executes the search, answers with sources and, for
   * learn requests, stores a StudyNote in the shared brain).
   */
  const handleSearch = useCallback(
    async (query: string, learn: boolean) => {
      push("ai", learn ? "Ищу и изучаю…" : "Ищу информацию…");
      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `${learn ? "изучи" : "найди"} ${query}` }),
          signal: AbortSignal.timeout(120_000),
        });
        const data = (await res.json().catch(() => null)) as { reply?: string } | null;
        const reply = data?.reply ?? "Не удалось найти информацию. Попробуйте позже.";
        push("ai", reply);
        speakRef.current(reply);
      } catch (err) {
        console.warn("[voice] search failed:", err);
        const msg = "Поиск не удался. Попробуйте позже.";
        push("ai", msg);
        speakRef.current(msg);
      }
    },
    [push],
  );

  const handleListApps = useCallback(async () => {
    try {
      const res = await fetch("/api/apps");
      if (!res.ok) throw new Error(`apps ${res.status}`);
      const data = (await res.json()) as { count?: number; apps?: string[] };
      const list = Array.isArray(data.apps) ? data.apps : [];
      if (list.length === 0) {
        const none = "Не нашёл установленных приложений.";
        push("ai", none);
        speakRef.current(none);
        return;
      }
      const sample = list.slice(0, 12).join(", ");
      const reply = `Установлено ${data.count ?? list.length} приложений. Например: ${sample}.`;
      push("ai", reply);
      speakRef.current(reply);
    } catch {
      const fb = "Не удалось прочитать список установленных приложений.";
      push("ai", fb);
      speakRef.current(fb);
    }
  }, [push]);

  const LESSON_SAMPLE_MS = 2500;

  /** Generate an image via the Gemini image model and show it in the log. */
  const handleImage = useCallback(
    async (prompt: string) => {
      push("ai", "Генерирую изображение…");
      try {
        const res = await fetch("/api/image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          const msg = `Не удалось сгенерировать изображение: ${body?.error ?? res.status}.`;
          push("ai", msg);
          speakRef.current(msg);
          return;
        }
        const data = (await res.json()) as { b64?: string; mime?: string };
        if (!data.b64) {
          const msg = "Не удалось сгенерировать изображение.";
          push("ai", msg);
          speakRef.current(msg);
          return;
        }
        push("ai", "Изображение готово.", { b64: data.b64, mime: data.mime ?? "image/png" });
      } catch (err) {
        console.warn("[image] request failed:", err);
        const msg = "Связь с сервером прервалась во время генерации изображения.";
        push("ai", msg);
        speakRef.current(msg);
      }
    },
    [push],
  );

  /**
   * «изучи <url>» — fetch a page (or a YouTube video's transcript via
   * /api/fetch), build a StudyNote with the LLM, store it in the brain so
   * generation can reuse the knowledge later. Videos are chunked so EVERYTHING
   * said is captured, not just the opening.
   */
  const handleLearnUrl = useCallback(
    async (url: string) => {
      try {
        const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          const msg = `Не удалось скачать страницу: ${body?.error ?? res.status}.`;
          push("ai", msg);
          speakRef.current(msg);
          return;
        }
        const data = (await res.json()) as {
          title?: string;
          text?: string;
          isVideo?: boolean;
          durationSec?: number | null;
        };
        const text = data.text ?? "";
        if (!text) {
          const msg = "Страница пуста — нечего изучать.";
          push("ai", msg);
          speakRef.current(msg);
          return;
        }
        if (data.isVideo) {
          const mins = data.durationSec ? Math.round(data.durationSec / 60) : 0;
          const status = mins > 0
            ? `Анализирую видео (~${mins} мин, ${(text.length / 1000).toFixed(1)} тыс. символов)…`
            : "Анализирую видео…";
          push("ai", status);
        } else {
          push("ai", "Анализирую содержимое…");
        }
        const note = await buildStudyNote({
          text,
          title: data.title,
          url,
          isVideo: data.isVideo === true,
          complete: async (messages) => {
            const r = await llm.router.complete(messages.map((m) => ({ role: m.role, content: m.content })));
            return r.content;
          },
        });
        brain.addNote({
          topic: note.topic,
          summary: note.summary,
          keyPoints: note.keyPoints,
          source: url,
          ...(data.isVideo ? { chapters: note.chapters, fullText: note.fullText } : {}),
        });
        setLearnedCount(brain.memoryCount);
        const msg = data.isVideo
          ? `Изучил видео: «${note.topic}» (${note.chapters?.length ?? 0} разделов, полный текст сохранён).`
          : `Изучил: «${note.topic}».`;
        push("ai", msg);
        speakRef.current(msg);
      } catch (err) {
        console.warn("[learn-url] failed:", err);
        const msg = "Не удалось изучить страницу.";
        push("ai", msg);
        speakRef.current(msg);
      }
    },
    [brain, llm, push],
  );

  const startLesson = useCallback(
    async (goal: string) => {
      if (lessonRef.current) return;
      const session = new ScreenLesson(goal);
      lessonRef.current = session;
      const ok = await session.start();
      if (!ok) {
        lessonRef.current = null;
        const msg = "Не удалось захватить экран. Возможно, доступ запрещён.";
        push("ai", msg);
        speakRef.current(msg);
        return;
      }
      brain.lessonActive = true;
      setLesson({ goal, frames: 0 });
      const msg = `Урок «${goal}» записывается. Покажите, как это делается. Скажите «хватит», когда закончите.`;
      push("ai", msg);
      speakRef.current(msg);
      const timer = window.setInterval(() => {
        const frame = lessonRef.current?.sample();
        if (frame) {
          const count = lessonRef.current?.frameCount ?? 0;
          setLesson((l) => (l ? { ...l, frames: count } : l));
        }
      }, LESSON_SAMPLE_MS);
      lessonTimerRef.current = timer;
    },
    [brain, push],
  );

  const stopLesson = useCallback(async () => {
    const session = lessonRef.current;
    if (lessonTimerRef.current !== null) {
      window.clearInterval(lessonTimerRef.current);
      lessonTimerRef.current = null;
    }
    lessonRef.current = null;
    brain.lessonActive = false;
    setLesson(null);
    if (!session) {
      const msg = "Урок не записывается.";
      push("ai", msg);
      speakRef.current(msg);
      return;
    }
    const skill = await session.conclude();
    if (!skill) {
      const msg = "Не получилось разобрать урок. Попробуйте ещё раз.";
      push("ai", msg);
      speakRef.current(msg);
      return;
    }
    brain.saveSkill(skill);
    setSkills(brain.skillList);
    const msg = `Урок запомнен: «${skill.name}» — ${skill.steps.length} шагов. Скажите «как открыть ${skill.name}» или «выполни навык ${skill.name}».`;
    push("ai", msg);
    speakRef.current(msg);
  }, [brain, push]);

  const runSkill = useCallback(
    async (skillId: string, startFrom = 0, confirmed = false) => {
      const skill = brain.skillList.find((s) => s.id === skillId);
      if (!skill || skill.steps.length === 0) return;

      // Confirm only the very first step; everything after runs automatically.
      if (startFrom === 0 && !confirmed) {
        confirmRef.current = { skillId };
        const first = skill.steps[0];
        const msg = `Навык «${skill.name}». Первый шаг: ${first.text ?? describeStep(first)}. Разрешаете выполнять? Скажите «да» или «нет».`;
        push("ai", msg);
        speakRef.current(msg);
        return;
      }

      confirmRef.current = null;
      const run = { cancelled: false };
      runRef.current = run;

      for (let i = startFrom; i < skill.steps.length; i++) {
        if (run.cancelled || runRef.current !== run) break;
        const step = skill.steps[i];
        push("ai", `Шаг ${i + 1}/${skill.steps.length}: ${step.text ?? describeStep(step)}`);
        try {
          const res = await fetch("/api/do-step", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: step.action, params: step.params }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            const msg = `Шаг ${i + 1} не удался: ${body?.error ?? res.status}.`;
            push("ai", msg);
            speakRef.current("Шаг не удался.");
            break;
          }
          await new Promise((r) => setTimeout(r, 400));
        } catch (err) {
          console.warn("[voice] step request failed:", err);
          push("ai", `Шаг ${i + 1} не удался: связь прервалась.`);
          break;
        }
      }

      runRef.current = null;
      if (!run.cancelled) {
        const done = `Навык «${skill.name}» выполнен.`;
        push("ai", done);
        speakRef.current("Готово.");
      }
    },
    [brain, push],
  );

  const forgetSkill = useCallback(
    (id: string) => {
      const gone = brain.forgetSkill(id);
      setSkills(brain.skillList);
      if (gone) {
        const msg = `Забыл навык «${gone.name}».`;
        push("ai", msg);
        speakRef.current(msg);
      }
    },
    [brain, push],
  );

  // Tear down any running lesson/skill run when the assistant unmounts.
  useEffect(
    () => () => {
      if (lessonTimerRef.current !== null) window.clearInterval(lessonTimerRef.current);
      lessonRef.current?.dispose();
      runRef.current = null;
      confirmRef.current = null;
    },
    [],
  );

  const handle = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      push("user", trimmed);

      // Local intents that need the server (can't be answered by the offline brain).
      const norm = normalize(trimmed);

      // A skill run is waiting for explicit permission for its first step.
      if (confirmRef.current) {
        if (/да|давай|ок|окей|хорошо|погнали|запускай|конечно|можно/.test(norm)) {
          const { skillId } = confirmRef.current;
          confirmRef.current = null;
          push("ai", "Выполняю.");
          speakRef.current("Выполняю.");
          await runSkill(skillId, 0, true);
        } else if (/нет|не надо|отмена|позже|не хочу|хватит|стоп|останови/.test(norm)) {
          confirmRef.current = null;
          runRef.current = null;
          const msg = "Отменяю выполнение.";
          push("ai", msg);
          speakRef.current(msg);
        } else {
          const ask = "Скажите «да» или «нет».";
          push("ai", ask);
          speakRef.current(ask);
        }
        return;
      }

      // Abort an in-progress skill run.
      if (runRef.current && /(?:^| )стоп(?: |$)|хватит|останови|прекрати/.test(norm)) {
        runRef.current.cancelled = true;
        const msg = "Останавливаю выполнение навыка.";
        push("ai", msg);
        speakRef.current(msg);
        return;
      }

      if (/(какие (у тебя )?(есть )?приложения|что (у тебя )?установлено|список приложений)/.test(norm)) {
        await handleListApps();
        return;
      }

      const outcome = brain.process(trimmed);

      // Capability analysis («навыки», «навык X», «чего не хватает», «чему ты
      // научился») — the server runs the LLM analysis against the shared brain.
      if (outcome.needsAbilityAnalysis) {
        push("ai", "Анализирую…");
        try {
          const res = await fetch("/api/assistant", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: trimmed }),
            signal: AbortSignal.timeout(120_000),
          });
          const data = (await res.json().catch(() => null)) as { reply?: string } | null;
          const reply = data?.reply ?? "Не удалось проанализировать способности.";
          push("ai", reply);
          speakRef.current(reply);
        } catch (err) {
          console.warn("[voice] ability analysis failed:", err);
          const msg = "Анализ способностей не удался. Попробуйте позже.";
          push("ai", msg);
          speakRef.current(msg);
        }
        return;
      }

      if (outcome.handled) {
        setLearnedCount(brain.memoryCount);
        setPcControlState(brain.pcControlEnabled);
        setSkills(brain.skillList);
        push("ai", outcome.reply);
        speakRef.current(outcome.reply);

        // Periodic audit: 10% of brain-handled queries get compared with LLM (fire-and-forget).
        if (Math.random() < 0.1 && outcome.action) {
          void fetch("/api/meta-analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: trimmed,
              brainHandled: true,
              brainReply: outcome.reply,
              brainAction: outcome.action ?? null,
              llmReply: "", // server will call LLM for comparison
            }),
          }).catch(() => {});
        }
        if (outcome.action) {
          switch (outcome.action.kind) {
            case "start-lesson":
              void startLesson(outcome.action.goal);
              break;
            case "stop-lesson":
              void stopLesson();
              break;
            case "run-skill":
              void runSkill(outcome.action.skillId);
              break;
            case "learn-url":
              void handleLearnUrl(outcome.action.url);
              break;
            case "search":
              void handleSearch(outcome.action.query, outcome.action.learn === true);
              break;
            case "weather":
              void handleWeather(outcome.action.city);
              break;
            case "image":
              void handleImage(outcome.action.prompt);
              break;
            default:
              handlersRef.current.onAction?.(outcome.action);
          }
        }
        return;
      }

      // Unknown phrase → ask the best available model.
      const history: ChatMessage[] = messagesRef.current
        .slice(-10)
        .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
      push("ai", "Думаю…");
      try {
        const result = await llm.router.complete([
          { role: "system", content: brain.buildSystemPrompt(trimmed, { brief: true }) },
          ...history,
          { role: "user", content: trimmed },
        ]);
        setActiveProvider(result.provider);

        const { text: replyText, parsed } = parseLLMContent(result.content);
        if (result.provider === "gemini") {
          learnFromGemini(trimmed, replyText);
        }
        const reply = replyText || "Выполнено.";
        const action = parsed?.action ? brain.resolveLLMAction(parsed.action) ?? undefined : undefined;
        const added =
          parsed?.learn && Array.isArray(parsed.learn)
            ? brain.learnFromLLM(parsed.learn as LLMLearnItem[])
            : 0;
        setLearnedCount(brain.memoryCount);
        setPcControlState(brain.pcControlEnabled);

        const finalReply = added > 0 ? `${reply} Запомнил.` : reply;
        push("ai", finalReply);
        speakRef.current(finalReply);

        // Meta-learning: send interaction data for algorithm generation (fire-and-forget).
        void fetch("/api/meta-analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: trimmed,
            brainHandled: false,
            llmReply: reply,
            llmAction: action ?? null,
          }),
        }).catch(() => {});

        const generated =
          typeof parsed?.generate === "string" && parsed.generate.trim() ? parsed.generate.trim() : "";
        if (generated) {
          push("ai", generated);
        }

        if (action) {
          if (action.kind === "weather") {
            void handleWeather(action.city);
          } else if (action.kind === "launch") {
            const offered = brain.offerAction(action);
            if (offered.reply) {
              push("ai", offered.reply);
              speakRef.current(offered.reply);
            } else {
              handlersRef.current.onAction?.(action);
            }
          } else if (action.kind === "image") {
            void handleImage(action.prompt);
          } else if (action.kind === "search") {
            void handleSearch(action.query, action.learn === true);
          } else if (action.kind === "learn-url") {
            void handleLearnUrl(action.url);
          } else {
            handlersRef.current.onAction?.(action);
          }
        }
      } catch (err) {
        console.warn("[llm] escalation failed:", err);
        setActiveProvider(null);
        const fallbackPrompt = extractImagePrompt(trimmed);
        if (fallbackPrompt) {
          const msg = "Генерирую изображение…";
          push("ai", msg);
          speakRef.current(msg);
          void handleImage(fallbackPrompt);
          return;
        }
        const fallback =
          "Все языковые модели сейчас недоступны (исчерпаны лимиты или нет связи). " +
          "Попробуйте готовые команды: «погода в <город>», «навыки», «помощь», «найди <запрос>».";
        push("ai", fallback);
        speakRef.current(fallback);
      }
    },
    [brain, llm, push, handleWeather, handleSearch, handleListApps, startLesson, stopLesson, runSkill, handleImage, handleLearnUrl],
  );
  const send = useCallback(
    (text: string) => {
      void handle(text);
    },
    [handle],
  );

  const say = useCallback(
    (text: string) => {
      if (!text) return;
      push("ai", text);
      speakRef.current(text);
    },
    [push],
  );

  const learnFromGemini = useCallback((query: string, reply: string) => {
    if (!query || !reply) return;
    void fetch("/api/learn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, reply }),
    }).catch(() => {});
  }, []);

  const resolveLaunch = useCallback(
    async (spoken: string): Promise<string | null> => {
      try {
        const res = await fetch("/api/apps");
        if (!res.ok) return null;
        const data = (await res.json()) as { apps?: string[] };
        const names = Array.isArray(data.apps) ? data.apps : [];
        if (names.length === 0) return null;

        const result = await llm.router.complete([
          {
            role: "system",
            content:
              "Ты — помощник, который сопоставляет название приложения, произнесённое по-русски, с точным названием в списке установленных программ (например «майнкрафт» = Minecraft, «гугл хром» = Google Chrome). Отвечай СТРОГО одним словом — точным названием из списка, либо ровно словом none.",
          },
          {
            role: "user",
            content: `Установленные приложения: ${names.join(", ")}.\nПользователь сказал: «${spoken}».\nКакое приложение он имеет в виду?`,
          },
        ]);

        const answer = result.content.trim().toLowerCase().replace(/[."]+/g, "").trim();
        if (!answer || answer === "none") return null;
        const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
        const exact = names.find((n) => norm(n) === answer);
        if (exact) return exact;
        return (
          names.find((n) => norm(n).includes(answer) || answer.includes(norm(n))) ?? null
        );
      } catch {
        return null;
      }
    },
    [llm],
  );

  const toggleTeachMode = useCallback(() => {
    brain.teachMode = !brain.teachMode;
    setTeachMode(brain.teachMode);
    push(
      "ai",
      brain.teachMode
        ? "Режим обучения включён: просто скажи фразу, и я её запомню."
        : "Режим обучения выключен.",
    );
  }, [brain, push]);

  const togglePcControl = useCallback(() => {
    brain.setPcControl(!brain.pcControlEnabled);
    setPcControlState(brain.pcControlEnabled);
    push(
      "ai",
      brain.pcControlEnabled
        ? "Доступ к управлению ПК предоставлен. Приложения запускаю без вопросов."
        : "Доступ к управлению ПК отозван. Перед запуском буду спрашивать разрешение.",
    );
  }, [brain, push]);

  const clearLog = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
  }, []);

  const forgetAll = useCallback(() => {
    brain.clear();
    setLearnedCount(0);
    setSkills([]);
    push("ai", "Память стёрта. Обучай меня заново.");
  }, [brain, push]);

  const cycleProvider = useCallback(() => {
    const next = llm.router.cyclePreferred();
    if (next) setPreferredProvider(next);
  }, [llm]);

  const loadWebLLM = useCallback(async () => {
    setWebllm({ ...getWebLLMStatus() });
    const timer = setInterval(() => setWebllm({ ...getWebLLMStatus() }), 300);
    try {
      await loadWebLLMEngine();
    } finally {
      clearInterval(timer);
      setWebllm({ ...getWebLLMStatus() });
    }
  }, []);

  // Learn which cloud keys exist on the server.
  useEffect(() => {
    void llm.refresh();
  }, [llm]);

  // One-way sync with the server brain (data/brain.json), the single source of
  // truth shared with the Telegram bot. The browser pushes every local change
  // immediately (save → PUT /api/brain) and pulls the server state back on
  // mount, periodically and on tab focus — mirroring it wholesale so memory,
  // skills and abilities are identical on both sides at all times.
  const pullServer = useCallback(async (): Promise<void> => {
    // A local change is still in flight — pulling now could clobber it.
    if (brain.syncDirty) return;
    try {
      const res = await fetch("/api/brain");
      if (!res.ok) return;
      const data = (await res.json()) as { brain?: BrainSnapshot | null };
      if (!data.brain || data.brain.version !== 1) return;
      brain.setServerBase(snapshotIds(data.brain));
      if (brain.mirrorKnowledge(data.brain)) {
        // Persist the mirrored state locally + confirm it on disk.
        brain.forceSync();
        setSkills(brain.skillList);
        setLearnedCount(brain.memoryCount);
        setPcControlState(brain.pcControlEnabled);
      }
    } catch {
      // Server not running — keep whatever localStorage had.
    }
  }, [brain]);

  // On mount: push local knowledge first (so the server never loses
  // browser-only material), then pull the authoritative state back. This
  // restores the local brain after a localStorage clear and keeps both brains
  // aligned from the first second.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      brain.forceSync();
      for (let i = 0; i < 20 && brain.syncDirty; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!cancelled) await pullServer();
    })();
    return () => {
      cancelled = true;
    };
  }, [brain, pullServer]);

  // Keep both brains in sync while the page is open: pull every 25s and on
  // returning to the tab.
  useEffect(() => {
    const timer = window.setInterval(() => void pullServer(), 25_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void pullServer();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [pullServer]);

  return {
    supported: voice.supported,
    listening: voice.listening,
    speaking: voice.speaking,
    voiceId: voice.voiceId,
    setVoice: voice.setVoice,
    teachMode,
    learnedCount,
    pcControl,
    messages,
    skills,
    lesson,
    activeProvider,
    preferredProvider,
    webllm,
    toggle: voice.toggle,
    stop: voice.stop,
    toggleTeachMode,
    togglePcControl,
    send,
    say,
    learnFromGemini,
    resolveLaunch,
    startLesson,
    stopLesson,
    runSkill,
    forgetSkill,
    clearLog,
    forgetAll,
    cycleProvider,
    loadWebLLM,
  };
}
