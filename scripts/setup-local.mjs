/**
 * ULTRON local-аппаратное окружение — автоматическая установка локальных
 * генераторов, чтобы «мозг» не зависел от облачных лимитов:
 *
 *   1. Ollama + qwen3:8b   — локальный LLM (неограниченные ответы текстом)
 *   2. ComfyUI portable    — локальная генерация изображений
 *   3. RealVisXL V5.0 fp16 — диффузионный чекпоинт (качественные фотореалистичные кадры)
 *   4. 4x-UltraSharp        — апскейл 2× (итог 2048×2048 из 1024×1024)
 *
 * Запуск:  node scripts/setup-local.mjs
 * Всё качается в C:\ComfyUI_dl, распаковывается в C:\ComfyUI.
 * Модель Ollama:  ollama pull qwen3:8b   (или задайте OLLAMA_MODEL в .env)
 */

import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DL_DIR = "C:\\ComfyUI_dl";
const COMFY_DIR = "C:\\ComfyUI";
const COMFY_URL = "https://github.com/Comfy-Org/ComfyUI/releases/download/v0.29.2/ComfyUI_windows_portable_nvidia.7z";
const COMFY_7Z = path.join(DL_DIR, "ComfyUI_portable.7z");
// RealVisXL V5.0 fp16 — 6.46GiB, качается частями по 16MB (xet-bridge).
const REALVIS_URL =
  "https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0_fp16.safetensors?download=true";
const REALVIS_FILE = path.join(DL_DIR, "RealVisXL_V5.0_fp16.safetensors");
const CHECKPOINTS = path.join(COMFY_DIR, "ComfyUI", "models", "checkpoints", "RealVisXL_V5.0_fp16.safetensors");
// 4x-UltraSharp — апскейлер для upscale_models.
const UPS_URL = "https://huggingface.co/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth";
const UPS_FILE = path.join(DL_DIR, "4x-UltraSharp.pth");
const UPS_DEST = path.join(COMFY_DIR, "ComfyUI", "models", "upscale_models", "4x-UltraSharp.pth");

