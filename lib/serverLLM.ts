/**
 * Server-side LLM calls for the /api/assistant core and the web-search flow.
 * Unlike the browser router (which proxies through /api/llm and can use
 * WebLLM/Ollama), this talks to providers directly with server-side keys.
 * Priority: Ollama (local, unlimited) → Gemini → Groq. OpenAI/DeepSeek keys
 * are currently unfunded, so they are left out of the chain (re-add them to
 * PROVIDERS once the accounts have a balance).
 */

import type { ChatMessage } from "./llm/types";
import { messageText } from "./llm/types";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:8b";

const MODELS: Record<string, string> = {
  openai: "gpt-4.1-mini",
  groq: "llama-3.3-70b-versatile",
  deepseek: "deepseek-chat",
  gemini: "gemini-3.1-flash-lite",
};

const PROVIDERS: Array<{ id: string; key?: string }> = [
  { id: "ollama" },
  { id: "gemini", key: process.env.GEMINI_API_KEY },
  { id: "groq", key: process.env.GROQ_API_KEY },
];

function toGemini(messages: ChatMessage[]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : messageText({ role: m.role, content: m.content })))
    .join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts:
        typeof m.content === "string"
          ? [{ text: m.content }]
          : m.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => ({ text: p.text })),
    }));
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };
}

/** Call a single provider; resolves with the trimmed text or throws. */
async function callProvider(messages: ChatMessage[], p: { id: string; key?: string }): Promise<string> {
  if (p.id === "ollama") {
    const flat = messages.map((m) => ({ role: m.role, content: messageText(m) }));
    // Native /api/chat (not the OpenAI-compat one): qwen3's thinking mode
    // eats the whole budget via the compat endpoint and returns empty content.
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: flat,
        stream: false,
        think: false,
        // qwen3 sometimes ignores the "return strict JSON" instruction and
        // answers conversationally — structured output forces valid JSON.
        format: "json",
        options: { temperature: 0.3, num_predict: 2048 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail =
        data && typeof data.error === "object" && data.error && "message" in (data.error as Record<string, unknown>)
          ? ((data.error as Record<string, unknown>).message as string)
          : res.statusText;
      throw new Error(`ollama ${res.status}: ${detail}`);
    }
    const ollamaContent = (data?.message as { content?: string } | undefined)?.content?.trim();
    if (!ollamaContent) throw new Error("ollama empty response");
    return ollamaContent;
  }
  if (!p.key) throw new Error(`${p.id} no key`);
  let content: string | undefined;
  if (p.id === "gemini") {
    const res = await fetch(`${GEMINI_URL}/${MODELS.gemini}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": p.key },
      body: JSON.stringify({ ...toGemini(messages), generationConfig: { temperature: 0.3, maxOutputTokens: 2048 } }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail =
        data && typeof data.error === "object" && data.error && "message" in (data.error as Record<string, unknown>)
          ? ((data.error as Record<string, unknown>).message as string)
          : res.statusText;
      throw new Error(`gemini ${res.status}: ${detail}`);
    }
    content = (data?.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined)?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
  } else {
    const url = p.id === "openai" ? OPENAI_URL : p.id === "groq" ? GROQ_URL : DEEPSEEK_URL;
    const flat = messages.map((m) => ({ role: m.role, content: messageText(m) }));
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ model: MODELS[p.id], messages: flat, temperature: 0.3, max_tokens: 2048, stream: false }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const detail =
        data && typeof data.error === "object" && data.error && "message" in (data.error as Record<string, unknown>)
          ? ((data.error as Record<string, unknown>).message as string)
          : res.statusText;
      throw new Error(`${p.id} ${res.status}: ${detail}`);
    }
    content = (data?.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content?.trim();
  }
  if (!content) throw new Error(`${p.id} empty response`);
  return content;
}

/** Best available model. Falls through providers until one answers. */
export async function completeCloud(messages: ChatMessage[]): Promise<string> {
  let lastError: unknown = null;
  for (const p of PROVIDERS) {
    if (p.id !== "ollama" && !p.key) continue;
    try {
      return await callProvider(messages, p);
    } catch (err) {
      lastError = err;
      console.warn(`[assistant] ${p.id} failed:`, err);
    }
  }
  throw lastError ?? new Error("no cloud provider available");
}

/** Ask a specific provider (e.g. DeepSeek as the "second advisor"). */
export async function completeWithProvider(messages: ChatMessage[], providerId: string): Promise<string> {
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p || !p.key) throw new Error(`provider ${providerId} unavailable`);
  return callProvider(messages, p);
}

export interface GroundedAnswer {
  answer: string;
  sources: string[];
}

const WIKI_PREFIXES = [
  "что такое из себя представляет",
  "что это такое",
  "расскажи что такое",
  "что представляет собой",
  "что такое",
  "что значит",
  "что это",
  "кто такой",
  "кто такая",
  "кто такие",
  "как работает",
  "как устроен",
  "как называется",
  "как",
  "зачем",
  "почему",
  "где",
  "определение",
  "значение слова",
  "значение",
  "факты о",
  "расскажи про",
  "расскажи о",
  "расскажи",
  "про",
  "о",
];

/** Drop leading question/request words so «что такое CRISP-DM» → «CRISP-DM». */
function normalizeWikiQuery(query: string): string {
  let q = query.trim();
  for (const p of WIKI_PREFIXES) {
    if (new RegExp(`^${p}\\s+`, "i").test(q)) {
      q = q.slice(p.length).trim();
      break;
    }
  }
  return q || query.trim();
}

/** Keyless fallback when Gemini search grounding is unavailable (no billing). */
async function wikipediaSearch(query: string): Promise<GroundedAnswer> {
  const q = normalizeWikiQuery(query);
  for (const lang of ["ru", "en"]) {
    const searchRes = await fetch(
      `https://${lang}.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(
        q,
      )}&limit=4&namespace=0&format=json`,
      { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Ultron Orb reader" } },
    );
    const searchData = (await searchRes.json().catch(() => null)) as Array<unknown> | null;
    const titles = (searchData?.[1] ?? []) as string[];
    if (!searchRes.ok || titles.length === 0) continue;
    const exact = titles.find((t) => t.toLowerCase() === q.toLowerCase());
    const title = exact ?? titles[0];
    const summaryRes = await fetch(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      { signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Ultron Orb reader" } },
    );
    const summary = (await summaryRes.json().catch(() => null)) as { extract?: string } | null;
    const extract = summary?.extract?.replace(/\s+/g, " ").slice(0, 2000) ?? "";
    if (!summaryRes.ok || !extract) continue;
    return {
      answer: `${title}. ${extract}`,
      sources: [`https://${lang}.wikipedia.org/wiki/${title.replace(/ /g, "_")}`],
    };
  }
  throw new Error("wikipedia search failed");
}

