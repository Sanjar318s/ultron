# AGENTS.md

## Commands

| What | Command | Notes |
|------|---------|-------|
| Typecheck + build | `npm run build` | No standalone `tsc` or lint script — `next build` runs tsc implicitly |
| Full PC-control validation | `npm run self-test` | Syntax, route schema (4xx not 500), PowerShell bridge, cleanup sandbox, skill-executor round-trip (scripted mock LLM: honest-planner correction, quote-safe `>` data, python artifact collection) |
| Live roundtrip | `npm run self-test -- --live` | Adds Edge TTS → Gemini transcription end-to-end |
| Dev server | `npm run dev` | http://localhost:3000 |
| Telegram bot | `npm run bot` | Long-polling bridge to the local server |
| Local infra setup | `node scripts/setup-local.mjs` | Installs Ollama + qwen3 models, ComfyUI + RealVisXL + 4x-UltraSharp; executor uses `qwen3:14b` |

**Run `npm run build` before every commit.** There is no lint script; tsc catches all type errors.

## Architecture

### Three source files (the orb)

- **`lib/orbScene.ts`** — pure Three.js, framework-agnostic. `createOrbScene(container)` builds the entire scene graph and returns `OrbSceneApi` (`rotateBy`, `zoomBy`, `setSpeaking`, `dispose`). The animation loop runs inside `animate()` — don't touch it from React. All state lives in closures, not React state.
- **`lib/handTracker.ts`** — pure MediaPipe/webcam logic. `HandTracker` owns the camera and `HandLandmarker`, runs its own RAF loop, and reports via three callbacks (`onRotate`, `onZoom`, `onStatus`) — never calls into orbScene directly. Pinch detection uses hysteresis (`PINCH_ON`/`PINCH_OFF` thresholds) — don't collapse to a single threshold.
- **`components/JarvisOrb.tsx`** — the only React component. Owns DOM refs, wires HandTracker callbacks into OrbSceneApi, renders the HUD overlay. Keyboard shortcuts (`G`/`R`/`+`/`-`) via window keydown listener. Client-only (`"use client"`).

Data flow is one-directional: HandTracker → callbacks → JarvisOrb → OrbSceneApi → orbScene closures. No global state, no context, no event bus.

### Assistant layer

- **`lib/assistantBrain.ts`** — pure client-side brain: rules, facts, skills, notes. Intent parsing, image prompt extraction. Persists to localStorage. Works in both browser and Node.
- **`lib/serverLLM.ts`** — server-side LLM calls. Chain: `[gemini, ollama]`. Direct provider calls with server-side keys.
- **`lib/llm/`** — client-side LLM chain. Router: `["ollama", "gemini", "webllm"]`. Browser never sees API keys — it proxies through `/api/llm`.
- **`app/api/assistant/route.ts`** — server core for the Telegram bot. Same brain + LLM pipeline as the browser. Deterministic skill gate BEFORE the LLM escalate: `bestMatch(visibleText)` score ≥0.3 + script skill (python/data) + leading task verb → dispatch straight into the sandbox executor (the escalate LLM is too weak at choosing — it parrots capabilities instead of returning `run-skill`). Successful runs return `files: [{rel,name,size,mime}]` (workdir diff minus `.run.log`, newest first, cap 5 × ≤40MB); the bot uploads images via `sendPhoto`, everything else via `sendDocument` (`path.join(ROOT, rel)`).
- **`lib/brainStore.ts`** — durable `data/brain.json` (single source of truth). Lossless merge protocol with per-process mutex and short-TTL tombstones for deleted ids.
- **`lib/promptSanitizer.ts`** — RU→EN sanitizer for image prompts. Tags re-injected ONLY at the local ComfyUI tier; Gemini/Pollinations never see them.
- **`lib/skillCatalog.ts`** — SKILL.md-based skills in `skills/<slug>/`. Sandbox executor runs only python/node, caps at 8 LLM rounds, per-chat workdir. Files are written via `node scripts/sandbox-write.mjs "<relPath>" --raw "<jsonEscaped>"` (models mangle base64 — never instruct base64). `parseExecReply` = JSON-first + quote-aware regex fallback; `REFUSAL_RE` rejects `done` that didn't actually solve the task; `.run.log` per run in the workdir. `execute()` snapshots the workdir before the loop and returns new files (minus `.run.log`, ≤5, ≤40MB each) as `artifacts` on success. Honest planner: a `done` whose result names files that DON'T exist in the workdir triggers a corrective round (never a silent lie); the final reply appends the real `📎 Созданные файлы: …` and `verified: true` is set only when every claimed file exists. Commands run via `spawn` WITHOUT a shell: `splitArgs` resolves backslash-escapes INSIDE quotes (`\"` → literal quote, `\n`/`\\`/`\u…` pass through for `--raw`), and `BLOCKED_FRAGMENTS` (`..`/`;`/`&&`/`|`/`$(`/`>`/`<`/…) are checked on the UNQUOTED view only — so `>` in file content is data, not a redirect; unquoted `*` (in `x**2`) stays allowed.
- **`lib/studyJobs.ts`** — background "study" engine: site crawl (≤100 pages/run), single URL, plain text, image/PDF vision. Job state in `data/study-jobs.json` (statuses queued/active/waiting/paused/done/failed; studied/skipped/failed[]/left counters). Notes committed via brainStore. One active job per chat; the bot polls `/api/study` every 8s and reports honestly (studied/skipped/failed+reasons/left). "Продолжить" resumes; "Хватит" pauses.
- **`lib/pageVision.ts`** — downloads pages/PDFs, strips HTML, renders scanned PDF pages to images, collects up to 8 images (≤1.5MB), OCRs them via Gemini (`resolveKey`) → local Ollama `qwen2.5vl:7b` fallback. `extractSiteLinks` keeps only same-domain links.
- **`app/api/study/route.ts`** — POST `/api/study` {type: site|url|text|image}, GET `?jobId|chatId`, PUT `/api/study` {resume|stop|delete}. `isLocalRequest` guard. The assistant route starts site/image jobs from the brain's `learn-site`/`learn-image` intents and returns `studyJobId` for the bot to poll.
- **`lib/n8n/`** — n8n webhook-actions (cloud automation: Google Sheets, email, Notion…). `config.ts` = scenario registry + LLM prompt block; `client.ts` = POST with `X-Ultron-Secret`, 10s timeout. LLM returns `{"type":"n8n_trigger","actionId":"<id>","payload":{...}}`; body adds `scenario` so the n8n Switch node routes. Local PC control (launcher.ts) NEVER goes through n8n.

