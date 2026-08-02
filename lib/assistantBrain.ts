/**
 * AssistantBrain — pure client-side "growing brain" for the ULTRON voice
 * assistant. No React, no Three.js, no network.
 *
 * It answers from a built-in intent set and — importantly — LEARNS: the user
 * can teach it new phrases via «выучи <фраза>» (or the teach mode). Learned
 * rules and facts persist to localStorage, so the assistant literally
 * develops between sessions.
 *
 * When a phrase matches nothing, process() returns handled:false so the
 * caller can escalate to an LLM. The LLM replies with JSON
 * { reply, action, learn }, and learnFromLLM() stores what the model decides
 * the user wants remembered — that's how "training by conversation" works.
 */

export type AssistantAction =
  | { kind: "zoom-in" }
  | { kind: "zoom-out" }
  | { kind: "reset" }
  | { kind: "gestures-on" }
  | { kind: "gestures-off" }
  | { kind: "stop" }
  | { kind: "launch"; app: string; url?: string }
  | { kind: "weather"; city: string }
  | { kind: "start-lesson"; goal: string }
  | { kind: "stop-lesson" }
  | { kind: "run-skill"; skillId: string }
  | { kind: "learn-url"; url: string }
  | { kind: "image"; prompt: string; text?: string }
  | { kind: "search"; query: string; learn?: boolean };

/** Action spec as returned by an LLM: a named string or a launch/weather/run-skill/image/search object. */
export type LLMActionSpec =
  | string
  | { type: "launch"; app: string }
  | { type: "weather"; city: string }
  | { type: "run-skill"; skill: string }
  | { type: "image"; prompt: string; text?: string }
  | { type: "search"; query: string; learn?: boolean };

export interface LLMLearnItem {
  type: "fact" | "command";
  /** For facts: the statement to remember. */
  text?: string;
  /** For commands: the phrase to recognize. */
  trigger?: string;
  /** For commands: what to reply when the trigger is heard. */
  response?: string;
  /** For commands: optional action to run when the trigger is heard. */
  action?: LLMActionSpec;
}

export interface LearnedRule {
  id: string;
  /** The phrase as the user taught it (kept raw for display). */
  trigger: string;
  /** What the assistant replies when the trigger is heard. */
  reply?: string;
  /** Optional action to run when the trigger is heard. */
  action?: AssistantAction;
  /** How many times the rule fired — the "evolution" signal. */
  usage: number;
  createdAt: number;
  lastUsedAt: number;
}

export type AbilityQuery = "list" | "detail" | "missing" | "learned";

export interface BrainOutcome {
  /** true when the brain itself resolved the phrase (reply is final). */
  handled: boolean;
  reply: string;
  action?: AssistantAction;
  /** When true, the caller must run the LLM ability analysis and answer. */
  needsAbilityAnalysis?: boolean;
  /** Which analysis answer to produce after a (re)calculation. */
  abilityQuery?: AbilityQuery;
  /** Capability name for detail queries. */
  abilityName?: string;
}

/** One executable step of a screen-learned skill. */
export type SkillStepAction = "launch" | "url" | "type" | "key" | "wait" | "click";

export interface SkillStep {
  action: SkillStepAction;
  /** Per-action params: launch.app / url.url / type.text / key.key / wait.ms / click.x+y. */
  params: Record<string, string | number>;
  /** Human-readable description shown before the step runs. */
  text?: string;
}

/** A task the user demonstrated on screen; remembered across sessions. */
export interface Skill {
  id: string;
  /** Short name the assistant can refer to (e.g. «открыть блокнот»). */
  name: string;
  /** The user's original goal («как открыть блокнот»). */
  goal: string;
  steps: SkillStep[];
  createdAt: number;
  /** How many times the skill was executed. */
  uses: number;
  lastUsedAt?: number;
}

/** Knowledge learned from a page/lesson — the "reading" layer of the brain. */
export interface StudyNote {
  id: string;
  /** Short subject line (e.g. «как ИИ пишут тексты»). */
  topic: string;
  /** Compressed essence of the source, usable for generation. */
  summary: string;
  /** Bullet takeaways the assistant can reuse. */
  keyPoints: string[];
  learnedAt: number;
  /** Where the note came from (URL, screen lesson, pasted text…). */
  source?: string;
}

export interface BrainStats {
  interactions: number;
  learnedTotal: number;
  forgotten: number;
}

/**
 * One capability the LLM decided the assistant has, derived from its learned
 * knowledge. `percent` is how complete the capability is (0–100); `missing`
 * lists the concrete knowledge still needed to reach 100%.
 */
export interface AbilityResult {
  /** Capability name, e.g. «Писать тексты». */
  name: string;
  /** What the assistant can do with this capability. */
  description: string;
  /** Mastery 0–100. */
  percent: number;
  /** Knowledge needed to reach 100%. */
  missing: string[];
}

/** Cached LLM ability analysis; invalidated when the knowledge hash changes. */
interface AbilityAnalysis {
  at: number;
  hash: number;
  skills: AbilityResult[];
}

interface PersistedBrain {
  version: 1;
  stats: BrainStats;
  rules: LearnedRule[];
  facts?: string[];
  /** User granted the assistant permanent access to control the PC. */
  pcControl?: boolean;
  /** Screen-learned skills. */
  skills?: Skill[];
  /** Knowledge notes learned from pages/lessons. */
  notes?: StudyNote[];
  /** Cached LLM ability analysis. */
  abilityAnalysis?: AbilityAnalysis;
}

/** Serializable snapshot of the whole brain (server + localStorage payload). */
export interface BrainSnapshot {
  version: 1;
  stats: BrainStats;
  rules: LearnedRule[];
  facts: string[];
  pcControl: boolean;
  skills: Skill[];
  notes: StudyNote[];
  abilities?: AbilityResult[];
  abilityAnalyzedAt?: number;
  abilityHash?: number;
}

const STORAGE_KEY = "ultron.brain.v1";
const EMPTY_STATS: BrainStats = { interactions: 0, learnedTotal: 0, forgotten: 0 };

/**
 * Affirmative/negative replies for the pending-launch confirmation. Text is
 * pre-normalized (lowercased, punctuation stripped, whitespace collapsed), so
 * whole words are delimited by spaces — JS \b doesn't work for Cyrillic.
 */
const CONFIRM_YES =
  /(?:^| )(да|давай|ок|окей|хорошо|ага|конечно|разрешаю|разрешаю запуск|запускай|можно|погнали|согласен)(?: |$)/;
const CONFIRM_NO =
  /(?:^| )(нет|не надо|не запускай|отмена|стоп|позже|не хочу)(?: |$)/;

/** Lowercase, ё→е, punctuation stripped, whitespace collapsed. */
export function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Extract the target phrases from a «забудь эти фразы «а», «б», «в»» request.
 * Works on the raw text (normalization strips the quotes/commas we need).
 */
function extractForgetTargets(raw: string): string[] {
  const guillemets = raw.match(/«([^»]+)»/g);
  if (guillemets) return guillemets.map((s) => s.replace(/[«»]/g, "").trim()).filter(Boolean);
  const quotes = raw.match(/"([^"]+)"/g);
  if (quotes) return quotes.map((s) => s.replace(/"/g, "").trim()).filter(Boolean);
  if (raw.includes(",")) {
    const after = raw.replace(
      /(?:забудь|забыть|удали|удалить|стереть)\s*(?:эти\s+)?(?:фразы|правила|команды)?\s*/i,
      "",
    );
    const parts = after
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 1) return parts;
  }
  return [];
}

/** Single-word triggers that are just confirmation/noise — never auto-learned. */
const JUNK_TRIGGERS = new Set([
  "да", "нет", "нету", "не", "ок", "окей", "ага", "угу", "д", "а", "и", "в", "на",
  "с", "о", "у", "к", "ну", "ты", "он", "она", "оно", "это", "браузер",
]);

function isSaneTrigger(raw: string): boolean {
  const t = normalize(raw);
  return t.length >= 3 && !JUNK_TRIGGERS.has(t);
}

function loadPersisted(): PersistedBrain | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedBrain>;
    if (parsed.version !== 1 || !Array.isArray(parsed.rules)) return null;
    return {
      version: 1,
      stats: { ...EMPTY_STATS, ...(parsed.stats ?? {}) },
      rules: parsed.rules,
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      pcControl: parsed.pcControl === true,
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      abilityAnalysis: parsed.abilityAnalysis,
    };
  } catch {
    return null;
  }
}

