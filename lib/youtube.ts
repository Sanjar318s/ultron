/**
 * YouTube transcript extraction WITHOUT an API key. Strategy order:
 *
 *   1. yt-dlp (if installed) with rotated player clients — by far the most
 *      reliable against YouTube's bot protection. The binary is located via
 *      `YTDLP_BIN` env, common install paths (`C:\Tools\yt-dlp\yt-dlp.exe`,
 *      PATH), then used with `--write-auto-subs --write-subs` and the
 *      resulting VTT files are parsed to plain text.
 *   2. A keyless native flow: fetch the watch page and locate the
 *      `ytInitialPlayerResponse` JSON (a balanced-brace scan, since naive
 *      regexes break on nested braces), pick the best caption track
 *      (ru/asr preferred, then en, then any) and fetch its timedtext URL.
 *   3. A keyless youtubei/v1/player fallback for pages where the HTML parse
 *      fails (consent wall, bot checks).
 *
 * Returns null when the video has no captions — callers should fall back to
 * page text then.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CONSENT_COOKIE = "CONSENT=YES+cb; SOCS=CAISHAgBEhJnd3NfMjAyNDA0MjQtMF9SQzIaAmVuIAEaBgiA_LyaBg";

/** Player clients yt-dlp tries in order — the default alone trips bot checks. */
const YTDLP_CLIENTS = "default,android_vr,web_embedded,tv,ios,mweb,android,web_safari";

function isNode(): boolean {
  return typeof process !== "undefined" && typeof process.platform === "string";
}

function findYtDlpBinary(): string | null {
  if (!isNode()) return null;
  const candidates: string[] = [];
  if (process.env.YTDLP_BIN) candidates.push(process.env.YTDLP_BIN);
  if (process.platform === "win32") {
    candidates.push("C:\\Tools\\yt-dlp\\yt-dlp.exe", "C:\\yt-dlp\\yt-dlp.exe");
  } else {
    candidates.push("/usr/local/bin/yt-dlp", "/opt/homebrew/bin/yt-dlp", "/usr/bin/yt-dlp");
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync("where", ["yt-dlp"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      for (const l of out.split(/\r?\n/).filter(Boolean)) candidates.push(l.trim());
    } catch {
      // not on PATH
    }
  } else {
    try {
      const out = execFileSync("which", ["yt-dlp"], { encoding: "utf8", timeout: 5000 });
      for (const l of out.split(/\n/).filter(Boolean)) candidates.push(l.trim());
    } catch {
      // not on PATH
    }
  }
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

/** Strip VTT markup (WEBVTT header, cue timestamps, inline `<c>`/word-clock tags). */
function parseVtt(text: string): string {
  const out: string[] = [];
  let started = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!started) {
      if (line.includes("-->")) started = true;
      continue;
    }
    if (!line || line.includes("-->")) continue;
    const cleaned = line
      .replace(/<c>/g, "")
      .replace(/<\/c>/g, "")
      .replace(/<\d{1,2}:\d{2}:[\d.,]+>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) continue;
    if (out.length > 0 && out[out.length - 1] === cleaned) continue;
    out.push(cleaned);
  }
  return out.join("\n");
}

/** Prefer ru manual, then ru auto, en manual, en auto, then any track. */
function pickVttFile(videoId: string, files: string[]): string | null {
  const vtts = files.filter((f) => f.startsWith(videoId) && f.endsWith(".vtt"));
  const order = ["ru", "ru-auto", "en", "en-auto"];
  for (const lang of order) {
    const hit = vtts.find((f) => f === `${videoId}.${lang}.vtt`);
    if (hit) return hit;
  }
  return vtts[0] ?? null;
}

interface YtDlpTranscript {
  transcript: string;
  language?: string;
  title?: string;
  durationSec?: number;
}

/** Transcript via the yt-dlp CLI. Null when the binary is missing or fails. */
async function fetchYtDlpTranscript(videoId: string): Promise<YtDlpTranscript | null> {
  const bin = findYtDlpBinary();
  if (!bin) return null;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ytdlp-")).catch(() => null);
  if (!dir) return null;
  try {
    return await new Promise<YtDlpTranscript | null>((resolve) => {
      const args = [
        "--skip-download",
        "--no-playlist",
        "--write-auto-subs",
        "--write-subs",
        "--sub-langs",
        "ru,en",
        "--sub-format",
        "vtt/best",
        "--no-warnings",
        "--quiet",
        "--write-info-json",
        "--extractor-args",
        `youtube:player_client=${YTDLP_CLIENTS}`,
        "-o",
        path.join(dir, "%(id)s.%(ext)s"),
        `https://www.youtube.com/watch?v=${videoId}`,
      ];
      execFile(
        bin,
        args,
        { timeout: 180_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          void (async () => {
            try {
              let title: string | undefined;
              let durationSec: number | undefined;
              try {
                const metaRaw = await fsp.readFile(path.join(dir, `${videoId}.info.json`), "utf8").catch(() => "");
                if (metaRaw) {
                  const meta = JSON.parse(metaRaw) as { title?: string; duration?: number };
                  title = meta.title;
                  durationSec = meta.duration ? Math.round(meta.duration) : undefined;
                }
              } catch {
                // metadata is best-effort
              }
              const files = await fsp.readdir(dir).catch(() => []);
              const file = pickVttFile(videoId, files);
              if (!file) {
                resolve(null);
                return;
              }
              const raw = await fsp.readFile(path.join(dir, file), "utf8").catch(() => "");
              const transcript = parseVtt(raw);
              if (!transcript.trim()) {
                resolve(null);
                return;
              }
              const langMatch = file.match(/([a-z]{2}(?:-[A-Z]{2})?)(-auto)?\.vtt$/);
              resolve({
                transcript,
                language: langMatch ? langMatch[1] : undefined,
                title,
                durationSec,
              });
            } catch {
              resolve(null);
            }
          })();
          void err; // subtitle-fetch errors don't matter if a usable file was written
          void stdout;
        }
      );
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** True for youtube.com / youtu.be / youtube-nocookie.com links. */
export function isYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "youtu.be" ||
      /(^|\.)youtube\.com$/i.test(u.hostname) ||
      /(^|\.)youtube-nocookie\.com$/i.test(u.hostname)
    );
  } catch {
    return false;
  }
}

/** Extract the 11-char video id from any YouTube URL shape. */
export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.replace(/^\//, "").split("/")[0] || null;
    if (/(^|\.)youtube\.com$/i.test(u.hostname) || /(^|\.)youtube-nocookie\.com$/i.test(u.hostname)) {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = u.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/);
      if (m) return m[1];
    }
  } catch {
    // ignore
  }
  return null;
}

