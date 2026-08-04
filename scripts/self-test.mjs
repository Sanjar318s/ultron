import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  musicSearchQuery,
  splitLaunchChain,
  steamAliasName,
  stripLaunchQualifiers,
} from "../lib/commandSplit.ts";
import { findSiteInPhrase, resolveSite } from "../lib/sites.ts";

/**
 * Self-test suite for the ULTRON PC-control surface.
 *
 * Non-destructive by default: checks script syntax, route schema (invalid
 * payloads must yield clean 4xx, never 500), the PowerShell bridge, and the
 * temp-cleanup logic against a throwaway sandbox dir. `--live` additionally
 * does an Edge-TTS → Gemini-transcribe roundtrip (proves /api/tts and
 * /api/transcribe end-to-end). Run before every commit:
 *
 *   npm run self-test
 *
 * Imported by the Telegram bot for the owner-only /self-test command.
 */

const SERVER = process.env.ULTRON_SERVER ?? "http://localhost:3000";
const timeoutMs = (ms) => AbortSignal.timeout(ms);

async function http(method, url, body, headers = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutMs(20_000),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body is fine */
    }
    return { status: res.status, json };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

function execFileP(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 30_000 }, (err) => resolve(err ? false : true));
  });
}

function powershellOk(script) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0 && out.includes("OK")));
  });
}

async function cleanupSandbox() {
  const sandbox = mkdtempSync(path.join(tmpdir(), "ultron-self-test-"));
  mkdirSync(path.join(sandbox, "sub"));
  writeFileSync(path.join(sandbox, "a.txt"), "hello");
  writeFileSync(path.join(sandbox, "sub", "b.txt"), "world");
  const { status, json } = await http("POST", `${SERVER}/api/clean-temp`, { sandbox });
  if (status !== 200) return { ok: false, detail: `clean-temp sandbox → HTTP ${status}` };
  if (json?.ok !== true) return { ok: false, detail: `clean-temp returned ok=${json?.ok}` };
  if ((json.removedCount ?? 0) < 1) return { ok: false, detail: `expected ≥1 removed, got ${json.removedCount}` };
  return { ok: true, detail: `removed ${json.removedCount}, freed ${json.freedMB} MB` };
}

export async function runSelfTests({ live = false } = {}) {
  const results = [];

  const check = (name, ok, detail = "") => results.push({ name, ok, detail: detail || (ok ? "ok" : "FAIL") });

  // 1. Syntax of all scripts.
  const scripts = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".mjs"));
  for (const f of scripts) {
    check(`syntax ${f}`, await execFileP("node", ["--check", fileURLToPath(new URL(f, import.meta.url))]));
  }

  // 1b. Pure command/site resolution checks (no side effects, no server needed).
  const pureChecks = [
    ["site yandex-music", resolveSite("яндекс музыка") === "https://music.yandex.ru"],
    ["site yandex-music phrase", findSiteInPhrase("яндекс музыку") === "https://music.yandex.ru"],
    ["site plain yandex stays ya.ru", findSiteInPhrase("яндекс") === "https://ya.ru"],
    [
      "split compound command",
      JSON.stringify(splitLaunchChain("открой стим и запусти кс 2")) === JSON.stringify(["стим", "кс 2"]),
    ],
    ["split single command", splitLaunchChain("блокнот").length === 1],
    ["steam alias cs2", steamAliasName("кс 2") === "Counter-Strike 2"],
    ["steam alias kontra in phrase", steamAliasName("запусти контра") === "Counter-Strike 2"],
    ["strip tail 'стим открыт'", stripLaunchQualifiers("кс 2 стим открыт") === "кс 2"],
    ["strip tail 'уже открыт'", stripLaunchQualifiers("кс 2 уже открыт") === "кс 2"],
    ["strip tail 'в яндекс музыке'", stripLaunchQualifiers("кс 2 в яндекс музыке") === "кс 2"],
    ["strip tail 'через браузер'", stripLaunchQualifiers("яндекс музыка через браузер") === "яндекс музыка"],
    ["strip idempotent chain", stripLaunchQualifiers("кс 2 стим открыт уже запущен") === "кс 2"],
    [
      "music full command",
      musicSearchQuery("поставь песню салам в яндекс музыке") === "салам",
    ],
    ["music bare noun", musicSearchQuery("песню салам") === "салам"],
    ["music 'найди трек'", musicSearchQuery("найди трек imagination") === "imagination"],
    ["music non-music null", musicSearchQuery("открой стим") === null],
    ["music track quote keeps words", musicSearchQuery("включи музыку стану джазом") === "стану джазом"],
  ];
  for (const [name, ok] of pureChecks) check(`pure ${name}`, ok);

  // 2. Server reachability.
  const probe = await http("GET", `${SERVER}/api/tts`);
  check("server reachable", probe.status > 0 && probe.status < 500, `GET /api/tts → ${probe.status || probe.error}`);

  // 3. Route schema guards: invalid payloads must give clean 4xx, never 500.
  const schema = [
    ["launch-app", "POST", `${SERVER}/api/launch-app`, { url: "not a url" }],
    ["do-step", "POST", `${SERVER}/api/do-step`, { action: "bogus-action", params: {} }],
    ["tts", "POST", `${SERVER}/api/tts`, { text: "" }],
    ["transcribe", "POST", `${SERVER}/api/transcribe`, { mime: "audio/ogg", data: "" }],
    ["clean-temp", "POST", `${SERVER}/api/clean-temp`, { sandbox: "relative/path" }],
    ["clean-temp non-json", "POST", `${SERVER}/api/clean-temp`, undefined],
  ];
  for (const [name, method, url, body] of schema) {
    const r = await http(method, url, body);
    const ok = r.status >= 400 && r.status < 500;
    check(`schema ${name}`, ok, r.status === 0 ? r.error : `expected 4xx, got ${r.status}`);
  }

  // 4. PowerShell bridge smoke.
  check("powershell smoke", await powershellOk("Write-Output 'OK'"));

  // 5. Temp-cleanup logic against a sandbox dir (never touches real TEMP).
  const cs = await cleanupSandbox();
  check("cleanup sandbox", cs.ok, cs.detail);

  // 6. Live roundtrip: Edge TTS → Gemini transcription.
  if (live) {
    try {
      const ttsRes = await fetch(`${SERVER}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Привет, это тестовая голосовая проверка.", voice: "ru-RU-DmitryNeural" }),
        signal: timeoutMs(30_000),
      });
      const b64 = Buffer.from(await ttsRes.arrayBuffer()).toString("base64");
      if (ttsRes.status !== 200 || b64.length < 100) {
        check("live tts→transcribe", false, `tts → ${ttsRes.status}, ${b64.length} b64`);
      } else {
        const tr = await http("POST", `${SERVER}/api/transcribe`, { mime: "audio/mpeg", data: b64 });
        const text = tr.json?.text ?? "";
        check(
          "live tts→transcribe",
          tr.status === 200 && text.length > 0,
          `transcribe → ${tr.status}: «${text.slice(0, 60)}»`,
        );
      }
    } catch (e) {
      check("live tts→transcribe", false, e.message);
    }
  }

  return results;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  const live = process.argv.includes("--live");
  const results = await runSelfTests({ live });
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "✓" : "✗"} ${r.name} — ${r.detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed${live ? " (live)" : ""}`);
  process.exit(failed > 0 ? 1 : 0);
}
