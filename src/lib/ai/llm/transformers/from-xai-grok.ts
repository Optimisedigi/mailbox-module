/**
 * xAI Grok (cli-chat-proxy) non-streaming Responses JSON -> canonical LLMResponse.
 *
 * The grok-cli proxy speaks the OpenAI Responses API. We send `stream:false`
 * and get a single JSON document with an `output` array of items
 * (type reasoning | message | function_call), plus `usage` and `status`.
 * This mirrors the item shapes from-codex.ts assembles from SSE, but here they
 * arrive in one response so we read them directly.
 *
 * Shape of cli-chat-proxy.grok.com/v1/responses.
 */

import type { LLMResponse, Message, StopReason, ContentPart, CredentialSource } from "../types";
import { sanitizeToolUseId } from "./_tool-id";

interface GrokOutputTextPart {
  type: "output_text" | "refusal";
  text?: string;
  refusal?: string;
}

interface GrokMessageItem {
  type: "message";
  role: string;
  content: GrokOutputTextPart[];
}

interface GrokFunctionCallItem {
  type: "function_call";
  call_id?: string;
  id?: string;
  name: string;
  arguments?: string;
}

type GrokOutputItem = GrokMessageItem | GrokFunctionCallItem | { type: string };

interface GrokUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

interface GrokResponse {
  output?: GrokOutputItem[];
  usage?: GrokUsage;
  model?: string;
  status?: string;
  error?: { message?: string; code?: string } | string;
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapStatus(status: string | undefined, hasToolUse: boolean): StopReason {
  switch (status) {
    case "completed":
      return hasToolUse ? "tool_use" : "end_turn";
    case "incomplete":
      return "max_tokens";
    case "failed":
    case "cancelled":
      return "error";
    default:
      return hasToolUse ? "tool_use" : "end_turn";
  }
}

/**
 * Assemble a canonical LLMResponse from a fully-parsed grok Responses JSON
 * document. Throws on a terminal error so the adapter maps it to an HttpError
 * and the fallback chain engages.
 */
export function fromXaiGrok(
  json: unknown,
  canonicalModel: string,
  source: CredentialSource,
): LLMResponse {
  const resp = (typeof json === "object" && json !== null ? json : {}) as GrokResponse;

  if (resp.error) {
    const message =
      typeof resp.error === "string"
        ? resp.error
        : resp.error.message || resp.error.code || "Grok response error";
    throw new Error(`Grok error: ${message}`);
  }

  const content: ContentPart[] = [];
  let hasToolUse = false;

  for (const item of resp.output ?? []) {
    if (item.type === "message") {
      const msg = item as GrokMessageItem;
      const text = (msg.content ?? [])
        .map((c) => (c.type === "output_text" ? c.text ?? "" : ""))
        .join("");
      if (text.length > 0) content.push({ type: "text", text });
    } else if (item.type === "function_call") {
      const fc = item as GrokFunctionCallItem;
      const rawId = fc.call_id ?? fc.id ?? "";
      content.push({
        type: "tool_use",
        id: sanitizeToolUseId(rawId),
        name: fc.name,
        input: safeParseJson(fc.arguments ?? "{}"),
      });
      hasToolUse = true;
    }
    // `reasoning` items carry only a summary; we drop them (no signature to
    // replay on this backend).
  }

  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  if (resp.usage) {
    const cached = resp.usage.input_tokens_details?.cached_tokens ?? 0;
    const totalInput = resp.usage.input_tokens ?? 0;
    usage = {
      inputTokens: Math.max(0, totalInput - cached),
      outputTokens: resp.usage.output_tokens ?? 0,
      cacheReadTokens: cached,
    };
  }

  const message: Message = { role: "assistant", content };
  return {
    message,
    stopReason: mapStatus(resp.status, hasToolUse),
    usage,
    model: canonicalModel,
    providerModel: resp.model ?? canonicalModel,
    source,
  };
}
