/**
 * Server-side admin engine (LOCALHOST-only, used by /api/assistant and the
 * Telegram bot).
 *
 * Owns the LLM-autonomy pipeline:
 *   - path validation (everything stays inside the project root)
 *   - safe `read` for the LLM (no approval, capped read-loop per chat)
 *   - pending approvals for write/replace/run/build (TTL, owner must confirm)
 *   - execute with backup + `node --check` + `npm run build`; auto-rollback
 *     on any failure
 *   - per-session change limit and a stop-ai kill switch
 *   - audit log (data/admin-log.jsonl)
 */

import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

export const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const PENDING_FILE = path.join(DATA_DIR, "pending.json");
const STATE_FILE = path.join(DATA_DIR, "autonomy-state.json");
const AUDIT_FILE = path.join(DATA_DIR, "admin-log.jsonl");
const STOP_FILE = path.join(DATA_DIR, "stop-ai");

export interface AdminSettings {
  autonomy: boolean;
  maxChangesPerSession: number;
  approvalTtlMs: number;
  protectedFiles: string[];
}

interface PendingEntry {
  id: string;
  kind: "write" | "replace" | "run" | "build";
  file?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  cmd?: string;
  createdAt: number;
  chatId?: number | string;
}

interface AutonomyState {
  changes: number;
  sessionStartedAt: number;
}

const DEFAULT_SETTINGS: AdminSettings = {
  autonomy: true,
  maxChangesPerSession: 3,
  approvalTtlMs: 600_000,
  protectedFiles: [
    "scripts/telegram-bot.mjs",
    "app/api/assistant/route.ts",
    "app/api/admin/route.ts",
    "lib/adminOps.ts",
    "lib/promptSanitizer.ts",
    "data/settings.json",
    "data/pending.json",
    "data/autonomy-state.json",
    "data/telegram-users.json",
  ],
};

let settings: AdminSettings = { ...DEFAULT_SETTINGS };
let pending: Record<string, PendingEntry> = {};
let state: AutonomyState = { changes: 0, sessionStartedAt: Date.now() };
/** In-process read-loop counter per chat id (reset after 5 min of silence). */
const readLoops = new Map<string, { reads: number; at: number }>();

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return { ...(fallback as Record<string, unknown>), ...(JSON.parse(raw) as T) } as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

export async function initAdmin(): Promise<void> {
  settings = { ...DEFAULT_SETTINGS, ...(await readJson<AdminSettings>(SETTINGS_FILE, DEFAULT_SETTINGS)) };
  pending = await readJson<Record<string, PendingEntry>>(PENDING_FILE, {});
  state = await readJson<AutonomyState>(STATE_FILE, { changes: 0, sessionStartedAt: Date.now() });
  // Reset the per-session change counter when the process restarts — the
  // bot's /autonomy on also resets it explicitly.
  state.sessionStartedAt = Date.now();
  state.changes = 0;
  await persistState();
  // Prune expired approvals.
  const now = Date.now();
  for (const [id, p] of Object.entries(pending)) {
    if (now - p.createdAt > settings.approvalTtlMs) delete pending[id];
  }
  await persistPending();
}

export async function getSettings(): Promise<AdminSettings> {
  return { ...settings, protectedFiles: [...settings.protectedFiles] };
}

export function isAutonomyOn(): boolean {
  return settings.autonomy;
}

export async function setAutonomy(on: boolean): Promise<AdminSettings> {
  settings.autonomy = on;
  await writeJson(SETTINGS_FILE, settings);
  if (on) {
    await fs.rm(STOP_FILE, { force: true }).catch(() => {});
  }
  return getSettings();
}

