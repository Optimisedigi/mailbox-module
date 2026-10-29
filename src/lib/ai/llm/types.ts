/**
 * Canonical LLM types.
 *
 * Provider-agnostic shapes the agent code sees. Adapters and transformers
 * are the only modules that ever speak provider dialects; everything else
 * (the agent loop, the tool layer, the activity log) reads and writes
 * these canonical shapes.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  /**
   * Extended-thinking block emitted by Anthropic-format models when thinking
   * is enabled (native Claude with the thinking param, and MiniMax-M3 which
   * defaults thinking on). The `signature` is Anthropic's cryptographic seal
   * over the thinking text; it MUST be replayed unchanged on subsequent turns
   * of a tool-use conversation, and a thinking block WITHOUT a signature must
   * be dropped on replay (the API rejects empty signatures).
   */
  | { type: "thinking"; text: string; signature?: string }
  /**
   * Encrypted ("redacted") thinking block. Opaque to us — we never read the
   * `data`, we only round-trip it verbatim so the model's reasoning chain
   * stays valid across turns.
   */
  | { type: "redacted_thinking"; data: string }
  /**
   * Opaque provider-native content that must be round-tripped verbatim.
   *
   * Used for Codex Responses `reasoning` output items containing
   * `encrypted_content`; the app must not inspect or mutate the payload, only
   * replay it before the related function calls on later turns.
   */
  | { type: "raw"; provider: "openai-codex"; value: Record<string, unknown> };

export interface Message {
  role: Role;
  content: ContentPart[];
  /**
   * Provider-emitted reasoning text (Kimi/Moonshot `reasoning_content`).
   * Captured on assistant messages when the provider runs in thinking mode
   * and required to be replayed in the next request — Kimi K2.5+ throws
   * 400 "thinking is enabled but reasoning_content is missing" if an
   * assistant message with tool_calls is replayed without it.
   *
   * Anthropic uses a different mechanism (thinking blocks) so this stays
   * provider-internal: only OpenAI-compatible adapters read/write it.
   */
  reasoningContent?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema, generated from a Zod schema by tool.ts */
  inputSchema: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "error";

export type CredentialSource = "oauth" | "api-key" | "api-key-fallback";

export interface LLMResponse {
  message: Message;
  stopReason: StopReason;
  usage: Usage;
  /** Canonical model name from the registry. */
  model: string;
  /** Raw model id the provider returned (for logs / audits). */
  providerModel: string;
  source: CredentialSource;
  /**
   * Models earlier in the fallback chain that failed before this one served
   * the request, with the reason each failed. Absent when the requested model
   * answered. Without this the caller only knows *that* a failover happened,
   * not why ("ChatGPT usage limit reached" vs "token expired"), which is the
   * single most useful thing to surface to the user.
   */
  fallbackFrom?: Array<{ model: string; reason: string }>;
}

export type ReasoningMode = "off" | "low" | "medium" | "high";

export interface CallLLMOptions {
  /** Canonical model name (key into MODEL_REGISTRY). */
  model: string;
  messages: Message[];
  system?: string;
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  /** If primary fails, try these in order. Each is a canonical model name. */
  fallbackModels?: string[];
  /** Hard limit on total wall time across primary + fallbacks. Default 60_000. */
  timeoutMs?: number;
  /** Per-request reasoning mode. Defaults to off for routine chat turns. */
  reasoningMode?: ReasoningMode;
}
