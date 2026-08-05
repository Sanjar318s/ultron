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
import { runSelfTests } from "./self-test.mjs";

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
  try {
    await apiCall("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" });
  } catch {
    await apiCall("editMessageText", { chat_id: chatId, message_id: messageId, text }).catch(() => {});
  }
}

/** Replace a status message with the final reply, sending overflow as new messages. */
async function finishStatus(chatId, messageId, reply) {
  const raw = String(reply ?? "");
  const text = raw && raw.length < 200 ? `${raw}\n\n— 🛸 УЛЬТРОН` : raw;
  const chunks = splitText(text, 3900);
  if (messageId !== null && chunks.length > 0) {
    await editStatus(chatId, messageId, chunks[0]);
    chunks.shift();
  }
  for (const c of chunks) await sendHtml(chatId, c);
}

// ---------------------------------------------------------------------------
// Local exec / files
// ---------------------------------------------------------------------------

function runCmd(cmd, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd: opts.cwd ?? ROOT, shell: true, windowsHide: true });
    let out = "";
    const push = (d) => {
      out += stripClixml(String(d));
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

/** Wrap a PowerShell snippet with UTF-8 output encoding (fixes cp866 mojibake)
 *  and silent progress (module-load progress is CLIXML noise on stderr). */
const ps = (cmd) =>
  `powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${cmd}"`;

/** Remove PowerShell's CLIXML progress-serialization blocks from mixed output. */
function stripClixml(text) {
  return String(text).replace(/#< CLIXML[\s\S]*?<\/Objs>\s*(?:#<\/CLIXML>)?/g, "").trim();
}

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

/** Chat is waiting for study input («жду ссылку/текст/фото»): chatId → type. */
const studyAwait = new Map();

/** Chats with an active study poller running. */
const studyPollers = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const statusId = await sendStatus(chatId, "💭 Думаю…");
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

  // Background study job (site crawl / image) — poll instead of finalizing.
  if (data.studyJobId) {
    await finishStatus(chatId, statusId, "📡 Изучаю ваши запросы…");
    await pollStudy(chatId, data.studyJobId, statusId);
    hist.push({ role: "assistant", content: data.reply ?? "Изучение запущено." });
    if (hist.length > 16) hist.splice(0, hist.length - 16);
    histories.set(String(chatId), hist);
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
  "🛸 <b>УЛЬТРОН</b> — команды",
  "",
  "<b>Общение</b>",
  "• просто пиши — отвечу",
  "• <code>найди {запрос}</code> — интернет",
  "• <code>изучи {тема}</code> — поиск + запоминание",
  "• <code>нарисуй {описание}</code> — картинка",
  "• <code>навыки</code> — список навыков",
  "",
  "<b>Команды</b>",
  "• /menu — меню",
  "• /help — справка",
  "• /skills — навыки",
  "• /keys — статус ключей",
  "• /id — ваш id",
  "",
  "<b>ПК (владелец)</b>",
  "• /screenshot — скриншот",
  "• /click &lt;цель&gt; — клик (напр. «нажми на капчу»)",
  "• /grid &lt;цель&gt; — клик по всем подходящим",
  "• /drag &lt;цель&gt; — перетащить слайдер",
].join("\n");

/** Command list registered via setMyCommands (shown by the «/» menu). */
const BOT_COMMANDS = [
  { command: "menu", description: "Главное меню" },
  { command: "skills", description: "Навыки — список и запуск" },
  { command: "click", description: "ИИ-клик: /click <что>" },
  { command: "screenshot", description: "Скриншот экрана" },
  { command: "memory", description: "Память: правила и заметки" },
  { command: "search", description: "Интернет-поиск" },
  { command: "draw", description: "Генерация изображений" },
  { command: "help", description: "Справка" },
  { command: "keys", description: "Статус Gemini-ключей" },
  { command: "id", description: "Ваш числовой id" },
  { command: "algorithms", description: "Алгоритмы мозга (владелец)" },
  { command: "selftest", description: "Самопроверка (владелец)" },
];

const ADMIN_HELP_HTML = [
  "🛸 <b>УЛЬТРОН</b> — админ-команды владельца",
  "",
  "<b>Доступ</b>",
  "• /users — список допущенных",
  "• /adduser &lt;имя|id&gt; — допустить",
  "• /rmuser &lt;имя|id&gt; — убрать",
  "",
  "<b>Файлы (от корня проекта)</b>",
  "• /ls [папка] • /tree [папка]",
  "• /cat &lt;файл&gt; • /find &lt;имя&gt;",
  "• /write &lt;файл&gt; [--no-build] + текст",
  "• /replace &lt;файл&gt; &lt;ст&gt; &lt;нов&gt; [--no-build]",
  "• /append &lt;файл&gt; + текст",
  "• /rm • /mkdir • /mv • /cp",
  "",
  "<b>Система</b>",
  "• /run &lt;команда&gt; — выполнить в корне",
  "• /node &lt;файл.js&gt; — запустить node",
  "• /build — npm run build",
  "• /restart — перезапуск бота",
  "• /restart-server — перезапуск веб-сервера",
  "• /log [n] — хвост логов",
  "• /sysinfo — CPU/RAM/диск/GPU",
  "• /selftest — самопроверка",
  "",
  "<b>Git и снимки</b>",
  "• /git &lt;аргументы&gt; — git",
  "• /snapshot [имя] — снимок состояния",
  "• /snapshots — список снимков",
  "• /rollback [имя] — откат к снимку",
  "",
  "<b>Автономия ИИ</b>",
  "• /autonomy on|off|status",
  "• /veto &lt;id&gt; — отклонить заявку",
  "• /stop-ai — аварийный стоп",
  "",
  "<b>Мета-обучение</b>",
  "• /algorithms — алгоритмы мозга",
  "• /algo-off &lt;id&gt; • /algo-on &lt;id&gt;",
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
    [
      { text: "📖 Изучить", callback_data: "study:menu" },
      { text: "⏳ Незавершённое", callback_data: "study:list" },
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
    text: "🛸 <b>Меню УЛЬТРОНА</b>",
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(owner),
  });
}

const SKILLS_PER_PAGE = 5;

/** Real skill list: screen-learned + SKILL.md catalog, as tappable cards. */
async function renderSkills(chatId, owner, page = 1) {
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
  const items = [
    ...screen.map((s) => ({
      id: s.id,
      name: s.name,
      desc: s.goal || "",
      tag: `экранный · ${s.steps} шаг., ${s.uses} использ.`,
      kind: "screen",
      safe: true,
    })),
    ...catalog.map((c) => ({
      id: `cat:${c.slug}`,
      name: c.name,
      desc: c.description || "",
      tag: "каталог (SKILL.md)",
      kind: "cat",
      safe: c.safe,
    })),
  ];
  if (items.length === 0) {
    await sendHtml(chatId, "📚 <b>Мои навыки</b>\n\nНавыков пока нет.");
    return;
  }
  const pages = Math.max(1, Math.ceil(items.length / SKILLS_PER_PAGE));
  const pageIdx = Math.min(Math.max(1, page), pages);
  const slice = items.slice((pageIdx - 1) * SKILLS_PER_PAGE, pageIdx * SKILLS_PER_PAGE);

  const lines = [`📚 <b>Мои навыки</b> — ${pageIdx}/${pages}`, ""];
  for (const it of slice) {
    const desc = it.desc.length > 90 ? `${it.desc.slice(0, 87).trim()}…` : it.desc;
    lines.push(
      `▫️ <b>${esc(it.name)}</b>\n   ${desc ? `${esc(desc)} ` : ""}<i>${it.tag}</i>${it.kind === "cat" && !it.safe ? " ⚠️" : ""}`,
    );
  }

  const kb = [];
  for (const it of slice) {
    const row = [
      it.safe ? { text: "▶ Запустить", callback_data: `skill:run:${it.id}` } : null,
      { text: "ℹ", callback_data: `skill:info:${it.id}` },
      it.kind === "screen" && owner ? { text: "🗑", callback_data: `skill:del:${it.id}` } : null,
    ].filter(Boolean);
    kb.push(row);
  }
  if (pages > 1) {
    const nav = [];
    if (pageIdx > 1) nav.push({ text: "◀", callback_data: `skill:page:${pageIdx - 1}` });
    nav.push({ text: `${pageIdx}/${pages}`, callback_data: "skill:none" });
    if (pageIdx < pages) nav.push({ text: "▶", callback_data: `skill:page:${pageIdx + 1}` });
    kb.push(nav);
  }
  kb.push([{ text: "✖ Закрыть", callback_data: "menu:close" }]);

  await apiCall("sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: kb },
  });
}

