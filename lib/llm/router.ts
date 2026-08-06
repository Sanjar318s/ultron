/**
 * LLMRouter — picks the best available model for a request and falls back
 * down the chain on failure. Priority order is configurable at runtime
 * (setPreferred) and defaults to:
 *
 *   Gemini → Ollama → WebLLM
 *
 * (OpenAI/DeepSeek keys exist but are unfunded — removed from the active
 * chain so we don't wait on their timeouts.)
 *
 * The caller never knows (or cares) which provider answered.
 */

import type { ChatMessage, CompleteOptions, LLMProvider, LLMResult, ProviderId } from "./types";

export const DEFAULT_ORDER: ProviderId[] = ["gemini", "ollama", "webllm"];

export class LLMRouter {
  private readonly providers = new Map<ProviderId, LLMProvider>();
  private order: ProviderId[];

  constructor(providers: LLMProvider[], order: ProviderId[] = DEFAULT_ORDER) {
    for (const p of providers) this.providers.set(p.id, p);
    // Keep only providers we actually have.
    this.order = order.filter((id) => this.providers.has(id));
  }

  getPreferred(): ProviderId | null {
    return this.order[0] ?? null;
  }

  setPreferred(id: ProviderId): void {
    if (!this.providers.has(id)) return;
    this.order = [id, ...this.order.filter((x) => x !== id)];
  }

  /** Providers that are configured/potentially usable, in priority order. */
  enabledProviders(): LLMProvider[] {
    return this.order.map((id) => this.providers.get(id)).filter((p): p is LLMProvider => !!p?.enabled());
  }

  /** The next enabled provider after the current preferred one (wraps). */
  cyclePreferred(): ProviderId | null {
    const enabled = this.enabledProviders();
    if (enabled.length === 0) return null;
    const current = this.getPreferred();
    const idx = enabled.findIndex((p) => p.id === current);
    const next = enabled[(idx + 1) % enabled.length];
    this.setPreferred(next.id);
    return next.id;
  }

  async complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<LLMResult> {
    let lastError: unknown = null;
    for (const id of this.order) {
      const provider = this.providers.get(id);
      if (!provider) continue;
      try {
        const ok = await provider.available();
        if (!ok) continue;
        const content = await provider.complete(messages, opts);
        if (!content) continue;
        return { provider: id, content };
      } catch (err) {
        lastError = err;
        console.warn(`[llm] provider ${id} failed, trying next:`, err);
      }
    }
    throw lastError ?? new Error("[llm] no provider available");
  }
}
