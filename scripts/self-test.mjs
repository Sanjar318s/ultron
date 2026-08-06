import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
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
import { bestMatch, execute as executeSkill, workDirFor } from "../lib/skillCatalog.ts";
import {
  lessonsForPrompt,
  recordLesson,
  storedLessons,
  clearLessons,
  flushSkillLessons,
} from "../lib/skillLessons.ts";
import { N8N_ACTIONS } from "../lib/n8n/config.ts";
import {
  isExplicitTask,
  matchFactQuery,
  matchDateIntent,
  matchTimeIntent,
  composeFinalReply,
} from "../lib/intentGuards.ts";
import { PRESET_CHAIN, PRESET_GEMINI_MODEL, MODEL_PRESETS, DEFAULT_PRESET } from "../lib/userSettings.ts";
import {
  parseRetrySeconds,
  isTransientRateLimit,
  isHardExhaustion,
} from "../lib/geminiKeys.ts";
import { classifyComplexity } from "../lib/complexity.ts";

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
    ["n8n actions non-empty", N8N_ACTIONS.length > 0],
    ["n8n ids unique", new Set(N8N_ACTIONS.map((a) => a.id)).size === N8N_ACTIONS.length],
    ["n8n ids prefixed", N8N_ACTIONS.every((a) => a.id.startsWith("n8n-"))],
    ["n8n schema object", N8N_ACTIONS.every((a) => a.payloadSchema && typeof a.payloadSchema === "object" && Object.keys(a.payloadSchema).length > 0)],
    ["n8n names non-empty", N8N_ACTIONS.every((a) => typeof a.name === "string" && a.name.trim().length > 0)],
    // P1: date/time answer ONLY on explicit phrasing (never on «датасет»).
    ["intent date explicit", typeof matchDateIntent("какое сегодня число") === "string"],
    ["intent date weekday", typeof matchDateIntent("какой сегодня день недели") === "string"],
    ["intent date ignores датасет", matchDateIntent("дай мне пример датасета в виде pdf") === null],
    ["intent date ignores bare дата", matchDateIntent("что такое дата") === null],
    ["intent time explicit", typeof matchTimeIntent("который час") === "string"],
    ["intent time ignores phrase", matchTimeIntent("проведу время в интернете") === null],
    // P2: run-skill gate — imperative task yes, vague follow-up no.
    ["task explicit создай файл", isExplicitTask("создай файл") === true],
    ["task explicit напиши скрипт", isExplicitTask("напиши python скрипт который вычислит 2**100") === true],
    ["task explicit сохрани график", isExplicitTask("сохрани график в png") === true],
    ["task vague что это значит", isExplicitTask("что это значит") === false],
    ["task vague это задача", isExplicitTask("это задача") === false],
    ["task vague объясни код", isExplicitTask("объясни код") === false],
    // P4: factual questions search, arithmetic does not.
    ["fact сколько людей на земле", matchFactQuery("сколько людей на земле") !== null],
    ["fact статистика населения", matchFactQuery("какая статистика населения сейчас") !== null],
    ["fact курс доллара", matchFactQuery("какой курс доллара сегодня") !== null],
    ["fact arithmetic 2+2 no search", matchFactQuery("сколько будет 2+2") === null],
    ["fact greeting no search", matchFactQuery("привет") === null],
    // P5: final reply carries NO «Запомнил.» noise, artifact tail is separate.
    ["final reply clean", composeFinalReply("Вот ответ", 3) === "Вот ответ"],
    ["final reply no suffix", !composeFinalReply("Ответ", 1).includes("Запомнил")],
    // Router presets: preferred chain + model mapping (⚡/🧠/🏠). No Groq.
    ["preset local first ollama", PRESET_CHAIN.local[0] === "ollama"],
    ["preset local second gemini", PRESET_CHAIN.local[1] === "gemini"],
    ["preset flash first gemini", PRESET_CHAIN.flash[0] === "gemini"],
    ["preset flash second ollama", PRESET_CHAIN.flash[1] === "ollama"],
    ["preset pro first gemini", PRESET_CHAIN.pro[0] === "gemini"],
    ["preset pro second ollama", PRESET_CHAIN.pro[1] === "ollama"],
    ["preset no groq anywhere", !Object.values(PRESET_CHAIN).flat().includes("groq")],
    ["preset pro model is deep", PRESET_GEMINI_MODEL.pro !== PRESET_GEMINI_MODEL.flash],
    ["preset default local", DEFAULT_PRESET === "local"],
    ["preset 3 options", Object.keys(MODEL_PRESETS).length === 3],
    // Gemini error classification: transient RPM must NOT kill the key; a
    // hard daily/token quota or an absurdly long retry window must.
    ["rate parse 30s", parseRetrySeconds("Please retry in 30.325598225s") === 30.325598225],
    ["rate parse compact m+s", parseRetrySeconds("Please try again in 28m6.528s") === 28 * 60 + 6.528],
    ["rate parse hours+min", parseRetrySeconds("try again in 1h30m") === 5400],
    ["rate parse unparseable", parseRetrySeconds("Internal server error") === null],
    ["rate parse missing unit", parseRetrySeconds("retry in 45") === 45],
    ["429 short wait is transient", isTransientRateLimit("Quota exceeded for metric: generate_content_free_tier_requests, limit: 20. Please retry in 30s") === true],
    ["429 short wait NOT hard", isHardExhaustion("Quota exceeded for metric: generate_content_free_tier_requests, limit: 20. Please retry in 30s") === false],
    ["long wait is hard", isHardExhaustion("Quota exceeded. Please retry in 28m6.528s") === true],
    ["daily keyword is hard", isHardExhaustion("429 RESOURCE_EXHAUSTED: daily tokens per day exhausted") === true],
    ["client-side limit is transient", isTransientRateLimit("gemini rate-limited (client-side 16/min)") === true],
    ["client-side limit not hard", isHardExhaustion("gemini rate-limited (client-side 16/min)") === false],
    ["503 high demand is transient", isTransientRateLimit("gemini 503: This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.") === true],
    ["503 high demand NOT hard", isHardExhaustion("gemini 503: This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.") === false],
    // Complexity tiers: heavy file tasks use the full system pool, greetings stay light.
    ["complexity pdf is tier 2", classifyComplexity("создай pdf отчёт с таблицей и графиком").tier === 2],
    ["complexity pdf isFileTask", classifyComplexity("создай pdf отчёт").isFileTask === true],
    ["complexity docx is tier 2", classifyComplexity("создай резюме в docx").tier === 2],
    ["complexity xlsx is tier 2", classifyComplexity("сделай таблицу xlsx с формулами").tier === 2],
    ["complexity script pdf is tier 2", classifyComplexity("напиши скрипт который построит график и сохранит в pdf").tier === 2],
    ["complexity plain script is tier 1", classifyComplexity("напиши скрипт который вычислит 2**100 и сохрани в файл").tier === 1],
    ["complexity chart is tier 1", classifyComplexity("нарисуй график y=x^2").tier === 1],
    ["complexity create file is tier 1", classifyComplexity("создай файл с заметками").tier === 1],
    ["complexity site is tier 1", classifyComplexity("сделай полноценный сайт с тремя страницами").tier === 1],
    ["complexity greeting is tier 0", classifyComplexity("привет").tier === 0],
    ["complexity greeting not heavy", classifyComplexity("привет")?.tooHeavy === false],
    ["complexity question is tier 0", classifyComplexity("как дела").tier === 0],
    ["complexity pdf not tooHeavy", classifyComplexity("создай pdf отчёт с таблицей").tooHeavy === false],
    ["complexity tooHeavy only absurd", classifyComplexity(`создай ${"pdf ".repeat(500)}отчёт с графиком, шаблоном и скриптом для сайта`).tooHeavy === true],
  ];
  for (const [name, ok] of pureChecks) check(`pure ${name}`, ok);

  // Skill routing: semantic match on the user's text must pick the right SKILL.md
  // even when a weak LLM names the wrong skill. Deterministic, no LLM involved.
  const matchData = await bestMatch("построй график y=x^2 для x от -5 до 5 и сохрани в png");
  check(
    "skill-match plot→data",
    matchData.skill?.slug === "data",
    `got ${matchData.skill?.slug ?? "none"} score=${matchData.score.toFixed(2)}`,
  );
  const matchPy = await bestMatch("напиши python скрипт который вычислит 2**100 и выведи результат");
  check(
    "skill-match python→python",
    matchPy.skill?.slug === "python",
    `got ${matchPy.skill?.slug ?? "none"} score=${matchPy.score.toFixed(2)}`,
  );

  // 1d. Skill executor round-trip with a SCRIPTED mock LLM (no network). Proves:
  //     - the honest planner: a done claiming a missing file triggers a
  //       corrective round instead of lying (reply names the real file);
  //     - `>` inside quoted --raw content is data, not a blocked redirect;
  //     - a python run's output file lands in artifacts; .run.log never does.
  const WRITE_HELPER = path.join(process.cwd(), "scripts", "sandbox-write.mjs").replace(/\\/g, "/");
  const fakeSkill = {
    slug: "selftest",
    name: "Самотест",
    description: "self-test",
    safe: true,
    body: "Выполни задачу в рабочей папке.",
    dir: path.join(process.cwd(), "skills", "python"),
  };
  const skillDirs = [];

  const skillChat = (tag) => {
    const id = `selftest-${tag}-${Date.now()}`;
    skillDirs.push(workDirFor(id));
    return id;
  };
  try {
    const stepsHonest = [
      JSON.stringify({ done: true, result: "создал ghost.txt" }),
      JSON.stringify({ cmd: `node "${WRITE_HELPER}" "real.txt" --raw "ok"` }),
      JSON.stringify({ done: true, result: "создал real.txt" }),
    ];
    let iHonest = 0;
    const resHonest = await executeSkill(fakeSkill, "создай real.txt", {
      chatId: skillChat("honest"),
      complete: async () => stepsHonest[Math.min(iHonest++, stepsHonest.length - 1)] ?? "{}",
    });
    check(
      "skill honest-planner correction",
      resHonest.ok &&
        resHonest.verified === true &&
        resHonest.artifacts?.some((a) => a.name === "real.txt") &&
        (resHonest.reply ?? "").includes("real.txt") &&
        !(resHonest.reply ?? "").includes("ghost.txt"),
      `ok=${resHonest.ok} verified=${resHonest.verified} rounds=${resHonest.rounds} artifacts=${JSON.stringify(resHonest.artifacts?.map((a) => a.name))} reply=${JSON.stringify((resHonest.reply ?? "").slice(0, 80))}`,
    );

    const stepsQuote = [
      JSON.stringify({ cmd: `node "${WRITE_HELPER}" "data.txt" --raw "привет>5"` }),
      JSON.stringify({ done: true, result: "записал привет>5 в data.txt" }),
    ];
    let iQuote = 0;
    const qChat = skillChat("quote");
    const resQuote = await executeSkill(fakeSkill, "запиши в data.txt фразу привет>5", {
      chatId: qChat,
      complete: async () => stepsQuote[Math.min(iQuote++, stepsQuote.length - 1)] ?? "{}",
    });
    const quoteContent = readFileSync(path.join(workDirFor(qChat), "data.txt"), "utf8");
    check(
      "skill quote-safe > data",
      resQuote.ok && quoteContent === "привет>5" && resQuote.artifacts?.some((a) => a.name === "data.txt"),
      `content=${JSON.stringify(quoteContent)} artifacts=${JSON.stringify(resQuote.artifacts?.map((a) => a.name))}`,
    );

    const stepsPy = [
      JSON.stringify({ cmd: `node "${WRITE_HELPER}" "work.py" --raw "open('out.txt','w',encoding='utf-8').write('py-ok')"` }),
      JSON.stringify({ cmd: `python "work.py"` }),
      JSON.stringify({ done: true, result: "скрипт выполнен, результат в out.txt" }),
    ];
    let iPy = 0;
    const pyChat = skillChat("py");
    const resPy = await executeSkill(fakeSkill, "запусти python скрипт который создаст out.txt", {
      chatId: pyChat,
      complete: async () => stepsPy[Math.min(iPy++, stepsPy.length - 1)] ?? "{}",
    });
    const outArt = resPy.artifacts?.find((a) => a.name === "out.txt");
    check(
      "skill python artifact collected",
      resPy.ok &&
        Boolean(outArt) &&
        outArt.rel.startsWith("data/skill-work/") &&
        !resPy.artifacts?.some((a) => a.name === ".run.log"),
      `artifacts=${JSON.stringify(resPy.artifacts?.map((a) => a.name))}`,
    );

    // Stuck-loop guard (P2): a mock model that repeats the same command three
    // times must be aborted with ok:false instead of burning all 8 rounds.
    const sameCmd = `node "${WRITE_HELPER}" "spin.txt" --raw "x"`;
    const stepsStuck = [
      JSON.stringify({ cmd: sameCmd }),
      JSON.stringify({ cmd: sameCmd }),
      JSON.stringify({ cmd: sameCmd }),
      JSON.stringify({ done: true, result: "готово" }),
    ];
    let iStuck = 0;
    const resStuck = await executeSkill(fakeSkill, "задание с зацикливанием", {
      chatId: skillChat("stuck"),
      complete: async () => stepsStuck[Math.min(iStuck++, stepsStuck.length - 1)] ?? "{}",
    });
    check(
      "skill stuck-loop abort",
      resStuck.ok === false && resStuck.rounds === 3 && (resStuck.reply ?? "").includes("зациклился"),
      `ok=${resStuck.ok} rounds=${resStuck.rounds} reply=${JSON.stringify((resStuck.reply ?? "").slice(0, 80))}`,
    );

    // 1e. Skill lessons: cross-run memory for the executor. Failure modes
    // (blocked command, unverified claim, stuck loop) are recorded and injected
    // into the next run's system prompt — deduplicated and capped.
    await clearLessons("selftest");
    await flushSkillLessons();

    const stepsBlocked = [JSON.stringify({ cmd: `curl http://x` })];
    let iBlocked = 0;
    const resBlocked = await executeSkill(fakeSkill, "сделай что-нибудь", {
      chatId: skillChat("blocked"),
      complete: async () => stepsBlocked[Math.min(iBlocked++, stepsBlocked.length - 1)] ?? "{}",
    });
    await flushSkillLessons();
    const lessonsAfter = await storedLessons("selftest");
    check(
      "skill lessons recorded (rejected)",
      resBlocked.ok === false && lessonsAfter.some((l) => /команда отклонена/.test(l)),
      `lessons=${JSON.stringify(lessonsAfter)}`,
    );

    let iBlocked2 = 0;
    await executeSkill(fakeSkill, "сделай что-нибудь ещё", {
      chatId: skillChat("blocked2"),
      complete: async () => stepsBlocked[Math.min(iBlocked2++, stepsBlocked.length - 1)] ?? "{}",
    });
    await flushSkillLessons();
    const lessonsDeduped = await storedLessons("selftest");
    const rejectedCount = lessonsDeduped.filter((l) => /команда отклонена.*curl/.test(l)).length;
    check("skill lessons dedupe", rejectedCount === 1, `count=${rejectedCount}`);

    for (let i = 0; i < 15; i++) recordLesson("selftest", `синтетический урок номер ${i}`);
    await flushSkillLessons();
    const lessonsCapped = await storedLessons("selftest");
    check("skill lessons cap", lessonsCapped.length === 12, `count=${lessonsCapped.length}`);

    const prompt = await lessonsForPrompt("selftest");
    check(
      "skill lessons injected",
      prompt.startsWith("\n\n## Грабли из прошлых запусков") && prompt.includes("синтетический урок"),
      prompt ? JSON.stringify(prompt.slice(0, 60)) : "empty",
    );
  } finally {
    for (const dir of skillDirs) rmSync(dir, { recursive: true, force: true });
    await clearLessons("selftest").catch(() => {});
    await flushSkillLessons().catch(() => {});
  }

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