/** Run a vision-driven click (screenshot → Gemini → mouse) via /api/screen-act. */
async function aiClickFromTelegram(chatId, prompt, mode) {
  await typing(chatId);
  const statusId = await sendStatus(chatId, "👁 Смотрю на экран…");
  let res;
  try {
    res = await fetch(`${SERVER}/api/screen-act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, mode }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    await finishStatus(chatId, statusId, `Сбой: ${err.message}. Сервер запущен?`);
    return;
  }
  const data = await res.json().catch(() => null);
  await finishStatus(chatId, statusId, data?.reply ?? data?.error ?? `Ошибка сервера: ${res.status}.`);
}

async function screenshotToTelegram(chatId) {
  let st;
  try {
    const res = await fetch(`${SERVER}/api/screenshot`, { signal: AbortSignal.timeout(20_000) });
    st = await res.json().catch(() => null);
    if (!res.ok || !st?.b64) throw new Error(st?.error ?? res.status);
  } catch (err) {
    await sendText(chatId, `Не удалось сделать скриншот: ${err.message}`);
    return;
  }
  await sendPhoto(chatId, st.b64, st.mime ?? "image/jpeg");
}

/** Details of one skill (step list for screen skills, description for catalog). */
async function skillInfo(chatId, id) {
  let data;
  try {
    const res = await fetch(`${SERVER}/api/skills`, { signal: AbortSignal.timeout(15_000) });
    data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error("bad response");
  } catch {
    await sendText(chatId, "Сервер недоступен.");
    return;
  }
  const screen = (Array.isArray(data.screen) ? data.screen : []).find((s) => s.id === id);
  if (screen) {
    const steps = Array.isArray(screen.stepList) && screen.stepList.length > 0 ? screen.stepList : [];
    const lines = [`🧩 <b>${esc(screen.name)}</b>`, "", `<b>Цель:</b> ${esc(screen.goal || "—")}`, `<b>Использован:</b> ${screen.uses} раз`];
    if (steps.length > 0) {
      lines.push("", "<b>Шаги:</b>");
      for (let i = 0; i < steps.length; i += 1) lines.push(`${i + 1}. ${esc(steps[i])}`);
    }
    await sendHtml(chatId, lines.join("\n"));
    return;
  }
  const cat = (Array.isArray(data.catalog) ? data.catalog : []).find((c) => `cat:${c.slug}` === id);
  if (cat) {
    await sendHtml(chatId, [
      `📘 <b>${esc(cat.name)}</b>`,
      "",
      esc(cat.description || "—"),
      "",
      `Каталог SKILL.md · безопасность: ${cat.safe ? "✅ автозапуск" : "⚠️ требует одобрения владельца"}`,
    ].join("\n"));
    return;
  }
  await sendText(chatId, "Навык не найден.");
}

/** Run a skill (screen id or `cat:<slug>`) via /api/skills and report back. */
async function runSkillFromTelegram(chatId, id, owner) {
  await typing(chatId);
  const statusId = await sendStatus(chatId, "🧠 Выполняю навык…");
  let res;
  try {
    res = await fetch(`${SERVER}/api/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run", id, chatId: String(chatId), isOwner: owner }),
      signal: AbortSignal.timeout(600_000),
    });
  } catch (err) {
    await finishStatus(chatId, statusId, `Сбой: ${err.message}. Сервер запущен?`);
    return;
  }
  const data = await res.json().catch(() => null);
  await finishStatus(chatId, statusId, data?.reply ?? `Ошибка сервера: ${res.status}.`);
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
// Meta-algorithms management
// ---------------------------------------------------------------------------

