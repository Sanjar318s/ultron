/**
 * Hybrid skill catalog — SKILL.md-based knowledge/instrumental skills.
 *
 * Companion to the screen-learned JSON-step skills in the brain. A catalog
 * skill is a folder `skills/<slug>/SKILL.md` with frontmatter:
 *
 *   ---
 *   name: «имя»
 *   description: одно-два предложения, чем полезен
 *   safe: true|false   (default true)
 *   ---
 *
 * Skills may bundle scripts in `skills/<slug>/scripts/`. They are executed
 * by an LLM-in-the-loop executor that runs ONLY python/node commands inside a
 * per-chat sandbox (data/skill-work/<chatId>/), validates every command,
 * caps output, and loops up to MAX_ROUNDS times until the model reports
 * {done, result}. Non-safe skills refuse to run without owner approval.
 */

import { promises as fs, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { getLearnedStyles } from "./lessonStore.ts";

export const SKILLS_DIR = path.join(process.cwd(), "skills");

/** External tool bins (poppler/pandoc/LibreOffice) appended to the sandbox PATH. */
function toolPath(): string {
  const candidates = [
    process.env.POPPLER_BIN,
    process.env.PANDOC_BIN,
    "C:\\Tools\\poppler\\poppler-26.02.0\\Library\\bin",
    "C:\\Tools\\pandoc\\pandoc-3.10.1",
    "C:\\Tools\\LibreOffice",
  ].filter(Boolean) as string[];
  const existing = new Set(candidates.map((p) => p.toLowerCase()));
  const list: string[] = [];
  for (const p of candidates) {
    const norm = path.resolve(p);
    if (!existing.has(norm.toLowerCase())) {
      existing.add(norm.toLowerCase());
      list.push(norm);
    }
  }
  return list.length > 0 ? `${list.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}` : (process.env.PATH ?? "");
}

const SANDBOX_PATH = toolPath();

export interface CatalogSkill {
  slug: string;
  name: string;
  description: string;
  safe: boolean;
  /** Full SKILL.md body (after frontmatter). */
  body: string;
  dir: string;
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([^:]+):\s*(.*)\s*$/);
    if (kv) meta[kv[1].trim().toLowerCase()] = kv[2].trim();
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

/** Scan skills/ for SKILL.md files; returns the registry sorted by name. */
export async function listCatalog(): Promise<CatalogSkill[]> {
  let dirs: string[] = [];
  try {
    dirs = (await fs.readdir(SKILLS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: CatalogSkill[] = [];
  for (const dir of dirs) {
    const mdPath = path.join(SKILLS_DIR, dir, "SKILL.md");
    try {
      const raw = await fs.readFile(mdPath, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      if (!meta.name) continue;
      let effectiveBody = body;
      if (dir === "image-style") {
        const learned = await getLearnedStyles();
        if (learned.length > 0) {
          effectiveBody = `${body}\n\n## Выученное у пользователя\n${learned.map((s) => `- ${s}`).join("\n")}`;
        }
      }
      out.push({
        slug: dir,
        name: meta.name,
        description: meta.description ?? "",
        safe: String(meta.safe ?? "true").toLowerCase() !== "false",
        body: effectiveBody,
        dir: path.join(SKILLS_DIR, dir),
      });
    } catch {
      // not a skill dir — skip
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/** One-line progressive-disclosure listing for the system prompt. */
export async function listForPrompt(): Promise<string> {
  const list = await listCatalog();
  if (list.length === 0) return "";
  const short = (s: string) => (s.length > 140 ? `${s.slice(0, 137).trim()}…` : s);
  return list.map((s) => `- «${s.name}» — ${short(s.description)}`).join("\n");
}

function tokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function tokScore(t: string, n: string): number {
  if (t.startsWith(n) || n.startsWith(t)) return 1;
  const len = Math.min(t.length, n.length);
  let p = 0;
  while (p < len && t[p] === n[p]) p += 1;
  return p >= 4 ? p / len : 0;
}

function score(name: string, query: string): number {
  const q = tokens(query);
  if (q.length === 0) return 0;
  const n = tokens(name);
  const nLower = name.toLowerCase();
  const qLower = query.toLowerCase();
  let hits = 0;
  for (const t of q) if (n.some((w) => tokScore(t, w) > 0)) hits += 1;
  let scoreVal = hits / q.length;
  if (nLower.includes(qLower)) scoreVal += 1;
  if (qLower.includes(nLower)) scoreVal += 0.5;
  return scoreVal;
}

/** RU aliases for the (mostly English) official SKILL.md descriptions. */
let ALIASES: Record<string, string> = {};
try {
  ALIASES = JSON.parse(readFileSync(path.join(SKILLS_DIR, "aliases.json"), "utf8")) as Record<string, string>;
} catch {
  // no aliases file — fine
}

/** Best fuzzy match for a loose spoken name; null when nothing fits. */
export async function fuzzyFind(query: string): Promise<CatalogSkill | null> {
  const list = await listCatalog();
  let best: CatalogSkill | null = null;
  let bestScore = 0.2;
  for (const s of list) {
    const raw = ALIASES[s.slug];
    const extra = Array.isArray(raw) ? raw.join(", ") : String(raw ?? "");
    const sc = score(s.name, query) + score(s.slug, query) * 0.3 + score(s.description, query) * 0.5 + score(extra, query) * 1.5;
    if (sc > bestScore) {
      best = s;
      bestScore = sc;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Sandbox executor
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 6;
const CMD_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 20_000;
const ALLOWED_BINS = new Set(["python", "py", "node", "pip", "pip3"]);
const BLOCKED_FRAGMENTS = ["..", ";", "&&", "||", "`", ">", "<", "|", "*", "$(", "rm -rf", "cmd.exe", "powershell", "git ", "curl "];

export function workDirFor(chatId: string): string {
  return path.join(process.cwd(), "data", "skill-work", String(chatId).replace(/[^a-z0-9_-]/gi, ""));
}

function validateCommand(cmd: string): string | null {
  const trimmed = cmd.trim();
  if (!trimmed || trimmed.length > 512) return "пустая или слишком длинная команда";
  const lower = trimmed.toLowerCase();
  for (const f of BLOCKED_FRAGMENTS) {
    if (lower.includes(f)) return `запрещённый фрагмент «${f}»`;
  }
  const first = trimmed.split(/\s+/)[0].toLowerCase();
  if (!ALLOWED_BINS.has(first)) return `допустимы только: ${[...ALLOWED_BINS].join(", ")}`;
  return null;
}

function runSandboxed(cmd: string, cwd: string): Promise<{ ok: boolean; code: number | null; out: string }> {
  return new Promise((resolve) => {
    const parts = cmd.trim().split(/\s+/);
    const bin = parts.shift() as string;
    const resolvedBin = bin === "python" || bin === "py" ? process.env.SKILL_PYTHON || "python" : bin === "pip" || bin === "pip3" ? process.env.SKILL_PIP || "pip" : bin;
    const child = spawn(resolvedBin, parts, { cwd, windowsHide: true, env: { ...process.env, PATH: SANDBOX_PATH } });
    let out = "";
    const push = (d: unknown) => {
      out += String(d);
      if (out.length > OUTPUT_CAP) out = out.slice(-OUTPUT_CAP);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, code: null, out: `${out}\n[timeout ${Math.round(CMD_TIMEOUT_MS / 1000)}с]` });
    }, CMD_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, out: `${out}\n[error] ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out });
    });
  });
}

export interface ExecuteResult {
  ok: boolean;
  reply: string;
  /** Rounds of LLM/command interaction used. */
  rounds: number;
  needsApproval?: { description: string };
}

export interface ExecuteOptions {
  complete: (messages: Array<{ role: "user" | "assistant" | "system"; content: string }>) => Promise<string>;
  chatId: string;
}

const EXEC_RE = /\{[\s\S]*?\}/;
const DONE_RE = /"done"\s*:\s*true/i;
const RESULT_RE = /"result"\s*:\s*"([\s\S]*?)"\s*}/;
const CMD_RE = /"cmd"\s*:\s*"([\s\S]*?)"/;

function parseExecReply(text: string): { done: boolean; result?: string; cmd?: string } | null {
  const match = text.match(EXEC_RE);
  if (!match) return null;
  const obj = match[0];
  if (DONE_RE.test(obj)) {
    const r = obj.match(RESULT_RE);
    return { done: true, result: r?.[1] ?? "" };
  }
  const c = obj.match(CMD_RE);
  if (c) return { done: false, cmd: c[1] };
  return null;
}

/** Run the skill against the user's request using an LLM-in-the-loop executor. */
export async function execute(
  skill: CatalogSkill,
  query: string,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const workdir = workDirFor(opts.chatId || "general");
  await fs.mkdir(workdir, { recursive: true });

  if (!skill.safe) {
    return {
      ok: false,
      reply: `Навык «${skill.name}» требует одобрения владельца и пока недоступен для автоматического запуска.`,
      rounds: 0,
      needsApproval: { description: `Запуск навыка «${skill.name}»` },
    };
  }

  const system = [
    "Ты — агент-исполнитель навыка в песочнице. Ниже — полное руководство навыка (SKILL.md) и запрос пользователя.",
    "Отвечай СТРОГО одним JSON-объектом без markdown. Чтобы выполнить команду: {\"cmd\":\"<команда>\",\"explain\":\"<кратко зачем>\"}. Когда задача выполнена: {\"done\":true,\"result\":\"<итог для пользователя: что сделано и путь к файлу>\"}.",
    `Рабочая папка: ${workdir} (все файлы создавай только здесь).`,
    `Скрипты навыка лежат в: ${skill.dir}/scripts/ — вызывай их так: python "${path.join(skill.dir, "scripts", "<файл>")}" <аргументы> (python = ${process.env.SKILL_PYTHON || "python"}).`,
    "Разрешены ТОЛЬКО: python, py, node, pip. Запрещены: git, curl, powershell, cmd, удаление вне рабочей папки, перенаправления, подстановки, точки «..».",
    "Вывод каждой команды вернётся тебе следующим сообщением. Максимум 6 команд. Действуй пошагово: сначала изучи скрипты и данные, потом выполняй, потом проверь результат.",
    "Если что-то не так — исправь и повтори. В конце верни done с понятным итогом.",
  ].join("\n");

  const sys2 = `РУКОВОДСТВО НАВЫКА «${skill.name}»:\n${skill.body.slice(0, 24_000)}`;
  let messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [
    { role: "system", content: system },
    { role: "system", content: sys2 },
    { role: "user", content: `Запрос пользователя: ${query}` },
  ];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let raw: string;
    try {
      raw = await opts.complete(messages);
    } catch (err) {
      return {
        ok: false,
        reply: `Исполнитель навыка не смог получить ответ модели: ${err instanceof Error ? err.message : String(err)}`,
        rounds: round,
      };
    }
    const parsed = parseExecReply(raw);
    if (!parsed) {
      messages.push({ role: "assistant", content: raw.slice(0, 1000) });
      messages.push({
        role: "user",
        content: "Ответ не распознан. Верни СТРОГО JSON {\"cmd\":\"...\"} или {\"done\":true,\"result\":\"...\"}.",
      });
      continue;
    }
    if (parsed.done) {
      return { ok: true, reply: parsed.result || "Готово.", rounds: round + 1 };
    }
    const cmd = parsed.cmd ?? "";
    const err = validateCommand(cmd);
    if (err) {
      messages.push({ role: "assistant", content: raw.slice(0, 1000) });
      messages.push({ role: "user", content: `Команда отклонена: ${err}. Придумай другую (только python/py/node/pip).` });
      continue;
    }
    const res = await runSandboxed(cmd, workdir);
    const outTail = res.out.length > OUTPUT_CAP ? `${res.out.slice(-OUTPUT_CAP)}\n…[обрезано]` : res.out;
    messages.push({ role: "assistant", content: raw.slice(0, 1000) });
    messages.push({
      role: "user",
      content: `Команда «${cmd}» завершилась (exit ${res.code}):\n${outTail || "(без вывода)"}\n\nПродолжай или верни {\"done\":true,\"result\":\"...\"}.`,
    });
  }

  return {
    ok: false,
    reply: "Исчерпан лимит шагов исполнителя (6). Проверьте результат вручную или уточните запрос.",
    rounds: MAX_ROUNDS,
  };
}
