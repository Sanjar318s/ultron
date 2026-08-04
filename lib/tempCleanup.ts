import { spawn } from "node:child_process";

/**
 * Resilient temp-file cleanup.
 *
 * Deletion is per-item inside PowerShell try/catch: a locked or access-denied
 * file is counted as "failed" and skipped instead of aborting the whole run.
 * The script ALWAYS exits 0 and prints a single JSON line — partial success is
 * success, never a hard error. Used by /api/clean-temp and the self-test.
 */

export interface CleanupEntry {
  path: string;
  freedMB: number;
  removed: number;
  failed: number;
}

export interface CleanupResult {
  ok: boolean;
  freedMB: number;
  removedCount: number;
  failedCount: number;
  paths: CleanupEntry[];
}

const psQuote = (p: string) => p.replace(/'/g, "''");

export function buildCleanupScript(paths: string[]): string {
  const quoted = paths.map((p) => `'${psQuote(p)}'`).join(", ");
  return [
    "$ProgressPreference='SilentlyContinue';",
    `$paths = @(${quoted});`,
    "$out = @();",
    "foreach ($p in $paths) {",
    "  if (-not (Test-Path -LiteralPath $p)) { continue };",
    "  $before = (Get-ChildItem -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum;",
    "  $removed = 0; $failed = 0;",
    "  Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | ForEach-Object {",
    "    try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop; $removed++ }",
    "    catch { $failed++ }",
    "  };",
    "  $after = (Get-ChildItem -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum;",
    "  $out += [pscustomobject]@{ path = $p; freedMB = [math]::Round(($before - $after)/1MB, 1); removed = $removed; failed = $failed }",
    "};",
    "$result = [pscustomobject]@{ ok = $true; freedMB = [math]::Round((($out | Measure-Object freedMB -Sum).Sum), 1); removedCount = (($out | Measure-Object removed -Sum).Sum); failedCount = (($out | Measure-Object failed -Sum).Sum); paths = $out };",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
    "Write-Output ($result | ConvertTo-Json -Depth 4 -Compress);",
    "exit 0",
  ].join(" ");
}

/** Run a cleanup over the given paths; always resolves ok (never throws). */
export async function runCleanup(paths: string[]): Promise<CleanupResult> {
  const script = buildCleanupScript(paths);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      { windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => {
      child.kill();
      resolve(fallback(out, true));
    }, 180_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(fallback(`${out}\n[error] ${e.message}`, true));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const jsonMatch = out.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as CleanupEntry[];
          resolve({
            ok: true,
            freedMB: round1(parsed.reduce((a, p) => a + (p.freedMB ?? 0), 0)),
            removedCount: parsed.reduce((a, p) => a + (p.removed ?? 0), 0),
            failedCount: parsed.reduce((a, p) => a + (p.failed ?? 0), 0),
            paths: parsed,
          });
          return;
        } catch {
          /* fall through to fallback */
        }
      }
      resolve(fallback(out, false));
    });
  });
}

function fallback(out: string, timedOut: boolean): CleanupResult {
  return {
    ok: !timedOut,
    freedMB: 0,
    removedCount: 0,
    failedCount: 0,
    paths: [],
    ...(timedOut ? {} : { note: out.slice(0, 300) }),
  } as CleanupResult;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