async function renderAlgorithms(chatId) {
  try {
    const res = await fetch(`${SERVER}/api/meta-analyze`, { signal: AbortSignal.timeout(10_000) });
    const store = await res.json().catch(() => null);
    if (!res.ok || !store) throw new Error("bad response");

    const active = (store.algorithms || []).filter(a => a.status === "active");
    const candidates = (store.algorithms || []).filter(a => a.status === "candidate");
    const deprecated = (store.algorithms || []).filter(a => a.status === "deprecated");

    let msg = "🧠 <b>Алгоритмы мозга</b>\n\n";
    msg += `<b>Активные (${active.length}):</b>\n`;
    if (active.length === 0) msg += "  (пусто)\n";
    for (const a of active) {
      msg += `• <code>${a.id}</code> — ${a.name}\n  ${a.description}\n  Точность: ${(a.confidence * 100).toFixed(0)}% | Исп: ${a.uses}\n\n`;
    }
    msg += `<b>Кандидаты (${candidates.length}):</b>\n`;
    if (candidates.length === 0) msg += "  (пусто)\n";
    for (const a of candidates) {
      msg += `• <code>${a.id}</code> — ${a.name}\n  ${a.description}\n  Точность: ${(a.confidence * 100).toFixed(0)}% | Источник: ${a.sourceQuery || "—"}\n\n`;
    }
    if (deprecated.length > 0) {
      msg += `<b>Отключённые (${deprecated.length}):</b>\n`;
      for (const a of deprecated) {
        msg += `• <code>${a.id}</code> — ${a.name}\n`;
      }
    }
    msg += `\n/stats: ${store.stats?.totalGenerated || 0} сген., ${store.stats?.totalPromoted || 0} развёрнуто, ${store.stats?.totalDeprecated || 0} откл.`;
    await sendHtml(chatId, msg);
  } catch {
    await sendText(chatId, "Не удалось получить алгоритмы (сервер запущен?).");
  }
}