/**
 * Real-time search via a self-hosted OpenSERP OSS server (MIT, keyless).
 * By default hits the multi-engine endpoint with mode=any (tries engines in
 * order until one answers); set OPENSERP_ENGINE to pin one engine. Results
 * carry optional extracted page content (extract=N) which is fed to the LLM
 * as grounding material, so answers come from live pages, not model weights.
 * Returns null when the server is down, blocked, or has nothing usable.
 */
async function openSerpSearch(query: string): Promise<GroundedAnswer | null> {
  const base = process.env.OPENSERP_BASE_URL?.trim() || "http://127.0.0.1:7000";
  const engine = process.env.OPENSERP_ENGINE?.trim() || "";
  const limit = Math.min(Math.max(Number(process.env.OPENSERP_LIMIT) || 8, 1), 20);
  const extract = Math.min(Math.max(Number(process.env.OPENSERP_EXTRACT) || 3, 0), 5);
  const region = process.env.OPENSERP_REGION?.trim() || "";
  const params = new URLSearchParams({ text: query, limit: String(limit), extract: String(extract) });
  if (region) params.set("region", region);
  const endpoint = engine
    ? `${base}/${engine}/search?${params}`
    : `${base}/mega/search?${params}&mode=any`;
  let res: Response;
  try {
    res = await fetch(endpoint, { signal: AbortSignal.timeout(50_000) });
  } catch (err) {
    console.warn("[search] openserp unreachable:", err instanceof Error ? err.message : String(err));
    return null;
  }
  if (!res.ok) {
    console.warn("[search] openserp HTTP", res.status);
    return null;
  }
  const data = (await res.json().catch(() => null)) as {
    meta?: { error_detail?: string };
    results?: Array<{
      rank?: number;
      title?: string;
      url?: string;
      snippet?: string;
      extracted?: { content?: string };
    }>;
  } | null;
  if (!data?.results || data.results.length === 0) {
    console.warn("[search] openserp empty:", data?.meta?.error_detail ?? "no results");
    return null;
  }
  const chunks: string[] = [];
  const sources: string[] = [];
  for (const r of data.results) {
    const url = r.url;
    if (!url || sources.includes(url)) continue;
    const content = (r.extracted?.content ?? "").trim().slice(0, 3000);
    const body = content || (r.snippet ?? "").trim();
    if (!body) continue;
    chunks.push(`ИСТОЧНИК ${sources.length + 1}: ${r.title ?? url}\nURL: ${url}\n${body}`);
    sources.push(url);
    if (sources.length >= 5) break;
  }
  if (chunks.length === 0) return null;
  const answer = await completeCloud([
    {
      role: "system",
      content:
        "Ты — поисковик с реальным доступом в интернет. Ниже — свежие материалы, найденные по запросу. Отвечай по-русски, кратко и по делу, опираясь ТОЛЬКО на эти материалы. Если материала недостаточно — честно это скажи, не выдумывай. На факты ссылайся на источник в квадратных скобках, например [1], [2].",
    },
    { role: "user", content: `Запрос: ${query}\n\nМатериалы:\n${chunks.join("\n\n---\n\n")}` },
  ]);
  return { answer, sources };
}

