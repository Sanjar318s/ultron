/**
 * ULTRON Telegram bot — long-polling bridge between Telegram and the local
 * assistant core (/api/assistant). Run alongside the web server:
 *
 *   npm run bot
 *
 * The owner (TELEGRAM_OWNER_USERNAME) gets full admin access: file ops, shell,
 * git, build, snapshots, rollback, and LLM-autonomy approval. Allowed users
 * (TELEGRAM_ALLOWED_USERNAMES / /adduser) can only chat with the assistant.
 *
 * Config (env):
 *   TELEGRAM_BOT_TOKEN       — from @BotFather
 *   TELEGRAM_OWNER_USERNAME  — Telegram username of the owner (admin)
 *   TELEGRAM_ALLOWED_USERNAMES — comma-separated additional allowed users
 *   ULTRON_SERVER            — base URL of the web app (default :3000)
 *   GITHUB_TOKEN             — used to authenticate `git` operations
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, openSync, readdirSync, statSync, existsSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const TMP_LOG = path.join(os.tmpdir(), "opencode");

function loadDotEnv(file) {
  try {
    const raw = readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    // .env missing — rely on the environment.
  }
}
loadDotEnv(path.join(__dirname, "..", ".env"));
loadDotEnv(path.join(__dirname, "..", ".env.local"));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SERVER = process.env.ULTRON_SERVER ?? "http://localhost:3000";
const OWNER_USERNAME = (process.env.TELEGRAM_OWNER_USERNAME ?? "").trim().toLowerCase();
const ALLOWED_USERNAMES = (process.env.TELEGRAM_ALLOWED_USERNAMES ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

if (!TOKEN) {
  console.error("[bot] TELEGRAM_BOT_TOKEN не задан. Добавьте его в .env");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const POLL_TIMEOUT = 25;

const REGISTRY_FILE = path.join(DATA_DIR, "telegram-users.json");
const AUDIT_FILE = path.join(DATA_DIR, "admin-log.jsonl");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const SNAPSHOT_FILE = path.join(DATA_DIR, "snapshots.json");
const STOP_FILE = path.join(DATA_DIR, "stop-ai");

function loadJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return fallback;
  }
}

let registry = loadJson(REGISTRY_FILE, {
  owner: { username: OWNER_USERNAME || null, id: null },
  allowed: [],
});
let settings = loadJson(SETTINGS_FILE, { autonomy: true, maxChangesPerSession: 3, approvalTtlMs: 600_000, protectedFiles: [] });

function saveRegistry() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}
function saveSettings() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
function audit(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
  } catch {
    // audit must never crash the bot
  }
}
function isStopped() {
  return existsSync(STOP_FILE);
}

// ---------------------------------------------------------------------------
// Auth: owner / allowed
// ---------------------------------------------------------------------------

function isOwner(from) {
  const name = (from?.username ?? "").toLowerCase();
  const id = from?.id;
  if (registry.owner.username && name === registry.owner.username) return true;
  if (registry.owner.id !== null && registry.owner.id === id) return true;
  if (OWNER_USERNAME && name === OWNER_USERNAME) return true;
  return false;
}

function isAllowed(from) {
  if (isOwner(from)) return true;
  const name = (from?.username ?? "").toLowerCase();
  const id = from?.id;
  return registry.allowed.some((u) => (u.username && u.username === name) || (u.id !== null && u.id === id));
}

/** Fix numeric ids on first contact; auto-admit env-listed usernames. */
function registerUser(from) {
  const name = (from?.username ?? "").toLowerCase();
  const id = from?.id;
  if (!name && id === undefined) return;
  let changed = false;
  if (registry.owner.username && name === registry.owner.username && registry.owner.id !== id) {
    registry.owner.id = id;
    changed = true;
  }
  for (const u of registry.allowed) {
    if (u.username && name === u.username && u.id !== id) {
      u.id = id;
      changed = true;
    }
  }
  if (ALLOWED_USERNAMES.includes(name) && !registry.allowed.some((u) => u.username === name)) {
    registry.allowed.push({ username: name, id: id ?? null, addedAt: Date.now() });
    changed = true;
  }
  if (changed) saveRegistry();
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

async function apiCall(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(POLL_TIMEOUT * 1000 + 15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} → HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function sendText(chatId, text) {
  for (const chunk of splitText(String(text ?? ""), 4096)) {
    await apiCall("sendMessage", { chat_id: chatId, text: chunk });
  }
}

async function sendPhoto(chatId, b64, mime) {
  const buf = Buffer.from(b64, "base64");
  const ext = (mime ?? "image/png").split("/")[1] ?? "png";
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("photo", new Blob([buf], { type: mime ?? "image/png" }), `image.${ext}`);
  await fetch(`${API}/sendPhoto`, { method: "POST", body: fd });
}

function splitText(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut <= max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

async function removeButtons(chatId, messageId) {
  await apiCall("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
}

// --- HTML / status helpers --------------------------------------------------

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stripTags = (s) => String(s ?? "").replace(/<[^>]*>/g, "");

/** Send with HTML parse_mode; falls back to plain text if Telegram rejects a chunk. */
async function sendHtml(chatId, text, extra = {}) {
  for (const chunk of splitText(String(text ?? ""), 3900)) {
    try {
      await apiCall("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "HTML", ...extra });
    } catch {
      await apiCall("sendMessage", { chat_id: chatId, text: stripTags(chunk), ...extra }).catch(() => {});
    }
  }
}

async function typing(chatId) {
  await apiCall("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

/** Send a transient status message and return its message_id for later editing. */
async function sendStatus(chatId, text) {
  try {
    const res = await apiCall("sendMessage", { chat_id: chatId, text });
    return res.result?.message_id ?? null;
  } catch {
    return null;
  }
}

async function editStatus(chatId, messageId, text) {
  await apiCall("editMessageText", { chat_id: chatId, message_id: messageId, text }).catch(() => {});
}

/** Replace a status message with the final reply, sending overflow as new messages. */
async function finishStatus(chatId, messageId, reply) {
  const chunks = splitText(String(reply ?? ""), 4096);
  if (messageId !== null && chunks.length > 0) {
    await editStatus(chatId, messageId, chunks[0]);
    chunks.shift();
  }
  for (const c of chunks) await sendText(chatId, c);
}

// ---------------------------------------------------------------------------
// Local exec / files
// ---------------------------------------------------------------------------

function runCmd(cmd, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd: opts.cwd ?? ROOT, shell: true, windowsHide: true });
    let out = "";
    const push = (d) => {
      out += String(d);
      if (out.length > 80_000) out = out.slice(-80_000);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const t = setTimeout(() => {
      child.kill();
      resolve({ ok: false, out: `${out}\n[timeout]` });
    }, opts.timeout ?? 240_000);
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ ok: false, out: `${out}\n[error] ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, out });
    });
  });
}

function resolvePath(rel) {
  const target = path.resolve(ROOT, rel);
  const relCheck = path.relative(ROOT, target);
  if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) return null;
  if (target.toLowerCase() === ROOT.toLowerCase()) return null;
  return target;
}

function gitArgs(args) {
  if (!GITHUB_TOKEN) return args;
  const auth = Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64");
  return ["-c", `http.extraheader=Authorization: Basic ${auth}`, ...args];
}

function git(args) {
  return new Promise((resolve) => {
    execFile("git", gitArgs(args), { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

/** Wrap a PowerShell snippet with UTF-8 output encoding (fixes cp866 mojibake). */
const ps = (cmd) =>
  `powershell -NoProfile -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${cmd}"`;

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function killPort(port) {
  await runCmd(
    ps(
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
    ),
    { timeout: 30_000 },
  );
}

function readTail(file, n) {
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    return lines.slice(-n).join("\n");
  } catch {
    return "(файл не найден)";
  }
}

// ---------------------------------------------------------------------------
// Snapshots / rollback (git-based, data/ excluded by .gitignore)
// ---------------------------------------------------------------------------

function loadSnapshots() {
  try {
    return JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveSnapshots(s) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(s, null, 2));
}

async function makeSnapshot(name) {
  const res = await runCmd(`git add -A && git stash create "autosnapshot ${name}"`, { timeout: 60_000 });
  if (!res.ok) return { ok: false, out: res.out };
  const hash = res.out.trim().split(/\r?\n/).pop().trim();
  await runCmd("git reset -q");
  if (!hash || !/^[0-9a-f]{40}$/.test(hash)) return { ok: false, out: "Нет незакоммиченных изменений для снимка." };
  const snaps = loadSnapshots();
  const key = name || String(Date.now());
  snaps[key] = { hash, at: Date.now() };
  saveSnapshots(snaps);
  audit({ action: "snapshot", name: key, hash });
  return { ok: true, out: `Снимок «${key}»: ${hash.slice(0, 10)}` };
}

async function rollbackSnapshot(name) {
  const snaps = loadSnapshots();
  const keys = Object.keys(snaps);
  const key = name || keys[keys.length - 1];
  const entry = key ? snaps[key] : null;
  if (!entry) return { ok: false, out: `Снимок «${name ?? "последний"}» не найден.` };
  const res = await runCmd(`git reset -q && git checkout ${entry.hash} -- . && git reset -q`, { timeout: 120_000 });
  audit({ action: "rollback", name: key, hash: entry.hash, ok: res.ok });
  return { ok: res.ok, out: res.ok ? `Откат к «${key}» (${entry.hash.slice(0, 10)}) выполнен.` : res.out };
}

// ---------------------------------------------------------------------------
// Approvals (LLM-autonomy)
// ---------------------------------------------------------------------------

/** Local shadow of server-side pending approvals: id → {id, chatId, createdAt}. */
const pendings = new Map();

function pendingFor(chatId) {
  for (const p of pendings.values()) if (p.chatId === chatId) return p;
  return null;
}

async function serverControl(payload) {
  const res = await fetch(`${SERVER}/api/assistant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(600_000),
  });
  return res.json().catch(() => null);
}

async function handleApprove(chatId, id) {
  const data = await serverControl({ action: "approve", id });
  await sendText(chatId, data?.reply ?? "Ошибка одобрения.");
}

async function handleReject(chatId, id) {
  const data = await serverControl({ action: "reject", id });
  await sendText(chatId, data?.reply ?? "Заявка отклонена.");
}

// ---------------------------------------------------------------------------
// Assistant chat
// ---------------------------------------------------------------------------

const histories = new Map();

async function chatWithAssistant(chatId, msg, text) {
  const hist = histories.get(String(chatId)) ?? [];
  hist.push({ role: "user", content: text });
  await typing(chatId);
  const statusId = await sendStatus(chatId, "⏳ Думаю…");
  let res;
  try {
    res = await fetch(`${SERVER}/api/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        history: hist.slice(0, -1).slice(-12),
        chatId: String(chatId),
        isOwner: isOwner(msg?.from),
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    await finishStatus(chatId, statusId, `Сбой обработки: ${err.message}. Сервер запущен?`);
    return;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    await finishStatus(chatId, statusId, `Ошибка сервера: ${data?.error ?? res.status}.`);
    return;
  }

  if (data.needsApproval && isOwner(msg?.from)) {
    await finishStatus(chatId, statusId, "⏳ Ожидается ваше решение.");
    const id = data.needsApproval.id;
    const desc = data.needsApproval.description;
    pendings.set(id, { id, chatId: String(chatId), createdAt: Date.now() });
    const kb = {
      inline_keyboard: [
        [
          { text: "✅ Да", callback_data: `approve:${id}` },
          { text: "❌ Нет", callback_data: `reject:${id}` },
        ],
      ],
    };
    await apiCall("sendMessage", {
      chat_id: chatId,
      text: `🔐 <b>Одобрение</b>: ${esc(desc)}\n\n⏱ ${Math.round((settings.approvalTtlMs ?? 600_000) / 60_000)} минут на решение.`,
      parse_mode: "HTML",
      reply_markup: kb,
    });
    audit({ action: "approval-prompt", id, description: desc });
    if (data.note) await sendText(chatId, data.note);
    return;
  }

  const parts = [];
  if (data.reply) parts.push(data.reply);
  if (data.generate) parts.push(data.generate);
  const joined = parts.length === 0 ? "Выполнено." : parts.join("\n\n");
  await finishStatus(chatId, statusId, joined);
  if (data.image) await sendPhoto(chatId, data.image.b64, data.image.mime);
  if (data.note) await sendText(chatId, data.note);
  hist.push({ role: "assistant", content: joined });
  if (hist.length > 16) hist.splice(0, hist.length - 16);
  histories.set(String(chatId), hist);
}

// ---------------------------------------------------------------------------
// Command parsing / help
// ---------------------------------------------------------------------------

function parseCommand(text) {
  const m = text.trim().match(/^(\/[a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), rest: (m[2] ?? "").trim() };
}

const HELP_HTML = [
  "<b>УЛЬТРОН — команды бота</b>",
  "",
  "<b>Общение</b>",
  "• просто пишите — я отвечаю",
  "• <code>найди {запрос}</code> — поиск в интернете",
  "• <code>изучи {тема}</code> — поиск и запоминание",
  "• <code>изучи {ссылка}</code> — прочитать и запомнить",
  "• <code>напиши статью про…</code> — текст",
  "• <code>нарисуй …</code> — изображение",
  "• <code>навыки</code> / <code>какие у тебя навыки</code>",
  "",
  "<b>Команды</b>",
  "• /menu — главное меню",
  "• /help — справка",
  "• /skills — список навыков",
  "• /keys — статус Gemini-ключей",
  "• /id — ваш числовой id",
].join("\n");

const ADMIN_HELP_HTML = [
  "<b>УЛЬТРОН — админ-команды владельца</b>",
  "",
  "<b>Доступ</b>",
  "• /users — список допущенных",
  "• /adduser &lt;username|id&gt; — допустить",
  "• /rmuser &lt;username|id&gt; — убрать",
  "",
  "<b>Файлы (относительно корня проекта)</b>",
  "• /ls [папка] — список",
  "• /tree [папка] — дерево",
  "• /cat &lt;файл&gt; — показать",
  "• /find &lt;имя&gt; — поиск файлов",
  "• /write &lt;файл&gt; [--no-build] + перевод строки + содержимое",
  "• /replace &lt;файл&gt; &lt;старое&gt; &lt;новое&gt; [--no-build]",
  "• /append &lt;файл&gt; + перевод строки + текст",
  "• /rm &lt;файл|папка&gt; • /mkdir &lt;папка&gt;",
  "• /mv &lt;откуда&gt; &lt;куда&gt; • /cp &lt;откуда&gt; &lt;куда&gt;",
  "",
  "<b>Система</b>",
  "• /run &lt;команда&gt; — выполнить в корне проекта",
  "• /node &lt;файл.js&gt; — запустить node",
  "• /build — npm run build",
  "• /restart — перезапустить бота",
  "• /restart-server — перезапустить веб-сервер",
  "• /log [n] — хвост логов (next/bot)",
  "• /sysinfo — CPU/RAM/диск/GPU",
  "",
  "<b>Git и снимки</b>",
  "• /git &lt;аргументы&gt; — git (авторизация через GITHUB_TOKEN)",
  "• /snapshot [имя] — снимок состояния",
  "• /snapshots — список снимков",
  "• /rollback [имя] — откат к снимку",
  "",
  "<b>Автономия ИИ</b>",
  "• /autonomy on|off|status",
  "• /veto &lt;id&gt; — отклонить заявку",
  "• /stop-ai — аварийный стоп автономии",
].join("\n");

function mainMenuKeyboard(owner) {
  const rows = [
    [
      { text: "💬 Справка", callback_data: "cmd:/help" },
      { text: "🧠 Память", callback_data: "cmd:/memory" },
      { text: "📚 Навыки", callback_data: "cmd:/skills" },
    ],
    [
      { text: "🔍 Поиск", callback_data: "cmd:/search" },
      { text: "🖼 Рисовать", callback_data: "cmd:/draw" },
      { text: "🔑 Статус", callback_data: "cmd:/keys" },
    ],
  ];
  if (owner) {
    rows.push([
      { text: "📊 Система", callback_data: "cmd:/sysinfo" },
      { text: "📁 Файлы", callback_data: "cmd:/ls" },
      { text: "🔨 Сборка", callback_data: "cmd:/build" },
    ]);
    rows.push([{ text: "🔐 Админ-команды", callback_data: "cmd:/adminhelp" }]);
  }
  rows.push([{ text: "✖ Закрыть меню", callback_data: "menu:close" }]);
  return { inline_keyboard: rows };
}

async function sendMenu(chatId, owner) {
  await apiCall("sendMessage", {
    chat_id: chatId,
    text: "🕹 <b>Главное меню</b>",
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(owner),
  });
}

/** Real skill list: screen-learned + SKILL.md catalog (not an LLM reply). */
async function renderSkills(chatId) {
  let data;
  try {
    const res = await fetch(`${SERVER}/api/skills`, { signal: AbortSignal.timeout(15_000) });
    data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error("bad response");
  } catch {
    await sendText(chatId, "Не удалось получить список навыков (сервер запущен?).");
    return;
  }
  const screen = Array.isArray(data.screen) ? data.screen : [];
  const catalog = Array.isArray(data.catalog) ? data.catalog : [];
  const lines = ["📚 <b>Мои навыки</b>", ""];
  if (screen.length > 0) {
    lines.push("<b>Экранные (шаги)</b>");
    for (const s of screen) {
      lines.push(`• ${esc(s.name)} — ${s.steps} шаг., ${s.uses} использ.`);
    }
    lines.push("");
  }
  if (catalog.length > 0) {
    lines.push("<b>Каталог (SKILL.md)</b>");
    for (const c of catalog) {
      lines.push(`• ${esc(c.name)} — ${esc(c.description)}`);
    }
    lines.push("");
  }
  if (screen.length === 0 && catalog.length === 0) lines.push("Навыков пока нет.");
  lines.push("Чтобы выполнить — просто опишите задачу, например: <code>извлеки текст из файла.pdf</code>");
  await sendHtml(chatId, lines.join("\n"));
}

/** Gemini key-pool status panel (owner + per-user). */
async function renderKeys(chatId, owner) {
  let st;
  try {
    const res = await fetch(`${SERVER}/api/keys`, { signal: AbortSignal.timeout(15_000) });
    st = await res.json().catch(() => null);
    if (!res.ok || !st) throw new Error("bad response");
  } catch {
    await sendText(chatId, "Не удалось получить статус ключей (сервер запущен?).");
    return;
  }
  const lines = ["🔑 <b>Статус Gemini-ключей</b>", ""];
  if (owner && Array.isArray(st.owner)) {
    lines.push("<b>Владелец</b>");
    for (const k of st.owner) {
      lines.push(`• Ключ №${k.index}: ${k.exhausted ? "лимит исчерпан ⏳" : "активен ✅"}`);
    }
    lines.push("");
  }
  if (typeof st.usersFree === "number") {
    lines.push(`<b>Пользователи</b>`);
    lines.push(`• В пуле: ${st.usersFree} свободн., ${st.usersAssigned} выдано, ${st.usersExhausted} исчерпано`);
  }
  lines.push("");
  lines.push("Лимиты сбрасываются в полночь по Тихоокеанскому времени.");
  await sendHtml(chatId, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Owner admin commands
// ---------------------------------------------------------------------------

function requireOwner(chatId, owner) {
  if (owner) return true;
  sendHtml(chatId, "🔒 <b>Команда доступна только владельцу.</b>");
  return false;
}

function splitPathContent(rest) {
  const nl = rest.indexOf("\n");
  if (nl === -1) return [rest, ""];
  return [rest.slice(0, nl).trim(), rest.slice(nl + 1)];
}

async function applyFileWrite(chatId, fileArg, content, action) {
  let noBuild = false;
  let rel = fileArg;
  if (rel.startsWith("--no-build")) {
    noBuild = true;
    rel = rel.replace(/^--no-build\s*/, "").trim();
  }
  const abs = resolvePath(rel);
  if (!abs) {
    await sendText(chatId, "Путь вне проекта.");
    return;
  }
  const backup = path.join(DATA_DIR, "backups", `${Date.now()}-${path.basename(abs)}.bak`);
  mkdirSync(path.dirname(backup), { recursive: true });
  const hadOriginal = existsSync(abs);
  if (hadOriginal) writeFileSync(backup, readFileSync(abs));
  try {
    if (action === "write") writeFileSync(abs, content, "utf8");
    else appendFileSync(abs, content, "utf8");
  } catch (err) {
    await sendText(chatId, `Ошибка записи: ${err.message}`);
    return;
  }
  audit({ action, file: rel, by: "owner" });

  if (!noBuild) {
    const check = await runCmd(`node --check ${JSON.stringify(abs)}`, { timeout: 30_000 });
    if (!check.ok) {
      if (hadOriginal) writeFileSync(abs, readFileSync(backup));
      await sendText(chatId, `Синтаксис не прошёл проверку — откат:\n${check.out.slice(0, 800)}`);
      return;
    }
    const build = await runCmd("npm run build", { timeout: 360_000 });
    if (!build.ok) {
      if (hadOriginal) writeFileSync(abs, readFileSync(backup));
      await sendText(chatId, `Сборка не прошла — откат:\n${build.out.slice(-1200)}`);
      return;
    }
    await sendText(chatId, `✅ ${action === "write" ? "Записан" : "Дополнен"} «${rel}» (проверено сборкой).`);
  } else {
    await sendText(chatId, `Записан «${rel}» (без сборки).`);
  }
}

function walk(root, maxDepth) {
  const out = [];
  function rec(dir, depth) {
    if (depth > maxDepth || out.length > 200) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === ".git" || e.name === "data") continue;
      if (e.isDirectory()) rec(path.join(dir, e.name), depth + 1);
      else out.push(path.relative(ROOT, path.join(dir, e.name)));
    }
  }
  rec(root, 0);
  return out;
}

async function handleCommand(chatId, msg, cmd) {
  const { name, rest } = cmd;
  const owner = isOwner(msg?.from);
  const fromName = msg?.from?.username ?? String(msg?.from?.id ?? "?");

  switch (name) {
    case "/start": {
      const who = owner ? "Владелец" : isAllowed(msg.from) ? "Гость" : "";
      await sendHtml(chatId, `Привет! Я <b>УЛЬТРОН</b>${who ? ` (${who})` : ""} — ваш ИИ-ассистент.\n\n${HELP_HTML}`);
      await sendMenu(chatId, owner);
      return;
    }
    case "/help": {
      await sendHtml(chatId, owner ? `${HELP_HTML}\n\n${ADMIN_HELP_HTML}` : HELP_HTML);
      await sendMenu(chatId, owner);
      return;
    }
    case "/menu": {
      await sendMenu(chatId, owner);
      return;
    }
    case "/id": {
      await sendText(chatId, `Ваш id: ${chatId}`);
      return;
    }
    case "/memory": {
      await chatWithAssistant(chatId, msg, "покажи свою память: какие правила, навыки и заметки ты помнишь");
      return;
    }
    case "/skills": {
      await renderSkills(chatId);
      return;
    }
    case "/keys": {
      await renderKeys(chatId, owner);
      return;
    }
    case "/search": {
      await sendHtml(chatId, "🔍 <b>Интернет-поиск</b>\n\nНапишите: <code>найди {запрос}</code>\nНапример: <code>найди последние новости про ИИ</code>");
      return;
    }
    case "/draw": {
      await sendHtml(chatId, "🖼 <b>Генерация изображений</b>\n\nНапишите: <code>нарисуй {описание}</code>\nНапример: <code>нарисуй неоновый кибергород</code>");
      return;
    }
    case "/adminhelp": {
      if (!requireOwner(chatId, owner)) return;
      await sendHtml(chatId, ADMIN_HELP_HTML);
      return;
    }

    // ---- access ----
    case "/users": {
      if (!requireOwner(chatId, owner)) return;
      const lines = [`Владелец: ${registry.owner.username ?? "?"} (id: ${registry.owner.id ?? "не зарегистрирован"})`];
      if (registry.allowed.length === 0) lines.push("Допущенных нет.");
      for (const u of registry.allowed) lines.push(`• ${u.username ?? u.id} (id: ${u.id ?? "?"})`);
      await sendText(chatId, lines.join("\n"));
      return;
    }
    case "/adduser": {
      if (!requireOwner(chatId, owner)) return;
      const key = rest.trim().replace(/^@/, "").toLowerCase();
      if (!key) {
        await sendText(chatId, "Укажите username или id: /adduser <username|id>");
        return;
      }
      if (/^\d+$/.test(key)) {
        if (!registry.allowed.some((u) => u.id === Number(key))) {
          registry.allowed.push({ username: null, id: Number(key), addedAt: Date.now() });
          saveRegistry();
          audit({ action: "adduser", by: fromName, key });
          await sendText(chatId, `Допущен id ${key}.`);
        } else {
          await sendText(chatId, "Уже допущен.");
        }
      } else {
        if (!registry.allowed.some((u) => u.username === key)) {
          registry.allowed.push({ username: key, id: null, addedAt: Date.now() });
          saveRegistry();
          audit({ action: "adduser", by: fromName, key });
          await sendText(chatId, `Допущен @${key} (id зафиксируется при первом сообщении).`);
        } else {
          await sendText(chatId, "Уже допущен.");
        }
      }
      return;
    }
    case "/rmuser": {
      if (!requireOwner(chatId, owner)) return;
      const key = rest.trim().replace(/^@/, "").toLowerCase();
      const before = registry.allowed.length;
      registry.allowed = registry.allowed.filter((u) => u.username !== key && u.id !== Number(key));
      if (registry.allowed.length !== before) {
        saveRegistry();
        audit({ action: "rmuser", by: fromName, key });
        await sendText(chatId, `Убран ${key}.`);
      } else {
        await sendText(chatId, "Не найден.");
      }
      return;
    }

    // ---- files ----
    case "/ls": {
      if (!requireOwner(chatId, owner)) return;
      const dir = rest || ".";
      const abs = resolvePath(dir);
      if (!abs) {
        await sendText(chatId, "Путь вне проекта.");
        return;
      }
      try {
        const entries = readdirSync(abs, { withFileTypes: true });
        if (entries.length === 0) {
          await sendText(chatId, "(пусто)");
          return;
        }
        const lines = await Promise.all(
          entries.map(async (e) => {
            const full = path.join(abs, e.name);
            if (e.isDirectory()) return `[DIR]  ${e.name}`;
            try {
              const st = statSync(full);
              return `${st.size >= 1024 ? `${(st.size / 1024).toFixed(1)}K` : `${st.size}B`}`.padStart(8) + `  ${e.name}`;
            } catch {
              return `      ?  ${e.name}`;
            }
          }),
        );
        await sendText(chatId, `${dir}:\n${lines.join("\n")}`);
      } catch (err) {
        await sendText(chatId, `Ошибка: ${err.message}`);
      }
      return;
    }
    case "/tree": {
      if (!requireOwner(chatId, owner)) return;
      const dir = rest || ".";
      const abs = resolvePath(dir);
      if (!abs) {
        await sendText(chatId, "Путь вне проекта.");
        return;
      }
      const out = [];
      const walkTree = (dir2, indent, depth) => {
        if (depth > 2 || out.length > 300) return;
        let entries;
        try {
          entries = readdirSync(dir2, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
          if (e.isDirectory()) {
            out.push(`${indent}[DIR] ${e.name}`);
            walkTree(path.join(dir2, e.name), `${indent}  `, depth + 1);
          } else {
            out.push(`${indent}${e.name}`);
          }
        }
      };
      out.push(dir);
      walkTree(abs, "  ", 0);
      await sendText(chatId, out.join("\n"));
      return;
    }
    case "/cat": {
      if (!requireOwner(chatId, owner)) return;
      const abs = resolvePath(rest);
      if (!abs) {
        await sendText(chatId, "Путь вне проекта.");
        return;
      }
      try {
        const content = readFileSync(abs, "utf8");
        const capped = content.length > 20_000 ? `${content.slice(0, 20_000)}\n…[обрезано]` : content;
        await sendText(chatId, `— ${rest} —\n${capped}`);
      } catch (err) {
        await sendText(chatId, `Не удалось прочитать: ${err.message}`);
      }
      return;
    }
    case "/find": {
      if (!requireOwner(chatId, owner)) return;
      const q = rest.toLowerCase();
      if (!q) {
        await sendText(chatId, "Укажите имя файла: /find <имя>");
        return;
      }
      const matches = walk(ROOT, 5).filter((f) => path.basename(f).toLowerCase().includes(q));
      await sendText(chatId, matches.length === 0 ? "Ничего не найдено." : `Найдено:\n${matches.slice(0, 50).join("\n")}`);
      return;
    }
    case "/write": {
      if (!requireOwner(chatId, owner)) return;
      const [fileArg, content] = splitPathContent(rest);
      if (!fileArg) {
        await sendText(chatId, "Формат: /write <файл>\n<содержимое>");
        return;
      }
      await applyFileWrite(chatId, fileArg, content, "write");
      return;
    }
    case "/append": {
      if (!requireOwner(chatId, owner)) return;
      const [fileArg, content] = splitPathContent(rest);
      if (!fileArg) {
        await sendText(chatId, "Формат: /append <файл>\n<текст>");
        return;
      }
      await applyFileWrite(chatId, fileArg, content, "append");
      return;
    }
    case "/replace": {
      if (!requireOwner(chatId, owner)) return;
      const m = rest.match(/^(\S+)\s+([\s\S]+?)\s+([\s\S]+?)(?:\s+--no-build)?$/);
      if (!m) {
        await sendText(chatId, "Формат: /replace <файл> <старое> <новое> [--no-build]");
        return;
      }
      let [, rel, oldText, newText] = m;
      const noBuild = /--no-build\s*$/.test(rest);
      const abs = resolvePath(rel);
      if (!abs) {
        await sendText(chatId, "Путь вне проекта.");
        return;
      }
      try {
        const content = readFileSync(abs, "utf8");
        if (!content.includes(oldText)) {
          await sendText(chatId, "Фрагмент не найден.");
          return;
        }
        const backup = path.join(DATA_DIR, "backups", `${Date.now()}-${path.basename(abs)}.bak`);
        mkdirSync(path.dirname(backup), { recursive: true });
        writeFileSync(backup, content);
        writeFileSync(abs, content.split(oldText).join(newText), "utf8");
        audit({ action: "replace", file: rel, by: fromName });
        if (!noBuild) {
          const build = await runCmd("npm run build", { timeout: 360_000 });
          if (!build.ok) {
            writeFileSync(abs, readFileSync(backup));
            await sendText(chatId, `Сборка не прошла — откат:\n${build.out.slice(-1200)}`);
            return;
          }
        }
        await sendText(chatId, `✅ Заменено в «${rel}».`);
      } catch (err) {
        await sendText(chatId, `Ошибка: ${err.message}`);
      }
      return;
    }
    case "/rm": {
      if (!requireOwner(chatId, owner)) return;
      const abs = resolvePath(rest);
      if (!abs) {
        await sendText(chatId, "Путь вне проекта.");
        return;
      }
      const base = path.basename(abs);
      if (base === "node_modules" || base === ".git") {
        await sendText(chatId, "Этот каталог удалять нельзя.");
        return;
      }
      audit({ action: "rm", file: rest, by: fromName });
      await runCmd(`rm -rf ${JSON.stringify(abs)}`, { timeout: 60_000 });
      await sendText(chatId, `Удалено: ${rest}`);
      return;
    }
    case "/mkdir": {
      if (!requireOwner(chatId, owner)) return;
      const abs = resolvePath(rest);
      if (!abs) {
        await sendText(chatId, "Путь вне проекта.");
        return;
      }
      try {
        mkdirSync(abs, { recursive: true });
        await sendText(chatId, `Создано: ${rest}`);
      } catch (err) {
        await sendText(chatId, `Ошибка: ${err.message}`);
      }
      return;
    }
    case "/mv":
    case "/cp": {
      if (!requireOwner(chatId, owner)) return;
      const [a, b] = rest.split(/\s+/).filter(Boolean);
      const absA = a ? resolvePath(a) : null;
      const absB = b ? resolvePath(b) : null;
      if (!absA || !absB) {
        await sendText(chatId, "Оба пути должны быть внутри проекта.");
        return;
      }
      audit({ action: name.slice(1), from: a, to: b, by: fromName });
      const cmd = name === "/mv" ? `mv` : `cp -r`;
      await runCmd(`${cmd} ${JSON.stringify(absA)} ${JSON.stringify(absB)}`, { timeout: 60_000 });
      await sendText(chatId, "Готово.");
      return;
    }

    // ---- system ----
    case "/run": {
      if (!requireOwner(chatId, owner)) return;
      if (!rest) {
        await sendText(chatId, "Укажите команду: /run <команда>");
        return;
      }
      audit({ action: "run", cmd: rest.slice(0, 200), by: fromName });
      const statusId = await sendStatus(chatId, `⏳ Выполняю: ${rest}`);
      const r = await runCmd(rest, { timeout: 300_000 });
      const head = r.ok ? "" : "⚠️ Команда завершилась с ошибкой.\n";
      await finishStatus(chatId, statusId, `${head}${r.out.slice(0, 3500) || "(без вывода)"}`);
      return;
    }
    case "/node": {
      if (!requireOwner(chatId, owner)) return;
      const abs = resolvePath(rest);
      if (!abs) {
        await sendText(chatId, "Путь вне проекта.");
        return;
      }
      audit({ action: "node", file: rest, by: fromName });
      const statusId = await sendStatus(chatId, `⏳ Запускаю: ${rest}`);
      const r = await runCmd(`node ${JSON.stringify(abs)}`, { timeout: 300_000 });
      await finishStatus(chatId, statusId, `${r.out.slice(0, 3500) || "(без вывода)"}${r.ok ? "" : "\n⚠️ exit != 0"}`);
      return;
    }
    case "/build": {
      if (!requireOwner(chatId, owner)) return;
      audit({ action: "build", by: fromName });
      const statusId = await sendStatus(chatId, "⏳ Собираю (next build)…");
      const r = await runCmd("npm run build", { timeout: 360_000 });
      const last = r.out.split(/\r?\n/).slice(-25).join("\n");
      await finishStatus(chatId, statusId, r.ok ? `✅ Сборка успешна.\n${last}` : `⚠️ Сборка не удалась:\n${last}`);
      return;
    }
    case "/restart": {
      if (!requireOwner(chatId, owner)) return;
      audit({ action: "restart", by: fromName });
      await sendText(chatId, "Перезапускаю бота…");
      mkdirSync(TMP_LOG, { recursive: true });
      const logFd = openSync(path.join(TMP_LOG, "bot.log"), "a");
      const child = spawn(process.execPath, [__filename], { cwd: ROOT, detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true });
      child.unref();
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    case "/restart-server": {
      if (!requireOwner(chatId, owner)) return;
      audit({ action: "restart-server", by: fromName });
      await sendText(chatId, "⏳ Перезапускаю веб-сервер…");
      await killPort(3000);
      mkdirSync(TMP_LOG, { recursive: true });
      const logFd = openSync(path.join(TMP_LOG, "next.log"), "a");
      const child = spawn("npm.cmd", ["run", "start"], { cwd: ROOT, detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true });
      child.unref();
      await sendText(chatId, "Запущен next start -p 3000. Проверяю доступность…");
      const ok = await waitForServer(3000, 120_000);
      await sendText(chatId, ok ? "✅ Сервер снова доступен." : "⚠️ Сервер не поднялся за 2 минуты. Смотрите /log.");
      return;
    }
    case "/log": {
      if (!requireOwner(chatId, owner)) return;
      const n = Math.max(5, Math.min(200, Number(rest) || 50));
      const next = readTail(path.join(TMP_LOG, "next.log"), n);
      await sendText(chatId, `— next.log (последние ${n}) —\n${next}`);
      return;
    }
    case "/sysinfo": {
      if (!requireOwner(chatId, owner)) return;
      const r = await runCmd(
        ps(
          `$os=Get-CimInstance Win32_OperatingSystem; $cpu=Get-CimInstance Win32_Processor | Select-Object -First 1; $disk=Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'; $gpu=Get-CimInstance Win32_VideoController | Select-Object -First 1; $up=(Get-Date)-$os.LastBootUpTime; Write-Output ('OS: '+$os.Caption); Write-Output ('Uptime: '+[math]::Round($up.TotalHours,1)+' h'); Write-Output ('CPU: '+$cpu.Name+' load '+$cpu.LoadPercentage+'%'); Write-Output ('RAM free: '+[math]::Round($os.FreePhysicalMemory/1MB,1)+' GB / '+[math]::Round($os.TotalVisibleMemorySize/1MB,1)+' GB'); $disk | ForEach-Object { Write-Output ('DISK '+$_.DeviceID+' free '+[math]::Round($_.FreeSpace/1GB,1)+' GB / '+[math]::Round($_.Size/1GB,1)+' GB') }; Write-Output ('GPU: '+$gpu.Name)`,
        ),
        { timeout: 60_000 },
      );
      await sendText(chatId, `📊 Система:\n${r.out}`);
      return;
    }

    // ---- git / snapshots ----
    case "/git": {
      if (!requireOwner(chatId, owner)) return;
      if (!rest) {
        const s = await git(["status", "--short"]);
        await sendText(chatId, `git status:\n${s.out.slice(0, 3000) || "(чисто)"}`);
        return;
      }
      audit({ action: "git", cmd: rest.slice(0, 200), by: fromName });
      const r = await git(rest.split(/\s+/).filter(Boolean));
      await sendText(chatId, r.ok ? r.out.slice(0, 3500) : `⚠️ ${r.out.slice(0, 3500)}`);
      return;
    }
    case "/snapshot": {
      if (!requireOwner(chatId, owner)) return;
      const name = (rest || "").replace(/\s+/g, "-") || undefined;
      const r = await makeSnapshot(name);
      await sendText(chatId, r.ok ? `✅ ${r.out}` : `⚠️ ${r.out}`);
      return;
    }
    case "/snapshots": {
      if (!requireOwner(chatId, owner)) return;
      const snaps = loadSnapshots();
      const keys = Object.keys(snaps);
      await sendText(chatId, keys.length === 0 ? "Снимков нет." : `Снимки:\n${keys.map((k) => `• ${k} (${new Date(snaps[k].at).toLocaleString("ru-RU")}, ${snaps[k].hash.slice(0, 10)})`).join("\n")}`);
      return;
    }
    case "/rollback": {
      if (!requireOwner(chatId, owner)) return;
      const r = await rollbackSnapshot(rest || undefined);
      await sendText(chatId, r.ok ? `✅ ${r.out}` : `⚠️ ${r.out}`);
      return;
    }

    // ---- autonomy ----
    case "/autonomy": {
      if (!requireOwner(chatId, owner)) return;
      const arg = rest.split(/\s+/)[0];
      if (arg === "on") {
        settings.autonomy = true;
        saveSettings();
        await import("node:fs").then((fs) => fs.rmSync(STOP_FILE, { force: true }));
        audit({ action: "autonomy-on", by: fromName });
        await sendText(chatId, "✅ Автономия ИИ включена.");
      } else if (arg === "off") {
        settings.autonomy = false;
        saveSettings();
        audit({ action: "autonomy-off", by: fromName });
        await sendText(chatId, "Автономия ИИ выключена.");
      } else {
        const stopped = isStopped();
        const changesUsed = (() => {
          try {
            const st = JSON.parse(readFileSync(path.join(DATA_DIR, "autonomy-state.json"), "utf8"));
            return st.changes ?? 0;
          } catch {
            return 0;
          }
        })();
        await sendText(
          chatId,
          `Автономия: ${settings.autonomy ? "ВКЛ" : "ВЫКЛ"}\nСтоп-флаг: ${stopped ? "установлен (/stop-ai)" : "нет"}\nИзменений за сессию: ${changesUsed}/${settings.maxChangesPerSession ?? 3}`,
        );
      }
      return;
    }
    case "/veto": {
      if (!requireOwner(chatId, owner)) return;
      const id = rest.trim();
      if (!id) {
        await sendText(chatId, "Укажите id заявки (см. сообщение с кнопками).");
        return;
      }
      pendings.delete(id);
      await handleReject(chatId, id);
      return;
    }
    case "/stop-ai": {
      if (!requireOwner(chatId, owner)) return;
      writeFileSync(STOP_FILE, String(Date.now()));
      audit({ action: "stop-ai", by: fromName });
      await sendText(chatId, "🛑 Автономия остановлена. Включить: /autonomy on.");
      return;
    }

    default:
      await sendText(chatId, "Неизвестная команда. /help");
  }
}

// ---------------------------------------------------------------------------
// Natural-language admin intents (owner only)
// ---------------------------------------------------------------------------

async function tryNlAdmin(chatId, msg, text) {
  const lower = text.toLowerCase();
  await typing(chatId);
  if (/свободное место|место на диске|сколько места|диск заполнен/.test(lower)) {
    const r = await runCmd(
      ps(
        `$disk=Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'; $disk | ForEach-Object { Write-Output ($_.DeviceID+' free '+[math]::Round($_.FreeSpace/1GB,1)+' GB / '+[math]::Round($_.Size/1GB,1)+' GB') }`,
      ),
      { timeout: 60_000 },
    );
    await sendText(chatId, `💾 Место на диске:\n${r.out}`);
    return true;
  }
  // «сколько место освободилось / сколько стало свободно» — реальный замер TEMP.
  if (/сколько\s+(место|места|пространства)\s+(освободилось|освободил|осталось|свободно|стало)/.test(lower)) {
    const before = await runCmd(
      ps(
        `$s=(Get-ChildItem $env:TEMP -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; Write-Output ('TEMP: '+[math]::Round($s/1GB,2)+' GB')`,
      ),
      { timeout: 60_000 },
    );
    const disk = await runCmd(
      ps(
        `$d=Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -First 1; Write-Output ('DISK '+$d.DeviceID+' free '+[math]::Round($d.FreeSpace/1GB,1)+' GB / '+[math]::Round($d.Size/1GB,1)+' GB')`,
      ),
      { timeout: 60_000 },
    );
    await sendText(chatId, `${before.out.trim()}\n${disk.out.trim()}\n\nМогу очистить временные файлы: «очисти временные файлы».`);
    return true;
  }
  if (/статус системы|состояние системы|загрузка системы|статус пк|состояние пк/.test(lower)) {
    const fake = { name: "/sysinfo", rest: "" };
    await handleCommand(chatId, msg, fake);
    return true;
  }
  if (/покажи файл|покажи содержимое|выведи файл|прочитай файл/.test(lower)) {
    const m = text.match(/(?:покажи файл|покажи содержимое|выведи файл|прочитай файл)\s+(.+)/);
    const rel = m?.[1]?.trim();
    const abs = rel ? resolvePath(rel) : null;
    if (!abs) {
      await sendText(chatId, "Не понял, какой файл. Укажите путь.");
      return true;
    }
    try {
      const content = readFileSync(abs, "utf8");
      const capped = content.length > 20_000 ? `${content.slice(0, 20_000)}\n…[обрезано]` : content;
      await sendText(chatId, `— ${rel} —\n${capped}`);
    } catch (err) {
      await sendText(chatId, `Не удалось прочитать: ${err.message}`);
    }
    return true;
  }
  if (/список файлов|что в (папке|каталоге)|покажи (папку|каталог|директорию)/.test(lower)) {
    const m = text.match(/(?:папке|каталоге|папку|каталог|директорию)\s+(.+)/);
    const dir = m?.[1]?.trim() || ".";
    const abs = resolvePath(dir);
    if (!abs) {
      await sendText(chatId, "Не понял, какую папку показать.");
      return true;
    }
    const fake = { name: "/ls", rest: dir };
    await handleCommand(chatId, msg, fake);
    return true;
  }
  // «сделай что-то полезное для пк» — системный осмотр + советы, а не картинка.
  if (/что\s*[-\s]*(то|нибудь|либо)\s*[-\s]*полезн/.test(lower)) {
    await sendText(chatId, "🔍 Осматриваю систему…");
    await handleCommand(chatId, msg, { name: "/sysinfo", rest: "" });
    const tmp = await runCmd(
      ps(
        `$s=(Get-ChildItem $env:TEMP -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; Write-Output ('TEMP: '+[math]::Round($s/1GB,2)+' GB')`,
      ),
      { timeout: 60_000 },
    );
    await sendText(
      chatId,
      `${tmp.out.trim()}\n\nМогу: очистить временные файлы («очисти временные файлы»), перезапустить сервер, показать логи (/log) или собрать проект (/build).`,
    );
    return true;
  }
  // «очисти временные файлы» — безопасная чистка TEMP (best-effort).
  // Ловим и «очишай», и «очисти темп/temp», и «почисть».
  if (
    /очи(ст|ш|сти|стить|щай|стить)\s+(временн|темп|temp)|почист(и|ь)\s+(временн|темп|temp)|чистк(а|ой)\s+темп|удали\s+временн/.test(lower)
  ) {
    await sendText(chatId, "🧹 Чищу временные файлы…");
    const before = await runCmd(
      ps(
        `$s=(Get-ChildItem $env:TEMP -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; Write-Output ([math]::Round($s/1MB,1))`,
      ),
      { timeout: 60_000 },
    );
    const r = await runCmd(
      ps(
        `$ErrorActionPreference='SilentlyContinue'; Get-ChildItem $env:TEMP -Recurse -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
      ),
      { timeout: 180_000 },
    );
    const after = await runCmd(
      ps(
        `$s=(Get-ChildItem $env:TEMP -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum; Write-Output ([math]::Round($s/1MB,1))`,
      ),
      { timeout: 60_000 },
    );
    await sendText(
      chatId,
      r.ok === false
        ? `⚠️ Очистка частично не удалась: ${r.out.slice(0, 500)}`
        : `✅ Очищено. Было ~${before.out.trim()} MB мусора, осталось ~${after.out.trim()} MB.`,
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Callback (approve / reject buttons)
// ---------------------------------------------------------------------------

async function handleCallback(query) {
  const data = query.data ?? "";
  const chatId = query.message?.chat?.id;
  if (chatId === undefined) return;
  const fakeFrom = { username: query.from?.username, id: query.from?.id };
  const msg = { chat: { id: chatId }, text: "", from: query.from };
  const [verb, id] = data.split(":");

  // Main-menu buttons are open to everyone: "cmd:/xxx" re-runs a command,
  // "menu:close" hides the buttons.
  if (verb === "cmd" && id) {
    const fake = parseCommand(id.startsWith("/") ? id : `/${id}`);
    if (fake) await handleCommand(chatId, msg, fake);
    else await sendText(chatId, "Неизвестная команда. /help");
    return;
  }
  if (verb === "menu" && id === "close") {
    await removeButtons(chatId, query.message?.message_id);
    return;
  }

  // Approve/reject are owner-only.
  if (!isOwner(fakeFrom)) {
    await apiCall("answerCallbackQuery", { callback_query_id: query.id, text: "Только владелец может одобрять." }).catch(() => {});
    return;
  }
  if (!id) return;

  await apiCall("answerCallbackQuery", { callback_query_id: query.id, text: verb === "approve" ? "Одобрено" : "Отклонено" }).catch(() => {});
  await removeButtons(chatId, query.message?.message_id);
  const p = pendings.get(id);
  if (verb === "approve") {
    if (!p) {
      await sendText(chatId, "Заявка не найдена (возможно, уже обработана).");
      return;
    }
    if (Date.now() - p.createdAt > (settings.approvalTtlMs ?? 600_000)) {
      pendings.delete(id);
      await sendText(chatId, "Заявка истекла (более 10 минут). Запросите заново.");
      return;
    }
    pendings.delete(id);
    audit({ action: "approve", id, by: fakeFrom.username ?? fakeFrom.id });
    await handleApprove(chatId, id);
  } else {
    pendings.delete(id);
    audit({ action: "reject", id, by: fakeFrom.username ?? fakeFrom.id });
    await handleReject(chatId, id);
  }
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text ?? "").trim();
  if (chatId === undefined || !text) return;
  registerUser(msg.from);
  if (!isAllowed(msg.from)) {
    console.log(`[bot] заблокирован id=${chatId}`);
    return;
  }
  console.log(`[bot] ← ${chatId}: ${text.slice(0, 120)}`);

  const cmd = parseCommand(text);
  if (cmd) {
    await handleCommand(chatId, msg, cmd);
    return;
  }

  // Text answer to a pending approval (owner only).
  const pending = pendingFor(String(chatId));
  if (pending && isOwner(msg.from)) {
    const t = text.toLowerCase();
    if (/^(да|давай|ок|окей|подтверждаю|давай)([.!]|$)/.test(t)) {
      pendings.delete(pending.id);
      audit({ action: "approve-text", id: pending.id, by: msg.from?.username ?? msg.from?.id });
      await handleApprove(chatId, pending.id);
      return;
    }
    if (/^(нет|отмена|не надо|стоп|veto)([.!]|$)/.test(t)) {
      pendings.delete(pending.id);
      audit({ action: "reject-text", id: pending.id, by: msg.from?.username ?? msg.from?.id });
      await handleReject(chatId, pending.id);
      return;
    }
  }

  // Owner natural-language admin intents.
  if (isOwner(msg.from)) {
    const handled = await tryNlAdmin(chatId, msg, text);
    if (handled) return;
  }

  await chatWithAssistant(chatId, msg, text);
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

async function main() {
  let offset = 0;
  console.log(`[bot] запущен. Сервер: ${SERVER}. Владелец: @${OWNER_USERNAME || "?"}.`);
  if (registry.owner.id !== null) {
    // Startup greeting so the owner knows the bot is alive after a restart.
    try {
      await sendHtml(registry.owner.id, "🟢 <b>Бот запущен.</b>");
    } catch {
      // owner chat may be blocked — ignore
    }
  }
  while (true) {
    try {
      const data = await apiCall("getUpdates", {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of data.result ?? []) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          handleCallback(update.callback_query).catch((e) => console.error("[bot] callback error:", e.message));
          continue;
        }
        const msg = update.message;
        if (!msg || !msg.text) continue;
        await handleMessage(msg);
      }
    } catch (err) {
      console.error("[bot] polling error:", err.message ?? err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main();
