# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ULTRON Orb UI — a single-page Next.js app rendering an Iron Man-style holographic
wireframe orb in Three.js, controllable by mouse/touch or by webcam hand-gesture
tracking (MediaPipe). It's the open-source interface layer for a separate, closed
"ULTRON" project. The orb rendering runs entirely client-side in the browser;
localhost-only API routes provide PC automation (launch/type/click), the LLM
gateway, and durable brain storage.

## Commands

```bash
npm install
npm run dev     # start dev server at http://localhost:3000
npm run build   # production build
npm run start   # serve production build
```

There is no lint script and no test suite configured in this repo. `tsc` runs
implicitly via `next build`; there's no standalone typecheck script, so run
`npm run build` to catch type errors.

## Architecture

The app has exactly three source files under `app`/`components`/`lib`, and the
split between them is intentional — preserve it when adding features:

- **`lib/orbScene.ts`** — pure Three.js, framework-agnostic. `createOrbScene(container)`
  builds the entire scene graph (nested shell layers, spiral inner core, code-text
  sprites, orbiting debris, dust particles, scan rings, bloom + chromatic-aberration
  post-processing) and starts its own `requestAnimationFrame` loop internally. It
  returns an `OrbSceneApi` (`rotateBy`, `zoomBy`, `zoomIn`, `zoomOut`, `resetView`,
  `dispose`) — this is the *entire* surface other code is allowed to touch. Nothing
  outside this file should reach into `THREE` internals or the scene graph directly.
  All animation state (rotation speeds, pulse waves, drift) lives in closures inside
  `animate()`, not in React state — the render loop is deliberately decoupled from
  React's render cycle for performance.

- **`lib/handTracker.ts`** — pure MediaPipe/webcam logic, no Three.js and no React.
  `HandTracker` owns the camera stream and `HandLandmarker` model, runs its own RAF
  loop keyed off `video.currentTime` changes, and reports out via three callbacks
  (`onRotate`, `onZoom`, `onStatus`) passed into the constructor — it never calls
  into `orbScene` directly. Per-hand pinch state is tracked in a `Map` keyed by
  MediaPipe's handedness label (`"Left"`/`"Right"`) so it survives hand reordering
  between frames. Pinch detection uses hysteresis (`PINCH_ON`/`PINCH_OFF` thresholds)
  to avoid flicker at the boundary — don't collapse these to a single threshold.
  Gesture mode is derived from how many hands are currently pinching: 0 → idle,
  1 → spin (drag), 2 → zoom (spread/pinch distance).

- **`components/JarvisOrb.tsx`** — the only React component. It owns refs to the
  DOM container/video/canvas, instantiates `orbScene` and `HandTracker` in
  `useEffect`, wires `HandTracker` callbacks into the `OrbSceneApi` methods, and
  renders the HUD overlay (title, control hints, camera preview panel, buttons).
  Keyboard shortcuts (`G`/`R`/`+`/`-`) are handled here via a `window` keydown
  listener. This is a client component (`"use client"`) — the scene/tracker can't
  run server-side or during SSR.

Data flow is one-directional and callback-based, not event-bus or state-management
based: `HandTracker` → callbacks → `JarvisOrb` → `OrbSceneApi` methods → `orbScene`
closures. There is no global state, no context, no external state library.

### Working in `orbScene.ts`

The scene is built as many independently-rotating `THREE.Group`s (`outerShell`,
`panelGroup`, `shell2`, `innerCore`, debris, text sprite groups) that get their
own rotation/opacity/scale animated per-frame in `animate()`. When adding a new
visual layer, follow the existing pattern: build geometry/lines once at scene
creation time (most geometry is `THREE.Line`/`LineSegments` with additive-blended,
transparent materials for the wireframe/glow look), stash any per-object animation
parameters in `mesh.userData`, and add the per-frame update inside `animate()`.
Reuse geometries across repeated objects (see `debrisGeos`) rather than creating
new geometry per-instance. Everything created (geometries, materials, textures)
must be disposed in `dispose()` — the existing `scene.traverse` cleanup handles
most of this automatically as long as new objects are added to the scene graph.

### Working in `handTracker.ts`