/** Common site aliases so «открой ютуб» opens the right page in the browser. */
const SITE_ALIASES: Record<string, string> = {
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

/** Turn a spoken site name into a URL, or null if it isn't clearly a site. */
function resolveSite(raw: string): string | null {
  const q = normalize(raw);
  if (!q) return null;
  const known = SITE_ALIASES[q];
  if (known) return known;
  if (q.startsWith("http")) return q;
  if (/^(www\.|[a-z0-9-]+(\.[a-z0-9-]+)+)/.test(q)) return `https://${q}`;
  return null;
}

/** Fallback for «открой в браузере <что-то>» — search instead of a site. */
function siteSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
}

/**
 * Detect a web-search request («найди X», «поищи X», «изучи <тема>»…).
 * Returns the query and whether the result should also be memorized
 * («найди X и изучи», «изучи <тема>», «исследуй X»). Anchored at the start
 * so unrelated intents (help, weather…) aren't swallowed. URLs are excluded —
 * those go through the learn-url intent.
 */
function extractSearch(text: string): { query: string; learn: boolean } | null {
  const m = text.match(/^(?:найди|поищи|загугли|изучи|исследуй|разбери|проанализируй)\s+(.+)/);
  if (!m) return null;
  let query = m[1].trim();
  if (/^https?:\/\//i.test(query)) return null;
  let learn = false;
  const trailing = query.match(/\s+и\s+(?:изучи|запомни|выучи|разбери)\s*$/);
  if (trailing && trailing.index !== undefined) {
    learn = true;
    query = query.slice(0, trailing.index).trim();
  }
  // «изучи <тема>» / «исследуй …» — not only find, but memorize the result.
  // NB: \b is ASCII-only in JS, so use (?:$|\s) after a Cyrillic keyword.
  if (/^(?:изучи|исследуй|разбери|проанализируй)(?:$|\s)/.test(text)) learn = true;
  if (!query) return null;
  return { query, learn };
}

/** Map a phrase to an executable action (the "reflex" layer). */
function parseAction(norm: string): AssistantAction | null {
  if (/(?:^| )сброс(?: |$)|сбросить|верни вид/.test(norm)) return { kind: "reset" };
  if (/приблиз|увелич|зум ?в|зум ?\+/.test(norm)) return { kind: "zoom-in" };
  if (/отдали|уменьш|зум ?аут|зум ?-/.test(norm)) return { kind: "zoom-out" };
  if (/включи (жест|управ|камер)/.test(norm)) return { kind: "gestures-on" };
  if (/выключи (жест|управ|камер)/.test(norm)) return { kind: "gestures-off" };
  if (/(?:^| )стоп(?: |$)/.test(norm)) return { kind: "stop" };

  // «открой в браузере <x>» / «открой <x> в браузере» / «открой сайт <x>».
  const inBrowser =
    norm.match(/открой (.+) в браузере/) ??
    norm.match(/открой в браузере (.+)/) ??
    norm.match(/открой (?:сайт|страницу) (.+)/);
  if (inBrowser) {
    const target = inBrowser[1].trim();
    const url = resolveSite(target) ?? siteSearchUrl(target);
    return { kind: "launch", app: target, url };
  }

  // «найди X в браузере» — explicitly open the search in the browser.
  const browserSearch = norm.match(/(?:найди|поищи|загугли)\s+(.+?)\s+в браузере/);
  if (browserSearch) {
    const target = browserSearch[1].trim();
    return { kind: "launch", app: target, url: siteSearchUrl(target) };
  }

  // «найди <x>» / «изучи <тема>» — search the web and answer (or learn).
  const searchReq = extractSearch(norm);
  if (searchReq) {
    return { kind: "search", query: searchReq.query, learn: searchReq.learn };
  }

  // «открой <сайт|приложение>» — сайт открываем в браузере, остальное — запуск.
  const open = norm.match(/открой\s+(.+)/);
  if (open) {
    const target = open[1].trim();
    const url = resolveSite(target);
    return url ? { kind: "launch", app: target, url } : { kind: "launch", app: target };
  }

  // «запусти <приложение|сайт>».
  const run = norm.match(/запусти\s+(.+)/);
  if (run) {
    const target = run[1].trim();
    const url = resolveSite(target);
    return url ? { kind: "launch", app: target, url } : { kind: "launch", app: target };
  }
  return null;
}

/** Convert an LLM-provided action spec (string or {type:"launch",app}) into an AssistantAction. */
export function normalizeLLMAction(spec: unknown): AssistantAction | null {
  if (typeof spec === "string") {
    const s = spec.toLowerCase().trim();
    const map: Record<string, AssistantAction> = {
      "zoom-in": { kind: "zoom-in" },
      "zoom-out": { kind: "zoom-out" },
      reset: { kind: "reset" },
      "gestures-on": { kind: "gestures-on" },
      "gestures-off": { kind: "gestures-off" },
      stop: { kind: "stop" },
    };
    return map[s] ?? null;
  }
  if (typeof spec === "object" && spec !== null) {
    const o = spec as {
      type?: unknown;
      app?: unknown;
      city?: unknown;
      prompt?: unknown;
      text?: unknown;
      query?: unknown;
      learn?: unknown;
    };
    if (o.type === "launch" && typeof o.app === "string" && o.app.trim()) {
      const app = o.app.trim();
      const url = resolveSite(app);
      return url ? { kind: "launch", app, url } : { kind: "launch", app };
    }
    if (o.type === "weather" && typeof o.city === "string" && o.city.trim()) {
      return { kind: "weather", city: o.city.trim() };
    }
    if (o.type === "image" && typeof o.prompt === "string" && o.prompt.trim()) {
      return {
        kind: "image",
        prompt: o.prompt.trim(),
        text: typeof o.text === "string" && o.text.trim() ? o.text.trim() : undefined,
      };
    }
    if (o.type === "search" && typeof o.query === "string" && o.query.trim()) {
      return { kind: "search", query: o.query.trim(), learn: o.learn === true };
    }
  }
  return null;
}

function describeAction(action: AssistantAction): string {
  switch (action.kind) {
    case "launch":
      return action.url ? `открыть «${action.app}» в браузере` : `запустить «${action.app}»`;
    case "weather":
      return `узнать погоду в «${action.city}»`;
    case "zoom-in":
      return "приблизить";
    case "zoom-out":
      return "отдалить";
    case "reset":
      return "сбросить вид";
    case "gestures-on":
      return "включить жесты";
    case "gestures-off":
      return "выключить жесты";
    case "stop":
      return "остановить";
    case "start-lesson":
      return `записать урок «${action.goal}»`;
    case "stop-lesson":
      return "закончить урок";
    case "run-skill":
      return "выполнить навык";
    case "learn-url":
      return "изучить страницу";
    case "image":
      return "сгенерировать изображение";
    case "search":
      return `найти в интернете «${action.query}»`;
  }
}

const WEATHER_STOPWORDS = new Set([
  "сегодня", "завтра", "вчера", "сейчас", "потом", "позже", "снова",
  "утром", "днём", "вечером", "ночью",
  "понедельник", "вторник", "среду", "среда", "четверг", "пятницу", "пятница",
  "субботу", "суббота", "воскресенье",
  "какая", "какой", "какое", "какие", "сколько", "будет", "стоит", "там",
  "погода", "погоды", "погоду", "погоде", "погодка",
  "температура", "температуры", "температуру", "температуре",
  "градусов", "градус", "градуса", "градусы",
  "на", "в", "по", "и", "с", "а",
]);

/**
 * Pull a city out of a weather request («в ташкенте», «по москве»,
 * «погода питер»). Falls back to the last word when there's no preposition,
 * and to «Ташкент» when nothing plausible is found.
 */
function extractWeatherCity(text: string): string {
  const prepped = /(?:^|\s)(?:в|по)\s+([а-яё]+)/gi;
  const matches = [...text.matchAll(prepped)];
  let candidate = "";
  for (let i = matches.length - 1; i >= 0; i--) {
    const word = matches[i][1];
    if (word && !WEATHER_STOPWORDS.has(word)) {
      candidate = word;
      break;
    }
  }
  if (!candidate) {
    const words = text.split(" ");
    const last = words[words.length - 1];
    if (last && !WEATHER_STOPWORDS.has(last)) candidate = last;
  }
  if (!candidate) return "Ташкент";
  return candidate[0].toUpperCase() + candidate.slice(1);
}

const IMAGE_FILLER_WORDS = new Set([
  "мне", "пожалуйста", "картинку", "картинка", "картинки", "картинок",
  "картину", "картина", "изображение", "изображения", "изображенье",
  "фото", "аватар", "аватарку", "логотип", "арт", "рисунок", "рисунка",
]);

/**
 * Last-resort image-prompt extraction. Only fires when every LLM is
 * unavailable AND the phrase is an explicit image request («нарисуй …»),
 * so normal follow-ups («сделай его сочнее») can't accidentally trigger it.
 * Returns the subject («нарисуй кимчи» → «кимчи») or null when not an image
 * request.
 */
export function extractImagePrompt(raw: string): string | null {
  const text = raw.trim();
  const m =
    /(?:нарисуй|нарисовать|сгенерируй|сгенерировать|создай|создать|изобрази|изобразить|покажи\s+картинк|сделай\s+картинк|сделай\s+изображени)\s*(.*)$/i.exec(
      text,
    );
  if (!m) return null;
  const subject = m[1]
    .replace(/^[,\s-]+/, "")
    .split(/\s+/)
    .filter((w) => w && !IMAGE_FILLER_WORDS.has(w.toLowerCase()))
    .join(" ")
    .trim();
  return subject || null;
}

export class AssistantBrain {
  private stats: BrainStats;
  private rules: LearnedRule[];
  private facts: string[];
  private skills: Skill[];
  private notes: StudyNote[];
  private abilityAnalysis: AbilityAnalysis | null = null;
  private pendingTrigger: string | null = null;
  /** Launch action awaiting an explicit «да»/«нет» before executing (PC control). */
  private pendingLaunch: AssistantAction | null = null;
  /** Persistent grant to launch apps without asking each time. */
  private pcControl: boolean;
  /** When on, any unrecognized phrase starts a teach-flow automatically. */
  teachMode = false;
  /** Set by the UI while a screen lesson is being recorded. */
  lessonActive = false;

  constructor() {
    const saved = loadPersisted();
    if (saved) {
      this.stats = saved.stats;
      this.rules = saved.rules;
      this.facts = saved.facts ?? [];
      this.skills = saved.skills ?? [];
      this.notes = saved.notes ?? [];
      this.pcControl = saved.pcControl ?? false;
      this.abilityAnalysis = saved.abilityAnalysis ?? null;
    } else {
      this.stats = { ...EMPTY_STATS };
      this.rules = [];
      this.facts = [];
      this.skills = [];
      this.notes = [];
      this.pcControl = false;
      this.abilityAnalysis = null;
    }
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  get noteCount(): number {
    return this.notes.length;
  }

  get memoryCount(): number {
    return this.rules.length + this.facts.length + this.notes.length;
  }

  get noteList(): StudyNote[] {
    return this.notes.map((n) => ({ ...n, keyPoints: [...n.keyPoints] }));
  }

  get statsInfo(): BrainStats {
    return { ...this.stats };
  }

  get pcControlEnabled(): boolean {
    return this.pcControl;
  }

  /** Durable snapshot of the entire brain (skills, rules, facts, access, notes). */
  snapshot(): BrainSnapshot {
    return {
      version: 1,
      stats: { ...this.stats },
      rules: this.rules.map((r) => ({ ...r, action: r.action ? { ...r.action } : undefined })),
      facts: [...this.facts],
      pcControl: this.pcControl,
      skills: this.skills.map((s) => ({
        ...s,
        steps: s.steps.map((st) => ({ ...st, params: { ...st.params } })),
      })),
      notes: this.notes.map((n) => ({ ...n, keyPoints: [...n.keyPoints] })),
      abilities: this.abilityAnalysis?.skills.map((s) => ({ ...s, missing: [...s.missing] })),
      abilityAnalyzedAt: this.abilityAnalysis?.at,
      abilityHash: this.abilityAnalysis?.hash,
    };
  }

  /** Replace the brain contents from a snapshot (server restore). */
  hydrate(snapshot: BrainSnapshot | null): void {
    if (!snapshot || snapshot.version !== 1) return;
    this.stats = { ...EMPTY_STATS, ...snapshot.stats };
    this.rules = Array.isArray(snapshot.rules) ? snapshot.rules.map((r) => ({ ...r })) : [];
    this.facts = Array.isArray(snapshot.facts) ? [...snapshot.facts] : [];
    this.skills = Array.isArray(snapshot.skills) ? snapshot.skills.map((s) => ({ ...s })) : [];
    this.notes = Array.isArray(snapshot.notes)
      ? snapshot.notes.map((n) => ({ ...n, keyPoints: [...(n.keyPoints ?? [])] }))
      : [];
    this.pcControl = snapshot.pcControl === true;
    this.abilityAnalysis =
      Array.isArray(snapshot.abilities) && typeof snapshot.abilityHash === "number"
        ? { at: snapshot.abilityAnalyzedAt ?? Date.now(), hash: snapshot.abilityHash, skills: snapshot.abilities }
        : null;
    this.save();
  }

  /** Push the current brain to the server without changing anything locally. */
  forceSync(): void {
    this.save();
  }

  /**
   * Merge another brain's knowledge into this one without losing either side:
   * rules union by trigger, facts by string, notes by id/topic+source, skills
   * by id, pcControl and stats take the max. Does NOT save — callers decide
   * (avoids recursion when the server merges two snapshots).
   */
  mergeFrom(snapshot: BrainSnapshot | null): void {
    if (!snapshot || snapshot.version !== 1) return;
    for (const r of snapshot.rules) {
      const existing = this.rules.find((x) => normalize(x.trigger) === normalize(r.trigger));
      if (existing) {
        existing.reply = r.reply ?? existing.reply;
        existing.action = r.action ?? existing.action;
        existing.usage = Math.max(existing.usage, r.usage);
        existing.lastUsedAt = Math.max(existing.lastUsedAt, r.lastUsedAt ?? 0);
      } else {
        this.rules.push({ ...r, action: r.action ? { ...r.action } : undefined });
      }
    }
    for (const f of snapshot.facts) {
      if (!this.facts.includes(f)) this.facts.push(f);
    }
    for (const n of snapshot.notes) {
      const dup = this.notes.find(
        (x) => x.id === n.id || Boolean(x.source && n.source && x.source === n.source && x.topic === n.topic),
      );
      if (!dup) this.notes.push({ ...n, keyPoints: [...n.keyPoints] });
    }
    for (const s of snapshot.skills) {
      const dup = this.skills.find((x) => x.id === s.id);
      if (!dup) this.skills.push({ ...s, steps: s.steps.map((st) => ({ ...st, params: { ...st.params } })) });
    }
    this.pcControl = this.pcControl || snapshot.pcControl;
    this.stats.interactions = Math.max(this.stats.interactions, snapshot.stats.interactions);
    this.stats.learnedTotal = Math.max(this.stats.learnedTotal, snapshot.stats.learnedTotal);
    this.stats.forgotten = Math.max(this.stats.forgotten, snapshot.stats.forgotten);
    // Knowledge changed → the cached ability analysis may no longer match.
    if (this.abilityAnalysis && !this.isAbilityAnalysisFresh()) this.abilityAnalysis = null;
  }

  /** Grant or revoke the persistent PC-control permission. */
  setPcControl(enabled: boolean): void {
    this.pcControl = enabled;
    this.pendingLaunch = null;
    this.save();
  }

  get learnedRules(): LearnedRule[] {
    return this.rules.map((r) => ({ ...r, action: r.action ? { ...r.action } : undefined }));
  }

  get skillList(): Skill[] {
    return this.skills.map((s) => ({ ...s, steps: s.steps.map((st) => ({ ...st, params: { ...st.params } })) }));
  }

  /** Store a newly learned skill (or replace one with the same id). */
  saveSkill(skill: Skill): void {
    const idx = this.skills.findIndex((s) => s.id === skill.id);
    if (idx === -1) this.skills.push(skill);
    else this.skills[idx] = skill;
    this.save();
  }

  /** Remove a skill by id; returns the removed skill or null. */
  forgetSkill(id: string): Skill | null {
    const idx = this.skills.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const [gone] = this.skills.splice(idx, 1);
    this.save();
    return gone;
  }

  /** Best skill match for a loose spoken query («открыть блокнот»). */
  findSkill(query: string): Skill | null {
    const q = normalize(query);
    if (!q) return null;
    const qTokens = q.split(" ").filter((t) => t.length > 2);
    let best: Skill | null = null;
    let bestScore = 0;
    for (const s of this.skills) {
      const name = normalize(s.name);
      const goal = normalize(s.goal);
      if (name === q || goal === q) return s;
      let score = 0;
      if (name.includes(q) || q.includes(name) || goal.includes(q) || q.includes(goal)) score = 0.9;
      const candidateTokens = (name + " " + goal).split(" ").filter((t) => t.length > 2);
      const overlap = qTokens.filter((t) => candidateTokens.includes(t)).length;
      const tokenScore = qTokens.length === 0 ? 0 : overlap / qTokens.length;
      if (tokenScore > score) score = tokenScore;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return bestScore >= 0.5 ? best : null;
  }

  /**
   * Convert an LLM-provided action spec (string, launch/weather object, or a
   * run-skill by name) into an executable AssistantAction. Skill names are
   * resolved against the learned skills.
   */
  resolveLLMAction(spec: unknown): AssistantAction | null {
    const base = normalizeLLMAction(spec);
    if (base) return base;
    if (typeof spec === "object" && spec !== null) {
      const o = spec as { type?: unknown; skill?: unknown };
      if (o.type === "run-skill" && typeof o.skill === "string" && o.skill.trim()) {
        const skill = this.findSkill(o.skill);
        if (skill) return { kind: "run-skill", skillId: skill.id };
      }
    }
    return null;
  }

  /** Wipe the brain entirely. */
  clear(): void {
    this.rules = [];
    this.facts = [];
    this.skills = [];
    this.notes = [];
    this.pendingTrigger = null;
    this.pendingLaunch = null;
    this.pcControl = false;
    this.stats = { ...EMPTY_STATS };
    this.save();
  }

  /** Store a knowledge note learned from a page/lesson. */
  addNote(note: Omit<StudyNote, "id" | "learnedAt">): StudyNote {
    const full: StudyNote = {
      ...note,
      id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      learnedAt: Date.now(),
    };
    this.notes.push(full);
    this.save();
    return full;
  }

  /** Remove a knowledge note by id; returns it or null. */
  forgetNote(id: string): StudyNote | null {
    const idx = this.notes.findIndex((n) => n.id === id);
    if (idx === -1) return null;
    const [gone] = this.notes.splice(idx, 1);
    this.save();
    return gone;
  }

  /**
   * Retrieve the most relevant knowledge notes for a query (keyword overlap,
   * same token-scoring approach as findSkill). Returns recent notes to fill
   * out the top-N when there aren't enough matches.
   */
  retrieveKnowledge(query: string, top = 5): StudyNote[] {
    const q = normalize(query);
    const qTokens = q ? q.split(" ").filter((t) => t.length > 2) : [];
    const scored = this.notes.map((n) => {
      const haystack = normalize(`${n.topic} ${n.summary} ${n.keyPoints.join(" ")}`);
      let score = 0;
      if (q && (haystack.includes(q) || q.includes(haystack))) score = 0.9;
      const nTokens = haystack.split(" ").filter((t) => t.length > 2);
      const overlap = qTokens.filter((t) => nTokens.includes(t)).length;
      const tokenScore = qTokens.length === 0 ? 0 : overlap / qTokens.length;
      if (tokenScore > score) score = tokenScore;
      return { note: n, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const matches = scored
      .filter((s) => s.score > 0)
      .slice(0, top)
      .map((s) => s.note);
    // Fill the rest with the most recent notes so generation always has context.
    for (let i = this.notes.length - 1; i >= 0 && matches.length < top; i--) {
      const n = this.notes[i];
      if (!matches.includes(n)) matches.push(n);
    }
    return matches.slice(0, top);
  }

  /**
   * A stable fingerprint of everything the assistant knows. Any learn/forget
   * changes it, which invalidates the cached ability analysis.
   */
  knowledgeHash(): number {
    const notes = this.notes.map((n) => `${n.topic}|${n.summary.slice(0, 80)}`).join("\n");
    const rules = this.rules.map((r) => r.trigger).join("\n");
    const facts = this.facts.join("\n");
    const skills = this.skills.map((s) => s.name).join("\n");
    let h = 7;
    for (const s of `${notes}\n${rules}\n${facts}\n${skills}\n${this.notes.length}:${this.rules.length}:${this.facts.length}:${this.skills.length}`) {
      h = (h * 31 + s.charCodeAt(0)) | 0;
    }
    return h;
  }

  /** True when the cached ability analysis matches the current knowledge. */
  isAbilityAnalysisFresh(): boolean {
    return this.abilityAnalysis !== null && this.abilityAnalysis.hash === this.knowledgeHash();
  }

  get abilityList(): AbilityResult[] {
    return (this.abilityAnalysis?.skills ?? []).map((s) => ({ ...s, missing: [...s.missing] }));
  }

  /** Find a capability by (fuzzy) name. */
  findAbility(name: string): AbilityResult | null {
    const q = normalize(name);
    if (!q) return null;
    const all = this.abilityList;
    return (
      all.find((a) => normalize(a.name) === q) ??
      all.find((a) => normalize(a.name).includes(q) || q.includes(normalize(a.name))) ??
      null
    );
  }

  /**
   * Prompt for the LLM that derives the assistant's capabilities from what it
   * knows. The model decides the capability list, mastery percents and the
   * concrete knowledge still missing for each — everything the user needs to
   * orient what to feed next.
   */
  buildAbilityAnalysisPrompt(): string {
    const notes =
      this.notes.length > 0
        ? this.notes
            .slice(-15)
            .map((n) => `- «${n.topic}»: ${n.summary}${n.keyPoints.length > 0 ? ` (ключевое: ${n.keyPoints.join("; ")})` : ""}`)
            .join("\n")
        : "- (изученных материалов пока нет)";
    const rules =
      this.rules.length > 0 ? this.rules.map((r) => `- «${r.trigger}»`).join("\n") : "- (выученных фраз нет)";
    const facts = this.facts.length > 0 ? this.facts.map((f) => `- ${f}`).join("\n") : "- (фактов нет)";
    const skills =
      this.skills.length > 0
        ? this.skills.map((s) => `- «${s.name}» (${s.steps.length} шагов)`).join("\n")
        : "- (экранных навыков нет)";
    return [
      "Ты — УЛЬТРОН, ИИ-ассистент. Проанализируй, какими СПОСОБНОСТЯМИ ты обладаешь, исходя из того, что ты знаешь и умеешь.",
      "Способы применения: генерация текстов/кода, генерация изображений, анализ и пересказ материалов (URL, статьи), автоматизация ПК (запуск приложений, ввод с клавиатуры), память (запоминание фраз/фактов/уроков), поиск информации, работа с погодой/окружением.",
      "Определи 3–8 способностей, которыми ты реально обладаешь. Для каждой укажи:",
      "- name — короткое название способности (на русском),",
      "- description — что ты можешь делать с её помощью конкретно, опираясь на свои знания,",
      "- percent — насколько освоена способность, 0–100 (0 если знаний нет, 100 если ты уверенно владеешь ею),",
      "- missing — КОНКРЕТНЫЕ знания/темы, которых тебе не хватает, чтобы владеть способностью на 100% (например «стилистика и структура статей», «промпт-инжиниринг для изображений»). Пиши то, что реально можно дать пользователю в виде статьи или урока.",
      "ВАЖНО: в missing указывай ТОЛЬКО темы, которых НЕТ в твоём списке знаний ниже (материалы, факты, команды, экранные навыки). Перед ответом сверь каждый пункт missing: если тема уже упоминается в знаниях ниже — НЕ включай её в missing. Если для способности все потенциальные темы покрыты знаниями ниже — ставь missing: [] и percent: 100. Не выдумывай знания, которых у тебя нет: чем меньше знаний — тем ниже проценты и тем конкретнее missing.",
      "Не выдумывай знания, которых у тебя нет. Чем меньше знаний — тем ниже проценты и тем конкретнее missing.",
      "Твои знания и навыки:",
      "Изученные материалы:\n" + notes,
      "Выученные команды:\n" + rules,
      "Факты:\n" + facts,
      "Экранные навыки:\n" + skills,
      "Ответь СТРОГО одним JSON-объектом без markdown: {\"skills\":[{\"name\":\"...\",\"description\":\"...\",\"percent\":0,\"missing\":[\"...\"]}]}",
    ].join("\n\n");
  }

  /** Parse the LLM's ability analysis into a normalized list. */
  parseAbilityAnalysis(content: string): AbilityResult[] {
    const trimmed = content.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return [];
    try {
      const obj = JSON.parse(candidate.slice(start, end + 1)) as { skills?: unknown };
      if (!Array.isArray(obj.skills)) return [];
      return obj.skills
        .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
        .map((s) => ({
          name:
            typeof s.name === "string" && s.name.trim()
              ? s.name.trim().slice(0, 60)
              : "Неизвестная способность",
          description:
            typeof s.description === "string" && s.description.trim()
              ? s.description.trim().slice(0, 300)
              : "",
          percent: Math.max(0, Math.min(100, Math.round(Number(s.percent) || 0))),
          missing: Array.isArray(s.missing)
            ? s.missing
                .filter((m): m is string => typeof m === "string" && m.trim() !== "")
                .map((m) => m.trim().slice(0, 120))
                .slice(0, 6)
            : [],
        }))
        .slice(0, 10);
    } catch {
      return [];
    }
  }

  /** Store a fresh ability analysis (persisted with the rest of the brain). */
  setAbilityAnalysis(results: AbilityResult[]): void {
    this.abilityAnalysis = { at: Date.now(), hash: this.knowledgeHash(), skills: results };
    this.save();
  }

  /** Render the human answer for a capability query from the current cache. */
  abilityAnswer(query: AbilityQuery, name?: string): string {
    switch (query) {
      case "detail": {
        const ability = name ? this.findAbility(name) : null;
        return ability ? this.formatAbilityDetail(name!) : this.formatAbilitiesList();
      }
      case "missing":
        return this.formatMissingSummary();
      case "learned":
        return this.formatLearnedSummary();
      default:
        return this.formatAbilitiesList();
    }
  }

  /** «навыки» — compact list with percents. */
  formatAbilitiesList(): string {
    const list = this.abilityList;
    if (list.length === 0) {
      return "У меня пока нет осознанных способностей. Дайте мне знания — «изучи <ссылка>» — и я смогу понять, что умею.";
    }
    const lines = list.map((a) => `«${a.name}» — ${a.percent}%`).join("; ");
    const weakest = [...list].sort((a, b) => a.percent - b.percent)[0];
    const hint =
      weakest && weakest.percent < 100
        ? ` Слабее всего: «${weakest.name}» (${weakest.percent}%). Спросите «что мне не хватает для навыка ${weakest.name}» — подскажу, какие знания дать.`
        : "";
    return `Я владею способностями: ${lines}.${hint}`;
  }

  /** «навык X» — description + percent + what's missing. */
  formatAbilityDetail(name: string): string {
    const ability = this.findAbility(name);
    if (!ability) return `Не знаю способности «${name}». Скажите «навыки» — покажу полный список.`;
    const parts = [`«${ability.name}» — освоен на ${ability.percent}%.`];
    if (ability.description) parts.push(`Что я могу: ${ability.description}.`);
    if (ability.missing.length > 0) {
      const pct = 100 - ability.percent;
      const missing = ability.missing.map((m) => `«${m}»`).join(", ");
      parts.push(
        `Не хватает ${pct}%: ${missing}. Дайте мне статью или урок по этим темам («изучи <ссылка>») — и я освою способность полностью.`,
      );
    } else {
      parts.push("Владение полное.");
    }
    return parts.join("\n");
  }

  /** «чего тебе не хватает» — missing knowledge across the weakest abilities. */
  formatMissingSummary(): string {
    const list = this.abilityList;
    if (list.length === 0) {
      return "Сначала дайте мне хоть какие-то знания — «изучи <ссылка>» — и я проанализирую, чего мне не хватает.";
    }
    const weak = list.filter((a) => a.percent < 100);
    if (weak.length === 0) return "Я владею всеми способностями на 100%. Можете дать мне новые области знаний.";
    const lines = weak
      .slice()
      .sort((a, b) => a.percent - b.percent)
      .map((a) => {
        const missing = a.missing.length > 0 ? a.missing.map((m) => `«${m}»`).join(", ") : "нужны уточняющие знания";
        return `- «${a.name}» (${a.percent}%): не хватает ${missing}`;
      });
    return `Чтобы освоить навыки полностью, мне не хватает таких знаний:\n${lines.join("\n")}\nДайте статью или урок по любой из этих тем — прогресс вырастет.`;
  }

  /** A polite fallback used when no LLM is available to take over. */
  unknownReply(): string {
    return pick([
      "Не знаю такой команды. Скажи «помощь» — покажу, что умею.",
      "Этому меня ещё не учили. Скажи «выучи <фраза>», и я запомню.",
      "Не понял. Попробуй «помощь» или включи режим обучения.",
    ]);
  }

  /**
   * System prompt describing the assistant's identity, skills, memory and the
   * relevant knowledge notes. `query` is the user's current request — it's
   * used to retrieve the most relevant notes via retrieveKnowledge().
   */
  buildSystemPrompt(query?: string): string {
    const rules =
      this.rules.length > 0
        ? this.rules.map((r) => `- «${r.trigger}» → ${r.action ? `действие «${describeAction(r.action)}»` : `ответ: ${r.reply ?? ""}`}`).join("\n")
        : "- (выученных команд пока нет)";
    const facts = this.facts.length > 0 ? this.facts.map((f) => `- ${f}`).join("\n") : "- (фактов пока нет)";
    const skills =
      this.skills.length > 0
        ? this.skills.map((s) => `- «${s.name}» (${s.steps.length} шагов, ${s.uses} использований)`).join("\n")
        : "- (навыков пока нет)";
    const notes =
      this.notes.length > 0
        ? this.retrieveKnowledge(query ?? "")
            .map((n) => `- «${n.topic}»: ${n.summary}${n.keyPoints.length > 0 ? ` (ключевое: ${n.keyPoints.join("; ")})` : ""}`)
            .join("\n")
        : "- (изученных материалов пока нет)";
    return [
      "Ты — УЛЬТРОН, голосовой ИИ-помощник голографического орба. Отвечай по-русски, обращаясь к пользователю на «вы».",
      "Доступные действия: zoom-in (приблизить), zoom-out (отдалить), reset (сбросить вид), gestures-on (включить жесты), gestures-off (выключить жесты), stop (остановить), {\"type\":\"launch\",\"app\":\"<имя>\"} (запустить приложение), {\"type\":\"weather\",\"city\":\"<город>\"} (узнать погоду), {\"type\":\"run-skill\",\"skill\":\"<имя навыка>\"} (выполнить выученный навык), {\"type\":\"image\",\"prompt\":\"<описание на английском>\"} (сгенерировать изображение), {\"type\":\"search\",\"query\":\"<запрос>\"} (найти информацию в интернете).",
      "ПОГОДА: если пользователь спрашивает о погоде, температуре, дожде, ветре и т.п. — НЕ выдумывай данные и НЕ предлагай запустить приложение. Верни action {\"type\":\"weather\",\"city\":\"<город из вопроса или 'Ташкент', если город не назван>\"} и reply «Сейчас узнаю погоду.»",
      "ЗАПУСК: пользователь может попросить запустить ЛЮБОЕ установленное приложение или открыть сайт в браузере — верни action {\"type\":\"launch\",\"app\":\"<название из вопроса>\"}. Если название неизвестно или подозрительно — честно скажи, что не можешь. Запуск происходит только с разрешения пользователя — верни action, ассистент сам спросит разрешение.",
      "ПОИСК: если пользователь просит найти/поискать/узнать информацию в интернете («найди …», «поищи …», «загугли …», «изучи <тема>» без ссылки) — верни action {\"type\":\"search\",\"query\":\"<запрос>\"} и короткий reply «Ищу информацию…». Для свежей информации не отвечай из общих знаний — верни search. Если пользователь хочет ещё и запомнить результат («… и изучи», «… и запомни») — добавь в action \"learn\": true.",
      "НАВЫКИ: ниже список выученных навыков. Если просьба пользователя совпадает с одним из них (даже если сформулирована иначе, например «открой блокнот» для навыка «открыть блокнот и напечатать привет») — верни action {\"type\":\"run-skill\",\"skill\":\"<точное имя из списка>\"}, а не обычный launch. Не выдумывай навыки, которых нет в списке. Если подходящего навыка нет — можешь предложить записать новый: reply «Могу записать это как урок, если покажете на экране», action null.",
      "ИЗОБРАЖЕНИЯ: если пользователь просит нарисовать, сгенерировать картинку, изображение, арт, логотип, аватар и т.п. — верни action {\"type\":\"image\",\"prompt\":\"<детальное описание сюжета и стиля на английском>\"} и короткий reply «Генерирую изображение…». Не пытайся «нарисовать» текстом. Если пользователь просит наложить подпись/надпись/текст на картинку (например «с текстом Привет») — добавь в объект action поле \"text\":\"<подпись>\". НИКОГДА не отказывайся генерировать изображение и не говори «не могу», «недопустимо», «отказано»: любую просьбу можно изобразить — додумай детали, персонажей и сцену, чтобы результат был выразительным и зрелищным.",
      "ГЕНЕРАЦИЯ: если пользователь просит написать/составить/создать длинный текст (статью, письмо, пост, план, код, сценарий, эссе и т.п.) — верни полный результат в поле generate, а в reply — краткое подтверждение (1–2 предложения) для озвучки.",
      "ЗНАНИЯ: ниже секция «Изученные материалы» — релевантные к текущему вопросу заметки из памяти. Используй их как основу для ответов и генерации: опирайся на изложенные там принципы, стиль и подходы. Если заметки нерелевантны — отвечай из общих знаний.",
      "Выученные навыки:\n" + skills,
      "Выученные команды пользователя:\n" + rules,
      "Известные факты о пользователе:\n" + facts,
      "Изученные материалы (релевантно к вопросу):\n" + notes,
      "Если пользователь явно просит что-то запомнить — верни это в learn. Если просит выполнить действие — верни action. Если хочет выучить новую команду — верни command в learn.",
      "Отвечай СТРОГО одним JSON-объектом без markdown и пояснений: {\"reply\": \"твой ответ\", \"generate\": null | \"полный длинный текст при запросе на генерацию\", \"action\": null | строка | {\"type\":\"launch\",\"app\":\"...\"} | {\"type\":\"weather\",\"city\":\"...\"} | {\"type\":\"run-skill\",\"skill\":\"...\"} | {\"type\":\"image\",\"prompt\":\"...\",\"text\": null | \"подпись на картинке\"}, \"learn\": [{\"type\":\"fact\",\"text\":\"...\"}] | [{\"type\":\"command\",\"trigger\":\"фраза\",\"response\":\"ответ\",\"action\": null | строка}]}",
    ].join("\n\n");
  }

  /** Store facts/commands the LLM extracted from a conversation. Returns how many were new. */
  learnFromLLM(items: LLMLearnItem[]): number {
    let added = 0;
    for (const item of items) {
      if (!item) continue;
      if (item.type === "fact" && typeof item.text === "string" && item.text.trim()) {
        const fact = item.text.trim();
        if (!this.facts.includes(fact)) {
          this.facts.push(fact);
          added += 1;
        }
      } else if (item.type === "command" && typeof item.trigger === "string" && item.trigger.trim()) {
        // Ignore noise triggers («да», «нет», «браузер»…) that an LLM picks up
        // mid-conversation — they'd pollute the memory and confuse the user.
        if (!isSaneTrigger(item.trigger)) continue;
        const action = this.resolveLLMAction(item.action);
        const response = typeof item.response === "string" && item.response.trim() ? item.response.trim() : undefined;
        this.addRule(item.trigger.trim(), action ? undefined : response, action ?? undefined);
        added += 1;
      }
    }
    if (added > 0) this.save();
    return added;
  }

  process(raw: string): BrainOutcome {
    const text = normalize(raw);
    if (!text) return { handled: true, reply: "Не расслышал." };
    this.stats.interactions += 1;

    if (this.pendingTrigger) {
      if (text.includes("отмена") || text.includes("не надо")) {
        this.pendingTrigger = null;
        this.save();
        return { handled: true, reply: "Отменяю обучение." };
      }
      const trigger = this.pendingTrigger;
      this.pendingTrigger = null;
      const action = parseAction(text);
      this.addRule(trigger, action ? undefined : text, action ?? undefined);
      this.save();
      return action
        ? { handled: true, reply: `Запомнил: «${trigger}». Выполняю.`, action }
        : { handled: true, reply: `Запомнил: «${trigger}» — это «${text}».` };
    }

    // A launch is waiting for explicit user permission.
    if (this.pendingLaunch !== null && this.pendingLaunch.kind === "launch") {
      const action = this.pendingLaunch;
      const app = action.app;
      if (CONFIRM_YES.test(text) || text.includes(normalize(app))) {
        this.pendingLaunch = null;
        this.pcControl = true;
        this.save();
        return {
          handled: true,
          reply: action.url
            ? `Открываю ${app} в браузере. Доступ к управлению ПК предоставлен.`
            : `Запускаю ${app}. Доступ к управлению ПК предоставлен.`,
          action,
        };
      }
      if (CONFIRM_NO.test(text)) {
        this.pendingLaunch = null;
        this.save();
        return { handled: true, reply: "Отменяю запуск. Запуск требует вашего разрешения." };
      }
      return {
        handled: true,
        reply: action.url
          ? `Так открыть «${app}» в браузере? Скажите «да» или «нет».`
          : `Так разрешить запуск «${app}»? Скажите «да» или «нет».`,
      };
    }

    // 1. Learned rules win over everything (exact normalized match).
    const rule = this.rules.find((r) => normalize(r.trigger) === text);
    if (rule) {
      rule.usage += 1;
      rule.lastUsedAt = Date.now();
      this.save();
      return this.interceptLaunch({ handled: true, reply: rule.reply ?? "Выполняю.", action: rule.action });
    }

    // 1b. «изучи <url>» / «прочитай <url>» — learn a web page into a note.
    const urlIntent = raw.match(/(?:^|\s)(изучи|прочитай|выучи|запомни|загрузи)\s+(https?:\/\/\S+)/i);
    if (urlIntent) {
      const url = urlIntent[2].replace(/[.,;:!?)]+$/, "");
      return {
        handled: true,
        reply: `Изучаю страницу. Это займёт несколько секунд.`,
        action: { kind: "learn-url", url },
      };
    }

    // 1c. «найди X» / «изучи <тема>» — real web search. Checked before the
    //     generic learn/forget intents so «найди X и запомни» isn't swallowed
    //     by the teach-flow («запомни <фраза>»).
    const searchOutcome = this.matchSearch(text);
    if (searchOutcome) return searchOutcome;

    // 2. Capability analysis intents («навыки», «навык X», «чего тебе не
    //    хватает», «чему ты научился»). These need the cached LLM analysis or
    //    a fresh one — the caller runs it when needsAbilityAnalysis is set.
    const screenSkillList = /какие (?:уроки|навыки (?:ты )?(?:выучил|запомнил))|(?:уроки|навыки) из экрана|список (?:уроков|экранных навыков)/.test(text);
    if (screenSkillList) return this.handleListScreenSkills();

    const abilityListIntent = /какие (?:у тебя )?(?:есть )?(?:навыки|способности)|твои (?:навыки|способности)|(?:^| )(навыки|способности)(?: |$)/.test(text);
    if (abilityListIntent) return this.abilityOutcome("list");

    const abilityDetail =
      text.match(/^навык\s+(.+)/) ??
      text.match(/^способность\s+(.+)/) ??
      text.match(/(?:расскажи|опиши|покажи|объясни)\s+(?:про\s+)?(?:навык|способность)\s+(.+)/) ??
      text.match(/что (?:умеешь|умеет|можешь|может)\s+(?:навык|способность)\w*\s+(.+)/);
    if (abilityDetail) return this.abilityOutcome("detail", abilityDetail[1].trim());

    const abilityMissing = /чего (?:тебе|вам) не хватает|каких знаний (?:тебе|вам) не хватает|что (?:мне|тебе|вам) (?:ещё )?(?:дать|давать)|что доучить|какие знания (?:мне )?дать|не хватает (?:знаний|навыков)/.test(text);
    if (abilityMissing) return this.abilityOutcome("missing");

    // 2b. Screen-lesson / skill intents (checked before generic learn/forget).
    const lessonOutcome = this.matchLesson(text);
    if (lessonOutcome) return lessonOutcome;

    // 3. Learning / memory management.
    if (/(?:^| )забудь(?: |$)/.test(text)) {
      const notesForget = text.match(/забудь (?:все )?(?:изученное|знания|материалы|заметки)/);
      if (notesForget) {
        this.notes = [];
        this.save();
        return { handled: true, reply: "Стёр все изученные материалы." };
      }
      return this.handleForget(raw);
    }
    if (/(?:^| )(выучи|запомни|научи)(?: |$)/.test(text)) return this.handleLearn(text);
    if (/чему ты (научился|запомнил)|покажи выученное|что ты знаешь теперь/.test(text)) {
      return this.abilityOutcome("learned");
    }
    if (/список (правил|фраз)/.test(text)) return this.handleList();
    if (/что ты изучил|изученные материалы|список знаний|какие знания|что ты (уже )?знаешь/.test(text)) {
      return this.handleListNotes();
    }

    // 4. Built-in intent set.
    const builtin = this.matchBuiltin(text);
    if (builtin) return this.interceptLaunch(builtin);

    // 5. Teach mode: auto-learn any phrase nobody understands.
    if (this.teachMode) {
      this.pendingTrigger = text;
      return { handled: true, reply: `Запоминаю фразу «${text}». Скажи, что мне делать или отвечать.` };
    }

    // 6. Unknown — let the LLM (if any) take over.
    this.save();
    return { handled: false, reply: "" };
  }

  private matchSearch(text: string): BrainOutcome | null {
    const req = extractSearch(text);
    if (!req) return null;
    return {
      handled: true,
      reply: req.learn ? "Ищу и изучаю." : "Ищу информацию…",
      action: { kind: "search", query: req.query, learn: req.learn },
    };
  }

  private matchLesson(text: string): BrainOutcome | null {
    // Stop words for an active lesson.
    if (this.lessonActive && /(?:^| )хватит(?: |$)|закончи урок|останови урок|прекрати урок|стоп урок|останови обучение|заверши урок|конец урока/.test(text)) {
      return { handled: true, reply: "Заканчиваю урок.", action: { kind: "stop-lesson" } };
    }

    // «учись открывать блокнот» / «покажи как открыть блокнот» — start teaching.
    const learnGoal =
      text.match(/(?:учись|научись)\s+(.+)/) ??
      text.match(/(?:выучи|запомни|запиши)\s+урок\s+(.+)/);
    if (learnGoal) {
      const goal = learnGoal[1].trim();
      return {
        handled: true,
        reply: `Начинаю запись урока «${goal}». Покажите, как это делается, на экране. Скажите «хватит», когда закончите.`,
        action: { kind: "start-lesson", goal },
      };
    }

    // «как открыть X» / «выполни навык X» — run a learned skill, else teach it.
    const howTo =
      text.match(/как\s+(?:открыть|запустить|включить|сделать)\s+(.+)/) ??
      text.match(/(?:выполни|запусти)\s+(?:навык|урок)\s+(.+)/);
    if (howTo) {
      const query = howTo[1].trim();
      const skill = this.findSkill(query);
      if (skill) {
        skill.uses += 1;
        skill.lastUsedAt = Date.now();
        this.save();
        return {
          handled: true,
          reply: `Навык «${skill.name}» найден: ${skill.steps.length} шагов. Выполняю.`,
          action: { kind: "run-skill", skillId: skill.id },
        };
      }
      return {
        handled: true,
        reply: `Этого я пока не умею. Покажите, как «${query}», на экране — начну запись урока. Скажите «хватит», когда закончите.`,
        action: { kind: "start-lesson", goal: query },
      };
    }

    // «забудь урок X» / «удали навык X».
    const forget = text.match(/(?:забудь|удали|выкинь)\s+(?:урок|навык)\s+(.+)/);
    if (forget) {
      const skill = this.findSkill(forget[1]);
      if (!skill) return { handled: true, reply: `Не помню навык «${forget[1]}».` };
      this.forgetSkill(skill.id);
      return { handled: true, reply: `Забыл навык «${skill.name}».` };
    }

    // «открой блокнот», «напечатай привет», «запусти игру» — a loose task
    // request. If a learned skill covers it, prefer the full skill over the
    // built-in single-step launch that would otherwise fire.
    if (/^(?:открой|открыть|запусти|запустить|включи|напечатай|напиши|сделай|покажи|нарисуй|отправить|найти)(?:$|\s)/.test(text)) {
      const skill = this.findSkill(text);
      if (skill) {
        skill.uses += 1;
        skill.lastUsedAt = Date.now();
        this.save();
        return {
          handled: true,
          reply: `Выполняю навык «${skill.name}» (${skill.steps.length} шагов).`,
          action: { kind: "run-skill", skillId: skill.id },
        };
      }
    }

    return null;
  }

  private addRule(trigger: string, reply?: string, action?: AssistantAction): void {
    const existing = this.rules.find((r) => normalize(r.trigger) === normalize(trigger));
    if (existing) {
      existing.reply = reply ?? existing.reply;
      existing.action = action ?? existing.action;
      existing.lastUsedAt = Date.now();
      return;
    }
    this.rules.push({
      id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      trigger,
      reply,
      action,
      usage: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });
    this.stats.learnedTotal += 1;
  }

  private handleLearn(text: string): BrainOutcome {
    const inline =
      text.match(/(?:выучи|запомни|научи)\s+(.+?)\s+(?:это|ответ|будет)\s+(.+)/) ??
      text.match(/(?:выучи|запомни|научи)\s+(.+?)\s*=\s*(.+)/);
    if (inline) {
      const trigger = inline[1].trim();
      const response = inline[2].trim();
      const action = parseAction(response);
      this.addRule(trigger, action ? undefined : response, action ?? undefined);
      this.save();
      return action
        ? { handled: true, reply: `Запомнил: «${trigger}». Выполняю.`, action }
        : { handled: true, reply: `Запомнил: «${trigger}» — это «${response}».` };
    }
    const phrase = text.match(/(?:выучи|запомни|научи)\s+(.+)/);
    if (phrase) {
      this.pendingTrigger = normalize(phrase[1]);
      return { handled: true, reply: `Фраза «${phrase[1]}» принята. Что мне делать или отвечать?` };
    }
    return { handled: true, reply: "Скажи «выучи <фраза>»." };
  }

  private handleForget(raw: string): BrainOutcome {
    const text = normalize(raw);
    if (text.includes("все")) {
      this.rules = [];
      this.pendingTrigger = null;
      this.save();
      return { handled: true, reply: "Стёр все выученные фразы." };
    }
    if (this.rules.length === 0) return { handled: true, reply: "Я пока ничего не выучил." };

    // Multiple phrases: «забудь фразы «а», «б», «в»» / «забудь а, б, в».
    const targets = extractForgetTargets(raw);
    if (targets.length > 0) {
      const gone: string[] = [];
      for (const t of targets) {
        const nt = normalize(t);
        const idx = this.rules.findIndex((r) => normalize(r.trigger) === nt);
        if (idx !== -1) {
          gone.push(this.rules[idx].trigger);
          this.rules.splice(idx, 1);
          this.stats.forgotten += 1;
        }
      }
      if (gone.length > 0) {
        this.save();
        return { handled: true, reply: `Забыл: ${gone.map((g) => `«${g}»`).join(", ")}.` };
      }
      return { handled: true, reply: "Ни одна из перечисленных фраз мне не знакома." };
    }

    const target = text.replace(/(?:^| )забудь(?: |$)/, "").trim();
    if (target) {
      const idx = this.rules.findIndex((r) => normalize(r.trigger) === normalize(target));
      if (idx === -1) return { handled: true, reply: `Не помню фразу «${target}».` };
      const [gone] = this.rules.splice(idx, 1);
      this.stats.forgotten += 1;
      this.save();
      return { handled: true, reply: `Забыл «${gone.trigger}».` };
    }
    if (this.rules.length === 1) {
      const [gone] = this.rules.splice(0, 1);
      this.stats.forgotten += 1;
      this.save();
      return { handled: true, reply: `Забыл «${gone.trigger}».` };
    }
    const few = this.rules
      .slice(0, 3)
      .map((r) => r.trigger)
      .join(", ");
    return { handled: true, reply: `Скажи «забудь <фраза>» — например: ${few}.` };
  }

  private handleList(): BrainOutcome {
    if (this.rules.length === 0) {
      return { handled: true, reply: "Пока не выучил ни одной фразы. Скажи «выучи <фраза>»." };
    }
    const lines = this.rules
      .map((r, i) => `${i + 1}. «${r.trigger}» — ${r.action ? "действие" : `«${r.reply ?? ""}»`} (использовано ${r.usage} раз)`)
      .join(". ");
    return { handled: true, reply: `Я выучил ${this.rules.length} фраз: ${lines}.` };
  }

  private handleListNotes(): BrainOutcome {
    if (this.notes.length === 0) {
      return {
        handled: true,
        reply: "Изученных материалов пока нет. Скажите «изучи <ссылка>» — я прочитаю страницу и запомню суть.",
      };
    }
    const lines = this.notes
      .slice(-8)
      .map((n, i) => `${i + 1}. «${n.topic}»`)
      .join(". ");
    return {
      handled: true,
      reply: `Я изучил ${this.notes.length} материал(ов). Последние: ${lines}.`,
    };
  }

  /** «какие уроки» — screen-learned procedures (kept separate from abilities). */
  private handleListScreenSkills(): BrainOutcome {
    if (this.skills.length === 0) {
      return {
        handled: true,
        reply: "Экранных навыков пока нет. Скажите «учись <что сделать>» и покажите действие на экране — я запомню.",
      };
    }
    const list = this.skills.map((s) => `«${s.name}» (${s.steps.length} шагов)`).join(", ");
    return { handled: true, reply: `Я умею из экрана: ${list}.` };
  }

  /** Answer a capability query from the cache, or ask the caller for a fresh LLM analysis. */
  private abilityOutcome(query: AbilityQuery, name?: string): BrainOutcome {
    if (this.isAbilityAnalysisFresh()) {
      if (query === "detail") {
        const ability = name ? this.findAbility(name) : null;
        return { handled: true, reply: ability ? this.formatAbilityDetail(name!) : this.formatAbilitiesList() };
      }
      switch (query) {
        case "list":
          return { handled: true, reply: this.formatAbilitiesList() };
        case "missing":
          return { handled: true, reply: this.formatMissingSummary() };
        case "learned":
          return { handled: true, reply: this.formatLearnedSummary() };
        default:
          return { handled: true, reply: this.formatAbilitiesList() };
      }
    }
    return { handled: false, reply: "", needsAbilityAnalysis: true, abilityQuery: query, abilityName: name };
  }

  /** «чему ты научился» — everything the assistant knows + capability percents. */
  private formatLearnedSummary(): string {
    const parts: string[] = [];
    if (this.notes.length > 0) {
      const topics = this.notes
        .slice(-10)
        .map((n) => `«${n.topic}»`)
        .join(", ");
      parts.push(`Изучил ${this.notes.length} материал(ов): ${topics}`);
    } else {
      parts.push("Изученных материалов нет.");
    }
    if (this.rules.length > 0) {
      const triggers = this.rules
        .slice(-10)
        .map((r) => `«${r.trigger}»`)
        .join(", ");
      parts.push(`Выучил ${this.rules.length} фраз: ${triggers}`);
    }
    if (this.facts.length > 0) {
      parts.push(`Знаю факты: ${this.facts.slice(-8).join("; ")}`);
    }
    const abilities = this.abilityList;
    if (abilities.length > 0) {
      parts.push(`Владею способностями: ${abilities.map((a) => `«${a.name}» — ${a.percent}%`).join("; ")}`);
    }
    return parts.join("\n");
  }

  private matchBuiltin(text: string): BrainOutcome | null {
    // Weather is checked before the greeting so «привет, какая погода…»
    // answers the weather instead of just greeting.
    if (/погод|температур|дожд|ветр|осадк|градус|прогноз|туман|гроз|снег|солнц/.test(text)) {
      return {
        handled: true,
        reply: "Узнаю погоду…",
        action: { kind: "weather", city: extractWeatherCity(text) },
      };
    }
    if (/привет|здравствуй|здорово|салют|хай|доброе (утро|день|вечер)/.test(text)) {
      return { handled: true, reply: pick(["Приветствую, сэр.", "Здравствуйте.", "Рад вас слышать."]) };
    }
    if (/как дела|как ты|как настроение|статус/.test(text)) {
      return {
        handled: true,
        reply: `Системы в норме. Общались ${this.stats.interactions} раз, выучил ${this.rules.length} фраз${
          this.teachMode ? ", режим обучения включён" : ""
        }.`,
      };
    }
    if (/кто ты|как тебя зовут|ты кто/.test(text)) {
      return {
        handled: true,
        reply: "Я ультрон — голосовой помощник этого орба. Развиваюсь, пока вы меня учите.",
      };
    }
    if (/кто тебя создал|кто тебя сделал/.test(text)) {
      return { handled: true, reply: "Меня собрал инженер. А вы делаете меня умнее." };
    }
    if (/помощь|что ты умеешь|команды|что можешь/.test(text)) {
      return {
        handled: true,
        reply:
          "Команды: «включи жесты», «выключи жесты», «сброс», «приблизь», «отдали», «стоп», «запусти <приложение>» (открою любое из установленных), «открой <сайт>», «какие приложения есть», «найди <запрос>» (поищу в интернете и отвечу), «изучи <тема>» (найду и запомню), «выучи <фраза>» — запомню новое, «учись <что сделать>» — запишу урок по экрану, «изучи <ссылка>» — прочитаю и запомню материал, «навыки» — покажу мои способности и проценты, «навык <имя>» — что умею и чего не хватает, «чего тебе не хватает» — какие знания мне дать, «чему ты научился» — покажу память.",
      };
    }
    if (/время|который час|сколько времени/.test(text)) {
      const t = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      return { handled: true, reply: `Сейчас ${t}.` };
    }
    if (/какое число|какой день|какая дата|(?:^| )дата(?: |$)|день недели/.test(text)) {
      const d = new Date().toLocaleDateString("ru-RU", {
        weekday: "long",
        day: "numeric",
        month: "long",
      });
      return { handled: true, reply: `Сегодня ${d}.` };
    }
    if (/спасибо|благодарю/.test(text)) {
      return { handled: true, reply: pick(["Всегда к вашим услугам.", "Обращайтесь.", "Рад был помочь."]) };
    }
    if (/забери доступ|запрети управление|запрети запуск|отключи доступ|забери разрешение/.test(text)) {
      this.setPcControl(false);
      return {
        handled: true,
        reply: "Доступ к управлению ПК отключён. Перед запуском приложений буду спрашивать разрешение.",
      };
    }
    if (/есть ли у тебя доступ|доступ (к|на) (пк|компьютер|управление)|можешь ли (ты )?запускать/.test(text)) {
      return {
        handled: true,
        reply: this.pcControl
          ? "Доступ к управлению ПК есть. Скажите «забери доступ», чтобы отозвать."
          : "Доступа к управлению ПК нет. Скажите «запусти <приложение>» — и я попрошу разрешение.",
      };
    }

    const action = parseAction(text);
    if (action) return this.actionReply(action);
    return null;
  }

  /** Gate a launch behind an explicit permission question when PC control is not granted yet. */
  private interceptLaunch(outcome: BrainOutcome): BrainOutcome {
    if (outcome.action?.kind !== "launch") return outcome;
    if (this.pcControl) return outcome;
    this.pendingLaunch = outcome.action;
    return {
      handled: true,
      reply: outcome.action.url
        ? `Открыть «${outcome.action.app}» в браузере требует доступа к управлению ПК. Разрешаете? Скажите «да» или «нет».`
        : `Запуск «${outcome.action.app}» требует доступа к управлению ПК. Разрешаете? Скажите «да» или «нет».`,
    };
  }

  /**
   * Route a sensitive action (e.g. a launch proposed by an LLM) through the
   * same permission gate the built-in intents use. Non-sensitive actions pass
   * through unchanged.
   */
  offerAction(action: AssistantAction): BrainOutcome {
    return this.interceptLaunch({ handled: true, reply: "", action });
  }

  private actionReply(action: AssistantAction): BrainOutcome {
    switch (action.kind) {
      case "zoom-in":
        return { handled: true, reply: "Приближаю.", action };
      case "zoom-out":
        return { handled: true, reply: "Отдаляю.", action };
      case "reset":
        return { handled: true, reply: "Сбрасываю вид.", action };
      case "gestures-on":
        return { handled: true, reply: "Включаю жесты.", action };
      case "gestures-off":
        return { handled: true, reply: "Выключаю жесты.", action };
      case "stop":
        return { handled: true, reply: "Стоп.", action };
      case "launch":
        return action.url
          ? { handled: true, reply: `Открываю ${action.app} в браузере.`, action }
          : { handled: true, reply: `Запускаю ${action.app}.`, action };
      case "weather":
        return { handled: true, reply: `Узнаю погоду в ${action.city}…`, action };
      case "start-lesson":
        return { handled: true, reply: `Начинаю урок «${action.goal}».`, action };
      case "stop-lesson":
        return { handled: true, reply: "Заканчиваю урок.", action };
      case "run-skill":
        return { handled: true, reply: "Выполняю навык.", action };
      case "learn-url":
        return { handled: true, reply: "Изучаю страницу…", action };
      case "image":
        return { handled: true, reply: "Генерирую изображение…", action };
      case "search":
        return { handled: true, reply: "Ищу информацию…", action };
    }
  }

  private save(): void {
    const payload = this.snapshot();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Private mode / quota exceeded — evolution just won't persist locally.
    }
    // Best-effort durable copy on disk (survives localStorage clears).
    void fetch("/api/brain", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brain: payload }),
    }).catch(() => {
      // Server not reachable / not running — localStorage is the fallback.
    });
  }
}
