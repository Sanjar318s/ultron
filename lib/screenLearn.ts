/**
 * ScreenLesson — client-side "learn by demonstration" for the ULTRON assistant.
 * No React, no Three.js: it owns the getDisplayMedia stream, a hidden <video>,
 * frame sampling with change-deduplication, and the Gemini analysis that turns
 * the captured frames into an executable Skill.
 *
 * Flow: start() → sample() every ~2.5s while the user demonstrates →
 * conclude() sends the frames to Gemini and parses a JSON step list.
 * The caller (hook) owns the sampling timer and reports status; this class
 * only captures, dedupes and analyzes.
 */

import type { ChatMessage } from "@/lib/llm/types";
import type { Skill, SkillStep, SkillStepAction } from "@/lib/assistantBrain";

const SAMPLE_WIDTH_CAP = 1280;
const JPEG_QUALITY = 0.72;
/** Frames sent to the model per lesson (caps payload + cost). */
const MAX_ANALYZED_FRAMES = 14;
const MAX_JSON_STEPS = 20;

const LEARN_SYSTEM_PROMPT = [
  "Ты — система, обучающаяся на демонстрации экрана.",
  "Пользователь показал, как выполняется задача, на серии скриншотов (по порядку, между кадрами 2-3 секунды).",
  "Возможные действия: launch (запустить приложение или открыть URL, params.app), url (открыть URL, params.url), type (ввести текст, params.text), key (нажать клавишу, params.key: Enter, Tab, Escape, Ctrl+V, Delete...), wait (подождать, params.ms), click (кликнуть по координатам экрана, params.x и params.y — ОБЯЗАТЕЛЬНО относительные 0..1, где 0 — левый/верхний край, 1 — правый/нижний), double-click (двойной клик, params.x/y), right-click (клик правой кнопкой, params.x/y), move (навести курсор без клика, params.x/y), drag (перетащить от params.x1,y1 к params.x2,y2), scroll (прокрутить: params.dir = up|down|left|right, params.lines — сколько «колесиком»), focus (сфокусировать окно: params.title или params.app), clear (очистить поле: Ctrl+A + Delete), smart-type (ввести текст и нажать Enter, если params.enter = true), copy (Ctrl+C), paste (Ctrl+V).",
  "Верни ТОЛЬКО валидный JSON без пояснений и без markdown: {\"name\": \"<короткое имя навыка, 2-5 слов>\", \"steps\": [{\"action\": \"...\", \"params\": {...}, \"text\": \"<описание шага для пользователя>\"}, ...]}.",
  "Включай только действия, которые реально видно на кадрах. Для кликов определяй относительные координаты по видимым элементам интерфейса.",
  "Если что-то не видно однозначно — всё равно дай лучшую догадку, не пропускай шаг.",
  `Максимум ${MAX_JSON_STEPS} шагов.`,
].join("\n");

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function coerceStep(raw: unknown): SkillStep | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as { action?: unknown; params?: unknown; text?: unknown };
  const allowed: SkillStepAction[] = [
    "launch", "url", "type", "key", "wait", "click",
    "double-click", "right-click", "move", "drag", "scroll",
    "focus", "clear", "smart-type", "copy", "paste",
  ];
  const rawAction = typeof o.action === "string" ? o.action : "";
  if (!allowed.includes(rawAction as SkillStepAction)) return null;
  const action = rawAction as SkillStepAction;
  const params: Record<string, string | number> = {};
  const p = (typeof o.params === "object" && o.params !== null ? o.params : {}) as Record<string, unknown>;

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : null;
  const coord = (v: unknown): number | null => {
    const n = num(v);
    return n === null ? null : Math.min(Math.max(n, 0), 1);
  };

  switch (action) {
    case "launch": {
      const app = typeof p.app === "string" ? p.app.trim() : "";
      if (!app) return null;
      params.app = app;
      break;
    }
    case "url": {
      const url = typeof p.url === "string" ? p.url.trim() : "";
      if (!url) return null;
      params.url = url;
      break;
    }
    case "type":
    case "smart-type": {
      const text = typeof p.text === "string" ? p.text : "";
      if (!text) return null;
      params.text = text;
      if (action === "smart-type" && (p.enter === true || p.enter === "true")) params.enter = 1;
      break;
    }
    case "key": {
      const key = typeof p.key === "string" ? p.key.trim() : "";
      if (!key) return null;
      params.key = key;
      break;
    }
    case "wait": {
      const ms = num(p.ms) ?? 1500;
      params.ms = Math.min(Math.max(Math.round(ms), 100), 30_000);
      break;
    }
    case "click":
    case "double-click":
    case "right-click":
    case "move": {
      const x = coord(p.x);
      const y = coord(p.y);
      if (x === null || y === null) return null;
      params.x = x;
      params.y = y;
      break;
    }
    case "drag": {
      const x1 = coord(p.x1);
      const y1 = coord(p.y1);
      const x2 = coord(p.x2);
      const y2 = coord(p.y2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) return null;
      params.x1 = x1;
      params.y1 = y1;
      params.x2 = x2;
      params.y2 = y2;
      break;
    }
    case "scroll": {
      const dir = typeof p.dir === "string" ? p.dir.trim().toLowerCase() : "";
      if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") return null;
      params.dir = dir;
      params.lines = Math.min(Math.max(Math.round(num(p.lines) ?? num(p.amount) ?? 3), 1), 20);
      break;
    }
    case "focus": {
      const title = typeof p.title === "string" ? p.title.trim() : "";
      const app = typeof p.app === "string" ? p.app.trim() : "";
      if (!title && !app) return null;
      if (title) params.title = title;
      if (app) params.app = app;
      break;
    }
    case "clear":
    case "copy":
    case "paste":
      break;
  }

  const text = typeof o.text === "string" && o.text.trim() ? o.text.trim().slice(0, 200) : undefined;
  return { action, params, text };
}

