import { NextRequest, NextResponse } from "next/server";
import { launchApp, launchAndFocus, openViaShell, runPs, SAFE_URL } from "@/lib/launcher";
import {
  clearField,
  clickAt,
  copySelection,
  dragTo,
  focusWindow,
  moveTo,
  pasteClipboard,
  scrollBy,
  sendKeys,
  toSendKeys,
  typeText,
} from "@/lib/desktopInput";
import type { SkillStepAction } from "@/lib/assistantBrain";

/**
 * Executes a single skill step on the host machine (LOCALHOST-only).
 * Actions: launch/url (app/URL), type (clipboard + Ctrl+V), smart-type (type
 * + optional Enter), key (SendKeys), clear (Ctrl+A+Delete), copy/paste,
 * wait (sleep), focus (AppActivate window), click/double-click/right-click
 * (screen coords 0..1 → pixels), move (cursor only), drag (x1,y1→x2,y2),
 * scroll (wheel, dir+lines).
 *
 * Mouse/keyboard primitives live in lib/desktopInput.ts (single source).
 */

const MAX_TEXT_LEN = 1000;
const MAX_WAIT_MS = 30_000;

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const allowed: SkillStepAction[] = [
    "launch", "url", "type", "key", "wait", "click",
    "double-click", "right-click", "move", "drag", "scroll",
    "focus", "clear", "smart-type", "copy", "paste",
  ];
  const action = typeof body?.action === "string" ? body.action : "";
  if (!allowed.includes(action as SkillStepAction)) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  const params = (body?.params ?? {}) as Record<string, unknown>;
  const a = action as SkillStepAction;

  const coord = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
  };

  try {
    switch (a) {
      case "launch": {
        const app = typeof params.app === "string" ? params.app.trim() : "";
        const url = typeof params.url === "string" ? params.url.trim() : "";
        if (!app && !url) return NextResponse.json({ error: "missing app" }, { status: 400 });
        // Focus the launched window so the next step (typing/keys) lands here.
        const outcome = await launchApp(app || url, url || undefined, { focus: true });
        if (!outcome) {
          return NextResponse.json({ error: `не удалось найти «${app}»` }, { status: 404 });
        }
        return NextResponse.json({ ok: true, matched: outcome.matched });
      }

      case "url": {
        const url = typeof params.url === "string" ? params.url.trim() : "";
        if (!url || !SAFE_URL.test(url) || url.length > 512) {
          return NextResponse.json({ error: "invalid url" }, { status: 400 });
        }
        openViaShell(url);
        return NextResponse.json({ ok: true });
      }

      case "type":
      case "smart-type": {
        const text = typeof params.text === "string" ? params.text.slice(0, MAX_TEXT_LEN) : "";
        if (!text) return NextResponse.json({ error: "empty text" }, { status: 400 });
        await typeText(text);
        if (a === "smart-type" && (params.enter === 1 || params.enter === "1" || params.enter === true)) {
          await sendKeys("{ENTER}");
        }
        return NextResponse.json({ ok: true });
      }

      case "key": {
        const key = typeof params.key === "string" ? params.key : "";
        const send = toSendKeys(key);
        if (!send) return NextResponse.json({ error: `unsupported key «${key}»` }, { status: 400 });
        await sendKeys(send);
        return NextResponse.json({ ok: true, key: send });
      }

      case "clear": {
        await clearField();
        return NextResponse.json({ ok: true });
      }

      case "copy": {
        await copySelection();
        return NextResponse.json({ ok: true });
      }

      case "paste": {
        await pasteClipboard();
        return NextResponse.json({ ok: true });
      }

      case "wait": {
        const ms = Math.min(Math.max(Number(params.ms) || 1000, 100), MAX_WAIT_MS);
        await new Promise((r) => setTimeout(r, ms));
        return NextResponse.json({ ok: true, waited: ms });
      }

      case "click":
      case "double-click":
      case "right-click": {
        const x = coord(params.x);
        const y = coord(params.y);
        if (x === null || y === null) {
          return NextResponse.json({ error: "invalid coordinates" }, { status: 400 });
        }
        const kind = a === "double-click" ? "double" : a === "right-click" ? "right" : "single";
        await clickAt(x, y, kind);
        return NextResponse.json({ ok: true });
      }

      case "move": {
        const x = coord(params.x);
        const y = coord(params.y);
        if (x === null || y === null) {
          return NextResponse.json({ error: "invalid coordinates" }, { status: 400 });
        }
        await moveTo(x, y);
        return NextResponse.json({ ok: true });
      }

      case "drag": {
        const x1 = coord(params.x1);
        const y1 = coord(params.y1);
        const x2 = coord(params.x2);
        const y2 = coord(params.y2);
        if (x1 === null || y1 === null || x2 === null || y2 === null) {
          return NextResponse.json({ error: "invalid drag coordinates" }, { status: 400 });
        }
        await dragTo(x1, y1, x2, y2);
        return NextResponse.json({ ok: true });
      }

      case "scroll": {
        const dir = typeof params.dir === "string" ? params.dir.toLowerCase() : "";
        if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") {
          return NextResponse.json({ error: "invalid scroll dir" }, { status: 400 });
        }
        const lines = Math.max(1, Math.min(Math.round(Number(params.lines) || 3), 20));
        await scrollBy(dir, lines);
        return NextResponse.json({ ok: true, dir, lines });
      }

      case "focus": {
        const title = typeof params.title === "string" ? params.title.trim() : "";
        const app = typeof params.app === "string" ? params.app.trim() : "";
        if (!title && !app) {
          return NextResponse.json({ error: "missing title/app" }, { status: 400 });
        }
        const ok = title && app ? await launchAndFocus(app, title) : await focusWindow(title, app);
        if (!ok) {
          return NextResponse.json({ error: `окно «${title || app}» не найдено` }, { status: 404 });
        }
        return NextResponse.json({ ok: true });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
