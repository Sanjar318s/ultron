/**
 * createAssistantLLM — assembles the full provider chain + router for the
 * assistant. Cloud providers (OpenAI/DeepSeek/Gemini) read their "configured"
 * flag from a shared CloudFlags object that is refreshed from the server
 * (/api/llm GET) so the browser knows which keys exist without ever seeing
 * the keys themselves.
 */

import { createGeminiProvider } from "./gemini";
import { createOpenAICloudProvider, createOllamaProvider, type CloudFlags } from "./openaiCompat";
import { createWebLLMProvider } from "./webllm";
import { LLMRouter } from "./router";

export interface AssistantLLM {
  router: LLMRouter;
  cloud: CloudFlags;
  /** Fetch which cloud keys exist on the server and update `cloud`. */
  refresh(): Promise<void>;
}

export function createAssistantLLM(): AssistantLLM {
  const cloud: CloudFlags = { openai: false, deepseek: false, gemini: false };

  const openai = createOpenAICloudProvider("openai", "OpenAI", cloud);
  const deepseek = createOpenAICloudProvider("deepseek", "DeepSeek", cloud);
  const gemini = createGeminiProvider(cloud);
  const ollama = createOllamaProvider("http://localhost:11434", "qwen3:8b");
  const webllm = createWebLLMProvider();

  // Active chain is local-first. OpenAI/DeepSeek stay defined (their keys may
  // be funded later) but are filtered out of the order, so the router never
  // waits on their timeouts.
  const router = new LLMRouter(
    [webllm, ollama, openai, deepseek, gemini],
    ["ollama", "gemini", "webllm"],
  );

  const refresh = async () => {
    try {
      const res = await fetch("/api/llm");
      if (!res.ok) return;
      const flags = (await res.json()) as Partial<CloudFlags>;
      cloud.openai = Boolean(flags.openai);
      cloud.deepseek = Boolean(flags.deepseek);
      cloud.gemini = Boolean(flags.gemini);
    } catch {
      // Dev server not ready yet — cloud providers stay disabled for now.
    }
  };

  return { router, cloud, refresh };
}
