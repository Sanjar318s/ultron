/**
 * Page vision — reads images, scanned PDFs and viewer pages AS TEXT.
 *
 * Used by the study engine (lib/studyJobs.ts) and the single-page learn-url
 * flow (app/api/assistant/route.ts) so notes actually contain figure, table
 * and diagram content — not just the surrounding HTML text.
 *
 * Pipeline: download the page → plain text via stripHtml / pdftotext → collect
 * <img> parts (≤ MAX_IMAGES, ≤ MAX_IMAGE_BYTES) or render scanned PDF pages →
 * OCR through Gemini (per-user key pool) → local Ollama VL model (qwen2.5vl).
 * Images that fail OCR are skipped gracefully — never crash the study step.
 */

import { promises as fsp } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveKey } from "@/lib/geminiKeys";

const execFileP = promisify(execFile);

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const GEMINI_VISION_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const VISION_LOCAL_MODEL = process.env.VISION_LOCAL_MODEL || "qwen2.5vl:7b";

/** Cap on how many images a single page contributes to the OCR batch. */
export const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_FETCH_TRIES = 24;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface ImagePart {
  mimeType: string;
  /** Base64 data URI body (no "data:...;base64," prefix). */
  data: string;
}

export interface PageContent {
  title: string;
  text: string;
  /** Raw HTML — needed by callers that keep link extraction (site crawl). */
  html?: string;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cyberleninka viewer pages are HTML wrappers — hit the real PDF instead. */
export function resolvePdfUrl(url: string): string {
  const m = url.match(/^(https?:\/\/cyberleninka\.ru\/article\/n\/[^/]+)\/viewer$/i);
  if (m) return `${m[1]}/pdf`;
  return url;
}

function isPdfUrl(url: string): boolean {
  return /\.pdf(?:$|[?#])/i.test(url);
}

/** Plain text from a PDF file via poppler's pdftotext (in C:\Tools + PATH). */
export async function extractPdfText(pdfPath: string): Promise<string> {
  try {
    const { stdout } = await execFileP("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], { timeout: 60_000 });
    return String(stdout ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Render PDF pages to PNGs via the pdf skill's convert_pdf_to_images.py
 * (pdf2image + poppler). Returns page image paths, capped at MAX_IMAGES.
 */
export async function renderPdfPages(pdfPath: string, maxPages = MAX_IMAGES): Promise<string[]> {
  const outDir = await fsp.mkdtemp(`${process.env.TEMP || "/tmp"}/ultron-pdf-`);
  try {
    await execFileP("python", [process.env.PYTHON_SCRIPT_PATH || "skills/pdf/scripts/convert_pdf_to_images.py", pdfPath, outDir], {
      timeout: 180_000,
      cwd: process.cwd(),
    });
    const files = await fsp.readdir(outDir);
    return files
      .filter((f) => /^page_\d+\.png$/i.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)?.[0] ?? "0", 10) - parseInt(b.match(/\d+/)?.[0] ?? "0", 10))
      .slice(0, maxPages)
      .map((f) => `${outDir}/${f}`);
  } catch {
    return [];
  }
}

async function fileToImagePart(p: string): Promise<ImagePart | null> {
  try {
    const buf = await fsp.readFile(p);
    if (buf.byteLength > MAX_IMAGE_BYTES) return null;
    return { mimeType: "image/png", data: buf.toString("base64") };
  } catch {
    return null;
  }
}

async function fetchBytes(url: string, timeoutMs: number): Promise<{ buf: Buffer; mime: string } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "follow",
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return null;
    const mime = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf, mime };
  } catch {
    return null;
  }
}

function sniffMime(mime: string, buf: Buffer): string {
  if (mime.includes("image/")) return mime.split(";")[0].trim();
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  return "image/jpeg";
}

/** Download an image URL into an OCR-ready part (sized/capped). */
export async function downloadImagePart(url: string): Promise<ImagePart | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  const fb = await fetchBytes(url, 30_000);
  if (!fb || fb.buf.byteLength === 0 || fb.buf.byteLength > MAX_IMAGE_BYTES) return null;
  return { mimeType: sniffMime(fb.mime, fb.buf), data: fb.buf.toString("base64") };
}

/**
 * Collect <img> parts from page HTML: absolute URLs, deduped, skipping
 * data-URIs, icons/trackers and oversized downloads. ≤ MAX_IMAGES parts.
 */
export async function collectImageParts(html: string, baseUrl: string): Promise<ImagePart[]> {
  const parts: ImagePart[] = [];
  const seen = new Set<string>();
  const hrefRe = /<img\b[^>]*src=["']([^"']+)["']/gi;
  let tries = 0;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    if (parts.length >= MAX_IMAGES) break;
    if (tries++ >= MAX_FETCH_TRIES) break;
    const raw = (m[1] ?? "").trim();
    if (!raw || /^(data:|blob:|javascript:|#)/i.test(raw)) continue;
    if (/(logo|icon|avatar|spacer|tracker|pixel|emoji|sprite|favicon)/i.test(raw)) continue;
    let abs: URL;
    try {
      abs = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (seen.has(abs.href)) continue;
    seen.add(abs.href);
    const fb = await fetchBytes(abs.href, 15_000);
    if (!fb || fb.buf.byteLength === 0 || fb.buf.byteLength > MAX_IMAGE_BYTES) continue;
    const mime = sniffMime(fb.mime, fb.buf);
    parts.push({ mimeType: mime, data: fb.buf.toString("base64") });
  }
  return parts;
}

const OCR_PROMPT =
  "Извлеки весь текст с изображения(й), включая таблицы, формулы и подписи к диаграммам. " +
  "Сохрани язык оригинала. Если это график/диаграмма/схема — опиши его содержание и приведённые данные. " +
  "Запиши результат точно и полно, ничего не выдумывая.";

async function ocrViaGemini(parts: ImagePart[], apiKey: string): Promise<string> {
  const res = await fetch(`${GEMINI_URL}/${GEMINI_VISION_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: OCR_PROMPT },
            ...parts.map((p) => ({ inline_data: { mime_type: p.mimeType, data: p.data } })),
          ],
        },
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) throw new Error(`gemini vision ${res.status}`);
  return (
    (data?.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined)?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim() ?? ""
  );
}

async function ocrViaOllama(parts: ImagePart[]): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VISION_LOCAL_MODEL,
      messages: [{ role: "user", content: OCR_PROMPT, images: parts.map((p) => p.data) }],
      stream: false,
      think: false,
      options: { temperature: 0.2, num_predict: 2048 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = (await res.json().catch(() => null)) as { message?: { content?: string } } | null;
  if (!res.ok) throw new Error(`ollama vision ${res.status}`);
  return (data?.message?.content ?? "").trim();
}

/**
 * OCR image parts. Chain: Gemini (per-user key pool) → local Ollama VL model.
 * Returns "" when nothing could be read — callers skip gracefully.
 */
export async function ocrImages(parts: ImagePart[], opts: { chatId: string; isOwner: boolean }): Promise<string> {
  if (parts.length === 0) return "";
  try {
    const rk = await resolveKey(opts.chatId, opts.isOwner);
    if (rk.key) return await ocrViaGemini(parts, rk.key);
  } catch (err) {
    console.warn("[vision] gemini OCR failed:", err);
  }
  try {
    return await ocrViaOllama(parts);
  } catch (err) {
    console.warn("[vision] ollama OCR failed:", err);
  }
  return "";
}

function joinSections(title: string, pageText: string, imageText: string): string {
  const parts: string[] = [];
  if (title) parts.push(`ЗАГОЛОВОК: ${title}`);
  const text = (pageText ?? "").trim();
  if (text) parts.push(text);
  const ocr = (imageText ?? "").trim();
  if (ocr) parts.push(`ТЕКСТ С ИЗОБРАЖЕНИЙ:\n${ocr}`);
  return parts.join("\n\n");
}

/**
 * Download and read a page (HTML or PDF) into text, OCR-ing its images /
 * scanned pages. Returns merged text + raw HTML for link discovery.
 */
export async function fetchPageContent(
  url: string,
  opts: { chatId: string; isOwner: boolean },
): Promise<PageContent> {
  const target = resolvePdfUrl(url);
  const fb = await fetchBytes(target, 30_000);
  if (!fb) throw new Error("HTTP-ошибка при загрузке страницы");

  if (isPdfUrl(target) || fb.mime.includes("application/pdf")) {
    const pdfPath = `${process.env.TEMP || "/tmp"}/ultron-study-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.pdf`;
    await fsp.writeFile(pdfPath, fb.buf);
    try {
      const pdfText = await extractPdfText(pdfPath);
      let imageText = "";
      // Thin text layer → scanned PDF → render pages and OCR them.
      if (pdfText.length < 200) {
        const pages = await renderPdfPages(pdfPath);
        const parts: ImagePart[] = [];
        for (const p of pages) {
          const part = await fileToImagePart(p);
          if (part) parts.push(part);
          if (parts.length >= MAX_IMAGES) break;
        }
        imageText = await ocrImages(parts, opts);
      }
      return { title: "", text: joinSections("", pdfText, imageText) };
    } finally {
      await fsp.rm(pdfPath, { force: true }).catch(() => {});
    }
  }

  const html = fb.buf.toString("utf-8");
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  const pageText = stripHtml(html);
  let imageText = "";
  try {
    const parts = await collectImageParts(html, target);
    imageText = await ocrImages(parts, opts);
  } catch (err) {
    console.warn("[vision] page image OCR failed:", err);
  }
  return { title, text: joinSections(title, pageText, imageText), html };
}

/**
 * Discover same-site article links from page HTML. Skips anchors, file
 * downloads and off-domain URLs; normalizes trailing slashes. Never mutates —
 * dedup lives in the caller.
 */
export function extractSiteLinks(html: string, baseUrl: string): string[] {
  const host = new URL(baseUrl).hostname.replace(/^www\./, "");
  const out: string[] = [];
  const seen = new Set<string>();
  const hrefRe = /<a\b[^>]*href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const raw = (m[1] ?? "").trim();
    if (!raw || /^(mailto:|tel:|javascript:|#)/i.test(raw)) continue;
    let abs: URL;
    try {
      abs = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (abs.hostname.replace(/^www\./, "") !== host) continue;
    abs.hash = "";
    const u = abs.href.replace(/\/+$/, "");
    if (/\.(pdf|zip|rar|7z|tar|gz|png|jpe?g|gif|webp|svg|mp3|mp4|avi|mov|mkv|docx?|xlsx?|pptx?|css|js|json|xml)(?:$|[?#])/i.test(u)) continue;
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
