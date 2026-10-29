/**
 * OpenAI Chat Completions response -> canonical LLMResponse.
 */

import type { LLMResponse, Message, StopReason, ContentPart, CredentialSource } from "../types";
import { sanitizeToolUseId } from "./_tool-id";

interface OpenAIChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    /**
     * Kimi (Moonshot) and a few other thinking-capable OpenAI-compatible
     * providers emit the model's chain-of-thought here. We capture it on the
     * canonical Message so it can be replayed on the next request — Kimi
     * K2.5+ requires this when an assistant message has tool_calls.
     */
    reasoning_content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason: string | null;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

function mapFinishReason(r: string | null): StopReason {
  switch (r) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
    case null:
      return "error";
    default:
      return "error";
  }
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Strip inline reasoning blocks (`<think>...</think>`, `<thinking>...</thinking>`,
 * `<|thinking|>...<|/thinking|>`) from the visible assistant content.
 *
 * Some OpenAI-compatible providers (Kimi, GLM, Qwen, DeepSeek-R1) emit
 * chain-of-thought inline in `content` even when they ALSO populate
 * `reasoning_content`. Without scrubbing, the user sees the raw scratchpad
 * ("<think>Now I can calculate...") rendered as plain markdown in the chat.
 *
 * Conservative: only matches the well-known wrappers, leaves all other text
 * (including code blocks that legitimately contain the word "think") alone.
 * Anything between the opening and closing tag (across newlines) is removed,
 * and any unmatched leading `<think>` followed by no closer is also dropped
 * up to the first blank line so partial streams don't leak.
 */
function stripInlineThinking(text: string): string {
  let out = text;
  // Paired wrappers, non-greedy across newlines.
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");
  out = out.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  out = out.replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, "");
  // Unclosed opener at the very start (truncated reasoning block) — drop
  // until the first blank line so we don't strip the whole reply.
  out = out.replace(/^\s*<think>[\s\S]*?(?:\n\s*\n|$)/i, "");
  return out.trimStart();
}

export function fromOpenAI(
  json: unknown,
  canonicalModel: string,
  source: CredentialSource,
): LLMResponse {
  const r = json as OpenAIResponse;
  const choice = r.choices?.[0];
  if (!choice) {
    return {
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
      stopReason: "error",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: canonicalModel,
      providerModel: r.model ?? canonicalModel,
      source,
    };
  }
  const content: ContentPart[] = [];
  if (choice.message.content) {
    const cleaned = stripInlineThinking(choice.message.content);
    if (cleaned.length > 0) {
      content.push({ type: "text", text: cleaned });
    }
  }
  for (const tc of choice.message.tool_calls ?? []) {
    // Sanitise upstream provider IDs at the boundary so the canonical history
    // is always safe to ship to Anthropic on a later turn (model switch /
    // fallback). Same id deterministically maps to the same sanitised form,
    // so the matching tool_result still pairs correctly.
    content.push({
      type: "tool_use",
      id: sanitizeToolUseId(tc.id),
      name: tc.function.name,
      input: safeParseJson(tc.function.arguments),
    });
  }
  const message: Message = { role: "assistant", content };
  // Preserve provider-emitted reasoning so the next turn's request can echo
  // it back. Without this, Kimi thinking-mode 400s on the second tool turn.
  if (typeof choice.message.reasoning_content === "string" && choice.message.reasoning_content.length > 0) {
    message.reasoningContent = choice.message.reasoning_content;
  }
  return {
    message,
    stopReason: mapFinishReason(choice.finish_reason),
    usage: {
      inputTokens: r.usage?.prompt_tokens ?? 0,
      outputTokens: r.usage?.completion_tokens ?? 0,
      cacheReadTokens: r.usage?.prompt_tokens_details?.cached_tokens,
    },
    model: canonicalModel,
    providerModel: r.model ?? canonicalModel,
    source,
  };
}
