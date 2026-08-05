/**
 * Study engine — durable background learning jobs for the Telegram bot and the
 * browser assistant.
 *
 * Four job types:
 *   - site  : crawl a whole website (same-domain pages only), ≤ CAP pages per
 *             run, never re-studying URLs that already have a note (source).
 *   - url   : single web page (incl. PDFs / scanned docs via vision).
 *   - text  : raw pasted text → note.
 *   - image : a picture → OCR → note.
 *
 * State lives in data/study-jobs.json (like brain.json — gitignored runtime
 * state). The processor loop is a module singleton running inside the Next.js
 * process; jobs survive server restarts as `paused` and can be resumed from
 * the bot's «Незавершённое изучение» menu.
 *
 * Honesty contract (see the product requirements): the bot must NEVER claim a
 * study is finished before it truly is. The engine reports `left`, `failed[]`
 * and `waiting` (limit reached → user decides continue/stop) so callers can
 * give truthful status and final reports.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { commitBrain, loadBrain } from "@/lib/brainStore";
import { snapshotIds } from "@/lib/assistantBrain";
import { buildStudyNote, type CompleteFn } from "@/lib/noteBuilder";
import { completeCloud } from "@/lib/serverLLM";
import { resolveKey } from "@/lib/geminiKeys";
import {
  fetchPageContent,
  extractSiteLinks,
  ocrImages,
  downloadImagePart,
  type ImagePart,
} from "@/lib/pageVision";

export type StudyJobType = "site" | "url" | "text" | "image";
export type StudyJobStatus = "queued" | "active" | "waiting" | "paused" | "done" | "failed";

export interface StudyFailedItem {
  url?: string;
  reason: string;
}

export interface StudyJob {
  id: string;
  chatId: string;
  isOwner: boolean;
  type: StudyJobType;
  title: string;
  status: StudyJobStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  queue: string[];
  visited: string[];
  studied: number;
  skipped: number;
  processed: number;
  failed: StudyFailedItem[];
  current?: string;
  left: number;
  cap: number;
  seed?: string;
  text?: string;
  image?: ImagePart | null;
  imageUrl?: string;
}

export interface StudyJobView {
  id: string;
  chatId: string;
  type: StudyJobType;
  title: string;
  status: StudyJobStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  studied: number;
  skipped: number;
  failed: StudyFailedItem[];
  current?: string;
  left: number;
  cap: number;
}

const JOBS_FILE = path.join(process.cwd(), "data", "study-jobs.json");
export const DEFAULT_CAP = 100;

let jobs: StudyJob[] = [];
let loaded = false;
let running = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fsp.readFile(JOBS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as StudyJob[];
    if (Array.isArray(parsed)) {
      // Never auto-resume after a restart — surface as paused instead.
      jobs = parsed.map((j) =>
        j.status === "queued" || j.status === "active" || j.status === "waiting" ? { ...j, status: "paused" as const } : j,
      );
    }
  } catch {
    jobs = [];
  }
}

async function persist(): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(JOBS_FILE), { recursive: true });
    await fsp.writeFile(JOBS_FILE, JSON.stringify(jobs), "utf-8");
  } catch (err) {
    console.warn("[study] persist failed:", err);
  }
}

export function toView(j: StudyJob): StudyJobView {
  return {
    id: j.id,
    chatId: j.chatId,
    type: j.type,
    title: j.title,
    status: j.status,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    completedAt: j.completedAt,
    studied: j.studied,
    skipped: j.skipped,
    failed: j.failed,
    current: j.current,
    left: j.left,
    cap: j.cap,
  };
}

/** The active (runnable or awaiting decision) job for a chat, if any. */
export function activeForChat(chatId: string): StudyJob | undefined {
  return jobs.find((j) => j.chatId === chatId && (j.status === "queued" || j.status === "active" || j.status === "waiting"));
}

function makeComplete(job: StudyJob): CompleteFn {
  return async (messages) => {
    const rk = await resolveKey(job.chatId, job.isOwner).catch(() => ({ key: undefined as string | undefined }));
    return completeCloud(messages, { geminiKey: rk?.key });
  };
}

export interface StartStudyInput {
  chatId: string;
  isOwner: boolean;
  type: StudyJobType;
  /** For site/url: the seed URL. For text: the raw text. For image: an image URL or base64 part. */
  content: string | ImagePart;
  cap?: number;
}

/**
 * Start a study job. Returns the active job for the chat if one is already
 * running (one active per chat) — the caller should report that one.
 */
