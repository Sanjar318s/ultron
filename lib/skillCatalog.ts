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
import { lessonsForPrompt, recordLesson } from "./skillLessons.ts";

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
  if (nLower && nLower.includes(qLower)) scoreVal += 1;
  if (nLower && qLower.includes(nLower)) scoreVal += 0.5;
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
export async function bestMatch(query: string): Promise<{ skill: CatalogSkill | null; score: number }> {
  const list = await listCatalog();
  let best: CatalogSkill | null = null;
  let bestScore = 0;
  for (const s of list) {
    const raw = ALIASES[s.slug];
    const extra = Array.isArray(raw) ? raw.join(", ") : String(raw ?? "");
    const sc = score(s.name, query) + score(s.slug, query) * 0.3 + score(s.description, query) * 0.5 + score(extra, query) * 1.5;
    if (sc > bestScore) {
      best = s;
      bestScore = sc;
    }
  }
  return { skill: bestScore > 0 ? best : null, score: bestScore };
}

export async function fuzzyFind(query: string): Promise<CatalogSkill | null> {
  const { skill, score } = await bestMatch(query);
  return score > 0.2 ? skill : null;
}

// ---------------------------------------------------------------------------
// Sandbox executor
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 8;
const CMD_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 20_000;
/** Command length cap (base64 content rides in the args; Windows arg limit is ~32K). */
const MAX_CMD_LEN = 8000;
const ALLOWED_BINS = new Set(["python", "py", "node", "pip", "pip3"]);
// No shell is used (spawn with argv array), so `*` is a literal arg character —
// it must stay ALLOWED because --raw script content legitimately contains it
// (`x**2`, `2**100`). Shell metacharacters that could inject via a future
// shell-based path remain blocked.
const BLOCKED_FRAGMENTS = ["..", ";", "&&", "||", "`", ">", "<", "|", "$(", "rm -rf", "cmd.exe", "powershell", "git ", "curl "];
/** Sandbox file-writer (scripts/sandbox-write.mjs), path shown JSON-safe (forward slashes). */
const WRITE_HELPER = path.join(process.cwd(), "scripts", "sandbox-write.mjs").replace(/\\/g, "/");

export function workDirFor(chatId: string): string {
  return path.join(process.cwd(), "data", "skill-work", String(chatId).replace(/[^a-z0-9_-]/gi, ""));
}

/** Cap on files delivered to the user after a successful run. */
const MAX_ARTIFACTS = 5;
/** Telegram Bot API upload cap is 50MB; keep a safe margin. */
const MAX_ARTIFACT_BYTES = 40 * 1024 * 1024;

const ARTIFACT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  log: "text/plain",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

function mimeForRel(rel: string): string {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  return ARTIFACT_MIME[ext] ?? "application/octet-stream";
}

/** Recursive listing of a workdir: relative (slash-separated) paths + size + mtime. */
async function listDirFiles(dir: string): Promise<Array<{ rel: string; abs: string; size: number; mtime: number }>> {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ rel: string; abs: string; size: number; mtime: number }> = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = path.join(dir, e.name);
    try {
      const st = await fs.stat(abs);
      // Root-relative (ROOT = process.cwd()) so the Telegram bot can resolve
      // the file as path.join(ROOT, rel) — the workdir is inside data/skill-work.
      out.push({ rel: path.relative(process.cwd(), abs).split(path.sep).join("/"), abs, size: st.size, mtime: st.mtimeMs });
    } catch {
      // raced away
    }
  }
  return out;
}

/** New files produced by this run, newest first, capped by count and size.
 *  A file counts as new when it didn't exist before OR its size/mtime changed
 *  (so a re-run overwriting plot.png still delivers the fresh artifact). */
async function collectArtifacts(workdir: string, before: Set<string>): Promise<Artifact[]> {
  const after = await listDirFiles(workdir);
  return after
    .filter(
      (f) =>
        path.basename(f.rel) !== ".run.log" &&
        !before.has(artifactKey(f)) &&
        f.size > 0 &&
        f.size <= MAX_ARTIFACT_BYTES,
    )
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_ARTIFACTS)
    .map((f) => ({ rel: f.rel, name: path.basename(f.abs), size: f.size, mime: mimeForRel(f.rel) }));
}

