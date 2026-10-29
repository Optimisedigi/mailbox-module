/**
 * Anthropic Messages API response -> canonical LLMResponse.
 */

import type { LLMResponse, Message, StopReason, ContentPart, CredentialSource } from "../types";

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "thinking"; thinking: string; signature?: string }
    | { type: "redacted_thinking"; data: string }
  >;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function mapStopReason(r: string | null): StopReason {
  switch (r) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "error";
  }
}

export function fromAnthropic(
  json: unknown,
  canonicalModel: string,
  source: CredentialSource,
): LLMResponse {
  const r = json as AnthropicResponse;
  // MiniMax M3's Anthropic-compatible endpoint frequently returns tool_use
  // blocks with an empty or missing `id`. Passing that through verbatim makes
  // every such block collapse to the same `t_unknown` once to-anthropic's
  // sanitiser runs, so the follow-up turn can no longer pair the tool_use with
  // its tool_result — MiniMax then 400s with
  // "invalid function arguments json string, tool_call_id: t_unknown".
  // Mint a unique id at the ingest boundary so the round-trip holds. The id
  // must be unique across the WHOLE conversation, not just this turn: the full
  // history is replayed on every request, so a per-turn index (tooluse_0) would
  // collide with the same index from an earlier turn and the API would reject
  // the duplicate. A short random token keeps each minted id globally unique
  // while still matching Anthropic's [a-zA-Z0-9_-] id pattern.
  const content: ContentPart[] = r.content.map((c) => {
    if (c.type === "text") return { type: "text", text: c.text };
    // Preserve thinking blocks (text + signature) so they can be replayed on
    // the next turn. Required by MiniMax-M3 and native Claude thinking for
    // tool-use coherence. Order is preserved from the API response, which
    // always emits thinking blocks before text/tool_use — to-anthropic relies
    // on that ordering when it replays.
    if (c.type === "thinking") {
      return {
        type: "thinking",
        text: c.thinking,
        // Default to "" when absent; to-anthropic drops unsigned thinking
        // blocks on replay (Anthropic rejects empty signatures).
        signature: c.signature ?? "",
      };
    }
    if (c.type === "redacted_thinking") {
      return { type: "redacted_thinking", data: c.data };
    }
    const id =
      typeof c.id === "string" && c.id.length > 0
        ? c.id
        : `tooluse_${Math.random().toString(36).slice(2, 12)}`;
    return {
      type: "tool_use",
      id,
      name: c.name,
      input: c.input ?? {},
    };
  });
  const message: Message = { role: "assistant", content };
  return {
    message,
    stopReason: mapStopReason(r.stop_reason),
    usage: {
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      cacheCreationTokens: r.usage.cache_creation_input_tokens,
      cacheReadTokens: r.usage.cache_read_input_tokens,
    },
    model: canonicalModel,
    providerModel: r.model,
    source,
  };
}
