/**
 * Server-side text overlay for generated images. Draws a caption banner
 * (bottom strip) using Pillow under ComfyUI's bundled Python — reliable
 * Cyrillic rendering without adding npm native dependencies.
 *
 * The overlay is best-effort: if Python/Pillow are unavailable it returns the
 * original image untouched so the generation pipeline never breaks.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const PYTHON = process.env.COMFY_PYTHON || "C:\\ComfyUI\\python_embeded\\python.exe";
const SCRIPT = path.join(process.cwd(), "scripts", "text_overlay.py");

export interface OverlayResult {
  b64: string;
  mime: string;
}

export async function overlayText(b64: string, text: string): Promise<OverlayResult> {
  const trimmed = text.trim();
  if (!trimmed) return { b64, mime: "image/png" };
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "overlay-"));
  const inPath = path.join(tmp, "in.png");
  const outPath = path.join(tmp, "out.png");
  try {
    await fs.writeFile(inPath, Buffer.from(b64, "base64"));
    await new Promise<void>((resolve, reject) => {
      const p = spawn(PYTHON, [SCRIPT, inPath, outPath, trimmed], { windowsHide: true });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(0, 300) || `overlay exit ${code}`))));
    });
    const outBuf = await fs.readFile(outPath);
    return { b64: outBuf.toString("base64"), mime: "image/png" };
  } catch {
    return { b64, mime: "image/png" };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
