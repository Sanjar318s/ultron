import { NextRequest, NextResponse } from "next/server";
import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPs } from "@/lib/launcher";

/**
 * Captures the primary screen (LOCALHOST-only). The image is downscaled to a
 * max width of 1600 and saved as a JPEG (quality 72) so the base64 payload
 * stays comfortably under the 2MB vision cap. Coordinates derived from the
 * image are RELATIVE 0..1, so the downscale doesn't shift them.
 */

const MAX_WIDTH = 1600;
const SHOT_FILE = () => path.join(os.tmpdir(), "ultron-shot.jpg");

const SCRIPT = (outFile: string) => `Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
$scale = 1.0
if ($b.Width -gt ${MAX_WIDTH}) { $scale = ${MAX_WIDTH}.0 / $b.Width }
$w2 = [int]($b.Width * $scale)
$h2 = [int]($b.Height * $scale)
$out = New-Object System.Drawing.Bitmap($w2, $h2)
$g2 = [System.Drawing.Graphics]::FromImage($out)
$g2.DrawImage($bmp, 0, 0, $w2, $h2)
$out.Save('${outFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $out.Dispose()
Write-Output "$($b.Width)x$($b.Height)"`;

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

export async function GET(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const file = SHOT_FILE();
  try {
    const screenDims = await runPs(SCRIPT(file), 15_000);
    const [sw, sh] = screenDims.split("x").map(Number);
    const scale = sw && sw > MAX_WIDTH ? MAX_WIDTH / sw : 1;
    const width = sw ? Math.round(sw * scale) : 0;
    const height = sh ? Math.round(sh * scale) : 0;
    const b64 = (await readFile(file)).toString("base64");
    return NextResponse.json({ b64, mime: "image/jpeg", width, height });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    unlink(file).catch(() => {});
  }
}