async function deactivateAlgorithm(chatId, id) {
  try {
    const res = await fetch(`${SERVER}/api/meta-analyze`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status: "deprecated" }), signal: AbortSignal.timeout(10_000) });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) { await sendText(chatId, `Ошибка: ${data?.error || "неизвестно"}`); return; }
    await sendText(chatId, `Алгоритм «${data.algo.name}» (${id}) деактивирован.`);
  } catch (err) {
    await sendText(chatId, `Ошибка: ${err.message}`);
  }
}

async function reactivateAlgorithm(chatId, id) {
  try {
    const res = await fetch(`${SERVER}/api/meta-analyze`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status: "active" }), signal: AbortSignal.timeout(10_000) });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) { await sendText(chatId, `Ошибка: ${data?.error || "неизвестно"}`); return; }
    await sendText(chatId, `Алгоритм «${data.algo.name}» (${id}) восстановлен.`);
  } catch (err) {
    await sendText(chatId, `Ошибка: ${err.message}`);
  }
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
      await sendHtml(chatId, `🛸 <b>УЛЬТРОН</b>${who ? ` (${who})` : ""} online.\nПиши что угодно — помогу. Команды: /help\n\n${HELP_HTML}`);
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
      await renderSkills(chatId, owner);
      return;
    }
    case "/keys": {
      await renderKeys(chatId, owner);
      return;
    }
    case "/algorithms": {
      if (!requireOwner(chatId, owner)) return;
      await renderAlgorithms(chatId);
      return;
    }
    case "/selftest": {
      if (!requireOwner(chatId, owner)) return;
      await sendText(chatId, "🧪 Запускаю самопроверку…");
      try {
        const results = await runSelfTests({ live: false });
        const failed = results.filter((r) => !r.ok);
        const lines = results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name} — ${r.detail}`);
        const head = `🧪 Самопроверка: ${results.length - failed.length}/${results.length} OK`;
        await sendHtml(chatId, `<b>${head}</b>\n${lines.join("\n")}`);
      } catch (e) {
        await sendText(chatId, `⚠️ Самопроверка не запустилась: ${String(e?.message ?? e).slice(0, 300)}`);
      }
      return;
    }
    case "/algo-off": {
      if (!requireOwner(chatId, owner)) return;
      if (!rest) { await sendText(chatId, "Укажите id: /algo-off <id>"); return; }
      await deactivateAlgorithm(chatId, rest.trim());
      return;
    }
    case "/algo-on": {
      if (!requireOwner(chatId, owner)) return;
      if (!rest) { await sendText(chatId, "Укажите id: /algo-on <id>"); return; }
      await reactivateAlgorithm(chatId, rest.trim());
      return;
    }
    case "/screenshot": {
      if (!requireOwner(chatId, owner)) return;
      await screenshotToTelegram(chatId);
      return;
    }
    case "/click":
    case "/grid":
    case "/drag": {
      if (!requireOwner(chatId, owner)) return;
      const mode = name.slice(1);
      if (!rest) {
        await sendText(chatId, `Укажите цель: /${mode} <что сделать>`);
        return;
      }
      await aiClickFromTelegram(chatId, rest, mode);
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
    try {
      const post = await fetch(`${SERVER}/api/clean-temp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(200_000),
      });
      const r = await post.json().catch(() => ({}));
      if (post.ok) {
        const skipped = r.failedCount > 0 ? `\nПропущено ${r.failedCount} шт. — используются запущенными программами.` : "";
        await sendText(
          chatId,
          `✅ Очистка завершена. Освобождено ~${Number(r.freedMB ?? 0).toFixed(1)} MB (${r.removedCount ?? 0} файлов).${skipped}`,
        );
      } else {
        await sendText(chatId, `⚠️ Очистка не удалась: ${String(r.error ?? post.status).slice(0, 300)}`);
      }
    } catch (e) {
      await sendText(chatId, `⚠️ Очистка не удалась: ${String(e?.message ?? e).slice(0, 300)}`);
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Study flow (📖 Изучить: ссылка / сайт / картинка / текст)
// ---------------------------------------------------------------------------

const STUDY_TYPE_LABEL = {
  url: "🔗 Ссылка",
  site: "🌐 Веб-сайт",
  image: "🖼 Картинка",
  text: "📝 Текст",
};

function studyMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔗 Ссылка", callback_data: "study:type:url" },
        { text: "🌐 Веб-сайт", callback_data: "study:type:site" },
      ],
      [
        { text: "🖼 Картинка", callback_data: "study:type:image" },
        { text: "📝 Текст", callback_data: "study:type:text" },
      ],
      [
        { text: "◀ Назад", callback_data: "menu:main" },
        { text: "✖ Закрыть", callback_data: "menu:close" },
      ],
    ],
  };
}

