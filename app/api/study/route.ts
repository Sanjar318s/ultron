import { NextRequest, NextResponse } from "next/server";
import {
  deleteJob,
  getStudyJob,
  listStudyJobs,
  pauseJob,
  resumeJob,
  startStudy,
  toView,
  type StudyJobType,
} from "@/lib/studyJobs";

export const runtime = "nodejs";

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

function fail(msg: string, status = 400): NextResponse {
  return NextResponse.json({ error: msg }, { status });
}

const TYPES: StudyJobType[] = ["site", "url", "text", "image"];

/** POST /api/study — start a study job. Body: {type, content, chatId?, isOwner?} */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isLocalRequest(req)) return fail("forbidden", 403);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("bad json");

  const type = String(body.type ?? "");
  if (!TYPES.includes(type as StudyJobType)) return fail("unknown type");

  const chatId = String(body.chatId ?? "web");
  const isOwner = Boolean(body.isOwner);
  const cap = Number.isFinite(Number(body.cap)) ? Math.max(1, Math.min(500, Number(body.cap))) : undefined;

  let content: string | { mimeType: string; data: string };
  if (type === "image") {
    const img = body.image as Record<string, unknown> | undefined;
    if (img && typeof img.b64 === "string" && typeof img.mime === "string") {
      content = { mimeType: img.mime, data: img.b64 };
    } else if (typeof body.content === "string" && body.content.trim()) {
      content = body.content.trim();
    } else {
      return fail("image job needs {image:{b64,mime}} or content");
    }
  } else {
    if (typeof body.content !== "string" || !body.content.trim()) return fail("missing content");
    content = body.content.trim();
    if (type === "site" || type === "url") {
      const m = String(content).match(/^https?:\/\/\S+$/i);
      if (!m) return fail("content must be an http(s) URL");
    }
    if (type === "text" && content.length > 400_000) return fail("text too long");
  }

  const job = await startStudy({ chatId, isOwner, type: type as StudyJobType, content, cap });
  return NextResponse.json({ ok: true, job: toView(job) });
}

/** GET /api/study?jobId=…&chatId=… — job status (the bot polls this). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isLocalRequest(req)) return fail("forbidden", 403);
  const jobId = req.nextUrl.searchParams.get("jobId");
  const chatId = req.nextUrl.searchParams.get("chatId");

  if (chatId) {
    const list = await listStudyJobs(chatId);
    return NextResponse.json({ ok: true, jobs: list });
  }
  if (!jobId) return fail("missing jobId");

  const job = await getStudyJob(jobId, chatId ?? undefined);
  if (!job) return fail("job not found", 404);
  return NextResponse.json({ ok: true, job: toView(job) });
}

/** POST /api/study/action — {jobId, action: "resume"|"stop", chatId?} */
export async function PUT(req: NextRequest): Promise<NextResponse> {
  if (!isLocalRequest(req)) return fail("forbidden", 403);
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.jobId !== "string") return fail("missing jobId");

  const jobId = body.jobId;
  const chatId = typeof body.chatId === "string" ? body.chatId : undefined;
  const mine = await getStudyJob(jobId, chatId);
  if (!mine) return fail("job not found", 404);

  if (body.action === "resume") {
    const j = await resumeJob(jobId);
    return NextResponse.json({ ok: true, job: j ? toView(j) : null });
  }
  if (body.action === "stop") {
    const j = await pauseJob(jobId);
    return NextResponse.json({ ok: true, job: j ? toView(j) : null });
  }
  if (body.action === "delete") {
    const ok = await deleteJob(jobId, chatId);
    return NextResponse.json({ ok });
  }
  return fail("unknown action");
}