export interface VideoTranscript {
  transcript: string;
  language?: string;
  title?: string;
  durationSec?: number;
}

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

/** Extract the first balanced JSON object/array found after `marker`. */
function extractJsonAfter(html: string, marker: string): unknown | null {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  let start = -1;
  for (let i = idx; i < html.length; i++) {
    if (html[i] === "{" || html[i] === "[") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const open = html[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as unknown;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchWatchHtml(videoId: string): Promise<string> {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=ru`, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      Cookie: CONSENT_COOKIE,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Keyless youtubei/v1/player fallback when the watch-page parse fails. */
async function fetchPlayerApi(videoId: string): Promise<unknown | null> {
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": UA,
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00", hl: "ru" } },
        videoId,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

function pickCaptionTrack(player: unknown): CaptionTrack | null {
  const pr = player as {
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
    videoDetails?: { title?: string; lengthSeconds?: string };
  };
  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const withUrl = tracks.filter((t) => t.baseUrl);
  if (withUrl.length === 0) return null;
  const ru = withUrl.filter((t) => t.languageCode === "ru");
  const pool = ru.length > 0 ? ru : withUrl.filter((t) => t.languageCode === "en");
  const lang = pool.length > 0 ? pool : withUrl;
  // Auto-generated (asr) tracks usually cover the WHOLE video — prefer them.
  return lang.find((t) => t.kind === "asr") ?? lang[0] ?? null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    })
    .replace(/\r\n?/g, "\n");
}

async function fetchTimedText(track: CaptionTrack): Promise<string> {
  const base = (track.baseUrl ?? "").replace(/&fmt=[a-z0-9]+/i, "");
  // fmt=json returns {"events":[{tStartMs, segs:[{utf8}]}]} — easy to parse.
  try {
    const res = await fetch(`${base}${base.includes("?") ? "&" : "?"}fmt=json`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { events?: { segs?: { utf8?: string }[] }[] };
      if (Array.isArray(data?.events)) {
        const lines: string[] = [];
        for (const ev of data.events) {
          if (!Array.isArray(ev?.segs)) continue;
          let t = "";
          for (const seg of ev.segs) t += seg?.utf8 ?? "";
          const text = decodeEntities(t).replace(/\s+/g, " ").trim();
          if (text) lines.push(text);
        }
        if (lines.length > 0) return lines.join("\n");
      }
    }
  } catch {
    // fall through to the XML parse
  }
  const xmlRes = await fetch(base, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!xmlRes.ok) return "";
  const xml = await xmlRes.text();
  const lines: string[] = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const t = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
    if (t) lines.push(t);
  }
  return lines.join("\n");
}

/** Full transcript text (one caption line per line). Null if unobtainable. */
export async function fetchVideoTranscript(videoId: string): Promise<VideoTranscript | null> {
  if (isNode()) {
    const viaYtDlp = await fetchYtDlpTranscript(videoId);
    if (viaYtDlp) {
      return {
        transcript: viaYtDlp.transcript,
        language: viaYtDlp.language,
        title: viaYtDlp.title,
        durationSec: viaYtDlp.durationSec,
      };
    }
  }
  let player: unknown | null = null;
  try {
    const html = await fetchWatchHtml(videoId);
    player = extractJsonAfter(html, "ytInitialPlayerResponse");
    if (!player) {
      // captions sometimes live outside the player response.
      const standalone = extractJsonAfter(html, '"captionTracks"');
      if (Array.isArray(standalone)) {
        player = { captions: { playerCaptionsTracklistRenderer: { captionTracks: standalone } } };
      }
    }
  } catch {
    // keep null → try the player API
  }
  if (!player) player = await fetchPlayerApi(videoId);
  if (!player) return null;
  const track = pickCaptionTrack(player);
  if (!track) return null;
  const transcript = await fetchTimedText(track);
  if (!transcript.trim()) return null;
  const pr = player as { videoDetails?: { title?: string; lengthSeconds?: string } };
  return {
    transcript,
    language: track.languageCode,
    title: pr.videoDetails?.title,
    durationSec: Number(pr.videoDetails?.lengthSeconds) || undefined,
  };
}