async function sendStudyMenu(chatId) {
  await apiCall("sendMessage", {
    chat_id: chatId,
    text: "📖 <b>Изучение</b>\nЧто изучаем? Выбери — и я попрошу только вход.",
    parse_mode: "HTML",
    reply_markup: studyMenuKeyboard(),
  });
}

async function fetchStudyJob(jobId, chatId) {
  const res = await fetch(
    `${SERVER}/api/study?jobId=${encodeURIComponent(jobId)}&chatId=${encodeURIComponent(String(chatId))}`,
    { signal: AbortSignal.timeout(15_000) },
  ).catch(() => null);
  if (!res) return null;
  const data = await res.json().catch(() => null);
  return data?.job ?? null;
}

async function activeStudyFor(chatId) {
  const res = await fetch(`${SERVER}/api/study?chatId=${encodeURIComponent(String(chatId))}`, {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) return null;
  const data = await res.json().catch(() => null);
  const list = data?.jobs ?? [];
  return list.find((j) => j.status === "queued" || j.status === "active" || j.status === "waiting") ?? null;
}

/** Start a study job via /api/study and begin polling it. */
async function startStudyFromBot(chatId, msg, type, content, image) {
  const active = await activeStudyFor(chatId);
  if (active) {
    await sendHtml(
      chatId,
      `⏳ Уже идёт изучение: <b>${esc(active.title)}</b>\n✔ ${active.studied} изучено${active.left ? `, ⏳ ${active.left} осталось` : ""}. Дождитесь завершения или решите его судьбу в «⏳ Незавершённое».`,
    );
    return;
  }
  const body = { type, content, chatId: String(chatId), isOwner: isOwner(msg?.from) };
  if (image) body.image = image;
  try {
    const res = await fetch(`${SERVER}/api/study`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.job) {
      await sendHtml(chatId, `⚠️ Не удалось начать изучение: ${esc(data?.error ?? res.status)}.`);
      return;
    }
    studyAwait.delete(String(chatId));
    const job = data.job;
    if (job.status === "queued" || job.status === "active") {
      await pollStudy(chatId, job.id);
    } else {
      await sendHtml(chatId, buildStudyReport(job));
      if (job.status === "waiting") await sendStudyDecision(chatId, job);
    }
  } catch (err) {
    await sendHtml(chatId, `⚠️ Ошибка сервера изучения: ${String(err?.message ?? err).slice(0, 300)}`);
  }
}

/** Poll a running study job, reporting progress honestly; no premature «done». */
async function pollStudy(chatId, jobId, existingStatusId = null) {
  const key = String(chatId);
  if (studyPollers.has(key)) return;
  studyPollers.set(key, true);
  try {
    let statusId = existingStatusId;
    if (statusId === null) statusId = await sendStatus(chatId, "📡 Изучаю ваши запросы…");
    for (;;) {
      await sleep(8000);
      const job = await fetchStudyJob(jobId, chatId);
      if (!job) {
        await sendHtml(chatId, "⚠️ Задание изучения не найдено.");
        return;
      }
      if (job.status === "queued" || job.status === "active") {
        await editStatus(chatId, statusId, `📡 Изучаю ваши запросы…\n✔ ${job.studied} изучено, ⏳ ${job.left} осталось`).catch(() => {});
        continue;
      }
      await finishStatus(chatId, statusId, buildStudyReport(job));
      if (job.status === "waiting") await sendStudyDecision(chatId, job);
      return;
    }
  } finally {
    studyPollers.delete(key);
  }
}

/** Honest final report: studied / already-known / failed-with-reasons / left. */
function buildStudyReport(job) {
  const t = esc(job.title || "");
  const lines = [];
  if (job.status === "done") {
    lines.push(`✅ <b>Изучение завершено.</b>\n📖 <b>${t}</b>`);
  } else if (job.status === "paused") {
    lines.push(`⏸ <b>Изучение приостановлено.</b>\n📖 <b>${t}</b>`);
  } else if (job.status === "waiting") {
    lines.push(`⏳ <b>Изучение на паузе.</b>\n📖 <b>${t}</b>`);
  } else if (job.status === "failed") {
    lines.push(`⚠️ <b>Не удалось изучить.</b>\n📖 <b>${t}</b>`);
  }
  lines.push(`✔ Изучено: <b>${job.studied}</b>`);
  if (job.skipped > 0) lines.push(`⏭ Уже знал: ${job.skipped}`);
  if (job.failed.length > 0) {
    const reasons = job.failed
      .slice(0, 5)
      .map((f) => `• ${f.url ? esc(f.url) : "—"}: ${esc(f.reason)}`)
      .join("\n");
    lines.push(`⚠️ Не удалось: <b>${job.failed.length}</b>\n${reasons}`);
    if (job.failed.length > 5) lines.push(`… и ещё ${job.failed.length - 5}`);
    lines.push("Отложено — можно повторить в «⏳ Незавершённое».");
  }
  if (job.left > 0) lines.push(`⏳ Осталось не изучено: <b>${job.left}</b>`);
  return lines.join("\n");
}

async function sendStudyDecision(chatId, job) {
  const kb = {
    inline_keyboard: [
      [
        { text: "▶ Продолжить", callback_data: `study:resume:${job.id}` },
        { text: "✅ Хватит", callback_data: `study:stop:${job.id}` },
      ],
    ],
  };
  await apiCall("sendMessage", {
    chat_id: chatId,
    text: `Лимит ${job.cap} страниц за запуск исчерпан: изучено <b>${job.studied}</b>, осталось <b>${job.left}</b>. Продолжить обход?`,
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

async function renderUnfinishedStudies(chatId) {
  const res = await fetch(`${SERVER}/api/study?chatId=${encodeURIComponent(String(chatId))}`, {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const data = res ? await res.json().catch(() => null) : null;
  const jobs = (data?.jobs ?? []).filter((j) => j.status === "paused" || j.status === "waiting");
  if (jobs.length === 0) {
    await sendHtml(chatId, "⏳ <b>Незавершённое изучение</b>\n\nПока ничего нет.");
    return;
  }
  const cards = jobs.map((j) => {
    const when = new Date(j.updatedAt).toLocaleString("ru-RU");
    const parts = [`<b>${esc(j.title)}</b>`];
    parts.push(`✔ ${j.studied} изучено${j.left ? ` · ⏳ ${j.left} осталось` : ""}${j.failed.length ? ` · ⚠️ ${j.failed.length} отложено` : ""}`);
    parts.push(`🕒 ${when}`);
    return parts.join("\n");
  });
  const kb = {
    inline_keyboard: jobs.map((j) => [
      { text: "▶ Продолжить", callback_data: `study:resume:${j.id}` },
      { text: "✖ Убрать", callback_data: `study:delete:${j.id}` },
    ]),
  };
  await apiCall("sendMessage", {
    chat_id: chatId,
    text: "⏳ <b>Незавершённое изучение</b>\n\n" + cards.join("\n\n"),
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

async function studyAction(chatId, jobId, action) {
  const res = await fetch(`${SERVER}/api/study`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, action, chatId: String(chatId) }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) return null;
  return data.job ?? null;
}

/** Consume an awaited study input (url/site/text/image). Returns true if handled. */
async function handleStudyAwaiting(chatId, msg, awaiting, text) {
  if (!isAllowed(msg?.from)) return false;
  const lower = text.toLowerCase();
  if (/^(отмена|отмен|стоп|cancel)([.!]|$)/.test(lower)) {
    studyAwait.delete(String(chatId));
    await sendHtml(chatId, "✖ Изучение отменено.");
    return true;
  }
  if (awaiting === "image") {
    const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : null;
    const docImg = msg.document?.mime_type?.startsWith("image/") ? msg.document : null;
    const file = photo ?? docImg;
    if (file) {
      try {
        const f = await apiCall("getFile", { file_id: file.file_id });
        const filePath = f?.result?.file_path;
        if (!filePath) throw new Error("no file_path");
        const fileRes = await fetch(`${API}/file/${filePath}`);
        const bytes = Buffer.from(await fileRes.arrayBuffer());
        await startStudyFromBot(chatId, msg, "image", "", {
          b64: bytes.toString("base64"),
          mime: docImg ? msg.document?.mime_type ?? "image/jpeg" : "image/jpeg",
        });
      } catch (e) {
        await sendHtml(chatId, `⚠️ Не удалось скачать фото: ${String(e?.message ?? e).slice(0, 200)}`);
      }
      return true;
    }
    if (/^https?:\/\/\S+$/i.test(text)) {
      await startStudyFromBot(chatId, msg, "image", text);
      return true;
    }
    await sendHtml(chatId, "🖼 Отправьте фото или ссылку на изображение. Отмена — «стоп».");
    return true;
  }
  if (awaiting === "text") {
    if (text) {
      await startStudyFromBot(chatId, msg, "text", text);
      return true;
    }
    await sendHtml(chatId, "📝 Отправьте текст для изучения. Отмена — «стоп».");
    return true;
  }
  if (/^https?:\/\/\S+$/i.test(text)) {
    await startStudyFromBot(chatId, msg, awaiting === "site" ? "site" : "url", text);
    return true;
  }
  await sendHtml(chatId, awaiting === "site" ? "🌐 Отправьте ссылку на сайт. Отмена — «стоп»." : "🔗 Отправьте ссылку на страницу. Отмена — «стоп».");
  return true;
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
  if (verb === "menu" && id === "main") {
    await removeButtons(chatId, query.message?.message_id);
    await sendMenu(chatId, isOwner(fakeFrom));
    return;
  }

  // Study flow buttons are open to anyone allowed to chat.
  if (verb === "study") {
    const [sub, ...rest] = data.split(":").slice(1);
    const arg = rest.join(":");
    if (!isAllowed(fakeFrom)) {
      await apiCall("answerCallbackQuery", { callback_query_id: query.id, text: "Только для допущенных." }).catch(() => {});
      return;
    }
    if (sub === "menu") {
      await sendStudyMenu(chatId);
      return;
    }
    if (sub === "type" && STUDY_TYPE_LABEL[arg]) {
      studyAwait.set(String(chatId), arg);
      const asks = {
        url: "🔗 Отправьте ссылку на страницу.",
        site: "🌐 Отправьте ссылку на сайт.",
        image: "🖼 Отправьте фото или ссылку на изображение.",
        text: "📝 Отправьте текст для изучения.",
      };
      await removeButtons(chatId, query.message?.message_id);
      await sendHtml(chatId, `${asks[arg]}\n<code>стоп</code> — отменить.`);
      return;
    }
    if (sub === "list") {
      await renderUnfinishedStudies(chatId);
      return;
    }
    if (sub === "resume" && arg) {
      const job = await studyAction(chatId, arg, "resume");
      await apiCall("answerCallbackQuery", { callback_query_id: query.id, text: "Продолжаю" }).catch(() => {});
      if (job) {
        await removeButtons(chatId, query.message?.message_id);
        await pollStudy(chatId, job.id);
      } else {
        await sendHtml(chatId, "⚠️ Задание не найдено.");
      }
      return;
    }
    if (sub === "stop" && arg) {
      const job = await studyAction(chatId, arg, "stop");
      await apiCall("answerCallbackQuery", { callback_query_id: query.id, text: "Приостановлено" }).catch(() => {});
      await removeButtons(chatId, query.message?.message_id);
      if (job) await sendHtml(chatId, `⏸ Изучение приостановлено (✔ ${job.studied} изучено). Продолжить можно в «⏳ Незавершённое».`);
      return;
    }
    if (sub === "delete" && arg) {
      const ok = await studyAction(chatId, arg, "delete");
      await apiCall("answerCallbackQuery", { callback_query_id: query.id, text: ok ? "Удалено" : "Ошибка" }).catch(() => {});
      await removeButtons(chatId, query.message?.message_id);
      await renderUnfinishedStudies(chatId);
      return;
    }
    return;
  }

  // Skill cards are open to anyone allowed to chat (run/info); delete is
  // owner-only. Format: skill:<run|info|del|page|none>:<arg>
  if (verb === "skill") {
    const [sub, ...rest] = data.split(":").slice(1);
    const arg = rest.join(":");
    const owner = isOwner(fakeFrom);
    if (sub === "none") {
      await apiCall("answerCallbackQuery", { callback_query_id: query.id, text: "" }).catch(() => {});
      return;
    }
    if (sub === "page") {
      await renderSkills(chatId, owner, parseInt(arg, 10) || 1);
      return;
    }
    if (sub === "run" && arg) {
      await runSkillFromTelegram(chatId, arg, owner);
      return;
    }
    if (sub === "info" && arg) {
      await skillInfo(chatId, arg);
      return;
    }
    if (sub === "del" && arg) {
      if (!owner) {
        await apiCall("answerCallbackQuery", { callback_query_id: query.id, text: "Только владелец." }).catch(() => {});
        return;
      }
      const res = await fetch(`${SERVER}/api/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "forget", id: arg }),
      }).catch(() => null);
      const resData = res ? await res.json().catch(() => null) : null;
      await apiCall("answerCallbackQuery", {
        callback_query_id: query.id,
        text: resData?.ok ? "Удалён" : "Ошибка удаления",
      }).catch(() => {});
      await removeButtons(chatId, query.message?.message_id);
      await renderSkills(chatId, owner);
      return;
    }
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

/** Download a Telegram voice/audio file and transcribe it via /api/transcribe. */
async function transcribeVoice(chatId, voice) {
  try {
    const f = await apiCall("getFile", { file_id: voice.file_id });
    const filePath = f?.result?.file_path;
    if (!filePath) throw new Error("no file_path from getFile");
    const fileRes = await fetch(`${API}/file/${filePath}`);
    if (!fileRes.ok) throw new Error(`telegram file ${fileRes.status}`);
    const bytes = Buffer.from(await fileRes.arrayBuffer());
    const post = await fetch(`${SERVER}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mime: voice.mime_type ?? "audio/ogg", data: bytes.toString("base64") }),
    });
    const res = await post.json().catch(() => ({}));
    if (!post.ok) throw new Error(res.error ?? `transcribe ${post.status}`);
    const text = String(res.text ?? "").trim();
    if (!text) throw new Error("empty transcript");
    console.log(`[bot] транскрипция ${chatId}: ${text.slice(0, 120)}`);
    return text;
  } catch (e) {
    console.warn("[bot] transcribe error:", e.message ?? e);
    await sendHtml(chatId, "⚠️ Не удалось распознать голосовое.");
    return null;
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;

  // Voice/audio message with no text → transcribe it via Gemini and feed the
  // result into the normal text pipeline below.
  const voice = msg.voice ?? msg.audio ?? (msg.document?.mime_type?.startsWith("audio/") ? msg.document : null);
  if (chatId !== undefined && !msg.text && voice?.file_id) {
    msg.text = (await transcribeVoice(chatId, voice)) ?? "";
    if (!msg.text) return;
  }

  const text = (msg.text ?? "").trim();

  // Menu-driven study flow: the chat is waiting for a URL / text / photo.
  if (chatId !== undefined && studyAwait.has(String(chatId))) {
    const awaiting = studyAwait.get(String(chatId));
    if (await handleStudyAwaiting(chatId, msg, awaiting, text)) return;
  }

  // Photo with a «запомни как <имя>» caption → register a manual character
  // reference so future generations can steer by this face (FaceID).
  if (chatId !== undefined && !text && (msg.photo?.length || msg.document?.mime_type?.startsWith("image/"))) {
    const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : msg.document;
    const caption = (msg.caption ?? "").trim();
    const m = caption.match(/запомни\s+(?:как\s+)?(.+)/i);
    const name = m?.[1]?.trim();
    if (name && photo?.file_id) {
      if (isAllowed(msg.from)) {
        try {
          const f = await apiCall("getFile", { file_id: photo.file_id });
          const filePath = f?.result?.file_path;
          if (filePath) {
            const fileRes = await fetch(`${API}/file/${filePath}`);
            const bytes = Buffer.from(await fileRes.arrayBuffer());
            const post = await fetch(`${SERVER}/api/characters`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name, b64: bytes.toString("base64"), mode: "face" }),
            });
            const res = await post.json().catch(() => ({}));
            if (post.ok && res.ok) {
              console.log(`[bot] референс «${name}» сохранён (${res.file})`);
              await sendHtml(chatId, `📎 Сохранил референс «${esc(name)}» (лицо).`);
            } else {
              await sendHtml(chatId, `⚠️ Не удалось сохранить референс: ${res.error ?? post.status}.`);
            }
          }
        } catch (e) {
          console.warn("[bot] photo ref error:", e);
          await sendHtml(chatId, "⚠️ Ошибка при сохранении референса.");
        }
      } else {
        console.log(`[bot] референс от неавторизованного id=${chatId}`);
      }
      return;
    }
  }

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
  try {
    await apiCall("setMyCommands", { commands: BOT_COMMANDS });
  } catch (e) {
    console.warn("[bot] setMyCommands:", e.message);
  }
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
        const isAudio = !!(msg && (msg.voice || msg.audio || msg.document?.mime_type?.startsWith("audio/")));
        const isPhoto = !!(msg && (msg.photo?.length || msg.document?.mime_type?.startsWith("image/")));
        if (!msg || (!msg.text && !isAudio && !isPhoto)) continue;
        try {
          await handleMessage(msg);
        } catch (e) {
          console.error("[bot] handleMessage error:", e?.stack ?? e?.message ?? e);
          audit({ action: "handleMessage-error", chatId: msg.chat?.id, error: String(e?.message ?? e).slice(0, 300) });
        }
      }
    } catch (err) {
      console.error("[bot] polling error:", err.message ?? err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main();