export async function startStudy(input: StartStudyInput): Promise<StudyJob> {
  await ensureLoaded();
  const existing = activeForChat(input.chatId);
  if (existing) return existing;

  let job: StudyJob;
  if (input.type === "site") {
    const seed = String(input.content).trim();
    job = {
      id: jobId(),
      chatId: input.chatId,
      isOwner: input.isOwner,
      type: "site",
      title: seed,
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      queue: [seed],
      visited: [],
      studied: 0,
      skipped: 0,
      processed: 0,
      failed: [],
      left: 1,
      cap: input.cap ?? DEFAULT_CAP,
      seed,
    };
  } else if (input.type === "text") {
    const text = String(input.content).trim();
    job = {
      id: jobId(),
      chatId: input.chatId,
      isOwner: input.isOwner,
      type: "text",
      title: text.slice(0, 60),
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      queue: [],
      visited: [],
      studied: 0,
      skipped: 0,
      processed: 0,
      failed: [],
      left: 0,
      cap: 1,
      text,
    };
  } else if (input.type === "image") {
    const img: ImagePart = typeof input.content === "string" ? { mimeType: "image/jpeg", data: input.content } : input.content;
    const asUrl = typeof input.content === "string" && /^https?:\/\//i.test(input.content);
    job = {
      id: jobId(),
      chatId: input.chatId,
      isOwner: input.isOwner,
      type: "image",
      title: asUrl ? String(input.content) : "изображение",
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      queue: [],
      visited: [],
      studied: 0,
      skipped: 0,
      processed: 0,
      failed: [],
      left: 0,
      cap: 1,
      image: asUrl ? null : img,
      imageUrl: asUrl ? String(input.content) : undefined,
    };
  } else {
    const seed = String(input.content).trim();
    job = {
      id: jobId(),
      chatId: input.chatId,
      isOwner: input.isOwner,
      type: "url",
      title: seed,
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      queue: [],
      visited: [],
      studied: 0,
      skipped: 0,
      processed: 0,
      failed: [],
      left: 1,
      cap: 1,
      seed,
    };
  }
  jobs.push(job);
  await persist();
  kick();
  return job;
}

/** Pause a job — saved to history, resumable later from the menu. */
export async function pauseJob(id: string): Promise<StudyJob | undefined> {
  await ensureLoaded();
  const j = jobs.find((x) => x.id === id);
  if (!j) return undefined;
  if (j.status === "active") {
    // The processor loop checks the status between steps; mark it and let the
    // loop settle. The step will persist this state.
    j.status = "paused";
    await persist();
  } else if (j.status === "waiting" || j.status === "queued") {
    j.status = "paused";
    j.updatedAt = Date.now();
    await persist();
  }
  return j;
}

/** Resume a paused/waiting job — a fresh page budget and a retry of failures. */
export async function resumeJob(id: string): Promise<StudyJob | undefined> {
  await ensureLoaded();
  const j = jobs.find((x) => x.id === id);
  if (!j) return undefined;
  if (j.type === "site" && j.queue.length === 0 && j.failed.length > 0) {
    for (const f of j.failed) if (f.url) j.queue.push(f.url);
    j.failed = [];
  }
  j.processed = 0;
  j.status = "queued";
  j.updatedAt = Date.now();
  await persist();
  kick();
  return j;
}

export async function getStudyJob(id: string, chatId?: string): Promise<StudyJob | undefined> {
  await ensureLoaded();
  const j = jobs.find((x) => x.id === id);
  if (!j) return undefined;
  if (chatId !== undefined && j.chatId !== chatId) return undefined;
  return j;
}

/** Permanently remove a job from the history (notes stay in the brain). */
export async function deleteJob(id: string, chatId?: string): Promise<boolean> {
  await ensureLoaded();
  const idx = jobs.findIndex((j) => j.id === id && (chatId === undefined || j.chatId === chatId));
  if (idx === -1) return false;
  jobs.splice(idx, 1);
  await persist();
  return true;
}

/** All jobs for a chat, newest first (drives the «Незавершённое изучение» menu). */
export async function listStudyJobs(chatId: string): Promise<StudyJobView[]> {
  await ensureLoaded();
  return jobs
    .filter((j) => j.chatId === chatId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toView);
}

// ---------------------------------------------------------------------------
// Processor loop
// ---------------------------------------------------------------------------

function kick(): void {
  if (running) return;
  running = true;
  void (async () => {
    try {
      while (true) {
        const job = jobs.find((j) => j.status === "queued");
        if (!job) break;
        job.status = "active";
        job.updatedAt = Date.now();
        await persist();
        const again = await stepJob(job);
        if (job.status === "active") {
          if (again && job.type === "site") {
            job.status = "queued";
          } else if (again) {
            job.status = "queued";
          } else {
            job.status = job.failed.length > 0 ? "paused" : "done";
            job.completedAt = Date.now();
          }
        }
        job.updatedAt = Date.now();
        await persist();
        await delay(800);
      }
    } finally {
      running = false;
    }
  })();
}

