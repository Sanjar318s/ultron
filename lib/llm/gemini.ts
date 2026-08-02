/**
 * Gemini provider — key injected server-side via the /api/llm proxy.
 * Gemini's REST format differs from OpenAI-compatible, so this is a
 * separate provider; the router treats it like any other.
 */

import type { ChatMessage, CompleteOptions, LLMProvider } from "./types";
import type { CloudFlags } from "./openaiCompat";

export function createGeminiProvider(flags: CloudFlags): LLMProvider {
  return {
    id: "gemini",
    label: "Gemini",
    enabled: () => flags.gemini,
    available: () => flags.gemini,
    async complete(messages, opts) {
      const res = await fetch("/api/llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gemini", messages, temperature: opts?.temperature, maxTokens: opts?.maxTokens }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(`[llm] gemini failed: ${res.status} ${body?.error ?? ""}`);
      }
      const data = (await res.json()) as { content?: string };
      const content = data.content?.trim();
      if (!content) throw new Error("[llm] gemini returned empty content");
      return content;
    },
  };
}
