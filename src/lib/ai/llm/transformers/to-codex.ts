/**
 * Canonical CallLLMOptions -> Codex Responses API request body.
 *
 * Adapted from gg-framework (MIT, see THIRD_PARTY_NOTICES.md). Request shape:
 *   - the caller's system prompt is sent as the top-level `instructions`
 *     string (NOT a Codex sentinel, NOT a developer-role message),
 *   - messages map to Responses `input` items,
 *   - tool_call IDs are remapped to the `fc_` prefix the Codex backend
 *     requires (Anthropic-style `toolu_*` IDs are rejected),
 *   - body carries store:false, stream:true, tool_choice:auto,
 *     parallel_tool_calls:true, include:["reasoning.encrypted_content"],
 *     and reasoning:{ effort, summary:"auto" }.
 *
 * Input item mapping:
 *   - user text   -> { role:"user", content:[{type:"input_text"}] }
 *   - assistant text -> { type:"message", role:"assistant",
 *                         content:[{type:"output_text", annotations:[]}], status:"completed" }
 *   - tool_use    -> { type:"function_call", id, call_id, name, arguments }
 *   - tool_result -> { type:"function_call_output", call_id, output }
 */

import type { CallLLMOptions, ReasoningMode } from "../types";
import type { CodexEffort } from "../registry";

type CodexInputContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "output_text"; text: string; annotations: [] };

type CodexReasoningInputItem = { type: "reasoning"; encrypted_content?: string; [key: string]: unknown };

type CodexInputItem =
  | { role: "user"; content: CodexInputContentPart[] }
  | {
      type: "message";
      role: "assistant";
      content: CodexInputContentPart[];
      status: "completed";
    }
  | CodexReasoningInputItem
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface CodexRequestBody {
  model: string;
  /** Codex backend never persists; we always send a one-shot request. */
  store: false;
  /** The endpoint streams SSE; the adapter assembles it to a single response. */
  stream: true;
  instructions: string;
  input: CodexInputItem[];
  tool_choice: "auto";
  parallel_tool_calls: true;
  include?: string[];
  tools?: Array<{
    type: "function";
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: null;
  }>;
  temperature?: number;
  reasoning?: { effort: CodexEffort; summary: "auto" };
  /** Prompt-cache scope key. Set by the adapter (pinned on both the body and
   *  the session_id/x-client-request-id headers). */
  prompt_cache_key?: string;
}

const CODEX_SAFE_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Remap a tool-call id to the `fc_` prefix Codex requires.
 *
 * Splits composite `callId|itemId` values,
 * strip Anthropic's `toolu_` prefix, sanitize provider-specific characters,
 * and avoid collisions after sanitization.
 */
export function remapCodexId(id: string, idMap: Map<string, string>, usedIds: Set<string>): string {
  const existing = idMap.get(id);
  if (existing) return existing;

  const baseId = (typeof id === "string" && id.length > 0 ? id : "unknown").split("|")[0] || "unknown";
  const withoutAnthropicPrefix = baseId.replace(/^toolu_/, "");
  const withCodexPrefix =
    withoutAnthropicPrefix.startsWith("fc_") || withoutAnthropicPrefix.startsWith("fc-")
      ? withoutAnthropicPrefix
      : `fc_${withoutAnthropicPrefix}`;
  const sanitized = withCodexPrefix.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fallback = CODEX_SAFE_ID.test(sanitized) ? sanitized : "fc_unknown";

  let mapped = fallback;
  let suffix = 2;
  while (usedIds.has(mapped)) {
    mapped = `${fallback}_${suffix}`;
    suffix += 1;
  }

  idMap.set(id, mapped);
  usedIds.add(mapped);
  return mapped;
}

export function toCodex(
  opts: CallLLMOptions,
  providerModel: string,
  config: { reasoningMode: ReasoningMode },
): CodexRequestBody {
  const input: CodexInputItem[] = [];
  const idMap = new Map<string, string>();
  const usedIds = new Set<string>();

  for (const m of opts.messages) {
    if (m.role === "system") {
      // System messages mid-stream are folded into `instructions` below via
      // opts.system; ignore here (only opts.system is honoured).
      continue;
    }

    if (m.role === "user") {
      const content: CodexInputContentPart[] = [];
      for (const part of m.content) {
        if (part.type === "text") {
          content.push({ type: "input_text", text: part.text });
        } else if (part.type === "image") {
          content.push({
            type: "input_image",
            image_url: `data:${part.mediaType};base64,${part.data}`,
          });
        } else if (part.type === "tool_result") {
          // tool_result on a user message -> standalone function_call_output.
          input.push({
            type: "function_call_output",
            call_id: remapCodexId(part.toolUseId, idMap, usedIds),
            output: part.content,
          });
        }
      }
      if (content.length > 0) input.push({ role: "user", content });
      continue;
    }

    if (m.role === "assistant") {
      for (const part of m.content) {
        if (part.type === "text") {
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: part.text, annotations: [] }],
            status: "completed",
          });
        } else if (part.type === "raw" && part.provider === "openai-codex") {
          input.push({ ...part.value, type: "reasoning" } as CodexReasoningInputItem);
        } else if (part.type === "tool_use") {
          const mapped = remapCodexId(part.id, idMap, usedIds);
          input.push({
            type: "function_call",
            id: mapped,
            call_id: mapped,
            name: part.name,
            arguments: JSON.stringify(part.input),
          });
        }
      }
      continue;
    }

    if (m.role === "tool") {
      for (const part of m.content) {
        if (part.type === "tool_result") {
          input.push({
            type: "function_call_output",
            call_id: remapCodexId(part.toolUseId, idMap, usedIds),
            output: part.content,
          });
        }
      }
      continue;
    }
  }

  const body: CodexRequestBody = {
    model: providerModel,
    store: false,
    stream: true,
    // The caller's system prompt IS the instructions string.
    // The Codex Responses endpoint REQUIRES a non-empty instructions field
    // (it 400s with {"detail":"Instructions are required"} otherwise), so fall
    // back to a minimal instruction when the caller didn't supply a system
    // prompt (e.g. the auth probe).
    instructions:
      opts.system && opts.system.trim().length > 0
        ? opts.system
        : "You are a helpful assistant.",
    input,
    tool_choice: "auto",
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    reasoning: {
      effort: config.reasoningMode === "off" ? "none" : config.reasoningMode,
      summary: "auto",
    },
  };
  // Codex gets no temperature.
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: null,
    }));
  }
  return body;
}
