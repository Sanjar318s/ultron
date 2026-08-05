import os from "node:os";
import { runPs } from "@/lib/launcher";

/**
 * System context collector (LOCALHOST-only, server-side).
 *
 * Gathers runtime system info (date/time, uptime, active window, top processes,
 * disk space) and caches it for ~10 seconds to avoid hammering PowerShell on
 * every request. The formatted block is injected into the LLM system prompt so
 * the assistant can reference real system state.
 */

interface SystemContext {
  formatted: string;
  at: number;
}

let cache: SystemContext | null = null;
const CACHE_TTL_MS = 10_000;

const DAYS_RU = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function getActiveWindow(): Promise<string> {
  const script = `
    $sig = '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'
    Add-Type -MemberDefinition $sig -Name Win32 -Namespace PInvoke
    $hwnd = [PInvoke.Win32]::GetForegroundWindow()
    $proc = Get-Process | Where-Object { $_.MainWindowHandle -eq $hwnd } | Select-Object -First 1
    if ($proc) { Write-Output $proc.ProcessName } else { Write-Output 'unknown' }
  `;
  try {
    const out = await runPs(script, 5_000);
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function getTopProcesses(): Promise<string> {
  const script = `
    Get-Process | Where-Object { $_.WorkingSet64 -gt 0 } |
    Sort-Object WorkingSet64 -Descending |
    Select-Object -First 5 Name, @{N='MB';E={[math]::Round($_.WorkingSet64/1MB)}} |
    Format-Table -AutoSize -HideTableHeaders
  `;
  try {
    const out = await runPs(script, 8_000);
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.join(", ");
  } catch {
    return "unknown";
  }
}

async function getDiskSpace(): Promise<string> {
  const script = `
    $d = Get-PSDrive C -ErrorAction SilentlyContinue
    if ($d) {
      $free = [math]::Round($d.Free/1GB, 1)
      $used = [math]::Round($d.Used/1GB, 1)
      Write-Output "$($free)GB free / $($used)GB used"
    } else { Write-Output "unknown" }
  `;
  try {
    const out = await runPs(script, 5_000);
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Collect system context with ~10s caching. Returns a formatted string
 * ready to inject into the LLM system prompt.
 */
export async function getSystemContext(): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.formatted;

  const now = new Date();
  const dayName = DAYS_RU[now.getDay()];
  const dateStr = now.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  const timeStr = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const uptime = formatUptime(os.uptime());

  // Collect in parallel
  const [activeWindow, topProcesses, diskSpace] = await Promise.all([
    getActiveWindow(),
    getTopProcesses(),
    getDiskSpace(),
  ]);

  const formatted = [
    `[СИСТЕМНЫЙ КОНТЕКСТ]`,
    `Дата: ${dayName}, ${dateStr}, ${timeStr}`,
    `Аптайм: ${uptime}`,
    `Активное окно: ${activeWindow}`,
    `Топ процессов (по памяти): ${topProcesses}`,
    `Диск C:: ${diskSpace}`,
  ].join("\n");

  cache = { formatted, at: Date.now() };
  return formatted;
}
