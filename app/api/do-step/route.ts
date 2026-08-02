import { NextRequest, NextResponse } from "next/server";
import { launchApp, openViaShell, runPs, SAFE_URL } from "@/lib/launcher";
import type { SkillStepAction } from "@/lib/assistantBrain";

/**
 * Executes a single skill step on the host machine (LOCALHOST-only).
 * Actions: launch (app/URL), url, type (clipboard + Ctrl+V), key (SendKeys),
 * wait (sleep), click (screen coordinates, 0..1 → pixels).
 *
 * Everything goes through validated PowerShell scripts — raw step params are
 * never concatenated into a shell string (PS single-quote escaping everywhere).
 */

const MAX_TEXT_LEN = 1000;
const MAX_WAIT_MS = 30_000;

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

function psQuote(text: string): string {
  return text.replace(/'/g, "''");
}

/** Known-key → SendKeys token map (lowercase). */
const SENDKEYS: Record<string, string> = {
  enter: "{ENTER}",
  return: "{ENTER}",
  tab: "{TAB}",
  escape: "{ESC}",
  esc: "{ESC}",
  delete: "{DELETE}",
  del: "{DELETE}",
  backspace: "{BACKSPACE}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  space: " ",
  spacebar: " ",
};

function toSendKeys(key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  const lower = k.toLowerCase();
  if (SENDKEYS[lower]) return SENDKEYS[lower];
  if (/^f([1-9]|1[0-2])$/.test(lower)) return `{${lower.toUpperCase()}}`;
  const mods = new Set(["ctrl", "control", "alt", "shift"]);
  const parts = lower.split("+");
  if (parts.length >= 2) {
    const letter = parts.find((p) => !mods.has(p));
    if (letter && parts.length - 1 === parts.filter((p) => mods.has(p)).length && /^[a-z0-9]$/.test(letter)) {
      let prefix = "";
      for (const p of parts) {
        if (p === "ctrl" || p === "control") prefix += "^";
        else if (p === "alt") prefix += "%";
        else if (p === "shift") prefix += "+";
      }
      return `${prefix}${letter}`;
    }
  }
  if (/^[a-z0-9]$/.test(lower)) return lower;
  return null;
}

const CLICK_SCRIPT = (x: number, y: number) => `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
Add-Type -AssemblyName System.Windows.Forms
$w = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
$h = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
$px = [int]($w * ${x})
$py = [int]($h * ${y})
[Win32]::SetCursorPos($px, $py) | Out-Null
Start-Sleep -Milliseconds 120
[Win32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
[Win32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`;

const SENDKEYS_SCRIPT = (send: string) => `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${psQuote(send)}')
`;

const TYPE_SCRIPT = (text: string) => `Add-Type -AssemblyName System.Windows.Forms
$t = '${psQuote(text)}'
Set-Clipboard -Value $t
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait('^v')
`;

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const allowed: SkillStepAction[] = ["launch", "url", "type", "key", "wait", "click"];
  const action = typeof body?.action === "string" ? body.action : "";
  if (!allowed.includes(action as SkillStepAction)) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
  const params = (body?.params ?? {}) as Record<string, unknown>;
  const a = action as SkillStepAction;

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

      case "type": {
        const text = typeof params.text === "string" ? params.text.slice(0, MAX_TEXT_LEN) : "";
        if (!text) return NextResponse.json({ error: "empty text" }, { status: 400 });
        await runPs(TYPE_SCRIPT(text));
        return NextResponse.json({ ok: true });
      }

      case "key": {
        const key = typeof params.key === "string" ? params.key : "";
        const send = toSendKeys(key);
        if (!send) return NextResponse.json({ error: `unsupported key «${key}»` }, { status: 400 });
        await runPs(SENDKEYS_SCRIPT(send));
        return NextResponse.json({ ok: true, key: send });
      }

      case "wait": {
        const ms = Math.min(Math.max(Number(params.ms) || 1000, 100), MAX_WAIT_MS);
        await new Promise((r) => setTimeout(r, ms));
        return NextResponse.json({ ok: true, waited: ms });
      }

      case "click": {
        const x = Number(params.x);
        const y = Number(params.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
          return NextResponse.json({ error: "invalid coordinates" }, { status: 400 });
        }
        await runPs(CLICK_SCRIPT(x, y));
        return NextResponse.json({ ok: true });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
