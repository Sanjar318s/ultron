/**
 * OpenAI-compatible chat-completion client.
 *
 * Covers three providers with one wire protocol (/v1/chat/completions):
 *  - OpenAI & Groq run in the cloud, so their keys must never reach the
 *    browser — the client posts to our own /api/llm proxy, which injects
 *    the key server-side.
 *  - Ollama runs locally and needs no key, so the client talks to it
 *    directly at OLLAMA_URL.
 */

import type { ChatMessage, CompleteOptions, LLMProvider } from "./types";

export interface CloudFlags {
  openai: boolean;
  groq: boolean;
  deepseek: boolean;
  gemini: boolean;
}

export function createOpenAICloudProvider(
  id: "openai" | "groq" | "deepseek",
  label: string,
  flags: CloudFlags,
): LLMProvider {
  return {
    id,
    label,
    enabled: () => flags[id],
    available: () => flags[id],
    async complete(messages, opts) {
      const res = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: id, messages, temperature: opts?.temperature, maxTokens: opts?.maxTokens }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(`[llm] ${id} failed: ${res.status} ${body?.error ?? ""}`);
      }
      const data = (await res.json()) as { content?: string };
      const content = data.content?.trim();
      if (!content) throw new Error(`[llm] ${id} returned empty content`);
      return content;
    },
  };
}

interface OllamaState {
  reachable: boolean;
  checkedAt: number;
}

const OLLAMA_PROBE_TTL = 15_000;

export function createOllamaProvider(
  baseUrl: string,
  model: string,
  label = "Ollama",
): LLMProvider {
  const state: OllamaState = { reachable: false, checkedAt: 0 };

  async function probe(): Promise<boolean> {
    const now = Date.now();
    if (now - state.checkedAt < OLLAMA_PROBE_TTL) return state.reachable;
    state.checkedAt = now;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1200);
      const res = await fetch(`${baseUrl}/api/tags`, { signal: ctrl.signal });
      clearTimeout(timer);
      state.reachable = res.ok;
    } catch {
      state.reachable = false;
    }
    return state.reachable;
  }

  return {
    id: "ollama",
    label,
    enabled: () => true,
    available: probe,
    async complete(messages, opts) {
      // Native /api/chat — the OpenAI-compat endpoint makes qwen3 burn its
      // whole token budget on thinking and return empty content.
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          think: false,
          options: {
            temperature: opts?.temperature ?? 0.3,
            num_predict: opts?.maxTokens ?? 1024,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(`[llm] ollama failed: ${res.status} ${body?.error ?? ""}`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      const content = data.message?.content?.trim();
      if (!content) throw new Error("[llm] ollama returned empty content");
      return content;
    },
  };
}