MediaPipe's WASM runtime and hand-landmark model are loaded from CDN URLs
(`WASM_CDN`, `MODEL_URL`) at `start()` time — there's no bundled/local model.
GPU delegate is tried first with a CPU fallback on failure (some browsers/GPUs
reject GPU delegate). Landmark indices (`WRIST`, `THUMB_TIP`, `INDEX_TIP`,
`MIDDLE_MCP`) are MediaPipe's fixed hand-model indices, documented inline —
don't renumber without checking MediaPipe's hand landmark reference.

## The assistant layer (beyond the orb)

On top of the orb there is a voice/text assistant with its own architecture
(not Three.js/React-scene related). Key pieces and the local-first policy:

- **`lib/assistantBrain.ts`** — pure client-side "brain": rule/fact/skill/note
  storage, intent parsing (`parseAction`, `matchBuiltin`, weather intent,
  search/learn extraction), and `extractImagePrompt` (last-resort image fallback).
  Works in both the browser and the Node server. Persists to localStorage
  (browser) and mirrors a durable server copy. It tracks `serverBaseIds` (the
  last server state it saw) and a persisted `dropped` id-set (items the server
  removed that a stale full-state push must not resurrect); `save()` pushes
  `{ brain, base }` to `/api/brain` and bumps `pendingPuts` (→ `syncDirty`).
  `mirrorKnowledge(snapshot)` wholesale-adopts the server state without
  re-saving (used by the browser's 25s live-sync poll) and maintains `dropped`.
  `buildSystemPrompt(query, { brief })` — `brief: true` shortens the reply style
  (the browser's voice assistant reads short answers aloud; the Telegram bot
  keeps full answers).
- **`lib/noteBuilder.ts`** — turns raw page text or a YouTube transcript into a
  StudyNote. Framework-agnostic: callers inject their own LLM via `complete`.
  Videos are split into ~8k-char, sentence-aware chunks (`chunkText`); each chunk
  becomes a `chapter` (`{title, summary}` via a JSON-summarizer with up to 3
  retries) and a final pass builds the global note — so EVERYTHING said in the
  video is captured in `chapters` + `fullText` (≤260k), not just the opening.
  Chunk size is 8k on purpose: qwen3's forced-JSON mode reliably returns
  `{"title","summary"}` at 8k but falls back to a canned `{"status","data"}`
  schema at ~12k. Regular pages use a single compression pass + `fallbackNote`.
- **`lib/youtube.ts`** — keyless YouTube transcript extraction. Strategy order:
  (1) **yt-dlp** if installed — binary found via `YTDLP_BIN` env, common paths
  (`C:\Tools\yt-dlp\yt-dlp.exe`, PATH); runs with rotated player clients
  (`youtube:player_client=default,android_vr,web_embedded,tv,ios,mweb,...`) to
  dodge bot checks, `--write-auto-subs --write-subs --sub-langs ru,en`, then
  parses the VTT files (prefers ru manual → ru auto → en → any). (2) a keyless
  native flow: mobile watch page → `ytInitialPlayerResponse` balanced-brace
  scan → best caption track → timedtext `fmt=json`. (3) a youtubei/v1/player
  fallback. Some networks (flagged IPs, datacenter) return empty timedtext — on
  this machine only yt-dlp works. yt-dlp was installed to `C:\Tools\yt-dlp\`
  via aria2 (GitHub latest release).
- **`lib/brainStore.ts`** — server-side durable store for `data/brain.json`
  (the single source of truth): serialized write queue, `loadBrain()`,
  `readBrainSnapshot()`, and `commitBrain(updated, base)`. `commitBrain`
  merges only the deltas the writer hasn't seen yet, keeps the freshest
  `abilityAnalysis`, and maintains short-TTL (2 min, in-memory) tombstones for
  recently-deleted ids so a stale other writer can't resurrect them. Used by
  `/api/brain` and `/api/assistant` (both routes hold a shared brain instance).
- **`hooks/useVoiceAssistant.ts`** — the only React hook. Owns the local LLM
  router (`lib/llm`), speech recognition/synthesis, and the image pipeline.
- **`app/api/assistant/route.ts`** — server core for the Telegram bot
  (`scripts/telegram-bot.mjs`). Accepts `{ text, history?, chatId?, mode? }`;
  `mode: "browser"` makes the route build a brief system prompt (short spoken
  answers for the browser's voice assistant — see `buildSystemPrompt`). history
  is owned by the caller (the bot keeps a per-chat queue of the last ~16 turns)
  and is injected into the LLM escalation so follow-ups like «сделай его сочнее»
  stay in topic. Also handles admin-control messages
  (`{ action: "approve"|"reject" }`) from the bot and the LLM's autonomous
  `admin` JSON actions. Sanitizes RU "restricted" vocabulary out of the
  LLM-visible text (via `promptSanitizer`), re-injecting the hidden EN tags only
  into the local ComfyUI tier.
- **`lib/promptSanitizer.ts`** — RU→EN sanitizer. `sanitize`/`sanitizeTexts` strip
  restricted RU phrases from the LLM-visible text and collect English tags
  (`nude`, `breasts`, `doggystyle`, …); `composeFullPrompt` appends those tags
  to the LLM-built prompt ONLY for the local generator. Gemini/Pollinations never
  see the tags (they moderate). Tags accumulate across recent user turns so a
  follow-up keeps the hidden context. Cyrillic word boundaries are built by hand
  (`\b` is ASCII-only in JS).
- **`lib/adminOps.ts`** — server-side autonomy engine (localhost-only): path
  validation inside the project root, LLM read-loop cap (4 per chat, 5-min TTL),
  pending approvals (write/replace/run/build) with TTL, execution with backup +
  `node --check` + `npm run build` and auto-rollback on failure, a 3-changes-per-
  session limit, a `data/stop-ai` kill switch, and an audit log
  (`data/admin-log.jsonl`). Settings live in `data/settings.json`; pending
  approvals in `data/pending.json`.
- **`lib/textOverlay.ts` + `scripts/text_overlay.py`** — caption banner drawn on
  the generated image (bottom strip, Cyrillic-safe) using Pillow under ComfyUI's
  bundled Python (`COM FY_PYTHON`). Best-effort: returns the image untouched if
  Python is missing.
- **`scripts/telegram-bot.mjs`** — long-polling Telegram bridge. Owner
  (`TELEGRAM_OWNER_USERNAME`) gets full admin access: `/users /adduser /rmuser`,
  file ops (`/ls /tree /cat /find /write /append /replace /rm /mkdir /mv /cp`),
  shell (`/run /node /build /log /sysinfo`), git (`/git` via `GITHUB_TOKEN`),
  snapshots/rollback (git `stash create` + `checkout`, tracked in
  `data/snapshots.json`), server control (`/restart /restart-server`), and
  LLM-autonomy control (`/autonomy on|off|status`, `/veto <id>`, `/stop-ai`).
  Allowed users (`TELEGRAM_ALLOWED_USERNAMES` / `/adduser`) can only chat. User
  registry persists to `data/telegram-users.json`; approvals render as inline
  buttons (`approve:<id>` / `reject:<id>`) and execute via the route.
- **LLM chain (local-first, unlimited):** browser router order
  `["gemini", "ollama", "groq", "webllm"]` (`lib/llm/router.ts`); server order
  `[gemini, ollama, groq]` (`lib/serverLLM.ts`). The browser's `gemini`
  provider proxies through `/api/llm`, which rotates the owner's key pool
  (`lib/geminiKeys.ts`) and reports quota failures so the pool cycles keys.
  OpenAI/DeepSeek are excluded — their keys are unfunded. Ollama MUST use
  the native `/api/chat` endpoint with `think: false` and `format: "json"`:
  qwen3's thinking mode burns the whole token budget via the OpenAI-compat
  endpoint and returns empty content, and forced-JSON needs `format: "json"`
  (a plain prompt alone drifts off-schema at long contexts).
- **Hybrid SKILL.md skills (`lib/skillCatalog.ts`):** beyond screen-learned
  skills there's a catalog of `skills/<slug>/SKILL.md` folders (frontmatter
  `name`/`description`/`safe`; scripts in `skills/<slug>/scripts/`). Packed in:
  official `pdf`/`xlsx`/`docx`/`pptx`/`skill-creator` (anthropics/skills) and
  custom `sys-report` (python report) + `image-style` (knowledge/prompt styles).
  Dispatch (`runSkillDispatch` in `/api/assistant`) prefers screen skills, then
  fuzzy-matches the catalog (`fuzzyFind` — scores name/slug/description plus
  RU aliases from `skills/aliases.json`, threshold 0.2). Non-safe skills need
  owner approval (`data/pending.json`). The sandbox executor runs ONLY
  `python/py/node/pip` with a blocked-fragment validator, per-chat workdir
  `data/skill-work/<chatId>`, ≤6 LLM rounds, and appends external tool bins
  (poppler/pandoc/LibreOffice from `C:\Tools`) to PATH. `image-style` also gets
  user-learned styles appended to its body.
- **«Учёба у Gemini» (`lib/lessonStore.ts` + `/api/learn`):** the browser
  voice/assistant reports successful Gemini exchanges (`learnFromGemini` in
  `hooks/useVoiceAssistant.ts`); they accumulate in `data/gemini-lessons.json`.
  When ≥4 pile up (≤1 distill per 30 min) the route asks Gemini to distill
  reusable **facts** (`data/learned-facts.json`, injected into the server
  assistant system prompt via `learnedFactsSystemNote`) and **style rules**
  (`data/learned-styles.json`, injected into the image-style skill body). All
  three files are gitignored runtime state.
- **Web search (real-time, local-first):** `app/api/search/route.ts` →
  `completeCloudWithSearch` (`lib/serverLLM.ts`). Chain: Gemini Grounding
  (best; needs billing — free keys hit 429, and `gemini-2.5-flash` is
  discontinued) → self-hosted **OpenSERP** (`lib/serverLLM.ts:openSerpSearch`,
  MIT, keyless; default `http://127.0.0.1:7000`, run
  `openserp.exe serve -p 7000` in browser mode with Chrome/Edge; multi-engine
  `mega mode=any` unless `OPENSERP_ENGINE` pins one; `extract=N` fetches page
  content that is fed to the LLM as grounding, so answers come from live pages,
  not qwen3's 2024 weights) → keyless Wikipedia → model knowledge (with an
  honesty caveat). Never rely on qwen3/gemini weights for "what's new" answers.
