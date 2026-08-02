import { NextRequest, NextResponse } from "next/server";
import { runPs } from "@/lib/launcher";

/**
 * Reports the title of the currently focused window (LOCALHOST-only).
 * Used to verify a skill step landed where expected (e.g. Notepad focused
 * after launch) before typing into it.
 */

const SCRIPT = `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAct {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$h = [WinAct]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[WinAct]::GetWindowText($h, $sb, 512) | Out-Null
$sb.ToString()
`;

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const title = await runPs(SCRIPT, 10_000);
    return NextResponse.json({ title });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
