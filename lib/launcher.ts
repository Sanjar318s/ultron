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
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dedupeApps, findBestApp, isReasonableApp, matchAppScore, normForMatch, scanInstalledApps } from "@/lib/installedApps";
import { steamAliasName } from "@/lib/commandSplit";
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
  // Windows 11 system settings (ms-settings: URI schemes)
  "настройки": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:"] },
  "параметры": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:"] },
  "приложения по умолчанию": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:defaultapps"] },
  "приложения": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:appsfeatures"] },
  "диспетчер устройств": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:device-manager"] },
  "сеть": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:network"] },
  "интернет": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:network-status"] },
  "wifi": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:network-wifi"] },
  "звук": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:sound"] },
  "дисплей": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:display"] },
  "монитор": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:display"] },
  "экран": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:display"] },
  "принтеры": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:printers"] },
  "конфиденциальность": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:privacy"] },
  "обновление": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:windowsupdate"] },
  "обновления": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:windowsupdate"] },
  "учётные записи": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:accounts"] },
  "персонализация": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:personalization"] },
  "bluetooth": { command: "cmd.exe", args: ["/c", "start", "", "ms-settings:bluetooth"] },
  "панель управления": { command: "cmd.exe", args: ["/c", "start", "", "shell:ControlPanelFolder"] },
  "проводник": { command: "explorer.exe", args: [] },
  "explorer": { command: "explorer.exe", args: [] },
  "диспетчер задач": { command: "taskmgr.exe", args: [] },
};

/** Windows 11 ms-settings: URI scheme regex fallback for rare system setting phrases. */
const SETTINGS_REGEX = /^(?:настройк|параметр).*(?:систем|сеть|звук|дисплей|монитор|экран|принтер|обновлен|конфиден|bluetooth|приложен|персонал|учёт|запомина|default)/i;
const SETTINGS_URI_MAP: [RegExp, string][] = [
  [/^(?:приложени|программ).*(?:по умолчанию|default)/i, "ms-settings:defaultapps"],
  [/^(?:приложени|программ)/i, "ms-settings:appsfeatures"],
  [/^(?:диспетчер|управлен).*(?:устройств|device)/i, "ms-settings:device-manager"],
  [/^(?:сеть|интернет|wi-?fi|wifi)/i, "ms-settings:network"],
  [/^(?:звук|аудио|колонк|динамик|микрофон)/i, "ms-settings:sound"],
  [/^(?:дисплей|монитор|экран|яркост)/i, "ms-settings:display"],
  [/^(?:принтер|печать)/i, "ms-settings:printers"],
  [/^(?:конфиденц|приватн|privacy)/i, "ms-settings:privacy"],
  [/^(?:обновлен|update)/i, "ms-settings:windowsupdate"],
  [/^(?:учётн|аккаунт|account)/i, "ms-settings:accounts"],
  [/^(?:персонализа|тем|цвет|wallpaper)/i, "ms-settings:personalization"],
  [/^(?:bluetooth|блютуз)/i, "ms-settings:bluetooth"],
  [/^(?:панель управл|control panel)/i, "shell:ControlPanelFolder"],
];

/** Try to resolve a spoken name as a system settings URI. Returns the URI or null. */
export function resolveSettingsUri(name: string): string | null {
  for (const [re, uri] of SETTINGS_URI_MAP) {
    if (re.test(name)) return uri;
  }
  if (SETTINGS_REGEX.test(name)) return "ms-settings:";
  return null;
}

/**
 * Launch a target via PowerShell Start-Process. Immune to the quoting bugs of
 * `cmd /c start` for Start Menu paths with spaces (Node escapes embedded
 * quotes as \" which cmd misparses). Handles .lnk, .exe, https:// and app
 * protocols (steam:// …). Fire-and-forget.
 *
 * http(s):// targets are routed through `openUrlInternal` first: if the system
 * https URL association is broken (common after a browser reinstall — the
 * ProgId in HKCU UserChoice no longer exists), we fall back to launching a
 * known installed browser directly with the URL as an argument.
 */