function run(cmd, args, opts = {}) {
  console.log(`\n> ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: true, ...opts });
  if (res.status !== 0) throw new Error(`${cmd} exited with ${res.status}`);
}

function findAria2() {
  try {
    const res = execSync("where aria2c", { shell: true }).toString().trim();
    if (res) return res.split("\n")[0];
  } catch {}
  const fallback =
    "C:\\Users\\raybr.ADMIN\\AppData\\Local\\Microsoft\\WinGet\\Packages\\aria2.aria2_Microsoft.Winget.Source_8wekyb3d8bbwe\\aria2-1.37.0-win-64bit-build1\\aria2c.exe";
  return existsSync(fallback) ? fallback : "aria2c";
}

function downloadGitHub(url, dest) {
  // GitHub release — aria2 c многочисленными соединениями (работает стабильно)
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  run("cmd", ["/c", "mkdir", dir]);
  const res = spawnSync(findAria2(), ["-x", "8", "-s", "8", "-k", "4M", "-c",
    "--file-allocation=none", "--console-log-level=error", "--summary-interval=0",
    "-o", base, "-d", dir, url], { stdio: "inherit", timeout: 3 * 60 * 60 * 1000 });
  if (res.status !== 0) throw new Error("aria2 не завершился: " + res.status);
}

function downloadHuggingFace(url, dest, parts = 434) {
  // HuggingFace xet-bridge подписывает URL на конкретный диапазон — большой
  // диапазон (или мультидиапазон) виснет/отдаёт 403. Решение: мелкие куски
  // (16MB) параллельными соединениями, каждый со своим подписанным URL.
  run("cmd", ["/c", "mkdir", path.dirname(dest)]);
  const script = path.join(__dirname, "download-parallel.mjs");
  run("node", [script, url, dest, String(parts)], { timeout: 6 * 60 * 60 * 1000 });
}

function installOllama() {
  if (execSync("where ollama", { shell: true }).toString().trim()) {
    console.log("[skip] ollama уже установлен");
  } else {
    run("winget", ["install", "--id", "Ollama.Ollama", "-e", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"]);
  }
  console.log("\n> ollama pull qwen3:8b   (5.2 ГБ — может занять время)");
  run("ollama", ["pull", "qwen3:8b"], { timeout: 3 * 60 * 60 * 1000 });
  // Vision for the study engine (image/PDF OCR). qwen2.5vl:7b is the local
  // fallback behind Gemini; a 0.8–1.4 ГБ GGUF on the CPU — may take a while.
  console.log("\n> ollama pull qwen2.5vl:7b   (локальная vision-модель для изучения картинок/PDF)");
  run("ollama", ["pull", "qwen2.5vl:7b"], { timeout: 3 * 60 * 60 * 1000 });
}

function extractComfy() {
  if (existsSync(path.join(COMFY_DIR, "ComfyUI", "main.py"))) {
    console.log("[skip] ComfyUI уже распакован");
    return;
  }
  console.log("\n> Распаковка ComfyUI (7-Zip, архив в формате BCJ2 — py7zr не тянет)…");
  const sevenZip = installSevenZip();
  run(sevenZip, ["x", "-y", "-o" + COMFY_DIR, COMFY_7Z]);
  // portable-архив кладёт всё в ComfyUI_windows_portable/ — поднимаем на уровень выше
  const nested = path.join(COMFY_DIR, "ComfyUI_windows_portable");
  if (existsSync(nested)) {
    console.log("> Перемещаю содержимое ComfyUI_windows_portable → " + COMFY_DIR);
    run("cmd", ["/c", "move", path.join(nested, "*"), COMFY_DIR]);
    run("cmd", ["/c", "rmdir", nested]);
  }
}

function installSevenZip() {
  const exe = "C:\\7Zip\\7z.exe";
  if (existsSync(exe)) return exe;
  console.log("> Установка 7-Zip (тихо, в C:\\7Zip, без прав админа)…");
  run("curl", ["-sL", "-o", "C:\\ComfyUI_dl\\7zsetup.exe",
    "https://github.com/ip7z/7zip/releases/download/24.09/7z2409-x64.exe"], { timeout: 10 * 60 * 1000 });
  run("cmd", ["/c", "C:\\ComfyUI_dl\\7zsetup.exe /S /D=C:\\7Zip"]);
  if (!existsSync(exe)) throw new Error("7-Zip не установился в C:\\7Zip");
  return exe;
}

function placeCheckpoint() {
  if (existsSync(CHECKPOINTS)) {
    console.log("[skip] чекпоинт RealVisXL уже на месте");
  } else {
    console.log("\n> Копирую чекпоинт RealVisXL в models/checkpoints…");
    run("cmd", ["/c", "mkdir", CHECKPOINTS.replace(/\\[^\\]+$/, "")]);
    run("cmd", ["/c", "copy", REALVIS_FILE, CHECKPOINTS]);
  }
  if (existsSync(UPS_DEST)) {
    console.log("[skip] апскейлер 4x-UltraSharp уже на месте");
  } else {
    console.log("\n> Копирую апскейлер 4x-UltraSharp в models/upscale_models…");
    run("cmd", ["/c", "mkdir", UPS_DEST.replace(/\\[^\\]+$/, "")]);
    run("cmd", ["/c", "copy", UPS_FILE, UPS_DEST]);
  }
}

function main() {
  if (!/^win/i.test(process.platform)) {
    console.error("Скрипт рассчитан на Windows (пути C:\\ComfyUI, py7zr).");
    process.exit(1);
  }
  installOllama();
  run("cmd", ["/c", "mkdir", DL_DIR]);
  downloadGitHub(COMFY_URL, COMFY_7Z);
  downloadHuggingFace(REALVIS_URL, REALVIS_FILE, 434);
  downloadHuggingFace(UPS_URL, UPS_FILE, 5);
  extractComfy();
  placeCheckpoint();

  console.log("\n=== Готово ===");
  console.log("1. Запустите ComfyUI:  C:\\ComfyUI\\run_nvidia_gpu.bat");
  console.log("2. Проверьте API:       curl http://127.0.0.1:8188/system_stats");
  console.log("3. Перезапустите сервер: npm run build && npm run start");
  console.log("   Каскад: Gemini → локальный ComfyUI (RealVisXL 28 шагов + 2× апскейл) → Pollinations.");
}

main();
