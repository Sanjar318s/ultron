/**
 * Server-side launcher helpers shared by the API routes. Everything here runs
 * on the host machine only (LOCALHOST-only endpoints) and talks to Windows via
 * PowerShell — never interpolates raw user input into a shell command without
 * validation.
 *
 *  - openViaShell: fire-and-forget Start-Process (apps, URLs, app protocols).
 *  - runPs: await a PowerShell script and capture its output/errors (for
 *    keyboard/clipboard/mouse automation where we need to know it succeeded).
 *  - launchApp: match a spoken name → allowlist → known site → installed apps → domain.
 */

import { spawn } from "node:child_process";
import { dedupeApps, findBestApp, isReasonableApp, scanInstalledApps } from "@/lib/installedApps";
import { findSiteInPhrase, resolveSite } from "@/lib/sites";

/** Safe charset for a URL (https/http only, no quotes/semicolons/whitespace). */
export const SAFE_URL = /^https?:\/\/[a-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/i;

/** Fixed allowlist of known aliases (стим → steam://, телеграм, …). */
export const APPS: Record<string, { command: string; args: string[] }> = {
  "браузер": { command: "cmd.exe", args: ["/c", "start", "", "https://www.google.com"] },
  "блокнот": { command: "notepad.exe", args: [] },
  "калькулятор": { command: "calc.exe", args: [] },
  "погода": { command: "cmd.exe", args: ["/c", "start", "", "ms-weather:"] },
  "приложение погоды": { command: "cmd.exe", args: ["/c", "start", "", "ms-weather:"] },
  "стим": { command: "cmd.exe", args: ["/c", "start", "", "steam://"] },
  "steam": { command: "cmd.exe", args: ["/c", "start", "", "steam://"] },
  "дискорд": { command: "cmd.exe", args: ["/c", "start", "", "discord://"] },
  "discord": { command: "cmd.exe", args: ["/c", "start", "", "discord://"] },
  "телеграм": { command: "cmd.exe", args: ["/c", "start", "", "telegram://"] },
  "телеграмм": { command: "cmd.exe", args: ["/c", "start", "", "telegram://"] },
  "спотифай": { command: "cmd.exe", args: ["/c", "start", "", "spotify:"] },
  "спотифей": { command: "cmd.exe", args: ["/c", "start", "", "spotify:"] },
  "spotify": { command: "cmd.exe", args: ["/c", "start", "", "spotify:"] },
};

/**
 * Launch a target via PowerShell Start-Process. Immune to the quoting bugs of
 * `cmd /c start` for Start Menu paths with spaces (Node escapes embedded
 * quotes as \" which cmd misparses). Handles .lnk, .exe, https:// and app
 * protocols (steam:// …). Fire-and-forget.
 */
export function openViaShell(target: string): void {
  const command = `Start-Process -FilePath '${target.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    { detached: true, stdio: "ignore", windowsHide: true },
  ).unref();
}

/** Await a PowerShell script (hidden window); resolves with trimmed stdout. */
export function runPs(command: string, timeoutMs = 25_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // Force UTF-8 on the PS side so Cyrillic output survives the pipe.
    const full =
      "[Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8;" +
      command;
    const encoded = Buffer.from(full, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      { windowsHide: true },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("powerShell timeout"));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `powerShell exit ${code}`));
    });
  });
}

export interface LaunchOutcome {
  /** The spoken name as received. */
  launched: string;
  /** The resolved target (app name or URL). */
  matched: string;
  url?: string;
}

/**
 * Launch a target and then bring its window to the foreground, so the next
 * skill step (typing / keys) lands in the right app. Uses ShowWindow +
 * SetForegroundWindow (not AppActivate, which returns true but is blocked by
 * Windows foreground lock for background processes).
 */
export async function launchAndFocus(target: string): Promise<void> {
  const command = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@
$p = Start-Process -FilePath '${target.replace(/'/g, "''")}' -PassThru -ErrorAction SilentlyContinue
if ($p) {
  for ($i = 0; $i -lt 20; $i++) {
    $p.Refresh()
    if ($p.MainWindowHandle -ne 0) { break }
    Start-Sleep -Milliseconds 300
  }
  if ($p.MainWindowHandle -ne 0) {
    [WinFocus]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
    Start-Sleep -Milliseconds 150
    [WinFocus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  }
}
`;
  try {
    await runPs(command, 15_000);
  } catch (err) {
    console.warn("[launcher] launchAndFocus failed:", err);
  }
}

/** Resolve an allowlist entry to a launchable target string, if it has one. */
function allowlistTarget(key: string): string | null {
  const entry = APPS[key];
  if (!entry) return null;
  if (entry.command === "cmd.exe" && entry.args.length >= 4) return entry.args[3];
  return entry.command;
}

/**
 * Match an allowlist key only as a standalone token (Cyrillic-aware), so a
 * longer phrase like «ютуб через браузер на пк» doesn't hijack the «браузер»
 * entry via substring matching.
 */
function allowlistTokenMatch(name: string): [string, { command: string; args: string[] }] | null {
  const hit = Object.entries(APPS).find(([key]) => {
    if (!key) return false;
    const re = new RegExp(`(?:^|[^a-zа-яё0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-zа-яё0-9])`, "i");
    return re.test(name);
  });
  return hit ?? null;
}

/**
 * Match a spoken app/domain name and launch it: explicit URL → allowlist →
 * known site inside the phrase → fuzzy match against installed apps → spoken
 * domain in the browser. Returns null when nothing matches.
 */
export async function launchApp(
  spoken: string,
  explicitUrl?: string,
  opts?: { focus?: boolean },
): Promise<LaunchOutcome | null> {
  const focus = opts?.focus === true;

  if (explicitUrl) {
    if (!SAFE_URL.test(explicitUrl) || explicitUrl.length > 512) return null;
    openViaShell(explicitUrl);
    return { launched: spoken, matched: spoken, url: explicitUrl };
  }

  const name = spoken.trim().toLowerCase();

  // Exact allowlist first (стим → steam://, телеграм → desktop app, …).
  if (APPS[name]) {
    if (focus) {
      const target = allowlistTarget(name);
      if (target) {
        await launchAndFocus(target);
        return { launched: name, matched: name };
      }
    }
    spawn(APPS[name].command, APPS[name].args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return { launched: name, matched: name };
  }

  // Known site inside the phrase («ютуб через браузер на пк» → YouTube) —
  // BEFORE the allowlist token fallback so «браузер» can't steal the intent.
  const siteUrl = resolveSite(name) ?? findSiteInPhrase(name);
  if (siteUrl) {
    openViaShell(siteUrl);
    return { launched: name, matched: name, url: siteUrl };
  }

  const allowHit = allowlistTokenMatch(name);
  const allowEntry = allowHit?.[1] ?? null;
  const allowKey = allowHit?.[0] ?? null;
  if (allowEntry && allowKey) {
    if (focus) {
      const target = allowlistTarget(allowKey);
      if (target) {
        await launchAndFocus(target);
        return { launched: name, matched: name };
      }
    }
    spawn(allowEntry.command, allowEntry.args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return { launched: name, matched: name };
  }

  const installed = findBestApp(
    name,
    dedupeApps((await scanInstalledApps()).filter((a) => isReasonableApp(a.name))),
  );
  if (installed) {
    if (focus) await launchAndFocus(installed.path);
    else openViaShell(installed.path);
    return { launched: name, matched: installed.name };
  }

  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) {
    openViaShell(`https://${name}`);
    return { launched: name, matched: name };
  }

  return null;
}
