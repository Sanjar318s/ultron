/**
 * WebLLM provider — a fully offline model that runs in the browser via
 * WebGPU/WASM. No key, no server, no cloud.
 *
 * Deliberately lazy: nothing is downloaded until load() is called (the user
 * clicks "load" in the UI), because the first run pulls 1–3 GB of weights.
 * available() returns true only after the engine is actually loaded, so the
 * router never triggers the download on its own.
 */

import type { ChatMessage, CompleteOptions, LLMProvider } from "./types";

export const WEBLLM_MODEL = "Qwen2.5-3B-Instruct-q4f16_1-MLC";

export interface WebLLMStatus {
  /** true once the engine finished loading and can answer. */
  loaded: boolean;
  /** 0..1 download/load progress. */
  progress: number;
  message: string;
  /** true while a load is in flight. */
  loading: boolean;
  /** last load error, if any. */
  error: string | null;
}

type EngineLike = {
  chat: {
    completions: {
      create(opts: {
        messages: ChatMessage[];
        temperature?: number;
        max_tokens?: number;
      }): Promise<{ choices?: { message?: { content?: string } }[] }>;
    };
  };
};

interface WebLLMModule {
  CreateMLCEngine(
    model: string,
    opts?: { initProgressCallback?: (progress: { progress: number; text: string }) => void },
  ): Promise<EngineLike>;
}

const status: WebLLMStatus = { loaded: false, progress: 0, message: "не загружена", loading: false, error: null };

let enginePromise: Promise<EngineLike> | null = null;

async function getEngine(): Promise<EngineLike> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const mod = (await import("@mlc-ai/web-llm")) as unknown as WebLLMModule;
      status.loading = true;
      try {
        const engine = await mod.CreateMLCEngine(WEBLLM_MODEL, {
          initProgressCallback: (p) => {
            status.progress = p.progress;
            status.message = p.text;
          },
        });
        status.loaded = true;
        status.progress = 1;
        status.error = null;
        return engine;
      } catch (err) {
        status.error = err instanceof Error ? err.message : String(err);
        enginePromise = null;
        throw err;
      } finally {
        status.loading = false;
      }
    })();
  }
  return enginePromise;
}

export function getWebLLMStatus(): WebLLMStatus {
  return status;
}

/** Kick off the (potentially multi-GB) model download + engine init. */
export async function loadWebLLMEngine(): Promise<void> {
  await getEngine();
}

export function createWebLLMProvider(): LLMProvider {
  return {
    id: "webllm",
    label: "WebLLM",
    enabled: () => true,
    available: () => status.loaded,
    async complete(messages, opts) {
      const engine = await getEngine();
      const res = await engine.chat.completions.create({
        messages,
        temperature: opts?.temperature ?? 0.3,
        max_tokens: opts?.maxTokens ?? 1024,
      });
      const content = res.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("[llm] webllm returned empty content");
      return content;
    },
  };
}