/** True only for genuinely-typed deliverable files: a .pdf must really start
 *  with "%PDF-" — the executor model once "created" a resume by writing a
 *  pdfplumber script into a file named resume.pdf, and the name-only check let
 *  it through. Extend with more magic bytes as new formats are needed. */
async function isRealDeliverable(workdir: string, name: string): Promise<boolean> {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) {
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(path.join(workdir, name), "r");
      const buf = Buffer.alloc(5);
      const { bytesRead } = await fh.read(buf, 0, 5, 0);
      return bytesRead >= 5 && buf.toString("latin1").startsWith("%PDF-");
    } catch {
      return false;
    } finally {
      await fh?.close().catch(() => {});
    }
  }
  return true;
}

function artifactKey(f: { rel: string; size: number; mtime: number }): string {
  return `${f.rel}\0${f.size}\0${f.mtime}`;
}

// --- Honest result verification ---------------------------------------------
// An executor model sometimes claims files it never created («сохранил в
// result.csv», but the file isn't there). Before accepting {done}, cross-check
// every file reference in the result against the actual workdir contents; if a
// claimed file is missing, send one honest corrective round instead of lying
// to the user. The final reply lists the files the run REALLY produced.

const DELIVERABLE_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "txt", "csv", "md", "json", "html",
  "pdf", "xlsx", "xls", "pptx", "docx", "zip", "py", "log",
]);

// --- Requested-format check --------------------------------------------------
// A model can report {done} while delivering a script instead of the artifact
// the user asked for («сделай резюме в виде pdf» → resume_template.js). If the
// query names an output format and the run produced NO file of that format,
// send one corrective round instead of shipping the wrong deliverable.
const FILE_FORMAT = "(?:pdf|docx|xlsx|xls|pptx|csv|png|jpe?g|gif|webp|txt|md|json|html|zip|py)";
const REQUESTED_FORMAT_RE = new RegExp(
  `(?:^|\\s)(?:в виде|в формате|в формат|формат(?:ом)?)\\s+(?:файл(?:а|ов)?\\s+)?(${FILE_FORMAT})\\b` +
    `|(?:^|\\s)(?:сохрани(?:ть)?|запиши)\\s+(?:в|как)?\\s*(?:файл\\s+)?(${FILE_FORMAT})\\b` +
    `|(?:^|\\s)(?:создай|сделай)\\b[^.!?\\n]{0,80}\\b(${FILE_FORMAT})\\b`,
  "i",
);

/** Output extension the user explicitly asked for; null when the query is
 *  format-agnostic (no format words → no format gate). */
function requestedFormatFrom(query: string): string | null {
  const m = String(query ?? "").match(REQUESTED_FORMAT_RE);
  if (!m) return null;
  const fmt = (m[1] ?? m[2] ?? m[3]).toLowerCase();
  return fmt === "jpg" ? "jpeg" : fmt;
}