/** Stop-ai kill switch: once touched, admin operations refuse to run. */
export async function isAiStopped(): Promise<boolean> {
  try {
    await fs.access(STOP_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function stopAi(): Promise<void> {
  await fs.writeFile(STOP_FILE, String(Date.now()), "utf8");
}

export async function appendAudit(entry: Record<string, unknown>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(AUDIT_FILE, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`, "utf8");
}

/** Resolve a project-relative path; returns null when it escapes the root. */
export function resolveProjectPath(rel: string): string | null {
  const root = path.resolve(PROJECT_ROOT);
  const target = path.resolve(root, rel);
  const relCheck = path.relative(root, target);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) return null;
  if (target.toLowerCase() === root.toLowerCase()) return null;
  return target;
}

function isProtected(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return settings.protectedFiles.some((p) => {
    const np = p.replace(/\\/g, "/").replace(/^\.\//, "");
    return np.toLowerCase() === norm.toLowerCase() || norm.toLowerCase().startsWith(np.toLowerCase() + "/");
  });
}

/** List a directory as short one-line entries (name / DIR / size). */
export async function listDir(rel: string): Promise<string> {
  const abs = resolveProjectPath(rel);
  if (!abs) throw new Error("путь вне проекта");
  const entries = await fs.readdir(abs, { withFileTypes: true });
  if (entries.length === 0) return "(пусто)";
  const lines = await Promise.all(
    entries.map(async (e) => {
      const full = path.join(abs, e.name);
      if (e.isDirectory()) return `[DIR]  ${e.name}`;
      try {
        const st = await fs.stat(full);
        const size = st.size >= 1024 ? `${(st.size / 1024).toFixed(1)}K` : `${st.size}B`;
        return `${size.padStart(8)}  ${e.name}`;
      } catch {
        return `${"?".padStart(8)}  ${e.name}`;
      }
    }),
  );
  return lines.join("\n");
}

/** Recursive tree (depth-limited) of a directory. */
export async function treeDir(rel: string, depth = 2): Promise<string> {
  const abs = resolveProjectPath(rel);
  if (!abs) throw new Error("путь вне проекта");
  const lines: string[] = [];
  async function walk(dir: string, indent: string, d: number): Promise<void> {
    if (d > depth) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
      if (e.isDirectory()) {
        lines.push(`${indent}[DIR] ${e.name}`);
        await walk(path.join(dir, e.name), `${indent}  `, d + 1);
      } else {
        lines.push(`${indent}${e.name}`);
      }
    }
  }
  lines.push(rel || ".");
  await walk(abs, "  ", 0);
  return lines.join("\n");
}

export async function readFileText(rel: string): Promise<string> {
  const abs = resolveProjectPath(rel);
  if (!abs) throw new Error("путь вне проекта");
  return fs.readFile(abs, "utf8");
}

function runNodeCheck(fileAbs: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    if (!/\.(js|mjs|cjs)$/i.test(fileAbs)) return resolve({ ok: true, out: "" });
    const p = spawn(process.execPath, ["--check", fileAbs], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ ok: code === 0, out }));
  });
}

function runPyCheck(fileAbs: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    if (!/\.py$/i.test(fileAbs)) return resolve({ ok: true, out: "" });
    const py = process.env.COMFY_PYTHON || "C:\\ComfyUI\\python_embeded\\python.exe";
    const p = spawn(py, ["-m", "py_compile", fileAbs], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ ok: code === 0, out }));
  });
}

/** `npm run build` with a hard timeout; resolves {ok, out}. */
export function runBuild(timeoutMs = 300_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npmBin, ["run", "build"], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      shell: true,
    });
    let out = "";
    const push = (d: unknown) => {
      out += String(d);
      if (out.length > 60_000) out = out.slice(-60_000);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, out: `${out}\n[build] превышен лимит времени` });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, out: `${out}\n[build] ${err.message}` });
    });
  });
}

/** Run an arbitrary command in the project root (owner-approved only). */
export function runCommand(cmd: string, timeoutMs = 300_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd: PROJECT_ROOT, shell: true, windowsHide: true });
    let out = "";
    const push = (d: unknown) => {
      out += String(d);
      if (out.length > 60_000) out = out.slice(-60_000);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, out: `${out}\n[cmd] превышен лимит времени (${Math.round(timeoutMs / 1000)}с)` });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, out: `${out}\n[cmd] ${err.message}` });
    });
  });
}

function makeId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Register a change that needs the owner's explicit approval. */
export async function createPending(
  kind: PendingEntry["kind"],
  payload: { file?: string; content?: string; oldText?: string; newText?: string; cmd?: string; chatId?: number | string },
): Promise<{ id: string; ttlMs: number; description: string }> {
  const id = makeId();
  const entry: PendingEntry = { id, kind, ...payload, createdAt: Date.now() };
  pending[id] = entry;
  await persistPending();
  await appendAudit({ action: `pending:${kind}`, file: entry.file ?? null, cmd: entry.cmd ?? null, id });
  return { id, ttlMs: settings.approvalTtlMs, description: describePending(entry) };
}

function describePending(e: PendingEntry): string {
  switch (e.kind) {
    case "write":
      return `Запись файла «${e.file}» (${(e.content ?? "").length} симв.)`;
    case "replace":
      return `Замена в «${e.file}»: ${(e.oldText ?? "").slice(0, 40)} → ${(e.newText ?? "").slice(0, 40)}`;
    case "run":
      return `Команда: ${(e.cmd ?? "").slice(0, 200)}`;
    case "build":
      return "Сборка проекта (npm run build)";
  }
}

export async function rejectPending(id: string): Promise<boolean> {
  if (!pending[id]) return false;
  delete pending[id];
  await persistPending();
  await appendAudit({ action: "reject", id });
  return true;
}

/** Execute an approved pending change with backup + check + auto-rollback. */
export async function approvePending(id: string): Promise<{ ok: boolean; reply: string }> {
  const entry = pending[id];
  if (!entry) return { ok: false, reply: "Заявка не найдена (возможно, уже обработана)." };
  if (Date.now() - entry.createdAt > settings.approvalTtlMs) {
    delete pending[id];
    await persistPending();
    return { ok: false, reply: "Заявка истекла (более 10 минут). Запросите заново." };
  }
  if (await isAiStopped()) {
    return { ok: false, reply: "Автономия остановлена (/stop-ai). Включите /autonomy on." };
  }
  try {
    const result = await executeEntry(entry);
    delete pending[id];
    await persistPending();
    if (result.ok) {
      await bumpChanges();
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reply: `Ошибка исполнения: ${message}` };
  }
}

async function executeEntry(entry: PendingEntry): Promise<{ ok: boolean; reply: string }> {
  if (entry.kind === "build") {
    const res = await runBuild();
    return res.ok ? { ok: true, reply: "Сборка прошла успешно." } : { ok: false, reply: `Сборка не удалась:\n${tail(res.out, 1500)}` };
  }
  if (entry.kind === "run") {
    const res = await runCommand(entry.cmd ?? "");
    const ok = res.ok;
    const reply = ok ? "Команда выполнена." : "Команда завершилась с ошибкой.";
    return { ok, reply: `${reply}\n${tail(res.out, 3000)}` };
  }
  if (entry.kind === "write" || entry.kind === "replace") {
    const rel = entry.file ?? "";
    if (isProtected(rel)) return { ok: false, reply: `Файл «${rel}» защищён от автономного изменения.` };
    const abs = resolveProjectPath(rel);
    if (!abs) return { ok: false, reply: "путь вне проекта" };
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const backup = path.join(DATA_DIR, "backups", `${Date.now()}-${path.basename(abs)}.bak`);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.copyFile(abs, backup).catch(async () => {
      await fs.writeFile(backup, "", "utf8");
    });
    try {
      if (entry.kind === "write") {
        await fs.writeFile(abs, entry.content ?? "", "utf8");
      } else {
        const oldText = entry.oldText ?? "";
        const content = await fs.readFile(abs, "utf8");
        if (!content.includes(oldText)) {
          await fs.copyFile(backup, abs);
          return { ok: false, reply: `Не удалось найти фрагмент для замены в «${rel}».` };
        }
        await fs.writeFile(abs, content.split(oldText).join(entry.newText ?? ""), "utf8");
      }
      // Syntax gates: node --check (js) + py_compile (py) → then full build.
      const jsCheck = await runNodeCheck(abs);
      if (!jsCheck.ok) {
        await fs.copyFile(backup, abs);
        return { ok: false, reply: `Синтаксис не прошёл проверку (откат):\n${tail(jsCheck.out, 800)}` };
      }
      const pyCheck = await runPyCheck(abs);
      if (!pyCheck.ok) {
        await fs.copyFile(backup, abs);
        return { ok: false, reply: `Python не скомпилировался (откат):\n${tail(pyCheck.out, 800)}` };
      }
      const build = await runBuild();
      if (!build.ok) {
        await fs.copyFile(backup, abs);
        return { ok: false, reply: `Сборка не прошла — автооткат:\n${tail(build.out, 1500)}` };
      }
      await appendAudit({ action: entry.kind, file: rel, ok: true });
      return { ok: true, reply: `Изменение «${rel}» применено и проверено сборкой.` };
    } finally {
      await fs.rm(backup, { force: true }).catch(() => {});
    }
  }
  return { ok: false, reply: "Неизвестный тип заявки." };
}

async function bumpChanges(): Promise<void> {
  state.changes += 1;
  await persistState();
}

export async function changesLeft(): Promise<number> {
  return Math.max(0, settings.maxChangesPerSession - state.changes);
}

/** Track the LLM read-loop; returns how many reads were already used. */
export function countRead(chatId: string): number {
  const now = Date.now();
  const rec = readLoops.get(chatId);
  if (!rec || now - rec.at > 5 * 60_000) {
    readLoops.set(chatId, { reads: 1, at: now });
    return 1;
  }
  rec.reads += 1;
  rec.at = now;
  return rec.reads;
}

export function resetReadLoop(chatId: string): void {
  readLoops.delete(chatId);
}

function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `…${s.slice(-max)}`;
}

async function persistPending(): Promise<void> {
  await writeJson(PENDING_FILE, pending);
}

async function persistState(): Promise<void> {
  await writeJson(STATE_FILE, state);
}

/** Copy a snippet of a file for the approval preview. */
export async function filePreview(rel: string, max = 1200): Promise<string> {
  const abs = resolveProjectPath(rel);
  if (!abs) throw new Error("путь вне проекта");
  const content = await fs.readFile(abs, "utf8");
  return content.length > max ? `${content.slice(0, max)}\n…` : content;
}

export function tempDir(): string {
  return os.tmpdir();
}
