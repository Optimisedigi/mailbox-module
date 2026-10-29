/**
 * Codex Responses SSE stream -> canonical LLMResponse.
 *
 * The Codex endpoint streams Server-Sent Events. The adapter reads the stream
 * to completion and hands the parsed events here, which assembles a single
 * non-streaming LLMResponse (matching how the other adapters return).
 *
 * Relevant Responses events (verified against the openai responses event shape
 * used by the Codex backend):
 *   - response.output_item.done   — a completed output item (message / function_call)
 *   - response.completed          — terminal; carries final status + usage
 *   - response.failed / error     — terminal error
 *
 * We assemble from `response.output_item.done` items (each carries the full
 * content of one item, so we don't need to accumulate deltas) and read usage +
 * status from the final `response.completed` event.
 */

import type { LLMResponse, Message, StopReason, ContentPart, CredentialSource } from "../types";
import { sanitizeToolUseId } from "./_tool-id";

/** A parsed SSE event (already JSON-decoded from a `data:` line). */
export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

interface CodexOutputTextPart {
  type: "output_text" | "refusal";
  text?: string;
  refusal?: string;
}

interface CodexMessageItem {
  type: "message";
  role: string;
  content: CodexOutputTextPart[];
}

interface CodexFunctionCallItem {
  type: "function_call";
  call_id?: string;
  id?: string;
  name: string;
  arguments?: string;
}

interface CodexReasoningItem {
  type: "reasoning";
  encrypted_content?: string;
  [key: string]: unknown;
}

type CodexOutputItem = CodexMessageItem | CodexFunctionCallItem | CodexReasoningItem | { type: string };

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

interface CodexCompletedResponse {
  status?: string;
  usage?: CodexUsage;
  model?: string;
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function codexErrorMessage(prefix: string, message: string, requestId?: unknown): string {
  const suffix = typeof requestId === "string" && requestId.length > 0 ? ` request_id=${requestId}` : "";
  const lower = message.toLowerCase();
  const usageHint = /usage|rate.?limit|quota|too many requests|capacity/.test(lower)
    ? " ChatGPT subscription usage limit or rate limit reached; retry after the reset window or use a fallback model."
    : "";
  const modelHint = /model|not available|not found|unsupported|does not exist|not enabled/.test(lower)
    ? " Codex model may be unavailable for this ChatGPT account; choose another GPT Codex model."
    : "";
  return `${prefix}: ${message}${usageHint}${modelHint}${suffix}`;
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
 * Assemble a canonical LLMResponse from a fully-consumed Codex SSE event list.
 * Throws on a terminal error event so the adapter maps it to an HttpError and
 * the fallback chain engages.
 */
export function fromCodex(
  events: CodexEvent[],
  canonicalModel: string,
  source: CredentialSource,
): LLMResponse {
  const content: ContentPart[] = [];
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let providerModel = canonicalModel;
  let completed: CodexCompletedResponse | undefined;
  let hasToolUse = false;

  for (const ev of events) {
    if (ev.type === "error") {
      const nested = ev.error as { message?: string; code?: string } | undefined;
      const message =
        nested?.message ||
        nested?.code ||
        (ev.message as string) ||
        (ev.code as string) ||
        "Codex stream error";
      throw new Error(codexErrorMessage("Codex error", message, ev.request_id));
    }
    if (ev.type === "response.failed") {
      const resp = ev.response as { error?: { message?: string; code?: string }; id?: string } | undefined;
      const message = resp?.error?.message || resp?.error?.code || "Codex response failed";
      throw new Error(codexErrorMessage("Codex error", message, resp?.id ?? ev.request_id));
    }

    if (ev.type === "response.output_item.done") {
      const item = ev.item as CodexOutputItem | undefined;
      if (!item) continue;
      if (item.type === "message") {
        const msg = item as CodexMessageItem;
        const text = (msg.content ?? [])
          .map((c) => (c.type === "output_text" ? c.text ?? "" : ""))
          .join("");
        if (text.length > 0) content.push({ type: "text", text });
      } else if (item.type === "reasoning") {
        const reasoning = item as CodexReasoningItem;
        if (typeof reasoning.encrypted_content === "string" && reasoning.encrypted_content.length > 0) {
          content.push({ type: "raw", provider: "openai-codex", value: { ...reasoning } });
        }
      } else if (item.type === "function_call") {
        const fc = item as CodexFunctionCallItem;
        const rawId = fc.call_id ?? fc.id ?? "";
        content.push({
          type: "tool_use",
          id: sanitizeToolUseId(rawId),
          name: fc.name,
          input: safeParseJson(fc.arguments ?? "{}"),
        });
        hasToolUse = true;
      }
      continue;
    }

    if (
      ev.type === "response.completed" ||
      ev.type === "response.done" ||
      ev.type === "response.incomplete"
    ) {
      completed = ev.response as CodexCompletedResponse | undefined;
    }
  }

  if (completed?.usage) {
    const cached = completed.usage.input_tokens_details?.cached_tokens ?? 0;
    const totalInput = completed.usage.input_tokens ?? 0;
    usage = {
      // Codex includes cached tokens in input_tokens; subtract to get the
      // non-cached input, mirroring the OpenAI Responses accounting.
      inputTokens: Math.max(0, totalInput - cached),
      outputTokens: completed.usage.output_tokens ?? 0,
      cacheReadTokens: cached,
    };
  }
  if (completed?.model) providerModel = completed.model;

  const message: Message = { role: "assistant", content };
  return {
    message,
    stopReason: mapStatus(completed?.status, hasToolUse),
    usage,
    model: canonicalModel,
    providerModel,
    source,
  };
}
