/**
 * Canonical -> Anthropic Messages API request body.
 *
 * Maps Message[] to Anthropic's content-block shape, applies a single
 * cache_control breakpoint at the end of the system prompt for prompt
 * caching (the system prompt is stable across an agent run, so caching it
 * is the highest-leverage cost reduction).
 *
 */

import type { CallLLMOptions } from "../types";
import { sanitizeToolUseId } from "./_tool-id";

type CacheControl = { cache_control?: { type: "ephemeral" } };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Array<
    | ({ type: "text"; text: string } & CacheControl)
    | ({ type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } } & CacheControl)
    | ({ type: "tool_use"; id: string; name: string; input: Record<string, unknown> } & CacheControl)
    | ({ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean } & CacheControl)
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "redacted_thinking"; data: string }
  >;
}

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: AnthropicSystemBlock[];
  messages: AnthropicMessage[];
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  /**
   * Anthropic extended-thinking config. We never set this for the native
   * Anthropic provider (its models use adaptive thinking via beta flags), but
   * the MiniMax Anthropic-compatible adapter sets `{ type: "disabled" }` so
   * MiniMax-M3 does not emit `thinking` content blocks. M3 defaults thinking
   * ON and requires emitted thinking blocks to be replayed unchanged on every
   * subsequent tool-use turn; our canonical pipeline does not carry thinking
   * blocks, so leaving thinking on makes M3 400 on the second turn.
   */
  thinking?: { type: "disabled" } | { type: "adaptive" } | { type: "enabled"; budget_tokens: number };
}

/**
 * Put a second cache breakpoint on the newest block of the conversation.
 *
 * The system-prompt breakpoint alone leaves the whole message history
 * uncached, so every tool step of a run re-sent the conversation and every
 * earlier tool result at full input price (88% of agent runs and 91% of
 * email runs take two or more steps). With this mark the next step, or the
 * next chat turn inside the cache window, reads that prefix from cache.
 * Anthropic allows four breakpoints per request; this uses the second.
 * Thinking blocks cannot carry cache_control, so they are skipped.
 *
 * Native Anthropic only: Anthropic-compatible providers are not assumed to
 * accept message-level cache_control.
 */
export function addConversationCacheBreakpoint(body: AnthropicRequestBody): void {
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const content = body.messages[i]?.content ?? [];
    for (let j = content.length - 1; j >= 0; j -= 1) {
      const block = content[j];
      if (!block || block.type === "thinking" || block.type === "redacted_thinking") continue;
      content[j] = { ...block, cache_control: { type: "ephemeral" } };
      return;
    }
  }
}

function modelRejectsTemperature(providerModel: string): boolean {
  return /^claude-/i.test(providerModel);
}

export function toAnthropic(
  opts: CallLLMOptions,
  providerModel: string,
): AnthropicRequestBody {
  // Anthropic doesn't support 'system' or 'tool' as a message role; system goes
  // in the top-level system field, tool messages are user messages with
  // tool_result content blocks.
  const messages: AnthropicMessage[] = [];
  for (const m of opts.messages) {
    if (m.role === "system") continue; // Should be lifted into opts.system instead
    if (m.role === "tool") {
      messages.push({
        role: "user",
        content: m.content
          .filter((p) => p.type === "tool_result")
          .map((p) => {
            // narrowed by filter
            const part = p as Extract<typeof p, { type: "tool_result" }>;
            return {
              type: "tool_result" as const,
              // Defensive: persisted history may predate the from-openai
              // sanitiser. Anthropic rejects ids outside [a-zA-Z0-9_-].
              tool_use_id: sanitizeToolUseId(part.toolUseId),
              content: part.content,
              ...(part.isError ? { is_error: true } : {}),
            };
          }),
      });
      continue;
    }
    const mappedContent = m.content
      // Replay hygiene:
      //  - Drop thinking blocks without a signature — Anthropic rejects an
      //    empty/missing signature, and an unsigned block carries no value to
      //    replay anyway.
      //  - Drop empty text blocks — Anthropic rejects text content blocks with
      //    an empty string, which can appear alongside a tool_use or a
      //    thinking-only emission.
      .filter((part) => {
        if (part.type === "thinking" && !part.signature) return false;
        if (part.type === "text" && part.text === "") return false;
        if (part.type === "raw") return false;
        return true;
      })
      .map((part): AnthropicMessage["content"][number] => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "image") {
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: part.mediaType,
              data: part.data,
            },
          };
        }
        if (part.type === "tool_use") {
          return { type: "tool_use", id: sanitizeToolUseId(part.id), name: part.name, input: part.input };
        }
        if (part.type === "thinking") {
          // signature presence guaranteed by the filter above.
          return { type: "thinking", thinking: part.text, signature: part.signature as string };
        }
        if (part.type === "redacted_thinking") {
          return { type: "redacted_thinking", data: part.data };
        }
        if (part.type === "tool_result") {
          // tool_result on non-tool message: treat as user content
          return {
            type: "tool_result",
            tool_use_id: sanitizeToolUseId(part.toolUseId),
            content: part.content,
            ...(part.isError ? { is_error: true } : {}),
          };
        }
        throw new Error(`Unsupported Anthropic content part: ${part.type}`);
      });

    // An assistant turn whose only content was an unsigned thinking block (now
    // filtered out) would serialise to an empty content array, which Anthropic
    // rejects. Skip it entirely — there is nothing meaningful to replay.
    if (mappedContent.length === 0) continue;

    messages.push({
      role: m.role === "assistant" ? "assistant" : "user",
      content: mappedContent,
    });
  }

  const body: AnthropicRequestBody = {
    model: providerModel,
    max_tokens: opts.maxTokens ?? 4096,
    messages,
  };
  if (opts.temperature !== undefined && !modelRejectsTemperature(providerModel)) {
    body.temperature = opts.temperature;
  }

  if (opts.system) {
    body.system = [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }];
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
  return body;
}
