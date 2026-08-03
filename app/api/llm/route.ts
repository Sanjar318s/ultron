import { NextRequest, NextResponse } from "next/server";
import type { ContentPart } from "@/lib/llm/types";
import { messageText } from "@/lib/llm/types";
import { resolveKey as poolResolveKey, reportFailure as poolReportFailure, isQuotaError as poolIsQuota } from "@/lib/geminiKeys";

/**
 * Server-side LLM proxy for the cloud providers. Browser code sends
 * { provider, messages } here; the matching API key is read from env vars
 * on THIS machine and never shipped to the client. The provider's HTTP API
 * is called from the server and only the assistant's reply text comes back.
 * Messages may carry base64 image parts (for vision). Only gemini accepts
 * them; non-vision providers get an explicit 400 so a wrong choice fails
 * loudly instead of silently dropping the screenshot.
 */

export const runtime = "nodejs";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";

const MODELS: Record<string, string> = {
  openai: "gpt-4.1-mini",
  groq: "llama-3.3-70b-versatile",
  deepseek: "deepseek-chat",
  gemini: "gemini-3.1-flash-lite",
};

const KEYS: Record<string, () => string | undefined> = {
  openai: () => process.env.OPENAI_API_KEY,
  groq: () => process.env.GROQ_API_KEY,
  deepseek: () => process.env.DEEPSEEK_API_KEY,
  gemini: () => process.env.GEMINI_API_KEY,
};
const MAX_PARTS_PER_MESSAGE = 16;
const MAX_IMAGE_B64 = 2_000_000;

interface CloudMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

function sanitizeMessages(input: unknown): CloudMessage[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 20) return null;
  const out: CloudMessage[] = [];
  for (const m of input) {
    if (typeof m !== "object" || m === null) return null;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "system" && role !== "user" && role !== "assistant") return null;

    if (typeof content === "string") {
      const trimmed = content.trim();
      if (!trimmed) return null;
      out.push({ role, content: trimmed.slice(0, 4000) });
      continue;
    }

    if (!Array.isArray(content) || content.length === 0 || content.length > MAX_PARTS_PER_MESSAGE) return null;
    const parts: ContentPart[] = [];
    for (const raw of content) {
      if (typeof raw !== "object" || raw === null) return null;
      const type = (raw as { type?: unknown }).type;
      if (type === "text") {
        const text =
          typeof (raw as { text?: unknown }).text === "string" ? (raw as { text: string }).text.trim() : "";
        if (!text) return null;
        parts.push({ type: "text", text: text.slice(0, 4000) });
      } else if (type === "image") {
        const mimeType = (raw as { mimeType?: unknown }).mimeType;
        const data = (raw as { data?: unknown }).data;
        if (
          typeof mimeType !== "string" ||
          !/^image\/(jpeg|png|webp)$/.test(mimeType) ||
          typeof data !== "string" ||
          !data ||
          data.length > MAX_IMAGE_B64
        ) {
          return null;
        }
        parts.push({ type: "image", mimeType, data });
      } else {
        return null;
      }
    }
    out.push({ role, content: parts });
  }
  return out;
}

function isLocalRequest(req: NextRequest): boolean {
  const host = req.headers.get("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1");
}

function toGemini(messages: CloudMessage[]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : messageText({ role: m.role, content: m.content })))
    .join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: (typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content).map((p) =>
        p.type === "image" ? { inlineData: { mimeType: p.mimeType, data: p.data } } : { text: p.text },
      ),
    }));
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };
}

async function postJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const detail =
      typeof data?.error === "object" && data.error && "message" in (data.error as Record<string, unknown>)
        ? ((data.error as Record<string, unknown>).message as string)
        : res.statusText;
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return data;
}

export async function GET() {
  return NextResponse.json({
    openai: Boolean(process.env.OPENAI_API_KEY),
    groq: Boolean(process.env.GROQ_API_KEY),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
  });
}

export async function POST(req: NextRequest) {
  if (!isLocalRequest(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const provider = typeof body?.provider === "string" ? body.provider : "";
  if (!MODELS[provider]) {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }
  const messages = sanitizeMessages(body?.messages);
  if (!messages) {
    return NextResponse.json({ error: "invalid messages" }, { status: 400 });
  }
  if (provider !== "gemini" && messages.some((m) => Array.isArray(m.content))) {
    return NextResponse.json({ error: "images only supported for gemini" }, { status: 400 });
  }
  let key = KEYS[provider]?.();
  if (provider === "gemini") {
    const resolved = await poolResolveKey("", true);
    if (resolved.state === "ok" && resolved.key) key = resolved.key;
  }
  if (!key) {
    return NextResponse.json({ error: "missing api key" }, { status: 503 });
  }

  const temperature = typeof body?.temperature === "number" ? body.temperature : 0.3;
  const maxTokens = typeof body?.maxTokens === "number" ? Math.min(body.maxTokens, 2048) : 1024;

  try {
    let content: string | undefined;

    if (provider === "gemini") {
      const model = MODELS.gemini;
      const data = (await postJson(`${GEMINI_URL}/${model}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify({ ...toGemini(messages), generationConfig: { temperature, maxOutputTokens: maxTokens } }),
      })) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      content = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
    } else {
      const url = provider === "openai" ? OPENAI_URL : provider === "groq" ? GROQ_URL : DEEPSEEK_URL;
      const flat = messages.map((m) => ({ role: m.role, content: messageText(m) }));
      const data = (await postJson(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: MODELS[provider],
          messages: flat,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
      })) as { choices?: { message?: { content?: string } }[] };
      content = data.choices?.[0]?.message?.content?.trim();
    }

    if (!content) {
      return NextResponse.json({ error: "empty model response" }, { status: 502 });
    }
    return NextResponse.json({ content });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (provider === "gemini" && key && poolIsQuota(message)) {
      void poolReportFailure("", key, true);
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
