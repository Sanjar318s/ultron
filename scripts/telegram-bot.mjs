/**
 * ULTRON Telegram bot — long-polling bridge between Telegram and the local
 * assistant core (/api/assistant). Run alongside the web server:
 *
 *   npm run bot
 *
 * Config (env):
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   TELEGRAM_ALLOWED_IDS — comma-separated Telegram user IDs allowed to talk
 *                          to the bot (empty = anyone with the token).
 *   ULTRON_SERVER        — base URL of the web app (default http://localhost:3000)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
const ALLOWED_IDS = (process.env.TELEGRAM_ALLOWED_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SERVER = process.env.ULTRON_SERVER ?? "http://localhost:3000";

if (!TOKEN) {
  console.error("[bot] TELEGRAM_BOT_TOKEN не задан. Добавьте его в .env");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const POLL_TIMEOUT = 25; // seconds

// Per-chat conversation memory (in-process). The server /api/assistant core
// is stateless, so the bot owns the dialog history and forwards it as context
// on every message. Capped to the last 16 turns.
const histories = new Map();

async function apiCall(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(POLL_TIMEOUT * 1000 + 10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} → HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function sendText(chatId, text) {
  const chunks = splitText(text, 4096);
  for (const chunk of chunks) {
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

/** Telegram caps messages at 4096 chars — split on line boundaries. */
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

function allowed(chatId) {
  return ALLOWED_IDS.length === 0 || ALLOWED_IDS.includes(String(chatId));
}

const HELP_TEXT = [
  "Команды бота:",
  "• /start — приветствие",
  "• /help — эта справка",
  "• /id — ваш числовой id",
  "",
  "А ещё вы можете просто общаться:",
  "• «найди <запрос>» — поищу в интернете и отвечу со ссылками",
  "• «изучи <тема>» — найду информацию и запомню",
  "• «навыки» — мои способности и проценты",
  "• «навык <имя>» — что умею и чего не хватает",
  "• «чего тебе не хватает» — какие знания дать",
  "• «изучи <ссылка>» — прочитаю и запомню",
  "• «чему ты научился» — что я знаю",
  "• «напиши статью про …» — сгенерирую текст",
  "• «нарисуй …» — сгенерирую изображение",
].join("\n");

async function handleMessage(chatId, text, firstName) {
  console.log(`[bot] ← ${chatId}: ${text.slice(0, 120)}`);
  const cmd = text.trim().toLowerCase();
  const name = firstName || "Арыч";

  if (cmd === "/start") {
    await sendText(
      chatId,
      `Привет, ${name}! Я УЛЬТРОН — твой голосовой помощник. Я помню, что меня учили, и могу генерировать тексты и картинки.\n\n${HELP_TEXT}`,
    );
    return;
  }
  if (cmd === "/help") {
    await sendText(chatId, HELP_TEXT);
    return;
  }
  if (cmd === "/id") {
    await sendText(chatId, `Ваш id: ${chatId}`);
    return;
  }

  try {
    const hist = histories.get(chatId) ?? [];
    hist.push({ role: "user", content: text });
    const res = await fetch(`${SERVER}/api/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, history: hist.slice(0, -1).slice(-12) }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      await sendText(chatId, `Ошибка сервера: ${data?.error ?? res.status}.`);
      return;
    }

    const parts = [];
    if (data.reply) parts.push(data.reply);
    if (data.generate) parts.push(data.generate);
    if (data.image) {
      await sendPhoto(chatId, data.image.b64, data.image.mime);
    }
    if (parts.length === 0) parts.push("Выполнено.");
    await sendText(chatId, parts.join("\n\n"));

    hist.push({ role: "assistant", content: parts.join("\n\n") });
    if (hist.length > 16) hist.splice(0, hist.length - 16);
    histories.set(chatId, hist);
  } catch (err) {
    console.error("[bot] обработка сообщения не удалась:", err);
    await sendText(chatId, `Сбой обработки: ${err.message}. Сервер запущен?`).catch(() => {});
  }
}

async function main() {
  let offset = 0;
  console.log(`[bot] запущен. Сервер: ${SERVER}. Разрешённые id: ${ALLOWED_IDS.join(", ") || "все"}`);
  while (true) {
    try {
      const data = await apiCall("getUpdates", {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ["message"],
      });
      for (const update of data.result ?? []) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text) continue;
        const chatId = msg.chat?.id;
        if (chatId === undefined) continue;
        if (!allowed(chatId)) {
          console.log(`[bot] заблокирован id=${chatId}`);
          continue;
        }
        await handleMessage(chatId, msg.text, msg.from?.first_name);
      }
    } catch (err) {
      console.error("[bot] polling error:", err.message ?? err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main();