### Key gotchas

- **Ollama**: Must use native `/api/chat` with `think: false` and `format: "json"`. The OpenAI-compat endpoint + qwen3 thinking mode burns the whole token budget and returns empty content. Forced-JSON needs `format: "json"` — a plain prompt drifts off-schema at long contexts.
- **Ollama vision**: study OCR falls back to `qwen2.5vl:7b` (pulled by `setup-local.mjs`). Override via `VISION_LOCAL_MODEL` in `.env.local`.
- **Telegram command names**: only lowercase a-z, 0-9 and `_` — `self-test` (with hyphen) is rejected with `400 BOT_COMMAND_INVALID`; use `/selftest`.
- **LLM chain order**: Browser: `["ollama", "gemini", "webllm"]`. Server: `[gemini, ollama]`. OpenAI/DeepSeek are unfunded and excluded.
- **Localhost guard**: Every API route checks `isLocalRequest(req)` — returns 403 for non-localhost. Don't remove this.
- **`/data/` directory**: Gitignored runtime state (brain.json, settings.json, pending.json, learned-facts.json, gemini-lessons.json, character-refs.json, admin-log.jsonl, autonomy-state.json, telegram-users.json). Never commit files here.
- **`data/stop-ai`**: Kill switch that halts LLM autonomy. Don't create or delete without reason.
- **Protected files**: Admin autonomy blocks edits to: `scripts/telegram-bot.mjs`, `app/api/assistant/route.ts`, `lib/adminOps.ts`, `lib/promptSanitizer.ts`, `data/*`.
- **ComfyUI**: Local image gen at 127.0.0.1:8188. Probe TTL 15s. Workflow templates in `comfy/`. Anime prompts auto-switch checkpoint.
- **Image cascade**: Gemini (quota-limited) → ComfyUI (free, unlimited) → Pollinations (keyless fallback).
- **YouTube transcripts**: yt-dlp only works on this machine (datacenter IP blocks native flow). Binary at `C:\Tools\yt-dlp\yt-dlp.exe`.
- **Skills sandbox**: Only `python`, `py`, `node`, `pip` allowed. External tools (poppler/pandoc/LibreOffice) appended to PATH from `C:\Tools`. Executor order: `ollama` (qwen3:14b, unlimited) → `gemini` (quality fallback); pin-once per run, but the pin is CLEARED if the pinned provider dies so the next one gets a shot. `OLLAMA_MODEL=qwen3:14b` in `.env.local`.
- **Gemini 429 classification** (`lib/geminiKeys.ts`): a transient per-minute rate limit («retry in <15min» / `free_tier_requests`) sets a SHORT `cooldownUntil` and NEVER kills the key; only hard daily/token exhaustion (daily/PerDay/TPD or retry ≥15min) marks `exhaustedAt` until midnight Pacific. Don't merge the two — a single RPM burst faking a dead account was the original bug.
- **Timeline**: every `/api/assistant` request records per-phase timings (`resolveKey`, `provider:*`, `escalate`, `parse`, `action`, `executor:*`) in `lib/timeline.ts`, logs `[timeline] …` and exposes the last 50 via GET `/api/timeline` (localhost-only). Consult it before claiming anything about latency.
- **Meta-algorithms**: a `template`-type meta-algorithm with an EMPTY `pattern` must never match everything (it swallowed every request before the skill executor). Empty pattern → no match. Check `data/meta-algorithms.json` if a request starts returning a canned reply for all inputs.
- **Greeting intent**: only matches when the greeting word LEADS the message, otherwise a task like «запиши в файл фразу "привет"» is swallowed before the skill gate.
- **No CI**: No `.github/workflows`. Validation = `npm run build` + `npm run self-test`.
- **Yandex Music API**: `YM_TOKEN` in `.env.local` — OAuth token for `@dvxch/yandex-music`. Get via `node scripts/get-ym-token.mjs` (device flow). Token used by `lib/yandexMusicApi.ts` → `lib/musicPlayer.ts` for API-first search + deep-link playback.
- **n8n**: Cloud instance at `sb-ai.app.n8n.cloud`. `N8N_WEBHOOK_URL` (production) + `N8N_WEBHOOK_TEST_URL` (webhook-test) + `N8N_SHARED_SECRET` in `.env.local`. One webhook routes by `scenario` via a Switch node. Never commit the secret.
- **CLAUDE.md**: Comprehensive architecture reference — consult it for deep details.