/**
 * Answer a query using live web search. Chain: Gemini Grounding with Google
 * Search first (best quality; model from GEMINI_SEARCH_MODEL, default
 * gemini-3.6-flash; requires billing), then a self-hosted OpenSERP search
 * (keyless real-time, default http://127.0.0.1:7000), then the keyless
 * Wikipedia API, and finally model knowledge with an honesty caveat.
 */
export async function completeCloudWithSearch(query: string): Promise<GroundedAnswer> {
  const key = process.env.GEMINI_API_KEY;
  const configured = process.env.GEMINI_SEARCH_MODEL?.trim();
  const modelCandidates = [configured ?? "gemini-3.6-flash", "gemini-2.5-flash"].filter(
    (m): m is string => Boolean(m),
  );
  const models = key ? [...new Set(modelCandidates)] : [];
  let lastError: unknown = null;
  for (const model of models) {
    if (!key) break;
    try {
      const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: query }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const data = (await res.json().catch(() => null)) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
          groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
        }>;
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        throw new Error(`gemini ${res.status}: ${data?.error?.message ?? res.statusText}`);
      }
      const candidate = data?.candidates?.[0];
      const answer = candidate?.content?.parts?.map((p) => p.text ?? "").join("").trim();
      if (!answer) throw new Error("empty grounding response");
      const sources: string[] = [];
      for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
        const uri = chunk.web?.uri;
        if (uri && !sources.includes(uri)) sources.push(uri);
      }
      return { answer, sources: sources.slice(0, 5) };
    } catch (err) {
      lastError = err;
      console.warn(`[search] ${model} grounding failed:`, err);
    }
  }
  // Keyless real-time search via local OpenSERP before the Wikipedia fallback.
  const serp = await openSerpSearch(query);
  if (serp) return serp;
  // Last-resort keyless fallback.
  try {
    return await wikipediaSearch(query);
  } catch {
    // Nothing browsable found — answer from model knowledge (cutoff warning).
    try {
      const answer = await completeCloud([
        {
          role: "system",
          content:
            "Ты — поисковик без живого доступа в интернет. Отвечай по своим знаниям; если информация может быть неактуальной, честно это отметь. Отвечай по-русски, лаконично и по делу.",
        },
        { role: "user", content: query },
      ]);
      return { answer, sources: [] };
    } catch {
      throw lastError ?? new Error("search failed");
    }
  }
}
