/**
 * Next.js server instrumentation — runs once at process startup.
 *
 * Preloads the local Ollama model (fire-and-forget) so the first user request
 * after a restart never hits a 40-second cold load (which used to surface as
 * an ollama 500). The [warmup] instrumentation fired marker in the server log
 * proves the hook actually runs in `next start`.
 */
import { warmupOllama } from "./lib/serverLLM";

export async function register() {
  console.log("[warmup] instrumentation fired");
  void warmupOllama();
}