/** Filenames the model explicitly referenced in its done.result text. */
function fileRefsFromResult(result: string): string[] {
  const out = new Set<string>();
  for (const t of String(result ?? "").split(/[\s,"'():«»“”]+/)) {
    const clean = t.replace(/\\/g, "/").trim();
    if (!clean) continue;
    const base = (clean.split("/").pop() ?? clean).replace(/\.+$/, "");
    const dot = base.lastIndexOf(".");
    if (dot <= 0) continue;
    if (DELIVERABLE_EXT.has(base.slice(dot + 1).toLowerCase())) out.add(base);
  }
  return [...out];
}

/** Which claimed files exist in the workdir (by basename) and which don't. */
async function verifyResultFiles(workdir: string, result: string): Promise<{ missing: string[]; found: string[] }> {
  const refs = fileRefsFromResult(result);
  if (refs.length === 0) return { missing: [], found: [] };
  const existing = new Set((await listDirFiles(workdir)).map((f) => path.basename(f.rel).toLowerCase()));
  const missing: string[] = [];
  const found: string[] = [];
  for (const r of refs) {
    if (existing.has(r.toLowerCase())) found.push(r);
    else missing.push(r);
  }
  return { missing, found };
}

/** Command with quoted sections blanked — shell metacharacters inside `--raw`
 *  content (e.g. a `>` in the phrase to write) are DATA, not operators: spawn
 *  runs without a shell, so only unquoted occurrences are dangerous. */
function unquotedView(cmd: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === "\\" && i + 1 < cmd.length && cmd[i + 1] === quote) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function validateCommand(cmd: string): string | null {
  const trimmed = normalizeCommand(cmd).trim();
  if (!trimmed || trimmed.length > MAX_CMD_LEN) return `пустая или слишком длинная команда (лимит ${MAX_CMD_LEN} симв.)`;
  // The sandbox-write helper's --raw payload is FILE CONTENT, not a shell
  // command: it legitimately contains > | < ; etc. (reportlab markup, arrows,
  // pipes in text). spawn() runs without a shell, so the payload can never
  // redirect or pipe; the helper itself validates the relpath. Only the part
  // BEFORE --raw (bin + relpath + flags) gets the blocked-fragment check.
  const rawAt = trimmed.indexOf("--raw");
  const checkView = unquotedView(rawAt === -1 ? trimmed : trimmed.slice(0, rawAt));
  const lower = checkView.toLowerCase();
  for (const f of BLOCKED_FRAGMENTS) {
    if (lower.includes(f)) return `запрещённый фрагмент «${f}»`;
  }
  const first = trimmed.split(/\s+/)[0].toLowerCase();
  if (!ALLOWED_BINS.has(first)) return `допустимы только: ${[...ALLOWED_BINS].join(", ")}`;
  return null;
}

/**
 * Collapse shell-style line continuations (backslash-newline) and bare newlines
 * OUTSIDE quoted args. Newlines INSIDE quotes must survive: JSON-unescaping
 * `\n` in the model's `--raw "…"` payload turns it into a real newline, and
 * flattening it to a space silently corrupts multi-line script content into
 * one broken line (the PDF run's `import pdfplumber from reportlab …`).
 */
function normalizeCommand(cmd: string): string {
  let out = "";
  let quote: string | null = null;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < cmd.length && cmd[i + 1] === quote) {
        out += cmd[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "\\" && (i + 1 >= cmd.length || cmd[i + 1] === "\r" || cmd[i + 1] === "\n")) {
      i += 2;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      i += 1;
      if (!out.endsWith(" ")) out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/\\+\s*$/, "").trim();
}

/**
 * Split a command into argv respecting double/single quotes. spawn() runs without
 * a shell on Windows, so literal quotes in args are NOT stripped automatically
 * and would end up embedded in the path — strip them here.
 */
function splitArgs(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  const s = normalizeCommand(cmd);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      // Backslash escapes inside quoted args: `\"` is a literal quote (not a
      // terminator), `\\` stays two chars, `\n`/`\u…` pass through for the
      // --raw helper to decode. `spawn` runs without a shell, so this must be
      // resolved here or `matplotlib.use(\"Agg\")` splits into junk args.
      if (ch === "\\" && i + 1 < s.length) {
        const nx = s[i + 1];
        if (nx === quote) {
          cur += quote;
          i += 1;
        } else {
          cur += ch + nx;
          i += 1;
        }
        continue;
      }
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Relpath argument of a sandbox-write command, robust to unescaped inner
 *  quotes in the payload (they would misalign splitArgs' plain arg split). */
function writeRelPath(cmd: string): string {
  const m = cmd.match(/sandbox-write\.mjs"\s+"([^"]+)"/);
  return m ? m[1] : "";
}

/**
 * Split a sandbox-write command into argv WITHOUT mangling the --raw payload.
 * The payload is the LAST argument and may contain real newlines and unescaped
 * inner quotes (the model rarely escapes them); splitArgs would break it into
 * junk args. Take everything after `--raw ` verbatim, minus one wrapping quote
 * char, as the payload.
 */
function splitWriteCommand(cmd: string): string[] {
  const rawIdx = cmd.indexOf("--raw");
  if (rawIdx === -1) return splitArgs(cmd);
  const head = splitArgs(cmd.slice(0, rawIdx + "--raw".length));
  let payload = cmd.slice(rawIdx + "--raw".length).trim();
  if (payload.length >= 2 && (payload[0] === '"' || payload[0] === "'") && (payload[payload.length - 1] === '"' || payload[payload.length - 1] === "'")) {
    payload = payload.slice(1, -1);
  } else if (payload.length >= 1 && (payload[0] === '"' || payload[0] === "'")) {
    payload = payload.slice(1);
  }
  return [...head, payload];
}

function runSandboxed(cmd: string, cwd: string): Promise<{ ok: boolean; code: number | null; out: string }> {
  return new Promise((resolve) => {
    const parts = cmd.includes("sandbox-write.mjs") ? splitWriteCommand(cmd) : splitArgs(cmd);
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

export interface Artifact {
  rel: string;
  name: string;
  size: number;
  mime: string;
}

export interface ExecuteResult {
  ok: boolean;
  reply: string;
  /** Rounds of LLM/command interaction used. */
  rounds: number;
  needsApproval?: { description: string };
  /** Files produced during this run (new workdir files, minus .run.log). */
  artifacts?: Artifact[];
  /** True when every file the model claimed in its result actually exists. */
  verified?: boolean;
}

export interface ExecuteOptions {
  complete: (messages: Array<{ role: "user" | "assistant" | "system"; content: string }>) => Promise<string>;
  chatId: string;
}

const DONE_RE = /"done"\s*:\s*true/i;
// Quote-aware fallbacks for malformed JSON: stop at an UNescaped closing quote.
const RESULT_RE = /"result"\s*:\s*"((?:[^"\\]|\\.)*)"\s*}/;
const CMD_RE = /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function unescapeCmd(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Full JSON-string unescape (same table as sandbox-write.mjs's unescapeJson). */
function jsonUnescapeString(s: string): string {
  const esc: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  return s
    .replace(/\\(["\\/bfnrt])/g, (_, c: string) => esc[c] ?? c)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Find and parse the first TOP-LEVEL JSON object (brace-balanced, string-aware).
 * Unlike the old greedy /\{[\s\S]*\}/ this survives object-literal braces inside
 * --raw content (`{ x: 50 }` in JS code) and trailing prose. Returns null when
 * there is no balanced object or it isn't valid JSON (then regexes take over).
 */
function tryParseJsonObject(text: string): { done?: boolean; result?: string; cmd?: string } | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as { done?: boolean; result?: string; cmd?: string };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseExecReply(text: string): { done: boolean; result?: string; cmd?: string } | null {
  // 1) Balanced top-level JSON object, when present.
  const obj = tryParseJsonObject(text);
  if (obj) {
    if (obj.done === true) return { done: true, result: obj.result ?? "" };
    if (typeof obj.cmd === "string") return { done: false, cmd: obj.cmd };
  }
  // 2) Tolerant regexes over the WHOLE reply — survives a reply truncated
  //    before the closing brace and free-form prose wrapped around the JSON.
  if (DONE_RE.test(text)) {
    const r = text.match(RESULT_RE);
    return { done: true, result: r ? unescapeCmd(r[1]) : "" };
  }
  const c = text.match(CMD_RE);
  if (c) return { done: false, cmd: unescapeCmd(c[1]) };
  // 3) Write commands truncated mid-`--raw "…"` (the model hit its output
  //    cap or cut the JSON string): no closing quote means CMD_RE can't match,
  //    but for sandbox-write the payload is everything to end-of-reply. The
  //    payload-aware writer recovers the actual content later.
  if (text.includes("sandbox-write.mjs") && /"cmd"\s*:\s*"/.test(text)) {
    const m = text.match(/"cmd"\s*:\s*"([\s\S]*)$/);
    if (m) {
      let cmd = jsonUnescapeString(m[1]);
      if (cmd.endsWith('"}')) cmd = cmd.slice(0, -2);
      else if (cmd.endsWith('"')) cmd = cmd.slice(0, -1);
      if (cmd.includes("sandbox-write.mjs")) return { done: false, cmd };
    }
  }
  return null;
}

// A "done" that asks the user for the task / announces readiness / runs a
// hello-world instead of solving is a refusal, not a result.
const REFUSAL_RE =
  /укаж(и|ите|ишь).{0,24}задач|задай(те)?\s+задач|какую.{0,24}задач|сред\w*.{0,40}готов|готов.{0,40}задач|тестов\w*\s+скрипт|настроен\s+и\s+работает|проверк\w*\s+сред\w*|working\s+(correctly|fine|great)/i;

/** Run the skill against the user's request using an LLM-in-the-loop executor. */
export async function execute(
  skill: CatalogSkill,
  query: string,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const workdir = workDirFor(opts.chatId || "general");
  await fs.mkdir(workdir, { recursive: true });
  const before = new Set((await listDirFiles(workdir)).map(artifactKey));
  const runLog = (line: string) =>
    fs.appendFile(path.join(workdir, ".run.log"), `${line}\n`).catch(() => {});

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
    "Задача УЖЕ дана ниже — не приветствуй, не спрашивай задачу, не описывай окружение. Твой ПЕРВЫЙ ответ — команда, решающая задачу ({\"cmd\":\"...\"}).",
    `Рабочая папка: ${workdir} (все файлы создавай только здесь).`,
    `Чтобы создать файл (скрипт, данные, результат): node "${WRITE_HELPER}" "<относительный_путь>" --raw "<содержимое>". Содержимое передавай ОДНИМ аргументом с JSON-эскейпами: перенос строки как \\n, обратный слэш как \\\\. В СОДЕРЖИМОМ используй ТОЛЬКО одинарные кавычки (') для строк Python — двойные кавычки и символы | > < ; в содержимом ЗАПРЕЩЕНЫ (ломают разбор команды). Путь — только относительный. Затем запускай файл: python "<относительный_путь>". Скрипт должен РЕШАТЬ задачу пользователя, а не быть тестом среды. Пример: задача «вычислить 2**100» → создай work.py с содержимым print(2**100), запусти, и в done.result верни ВЫВОД скрипта.`,
    `Скрипты навыка лежат в: ${skill.dir}/scripts/ — вызывай их так: python "${path.join(skill.dir, "scripts", "<файл>")}" <аргументы> (python = ${process.env.SKILL_PYTHON || "python"}).`,
    "Разрешены ТОЛЬКО: python, py, node, pip. Запрещены: git, curl, powershell, cmd, удаление вне рабочей папки, перенаправления, подстановки, точки «..».",
    "УСТАНОВЛЕННЫЕ Python-библиотеки (используй ТОЛЬКО их): reportlab, pypdf, pdfplumber, pymupdf (fitz), matplotlib, numpy, pandas, PIL, openpyxl, requests. npm-модули (pdf-lib и др.) НЕ установлены — для создания PDF/графики/таблиц пиши Python-скрипты, никогда JS.",
    "КРИТИЧНО: задача пользователя должна быть РЕАЛЬНО решена — создан скрипт, получен вывод, результат проверен. Команды вроде «python --version» — это лишь проверка среды, это НЕ решение. НЕ возвращай {\"done\":true}, пока не получил конкретный итог по запросу пользователя (число, файл, текст ответа).",
    "Если ты создал файл-скрипт — ты ОБЯЗАН затем запустить его (python \"<файл>\"), дождаться вывода и привести этот вывод в done.result. Создание файла без запуска — это НЕ результат.",
    "Вывод каждой команды вернётся тебе следующим сообщением. Максимум " + `${MAX_ROUNDS}` + " команд. Действуй пошагово: сначала изучи скрипты и данные, потом выполняй, потом проверь результат.",
    "Если что-то не так — исправь и повтори. В конце верни done с понятным итогом.",
  ].join("\n");

  const sys2 = `РУКОВОДСТВО НАВЫКА «${skill.name}»:\n${skill.body.slice(0, 24_000)}`;
  const lessons = await lessonsForPrompt(skill.slug);
  // Lessons stay a SEPARATE system message: the local provider's context is
  // trimmed to the first 6KB of the skill guide, so appending them to sys2
  // would silently drop exactly the memory we want the model to see.
  let messages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [
    { role: "system", content: system },
    { role: "system", content: sys2 },
    ...(lessons ? [{ role: "system" as const, content: lessons }] : []),
    { role: "user", content: `Запрос пользователя: ${query}` },
  ];
  runLog(`[start] skill=${skill.slug} query=${query.slice(0, 120)}`);
  let lastRaw = "";

  // Stuck-loop guard: track the last executed command; 3 identical ones in a
  // row means the model is spinning (e.g. re-listing the same dir over and
  // over) — abort instead of burning all MAX_ROUNDS.
  let lastCommand = "";
  let sameRun = 0;
  // Rewrite-without-run guard: the PDF failure mode was the model RE-writing
  // the same file (different --raw content each time, so the exact-command
  // guard above can't see it) without ever running it. Track the last written
  // file; 2nd write → nudge to run it, 3rd write → abort as stuck.
  let lastWrittenFile = "";
  let sameWrite = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let raw: string;
    try {
      raw = await opts.complete(messages);
      lastRaw = raw;
    } catch (err) {
      runLog(`[error] ${err instanceof Error ? err.message : String(err)}`);
      return {
        ok: false,
        reply: `Исполнитель навыка не смог получить ответ модели: ${err instanceof Error ? err.message : String(err)}`,
        rounds: round,
      };
    }
    const parsed = parseExecReply(raw);
    if (!parsed) {
      runLog(`[R${round + 1}] UNPARSED: ${raw.slice(0, 200)}`);
      messages.push({ role: "assistant", content: raw.slice(0, 1000) });
      messages.push({
        role: "user",
        content: "Ответ не распознан. Верни СТРОГО JSON {\"cmd\":\"...\"} или {\"done\":true,\"result\":\"...\"}.",
      });
      continue;
    }
    if (parsed.done) {
      if (REFUSAL_RE.test(parsed.result ?? "")) {
        runLog(`[R${round + 1}] DONE-BUT-REFUSAL: ${(parsed.result ?? "").slice(0, 150)}`);
        recordLesson(skill.slug, "вернул done, не решив задачу (refusal)");
        messages.push({ role: "assistant", content: raw.slice(0, 1000) });
        messages.push({
          role: "user",
          content:
            "Ты вернул done, не решив задачу (похоже на приветствие/просьбу уточнить). Задача уже дана. Выполни ПЕРВУЮ команду для её решения прямо сейчас: {\"cmd\":\"...\"}.",
        });
        continue;
      }
      runLog(`[done] R${round + 1}: ${(parsed.result ?? "").slice(0, 300)}`);
      const resultText = parsed.result || "Готово.";
      const { missing } = await verifyResultFiles(workdir, resultText);
      if (missing.length > 0) {
        runLog(`[R${round + 1}] UNVERIFIED: ${missing.join(", ")}`);
        recordLesson(skill.slug, `утверждал файлы, которых нет: ${missing.join(", ")}`);
        messages.push({ role: "assistant", content: raw.slice(0, 1000) });
        messages.push({
          role: "user",
          content: `Ты вернул done и утверждаешь, что создал: ${missing.join(", ")}. В рабочей папке ${workdir} этих файлов НЕТ. Покажи реальное содержимое (python: import os; print(os.listdir('.'))) и СОЗДАЙ недостающие файлы по-настоящему, затем верни done с подтверждением.`,
        });
        continue;
      }
      const artifacts = await collectArtifacts(workdir, before);
      const requestedFormat = requestedFormatFrom(query);
      const requestedFormatMissing =
        requestedFormat &&
        !(
          await Promise.all(artifacts.map((a) => isRealDeliverable(workdir, a.name).then((ok) => ok && a.name.toLowerCase().endsWith(`.${requestedFormat}`))))
        ).some(Boolean);
      if (requestedFormat && requestedFormatMissing) {
        runLog(
          `[R${round + 1}] WRONG-FORMAT: запрошено .${requestedFormat}, созданы: ${artifacts.map((a) => a.name).join(", ") || "(ничего)"}`,
        );
        recordLesson(skill.slug, `отдал done без файла запрошенного формата .${requestedFormat}`);
        messages.push({ role: "assistant", content: raw.slice(0, 1000) });
        messages.push({
          role: "user",
          content: `Пользователь просил результат в формате .${requestedFormat}, но в рабочей папке нет НАСТОЯЩЕГО файла этого формата: есть только ${artifacts.map((a) => a.name).join(", ") || "(файлы не созданы)"}.${requestedFormat === "pdf" ? " Файл .pdf обязан начинаться с магических байтов %PDF-: создавай PDF СКРИПТОМ reportlab (SimpleDocTemplate/build), который при запуске пишет настоящий PDF. НЕ записывай python-код в файл с расширением .pdf и НЕ используй pdfplumber для создания PDF (pdfplumber только читает)." : ""} Создай НАСТОЯЩИЙ файл формата .${requestedFormat} и только потом верни done.`,
        });
        continue;
      }
      const unreported = artifacts.filter((a) => !resultText.toLowerCase().includes(a.name.toLowerCase())).map((a) => a.name);
      let reply = resultText;
      if (unreported.length > 0) {
        reply += `\n📎 Созданные файлы: ${unreported.join(", ")}.`;
      }
      return { ok: true, reply, rounds: round + 1, artifacts, verified: true };
    }
    const cmd = parsed.cmd ?? "";
    const err = validateCommand(cmd);
    if (err) {
      runLog(`[R${round + 1}] REJECTED: ${err}`);
      recordLesson(skill.slug, `команда отклонена: ${err}`);
      messages.push({ role: "assistant", content: raw.slice(0, 1000) });
      const contentHint = /[><|;&]/.test(err)
        ? " Символы | > < ; запрещены в команде: в содержимом файла используй ТОЛЬКО одинарные кавычки (') и не ставь | > < ; даже в тексте."
        : "";
      messages.push({ role: "user", content: `Команда отклонена: ${err}. Придумай другую (только python/py/node/pip).${contentHint}` });
      continue;
    }

    // Rewrite-without-run guard (state declared above the loop): the PDF
    // failure mode was the model re-writing the same file — different --raw
    // content every time, so the exact-command guard can't see it — and never
    // running it. 2nd write → nudge to run, 3rd write → abort as stuck.
    const cmdParts = splitArgs(cmd);
    const isWrite = cmd.includes("sandbox-write.mjs");
    const isRunBin = cmdParts[0] && ["python", "py", "node"].includes(cmdParts[0].toLowerCase());
    if (isWrite) {
      const target = writeRelPath(cmd).replace(/\\/g, "/").toLowerCase();
      if (target) {
        if (target === lastWrittenFile) sameWrite += 1;
        else {
          lastWrittenFile = target;
          sameWrite = 1;
        }
        if (sameWrite >= 3) {
          runLog(`[R${round + 1}] STUCK: ${lastWrittenFile} переписан ${sameWrite} раз без запуска`);
          recordLesson(skill.slug, `переписывает файл ${lastWrittenFile} без запуска`);
          return {
            ok: false,
            reply: `Исполнитель зациклился: файл «${lastWrittenFile}» записан ${sameWrite} раза подряд без запуска. Проверьте результат вручную или уточните запрос.`,
            rounds: round + 1,
          };
        }
        if (sameWrite >= 2) {
          runLog(`[R${round + 1}] NUDGE-RUN: ${lastWrittenFile} записан, но не запущен`);
          messages.push({ role: "assistant", content: raw.slice(0, 1000) });
          messages.push({
            role: "user",
            content: `Ты ${sameWrite} раза записал файл «${lastWrittenFile}», но ни разу не запустил его. Запусти его СЕЙЧАС: python "${lastWrittenFile}", дождись вывода, и только после этого, если нужно, меняй содержимое.`,
          });
          continue;
        }
      }
    } else if (isRunBin && lastWrittenFile) {
      const runTarget = (cmdParts[1] ?? "").replace(/\\/g, "/").toLowerCase().split("/").pop() ?? "";
      const lastBase = lastWrittenFile.split("/").pop() ?? "";
      if (runTarget && runTarget === lastBase) {
        lastWrittenFile = "";
        sameWrite = 0;
      }
      if (cmdParts[0].toLowerCase() === "node" && skill.slug === "pdf") {
        recordLesson(skill.slug, "не используй node/JS: npm-модули (pdf-lib) не установлены — для PDF пиши Python (reportlab/pypdf)");
      }
    }

    const normCmd = cmd.replace(/\s+/g, " ").trim();
    if (normCmd === lastCommand) sameRun += 1;
    else {
      sameRun = 1;
      lastCommand = normCmd;
    }
    if (sameRun >= 3) {
      runLog(`[R${round + 1}] STUCK (${normCmd} ×3): модель зациклилась на одной команде`);
      recordLesson(skill.slug, `зациклился на одной команде: ${normCmd}`);
      return {
        ok: false,
        reply: `Исполнитель зациклился на одной и той же команде («${normCmd}» ×3). Проверьте результат вручную или уточните запрос.`,
        rounds: round + 1,
      };
    }
    const res = await runSandboxed(cmd, workdir);
    const outTail = res.out.length > OUTPUT_CAP ? `${res.out.slice(-OUTPUT_CAP)}\n…[обрезано]` : res.out;
    runLog(`[R${round + 1}] ${cmd}  exit=${res.code}\n${outTail.slice(0, 500)}`);
    messages.push({ role: "assistant", content: raw.slice(0, 1000) });
    messages.push({
      role: "user",
      content: `Команда «${cmd}» завершилась (exit ${res.code}):\n${outTail || "(без вывода)"}\n\nПродолжай или верни {\"done\":true,\"result\":\"...\"}.`,
    });
  }

  runLog(`[exhausted] lastRaw=${lastRaw.slice(0, 150)}`);
  // The model often produces the real deliverable but never emits {done} (it
  // keeps polishing). If the requested output format was actually created,
  // ship it as a success instead of burning the user's work.
  const fallbackArtifacts = await collectArtifacts(workdir, before);
  const requestedFormat = requestedFormatFrom(query);
  const realMatch = (
    await Promise.all(fallbackArtifacts.map((a) => isRealDeliverable(workdir, a.name).then((ok) => (ok ? a : null))))
  ).find((a) => a && a.name.toLowerCase().endsWith(`.${requestedFormat}`));
  if (requestedFormat && realMatch) {
    const match = realMatch;
    runLog(`[exhausted→delivered] ${match.name}`);
    return {
      ok: true,
      reply: `Готово: создан файл ${match.name} (${match.size} байт). Исполнитель исчерпал лимит шагов, но требуемый результат получен.`,
      rounds: MAX_ROUNDS,
      artifacts: fallbackArtifacts,
      verified: true,
    };
  }
  recordLesson(skill.slug, "исчерпан лимит шагов исполнителя");
  return {
    ok: false,
    reply: `Исчерпан лимит шагов исполнителя (${MAX_ROUNDS}). Проверьте результат вручную или уточните запрос.`,
    rounds: MAX_ROUNDS,
  };
}