export function openViaShell(target: string): void {
  if (SAFE_URL.test(target)) {
    void openUrlInternal(target);
    return;
  }
  const command = `Start-Process -FilePath '${target.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    { detached: true, stdio: "ignore", windowsHide: true },
  ).unref();
}

// --- https URL opening with broken-association fallback ---------------------

let assocCache: { ok: boolean; ts: number } | null = null;

/**
 * Whether the system https URL association is resolvable — i.e. the ProgId
 * stored in HKCU UserChoice actually has a shell\open\command registration.
 */
async function urlAssociationOk(): Promise<boolean> {
  if (assocCache && Date.now() - assocCache.ts < 60_000) return assocCache.ok;
  const script = [
    "$ProgressPreference='SilentlyContinue';",
    "$c = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice' -ErrorAction SilentlyContinue;",
    "if (-not $c -or -not $c.ProgId) { Write-Output '0'; exit };",
    "$k = 'Registry::HKEY_CLASSES_ROOT\\' + $c.ProgId + '\\shell\\open\\command';",
    "if (Test-Path $k) { Write-Output '1' } else { Write-Output '0' }",
  ].join(" ");
  const out = await runPs(script, 15_000).catch(() => "0");
  const ok = out.includes("1");
  assocCache = { ok, ts: Date.now() };
  return ok;
}

/** Well-known browser install paths (most common first). */
const BROWSER_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
  "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
  "C:\\Program Files\\Yandex\\YandexBrowser\\Application\\browser.exe",
  "C:\\Program Files (x86)\\Yandex\\YandexBrowser\\Application\\browser.exe",
  "C:\\Users\\%USERNAME%\\AppData\\Local\\Yandex\\YandexBrowser\\Application\\browser.exe",
  "C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Opera\\opera.exe",
];

let browserCache: string | null | undefined;

/** First existing browser executable (cached per process lifetime). */
export function findBrowser(): string | null {
  if (browserCache !== undefined) return browserCache;
  const user = process.env.USERNAME ?? "";
  for (const raw of BROWSER_PATHS) {
    const p = raw.replace("%USERNAME%", user);
    try {
      if (existsSync(p)) {
        browserCache = p;
        return p;
      }
    } catch { /* path too long / invalid */ }
  }
  browserCache = null;
  return null;
}

/** Open an https URL: prefer the system association, else a real browser. */
async function openUrlInternal(url: string): Promise<void> {
  if (!SAFE_URL.test(url) || url.length > 512) return;
  const assocOk = await urlAssociationOk();
  if (assocOk) {
    const command = `Start-Process -FilePath '${url.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      { detached: true, stdio: "ignore", windowsHide: true },
    ).unref();
    return;
  }
  const browser = findBrowser();
  if (browser) {
    console.warn(`[launcher] https association broken — opening via ${browser}`);
    spawn(browser, [url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  // No browser found either — last resort: shell it anyway.
  const command = `Start-Process -FilePath '${url.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`;
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    { detached: true, stdio: "ignore", windowsHide: true },
  ).unref();
}

/** Strip PowerShell's CLIXML progress serialization noise («Подготовка модулей…»). */
function stripClixml(text: string): string {
  return text.replace(/#< CLIXML[\s\S]*?<\/Objs>\s*(?:#<\/CLIXML>)?/g, "").trim();
}

/** Await a PowerShell script (hidden window); resolves with trimmed stdout. */
export function runPs(command: string, timeoutMs = 25_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // Force UTF-8 on the PS side so Cyrillic output survives the pipe, and
    // disable the progress stream — module-load progress is serialized to
    // CLIXML on stderr on first run and pollutes the error channel.
    const full =
      "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Console]::InputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8;" +
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
      const cleanErr = stripClixml(err);
      if (code === 0) resolve(out.trim());
      else reject(new Error(cleanErr || `powerShell exit ${code}`));
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

/** Shared PS: find a window by process name and/or title substring and force
 *  it to the foreground. Prints FOCUS_OK / FOCUS_FAIL on stdout.
 *
 *  SwitchToThisWindow (Alt-Tab semantics) bypasses the Windows foreground lock
 *  that blocks AppActivate/SetForegroundWindow from background processes — on
 *  this machine GameInputSvc keeps a fullscreen helper window foreground, so
 *  even synthetic clicks don't activate anything; SwitchToThisWindow is the
 *  only thing that moves focus. Falls back to a real click at the window
 *  center when the switch doesn't stick. */
function focusScript(procName: string, title: string): string {
  return `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, int[] rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
$script:procName = '${procName}'
$script:title = '${title}'
function Find-TargetWindow {
  $script:found = [IntPtr]::Zero
  $cb = [WinEnum+EnumProc]{
    param($h, $l)
    if (-not [WinEnum]::IsWindowVisible($h)) { return $true }
    $s = New-Object System.Text.StringBuilder 256
    [WinEnum]::GetWindowText($h, $s, 256) | Out-Null
    $t = $s.ToString()
    $m2 = $script:title -ne '' -and $t.IndexOf($script:title, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($m2) { $script:found = $h; return $false }
    if ($script:procName -ne '') {
      $wp = 0
      [WinEnum]::GetWindowThreadProcessId($h, [ref]$wp) | Out-Null
      if ($wp -ne 0) {
        $pr = Get-Process -Id $wp -ErrorAction SilentlyContinue
        if ($pr -and $pr.ProcessName -ieq $script:procName) { $script:found = $h; return $false }
      }
    }
    return $true
  }
  [WinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
}
$script:verdict = 'FOCUS_FAIL'
for ($try = 0; $try -lt 6; $try++) {
  Find-TargetWindow
  if ($script:found -eq [IntPtr]::Zero) { break }
  [WinEnum]::SwitchToThisWindow($script:found, $true) | Out-Null
  Start-Sleep -Milliseconds 200
  if ([WinEnum]::GetForegroundWindow() -eq $script:found) { $script:verdict = 'FOCUS_OK'; break }
}
if ($script:verdict -ne 'FOCUS_OK' -and $script:found -ne [IntPtr]::Zero) {
  $r = New-Object int[] 4
  [WinEnum]::GetWindowRect($script:found, $r) | Out-Null
  if ($r[2] -gt $r[0] -and $r[3] -gt $r[1]) {
    $cx = [int](($r[0] + $r[2]) / 2); $cy = [int](($r[1] + $r[3]) / 2)
    [WinEnum]::SetCursorPos($cx, $cy) | Out-Null
    Start-Sleep -Milliseconds 120
    [WinEnum]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [WinEnum]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 250
    [WinEnum]::SwitchToThisWindow($script:found, $true) | Out-Null
    Start-Sleep -Milliseconds 250
    if ([WinEnum]::GetForegroundWindow() -eq $script:found) { $script:verdict = 'FOCUS_OK' }
  }
}
Write-Output $script:verdict
`;
}

/** Bring a window to the foreground by process name and/or title substring.
 *  True when the foreground window matched the target after forcing. */
export async function focusWindowByTitle(title: string, app?: string): Promise<boolean> {
  const procName = (app ?? "").replace(/\.exe$/i, "").toLowerCase();
  const out = await runPs(
    focusScript(procName.replace(/'/g, "''"), (title ?? "").replace(/'/g, "''")),
    20_000,
  );
  return out.includes("FOCUS_OK");
}

/**
 * Launch a target and then bring its window to the foreground, so the next
 * skill step (typing / keys) lands in the right app.
 *
 * Two stages: (1) focus an ALREADY-running window by process name or title —
 * found via EnumWindows, activated with SwitchToThisWindow; (2) if nothing
 * matched, Start-Process a fresh instance and poll for its window to appear.
 * Returns whether the foreground ended up on the target.
 */
export async function launchAndFocus(target: string, titleHint?: string): Promise<boolean> {
  const procName =
    target
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.exe$/i, "")
      .replace(/:.*$/, "") ?? "";
  if (await focusWindowByTitle(titleHint ?? "", procName)) return true;
  await runPs(`Start-Process -FilePath '${target.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`, 15_000).catch(
    () => {},
  );
  for (let i = 0; i < 12; i++) {
    if (await focusWindowByTitle(titleHint ?? "", procName)) return true;
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
}

/**
 * Last-resort app launch through the Windows Start-menu search: Win key →
 * type name (clipboard so Cyrillic works) → Enter. Used when the name is a
 * plausible app name but not found in the installed-app scan.
 */
export async function winSearchLaunch(name: string): Promise<boolean> {
  const safe = name.replace(/'/g, "''");
  const command = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
function TapK([byte]$vk) {
  [WinKeys]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  [WinKeys]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
}
function ChordK([byte[]]$keys) {
  foreach ($k in $keys) { [WinKeys]::keybd_event($k, 0, 0, [UIntPtr]::Zero) }
  for ($i = $keys.Length - 1; $i -ge 0; $i--) { [WinKeys]::keybd_event($keys[$i], 0, 2, [UIntPtr]::Zero) }
}
Set-Clipboard -Value '${safe}'
TapK(0x5B)
Start-Sleep -Milliseconds 500
ChordK @(0x11, 0x56)
Start-Sleep -Milliseconds 400
TapK(0x0D)
`;
  try {
    await runPs(command, 10_000);
    return true;
  } catch (err) {
    console.warn("[launcher] winSearchLaunch failed:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Steam games (steam://rungameid/<appid>)
// ---------------------------------------------------------------------------

const STEAM_ROOTS = [
  "C:\\Program Files (x86)\\Steam\\steamapps",
  "C:\\Program Files\\Steam\\steamapps",
  "C:\\Steam\\steamapps",
];

let steamCache: { games: SteamGame[]; at: number } | null = null;
const STEAM_CACHE_TTL = 60_000;

export interface SteamGame {
  appid: string;
  name: string;
}

/** Parse "appid"/"name" out of an appmanifest_*.acf file. */
function parseAcfGame(raw: string): SteamGame | null {
  const appid = raw.match(/"appid"\s+"(\d+)"/);
  const name = raw.match(/"name"\s+"((?:[^"\\]|\\.)*)"/);
  if (!appid || !name) return null;
  return { appid: appid[1], name: name[1].replace(/\\(.)/g, "$1") };
}

/** List installed Steam games from appmanifest_*.acf (cached 60s). */
export async function listSteamGames(): Promise<SteamGame[]> {
  if (steamCache && Date.now() - steamCache.at < STEAM_CACHE_TTL) return steamCache.games;
  const games: SteamGame[] = [];
  const dirs = new Set<string>(STEAM_ROOTS);
  for (const root of STEAM_ROOTS) {
    // libraryfolders.vdf can point to extra library roots with more steamapps/.
    const vdf = await readFile(path.join(root, "libraryfolders.vdf"), "utf8").catch(() => "");
    for (const m of vdf.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/g)) {
      dirs.add(path.join(m[1].replace(/\\(.)/g, "$1"), "steamapps"));
    }
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^appmanifest_\d+\.acf$/i.test(f)) continue;
      const raw = await readFile(path.join(dir, f), "utf8").catch(() => "");
      const game = parseAcfGame(raw);
      if (game) games.push(game);
    }
  }
  steamCache = { games, at: Date.now() };
  return games;
}

/** Best Steam-game match for a spoken name (same scoring as installed apps). */
export async function matchSteamGame(query: string): Promise<SteamGame | null> {
  const q = normForMatch(query);
  if (!q) return null;
  const games = await listSteamGames();
  let best: SteamGame | null = null;
  let bestScore = 60;
  // Spoken aliases («кс 2», «контра») → canonical library title, so the fuzzy
  // match below has something real to compare against instead of falling back
  // to the Windows Start-menu search (which opens the Xbox app for game names).
  const aliasTitle = steamAliasName(query);
  if (aliasTitle) {
    const aliasNorm = normForMatch(aliasTitle);
    for (const g of games) {
      const score = matchAppScore(aliasNorm, g.name);
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }
    if (best) return best;
  }
  for (const g of games) {
    const score = matchAppScore(q, g.name);
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best;
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

  // System settings URI fallback (ms-settings: for common phrases).
  const settingsUri = resolveSettingsUri(name);
  if (settingsUri) {
    openViaShell(settingsUri);
    return { launched: name, matched: name };
  }

  // Installed Steam game («запусти кс 2» → steam://rungameid/730). Checked
  // BEFORE the installed-app scan: game names must never be shadowed by a
  // Windows app (e.g. the Xbox Game Bar surfacing for «кс 2»).
  const game = await matchSteamGame(name);
  if (game) {
    openViaShell(`steam://rungameid/${game.appid}`);
    return { launched: name, matched: game.name };
  }

  const installed = findBestApp(
    name,
    dedupeApps((await scanInstalledApps()).filter((a) => isReasonableApp(a.name))),
  );
  if (installed) {
    if (focus) await launchAndFocus(installed.path, installed.name);
    else openViaShell(installed.path);
    return { launched: name, matched: installed.name };
  }

  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) {
    openViaShell(`https://${name}`);
    return { launched: name, matched: name };
  }

  // Last resort: Windows Start-menu search by spoken name (clipboard-safe).
  if (/^[\p{L}\p{N} _-]{2,40}$/u.test(name)) {
    const ok = await winSearchLaunch(name);
    if (ok) return { launched: name, matched: name };
  }

  return null;
}