- **Image chain (local-first):** `Gemini (quota-limited) → local ComfyUI
  (`lib/localImage.ts`, RealVisXL V5.0 fp16 on 127.0.0.1:8188, workflow template
  in `comfy/text2img.json`: 28 steps dpmpp_2m/karras, then 2× upscale through
  `4x-UltraSharp.pth`) → Pollinations (keyless fallback)`. Checkpoint is picked
  by `isAnimePrompt()` — anime/аниме/манга/маньхуа/вей у сянь switches to
  Animagine XL 4.0 (`COMFY_ANIME_CHECKPOINT`, prompt gets a
  `masterpiece, best quality, very aesthetic, absurdres, anime style, ` prefix),
  everything else stays on RealVisXL. `lib/localImage.ts` probes ComfyUI
  (`/system_stats`, 15s TTL), POSTs the template, polls `/history/{id}` for the
  finished image, and — when the sanitizer provided tags or the user asked for a
  caption — injects tags into the local prompt and draws the text overlay before
  returning.
- **Character references (IPAdapter/FaceID):** `lib/characters.ts` keeps a
  character registry (`data/character-refs.json`, gitignored; images in
  `C:\ComfyUI\ComfyUI\input\refs`). `resolveCharacterRef` fuzzy-matches by name
  + aliases; `fetchCharacterRefWeb` auto-fetches via Wikimedia (lead image →
  Commons search) when the LLM names an explicit character/work (`"ref"` in the
  image action). Commons search filters to raster files only (skips PDF/SVG
  scans) and skips cosplay photos; all Wikimedia calls send a descriptive
  `User-Agent` (Node's default agent gets throttled). Note: enwiki/ruwiki
  character infobox images are often non-free and never returned by the
  thumbnail API, so many anime characters resolve to nothing — the reliable
  path is manual registration via Telegram «запомни как <имя>». The route passes
  `{reference: {file, mode}}` into `generateImage`; `lib/localImage.ts` picks
  `comfy/ref2img.json` (IPAdapterUnifiedLoader STANDARD, style, weight 0.7) for
  `mode: "style"` and
  `comfy/faceid2img.json` (IPAdapterUnifiedLoaderFaceID FACEID PLUS V2 0.85,
  provider CPU, InsightFace `buffalo_l` in `models/insightface`) for
  `mode: "face"`, substituting `__REFERENCE__`/`__IPADAPTER_WEIGHT__`. Manual
  refs: caption a photo in Telegram «запомни как <имя>» → bot downloads it and
  POSTs to the localhost-only `app/api/characters/route.ts` (GET lists refs).
- **LLM autonomy (opt-in, owner-gated):** when `data/settings.json` has
  `autonomy: true`, the route appends an admin-mode system block. The LLM may
  return JSON `{ admin: { action: "read"|"write"|"replace"|"run"|"build", … } }`.
  `read` executes immediately (≤4 per loop); the rest require the owner's «да»
  via Telegram buttons, then run through `adminOps` with build-check + rollback.
  Protected files (bot, routes, sanitizer, adminOps, `data/*`) are never editable
  by the LLM.
- **Setup:** `node scripts/setup-local.mjs` installs Ollama + qwen3:8b and
  downloads/installs ComfyUI + RealVisXL V5.0 fp16 + 4x-UltraSharp
  (`C:\ComfyUI`). Start ComfyUI with `run_nvidia_gpu.bat`.
  - yt-dlp (for YouTube transcripts, `lib/youtube.ts`) is installed to
    `C:\Tools\yt-dlp\yt-dlp.exe` — override with `YTDLP_BIN`.
  - Downloads use `aria2` (GitHub) and `scripts/download-parallel.mjs`
    (HuggingFace). HF's xet-bridge signs each URL for one range — a single
    large range (or aria2's multi-range) hangs/403s, so the HF downloader
    fetches 16MB pieces across parallel connections, then concatenates.
    py7zr can't unpack ComfyUI's BCJ2-encoded 7z — setup installs 7-Zip
    silently to `C:\7Zip` (no admin) and moves the `ComfyUI_windows_portable`
    folder up a level.

## Robustness protocol (PC control)

Non-negotiable rules for every system/PC operation, so partial failures never
surface as scary errors and regressions get caught before the owner sees them:

1. **Per-item I/O.** Any bulk operation over files/processes/registry must
   isolate each item in its own try/catch. One locked or access-denied file
   must never abort the whole run — it is skipped and counted. See
   `lib/tempCleanup.ts` (per-item `Remove-Item -ErrorAction Stop` inside
   `ForEach-Object { try { … } catch { $failed++ } }`, script ALWAYS `exit 0`).
2. **Partial success = success.** A cleanup/launch/focus that mostly worked
   must report the positive result with the skipped count, never a red "failed"
   banner. Real failures (nothing happened at all, infrastructure down) are the
   only case for a negative report.
3. **Retry transient OS races.** Window/foreground state races with the OS —
   always retry (see `runWindowOp` in `lib/desktopInput.ts`: 3 attempts, 300ms
   apart; `launchAndFocus` in `lib/launcher.ts` polls up to 12×350ms).
4. **Structured results.** Operations return typed results (`CleanupResult`,
   `LaunchOutcome`) instead of raw exit codes/strings; callers render them into
   Telegram reports.
5. **Never 500 on bad input.** Routes must validate payloads and return clean
   `4xx`; guard localhost-only routes with the host check pattern from
   `app/api/do-step/route.ts`.
6. **Self-test before commit.** After any PC-control change, run
   `npm run self-test` (syntax + route schema + PowerShell bridge + cleanup
   sandbox; `--live` adds a TTS→transcribe roundtrip). Fix failures before
   committing. The bot exposes the same suite as the owner-only `/self-test`.
7. **Log bot crashes.** Unexpected exceptions in the bot's message handling are
   caught and written to `data/admin-log.jsonl` (see the `handleMessage` try/
   catch in the polling loop) — they must never die silently in the console.

