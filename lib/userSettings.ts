/**
 * Per-chat model presets: which provider the assistant tries FIRST and with
 * which Gemini model. Lives in data/user-settings.json (gitignored runtime
 * state). Pure data helpers here are node-loadable (no `@/`) so self-test can
 * verify the preset→chain mapping.
 *
 * Presets:
 *   ⚡ flash — Gemini Flash-lite first, then local Ollama.
 *   🧠 pro   — Gemini Pro first, then local Ollama.
 *   🏠 local — Ollama first, then Gemini. Fully offline answer path when the
 *              local model is healthy, free and unlimited.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ModelPreset = "flash" | "pro" | "local";
export type PresetProvider = "gemini" | "ollama";

export interface ModelPresetInfo {
  id: ModelPreset;
  emoji: string;
  label: string;
  hint: string;
}

export const MODEL_PRESETS: Record<ModelPreset, ModelPresetInfo> = {
  flash: { id: "flash", emoji: "⚡", label: "Быстрый Flash", hint: "молниеносные ответы" },
  pro: { id: "pro", emoji: "🧠", label: "Глубокий Pro", hint: "максимум качества" },
  local: { id: "local", emoji: "🏠", label: "Локальный Ollama", hint: "приватно, без интернета" },
};

export const DEFAULT_PRESET: ModelPreset = "local";

/** Provider order a preset prefers (fallbacks come after the first pick). */
export const PRESET_CHAIN: Record<ModelPreset, PresetProvider[]> = {
  flash: ["gemini", "ollama"],
  pro: ["gemini", "ollama"],
  local: ["ollama", "gemini"],
};

/** Gemini model to use when the preset's chain reaches Gemini. */
export const PRESET_GEMINI_MODEL: Record<ModelPreset, string> = {
  flash: "gemini-3.1-flash-lite",
  pro: "gemini-3.6-flash",
  local: "gemini-3.1-flash-lite",
};

const FILE = path.join(process.cwd(), "data", "user-settings.json");

interface UserSettingsFile {
  preset?: Record<string, ModelPreset>;
}

function load(): UserSettingsFile {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as UserSettingsFile;
  } catch {
    return {};
  }
}

function save(s: UserSettingsFile): void {
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2));
}

export function getUserPreset(chatId: string): ModelPreset {
  const p = load().preset?.[String(chatId ?? "anon")];
  return p && MODEL_PRESETS[p] ? p : DEFAULT_PRESET;
}

/** Persist the preset; returns the stored (sanitized) value. */
export function setUserPreset(chatId: string, preset: ModelPreset): ModelPreset {
  const safe: ModelPreset = MODEL_PRESETS[preset] ? preset : DEFAULT_PRESET;
  const s = load();
  s.preset = { ...(s.preset ?? {}), [String(chatId ?? "anon")]: safe };
  save(s);
  return safe;
}

export function isPresetFilePresent(): boolean {
  return existsSync(FILE);
}