/** Parse Gemini's JSON answer into a Skill, or null if it's unusable. */
export function parseSkillJSON(text: string): Skill | null {
  try {
    const obj = JSON.parse(stripFences(text)) as { name?: unknown; steps?: unknown };
    const name =
      typeof obj.name === "string" && obj.name.trim() ? obj.name.trim().slice(0, 60) : "выученный навык";
    if (!Array.isArray(obj.steps) || obj.steps.length === 0) return null;
    const steps = obj.steps.slice(0, MAX_JSON_STEPS).map(coerceStep).filter((s): s is SkillStep => s !== null);
    if (steps.length === 0) return null;
    return {
      id: `sk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      goal: name,
      steps,
      createdAt: Date.now(),
      uses: 0,
    };
  } catch {
    return null;
  }
}

function thumbnailHash(video: HTMLVideoElement): string {
  const w = 96;
  const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * w));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "";
  ctx.drawImage(video, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let hash = 0;
  for (let i = 0; i < data.length; i += 16) {
    hash = ((hash << 5) + hash) ^ data[i];
    hash |= 0;
  }
  return String(hash >>> 0);
}

export class ScreenLesson {
  private goal: string;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private frames: string[] = [];
  private lastHash: string | null = null;
  private disposed = false;

  constructor(goal: string) {
    this.goal = goal;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Ask the browser for a screen stream and wire up the hidden video. */
  async start(): Promise<boolean> {
    if (this.disposed) return false;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 15 } },
        audio: false,
      });
      if (this.disposed) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      this.stream = stream;
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      this.video = video;
      this.canvas = document.createElement("canvas");
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
      return true;
    } catch {
      this.dispose();
      return false;
    }
  }

  /**
   * Capture the current frame. Returns a JPEG data URI only when the screen
   * visibly changed since the previous sample (dedupe), else null.
   */
  sample(): string | null {
    if (this.disposed || !this.video || !this.canvas || !this.ctx) return null;
    const video = this.video;
    if (video.readyState < 2 || video.videoWidth === 0) return null;

    const hash = thumbnailHash(video);
    if (hash === this.lastHash) return null;
    this.lastHash = hash;

    const w = Math.min(video.videoWidth, SAMPLE_WIDTH_CAP);
    const h = Math.round(video.videoHeight * (w / video.videoWidth));
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(video, 0, 0, w, h);
    const dataUri = this.canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    this.frames.push(dataUri);
    return dataUri;
  }

  /** Stop capture and have Gemini turn the collected frames into a Skill. */
  async conclude(): Promise<Skill | null> {
    const frames = this.frames.slice(0, MAX_ANALYZED_FRAMES);
    this.dispose();
    if (frames.length === 0) return null;

    const imageParts = frames.map((dataUri) => {
      const comma = dataUri.indexOf(",");
      const meta = dataUri.slice(0, comma);
      const mimeType = /^data:([^;]+)/.exec(meta)?.[1] ?? "image/jpeg";
      return { type: "image" as const, mimeType, data: dataUri.slice(comma + 1) };
    });

    const messages: ChatMessage[] = [
      { role: "system", content: LEARN_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: `Цель пользователя: «${this.goal}». Определи последовательность шагов по кадрам.` },
          ...imageParts,
        ],
      },
    ];

    try {
      const res = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini", messages, temperature: 0.1, maxTokens: 1500 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(`${res.status} ${body?.error ?? ""}`);
      }
      const data = (await res.json()) as { content?: string };
      const skill = parseSkillJSON(data.content ?? "");
      if (!skill) throw new Error("unparseable steps");
      skill.goal = this.goal;
      return skill;
    } catch (err) {
      console.warn("[screenLearn] analyze failed:", err);
      return null;
    }
  }

  /** Stop the stream and drop the hidden video. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.canvas = null;
    this.ctx = null;
  }
}
