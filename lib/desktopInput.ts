import { focusWindowByTitle, runPs } from "./launcher";

/**
 * Desktop input primitives (LOCALHOST-only, host machine). All mouse
 * coordinates are RELATIVE 0..1 (fraction of the primary screen), matching
 * the screen-learned skills and the AI-click flow.
 *
 * Everything runs through validated PowerShell — params are single-quote
 * escaped, never concatenated raw into a shell string.
 */

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

/** Convert a spoken key name («ctrl+v», «enter») to a SendKeys token; null if unknown. */
export function toSendKeys(key: string): string | null {
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

const WIN32 = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
Add-Type -AssemblyName System.Windows.Forms
`;

/** keybd_event primitives. SendKeys.SendWait drops modifier keys on this
 *  machine (GameInput overlay swallows them — a plain "^v" pastes a literal
 *  "v"), so every keyboard action goes through raw keybd_event chords.
 *  IMPORTANT: every Tap/Chord must end with a ~800ms sleep so the target
 *  window's message loop fully processes the keyboard messages before the
 *  powershell process exits — without it the OS discards the pending events
 *  (tested empirically: 100ms was not enough, 800ms reliably delivers). */
const WIN_INPUT = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
function Tap([byte]$vk) {
  [WinInput]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  [WinInput]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 800
}
function Chord([byte[]]$keys) {
  foreach ($k in $keys) { [WinInput]::keybd_event($k, 0, 0, [UIntPtr]::Zero) }
  for ($i = $keys.Length - 1; $i -ge 0; $i--) { [WinInput]::keybd_event($keys[$i], 0, 2, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 800
}
`;

const PRIMARY_SCREEN = `$w = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
$h = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
`;

export type ClickKind = "single" | "double" | "right";

export async function clickAt(x: number, y: number, kind: ClickKind = "single"): Promise<void> {
  const tap = kind === "double" ? 2 : 1;
  const down = kind === "right" ? "0x0008" : "0x0002";
  const up = kind === "right" ? "0x0010" : "0x0004";
  const taps = Array.from({ length: tap }, (_, i) => i).map(
    () => `[Win32]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
[Win32]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
${kind === "double" ? "Start-Sleep -Milliseconds 90\n" : ""}`,
  );
  await runPs(`${WIN32}${PRIMARY_SCREEN}
[Win32]::SetCursorPos([int]($w * ${x}), [int]($h * ${y})) | Out-Null
Start-Sleep -Milliseconds 120
${taps.join("")}`);
}

export async function moveTo(x: number, y: number): Promise<void> {
  await runPs(`${WIN32}${PRIMARY_SCREEN}
[Win32]::SetCursorPos([int]($w * ${x}), [int]($h * ${y})) | Out-Null`);
}

export async function dragTo(x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await runPs(`${WIN32}${PRIMARY_SCREEN}
$x1 = [int]($w * ${x1}); $y1 = [int]($h * ${y1})
$x2 = [int]($w * ${x2}); $y2 = [int]($h * ${y2})
[Win32]::SetCursorPos($x1, $y1) | Out-Null
Start-Sleep -Milliseconds 120
[Win32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
for ($i = 1; $i -le 12; $i++) {
  $tx = [int]($x1 + ($x2 - $x1) * $i / 12)
  $ty = [int]($y1 + ($y2 - $y1) * $i / 12)
  [Win32]::SetCursorPos($tx, $ty) | Out-Null
  Start-Sleep -Milliseconds 25
}
Start-Sleep -Milliseconds 120
[Win32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`);
}

export type ScrollDir = "up" | "down" | "left" | "right";

export async function scrollBy(dir: ScrollDir, lines = 3): Promise<void> {
  const delta = Math.max(1, Math.min(Math.round(lines), 20)) * 120;
  const value = dir === "up" || dir === "right" ? delta : -delta;
  const flag = dir === "left" || dir === "right" ? "0x1000" : "0x0800";
  await runPs(`${WIN32}
[Win32]::mouse_event(${flag}, 0, 0, ${value}, [UIntPtr]::Zero)`);
}

const VK: Record<string, number> = {
  "{ENTER}": 0x0d, "{TAB}": 0x09, "{ESC}": 0x1b, "{ESCAPE}": 0x1b, "{DELETE}": 0x2e, "{BACKSPACE}": 0x08,
  "{HOME}": 0x24, "{END}": 0x23, "{PGUP}": 0x21, "{PGDN}": 0x22,
  "{UP}": 0x26, "{DOWN}": 0x28, "{LEFT}": 0x25, "{RIGHT}": 0x27, "{SPACE}": 0x20,
};
const MOD_VK: Record<string, number> = { "^": 0x11, "+": 0x10, "%": 0x12 };

/** VK code for a plain character (a-z/A-Z/0-9). */
function vkForChar(ch: string): number {
  const u = ch.toUpperCase();
  if (/^[A-Z0-9]$/.test(u)) return u.charCodeAt(0);
  return 0;
}

/** Send a SendKeys-style token via raw keybd_event: modifier chords (^v, +a),
 *  named keys ({ENTER}, {F1}, {LEFT}), or a single character. */
export async function sendKeys(token: string): Promise<void> {
  const t = token.trim();
  const mod = /^([\^+%]+)([a-z0-9])$/i.exec(t);
  if (mod) {
    const keys = [...mod[1]].map((m) => MOD_VK[m]).concat(vkForChar(mod[2]));
    await runPs(`${WIN_INPUT}
Chord @(${keys.map((k) => `0x${k.toString(16)}`).join(", ")})`);
    return;
  }
  let vk = VK[t.toUpperCase()];
  if (!vk) {
    const fkey = /^\{F([1-9]|1[0-2])\}$/i.exec(t);
    if (fkey) vk = 0x6f + Number(fkey[1]);
  }
  if (!vk) vk = vkForChar(t);
  if (!vk) return;
  await runPs(`${WIN_INPUT}
Tap(0x${vk.toString(16)})`);
}

/** Type text via clipboard + keybd_event Ctrl+V (Cyrillic-safe, atomic:
 *  Set-Clipboard + paste in one PS process — no 250ms sleep that lets
 *  GameInputSvc re-grab the foreground between clipboard set and paste). */
export async function typeText(text: string): Promise<void> {
  await runPs(`${WIN_INPUT}
Set-Clipboard -Value '${psQuote(text)}'
Chord @(0x11, 0x56)`);
}

/** Bring an existing window to the foreground by title or process name
 *  (EnumWindows + SwitchToThisWindow; click fallback). */
export async function focusWindow(title: string, app?: string): Promise<boolean> {
  return focusWindowByTitle(title, app);
}

/** Clear the focused text field (Ctrl+A + Delete). */
export async function clearField(): Promise<void> {
  await sendKeys("^a");
  await sendKeys("{DELETE}");
}

export async function copySelection(): Promise<void> {
  await sendKeys("^c");
}

export async function pasteClipboard(): Promise<void> {
  await sendKeys("^v");
}