/** Runs one unit of work. For site jobs it's a single page; for the rest the whole job. */
async function stepJob(job: StudyJob): Promise<boolean> {
  switch (job.type) {
    case "site":
      return processSiteStep(job);
    case "url":
      await processUrlJob(job);
      return false;
    case "text":
      await processTextJob(job);
      return false;
    case "image":
      await processImageJob(job);
      return false;
  }
}

async function commitNote(job: StudyJob, note: { topic: string; summary: string; keyPoints: string[] }, url?: string): Promise<boolean> {
  const brain = await loadBrain();
  if (url && brain.findNoteBySource(url)) return false; // studied meanwhile — skip
  brain.addNote({ topic: note.topic, summary: note.summary, keyPoints: note.keyPoints, ...(url ? { source: url } : {}) });
  await commitBrain(brain, snapshotIds(brain.snapshot()));
  return true;
}

async function processSiteStep(job: StudyJob): Promise<boolean> {
  const url = job.queue[0];
  if (!url) return false;
  job.current = url;
  const brain = await loadBrain();
  try {
    if (brain.findNoteBySource(url)) {
      job.skipped++;
      job.processed++;
      job.queue.shift();
      job.visited.push(url);
      job.left = job.queue.length + job.failed.length;
      if (job.processed >= job.cap) {
        job.status = "waiting";
        return false;
      }
      return job.queue.length > 0;
    }
    const page = await fetchPageContent(url, { chatId: job.chatId, isOwner: job.isOwner });
    const note = await buildStudyNote({
      text: page.text.slice(0, 400_000),
      title: page.title || undefined,
      url,
      complete: makeComplete(job),
    });
    if (await commitNote(job, note, url)) job.studied++;
    else job.skipped++;
    job.processed++;
    job.queue.shift();
    job.visited.push(url);
    if (page.html) {
      for (const link of extractSiteLinks(page.html, url)) {
        if (job.queue.includes(link) || job.visited.includes(link)) continue;
        if (!brain.findNoteBySource(link)) job.queue.push(link);
        // already-known links stay out of the queue → not counted as «left».
      }
    }
  } catch (err) {
    job.failed.push({ url, reason: err instanceof Error ? err.message : String(err) });
    job.processed++;
    job.queue.shift();
    job.visited.push(url);
  }
  job.left = job.queue.length + job.failed.length;
  if (job.processed >= job.cap) {
    job.status = "waiting"; // limit reached → user decides «продолжить / хватит»
    return false;
  }
  return job.queue.length > 0;
}

async function processUrlJob(job: StudyJob): Promise<void> {
  const url = job.seed ?? "";
  job.current = url;
  try {
    const brain = await loadBrain();
    const existing = brain.findNoteBySource(url);
    if (existing) {
      job.failed.push({ url, reason: "Страница уже полностью изучена." });
      return;
    }
    const page = await fetchPageContent(url, { chatId: job.chatId, isOwner: job.isOwner });
    const note = await buildStudyNote({
      text: page.text.slice(0, 400_000),
      title: page.title || undefined,
      url,
      complete: makeComplete(job),
    });
    if (await commitNote(job, note, url)) job.studied++;
    else job.failed.push({ url, reason: "Страница уже полностью изучена." });
  } catch (err) {
    job.failed.push({ url, reason: err instanceof Error ? err.message : String(err) });
  }
  job.left = job.failed.length;
}

async function processTextJob(job: StudyJob): Promise<void> {
  try {
    const note = await buildStudyNote({
      text: (job.text ?? "").slice(0, 400_000),
      title: job.title,
      complete: makeComplete(job),
    });
    if (await commitNote(job, note)) job.studied++;
    else job.failed.push({ reason: "Не удалось сохранить заметку." });
  } catch (err) {
    job.failed.push({ reason: err instanceof Error ? err.message : String(err) });
  }
  job.left = job.failed.length;
}

async function processImageJob(job: StudyJob): Promise<void> {
  try {
    let part = job.image ?? null;
    if (!part && job.imageUrl) {
      part = await downloadImagePart(job.imageUrl);
    }
    if (!part) {
      job.failed.push({ reason: "Нет изображения для изучения." });
      return;
    }
    const text = await ocrImages([part], { chatId: job.chatId, isOwner: job.isOwner });
    if (!text.trim()) {
      job.failed.push({ reason: "Не удалось прочитать текст с изображения." });
      return;
    }
    const note = await buildStudyNote({ text: text.slice(0, 30_000), title: job.title, complete: makeComplete(job) });
    if (await commitNote(job, note)) job.studied++;
    else job.failed.push({ reason: "Не удалось сохранить заметку." });
  } catch (err) {
    job.failed.push({ reason: err instanceof Error ? err.message : String(err) });
  }
  job.left = job.failed.length;
}
