/**
 * Shared types for the LLM gateway — the thin "provider abstraction" that
 * lets the assistant talk to any model (cloud or local) through one `ask()`
 * interface. Nothing outside lib/llm and the router cares which model is
 * actually answering.
 */

export type ProviderId = "openai" | "groq" | "deepseek" | "gemini" | "ollama" | "webllm";

/** Plain-text part of a message. */
export interface TextContentPart {
  type: "text";
  text: string;
}

/** Base64-encoded image part (mimeType like "image/jpeg"). */
export interface ImageContentPart {
  type: "image";
  mimeType: string;
  /** Base64 data URI body (no "data:...;base64," prefix). */
  data: string;
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/** Flattens a message's content to plain text (skips image parts). */
export function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is TextContentPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  readonly id: ProviderId;
  /** Short human-readable name shown in the UI. */
  readonly label: string;
  /** Configured / potentially usable (sync, cheap to compute). */
  enabled(): boolean;
  /** Actually reachable right now (may probe the network). */
  available(): boolean | Promise<boolean>;
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string>;
}

export interface LLMResult {
  provider: ProviderId;
  content: string;
}
