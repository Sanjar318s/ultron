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
  Works in both the browser and the Node server. Persists to `data/brain.json`
  via `/api/brain` (server) and localStorage (browser), merged on save.
- **`hooks/useVoiceAssistant.ts`** — the only React hook. Owns the local LLM
  router (`lib/llm`), speech recognition/synthesis, and the image pipeline.
- **`app/api/assistant/route.ts`** — server core for the Telegram bot
  (`scripts/telegram-bot.mjs`). Accepts `{ text, history?, chatId? }`; history is
  owned by the caller (the bot keeps a per-chat queue of the last ~16 turns) and
  is injected into the LLM escalation so follow-ups like «сделай его сочнее» stay
  in topic. Also handles admin-control messages (`{ action: "approve"|"reject" }`)
  from the bot and the LLM's autonomous `admin` JSON actions. Sanitizes RU
  "restricted" vocabulary out of the LLM-visible text (via `promptSanitizer`),
  re-injecting the hidden EN tags only into the local ComfyUI tier.
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
  `["ollama", "gemini", "groq", "webllm"]` (`lib/llm/router.ts`); server order
  `[ollama, gemini, groq]` (`lib/serverLLM.ts`). OpenAI/DeepSeek are excluded —
  their keys are unfunded. Ollama MUST use the native `/api/chat` endpoint with
  `think: false`: qwen3's thinking mode burns the whole token budget via the
  OpenAI-compat endpoint and returns empty content.
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
  `4x-UltraSharp.pth`) → Pollinations (keyless fallback)`. `lib/localImage.ts`
  probes ComfyUI (`/system_stats`, 15s TTL), POSTs the template, polls
  `/history/{id}` for the finished image, and — when the sanitizer provided tags
  or the user asked for a caption — injects tags into the local prompt and draws
  the text overlay before returning.
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
  - Downloads use `aria2` (GitHub) and `scripts/download-parallel.mjs`
    (HuggingFace). HF's xet-bridge signs each URL for one range — a single
    large range (or aria2's multi-range) hangs/403s, so the HF downloader
    fetches 16MB pieces across parallel connections, then concatenates.
    py7zr can't unpack ComfyUI's BCJ2-encoded 7z — setup installs 7-Zip
    silently to `C:\7Zip` (no admin) and moves the `ComfyUI_windows_portable`
    folder up a level.
