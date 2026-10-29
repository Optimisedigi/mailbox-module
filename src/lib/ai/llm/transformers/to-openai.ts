/**
 * Canonical -> OpenAI Chat Completions API request body.
 *
 * Used by the OpenAI-compatible adapter for Kimi (Moonshot) and MiniMax.
 * Tool calls map to `tool_calls` array on assistant messages; tool results
 * map to messages with role='tool' and tool_call_id.
 */

import type { CallLLMOptions } from "../types";

type OpenAIUserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAIUserContentPart[] | null;
  /**
   * Kimi (Moonshot) thinking-mode contract: when an assistant message
   * carries tool_calls, the API requires `reasoning_content` to be present
   * — even as an empty string — on subsequent requests, otherwise it 400s
   * with "thinking is enabled but reasoning_content is missing".
   * Other OpenAI-compatible providers ignore this field harmlessly.
   */
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface OpenAIRequestBody {
  model: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  messages: OpenAIMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
}

/**
 * OpenAI's reasoning / GPT-5-class models reject any `temperature` other than
 * the default of 1 ("invalid temperature: only 1 is allowed for this model").
 * For these we must omit the field entirely rather than send our usual value.
 * Matches gpt-5* (incl. gpt-5.5) and the o-series (o1/o3/o4...).
 */
function modelOnlyAllowsDefaultTemperature(providerModel: string): boolean {
  return /^(gpt-[56]|o\d)/i.test(providerModel);
}

export function toOpenAI(opts: CallLLMOptions, providerModel: string): OpenAIRequestBody {
  const messages: OpenAIMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });

  for (const m of opts.messages) {
    if (m.role === "system") {
      // Already injected above; ignore additional system messages mid-stream.
      continue;
    }

    if (m.role === "tool") {
      // Each tool_result becomes its own role:'tool' message.
      for (const part of m.content) {
        if (part.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: part.toolUseId,
            content: part.content,
          });
        }
      }
      continue;
    }

    if (m.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
      for (const part of m.content) {
        if (part.type === "text") textParts.push(part.text);
        else if (part.type === "tool_use") {
          toolCalls.push({
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.input) },
          });
        }
      }
      const message: OpenAIMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("") : null,
      };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
        // Kimi thinking-mode contract: assistant tool_calls must carry
        // reasoning_content. Use the captured value if we have one; fall
        // back to "" so the field is always present. Other OpenAI-compatible
        // providers ignore it.
        message.reasoning_content = m.reasoningContent ?? "";
      }
      messages.push(message);
      continue;
    }

    // user role
    const userContentParts: OpenAIUserContentPart[] = [];
    const userToolResults: OpenAIMessage[] = [];
    for (const part of m.content) {
      if (part.type === "text") {
        userContentParts.push({ type: "text", text: part.text });
      } else if (part.type === "image") {
        userContentParts.push({
          type: "image_url",
          image_url: { url: `data:${part.mediaType};base64,${part.data}` },
        });
      } else if (part.type === "tool_result") {
        // tool_result on a user message: emit as separate role:'tool' message
        userToolResults.push({
          role: "tool",
          tool_call_id: part.toolUseId,
          content: part.content,
        });
      }
    }
    if (userContentParts.length > 0) {
      const hasImage = userContentParts.some((part) => part.type === "image_url");
      messages.push({
        role: "user",
        content: hasImage
          ? userContentParts
          : userContentParts
              .filter((part): part is Extract<OpenAIUserContentPart, { type: "text" }> => part.type === "text")
              .map((part) => part.text)
              .join(""),
      });
    }
    messages.push(...userToolResults);
  }

  const body: OpenAIRequestBody = {
    model: providerModel,
    messages,
  };
  // GPT-6 and Xiaomi MiMo use the Chat Completions completion budget field.
  if (providerModel.startsWith("gpt-6-") || providerModel.startsWith("mimo-")) {
    body.max_completion_tokens = opts.maxTokens ?? 4096;
  } else {
    body.max_tokens = opts.maxTokens ?? 4096;
  }
  // Only send temperature when the model actually accepts a non-default value.
  if (
    opts.temperature !== undefined &&
    !modelOnlyAllowsDefaultTemperature(providerModel)
  ) {
    body.temperature = opts.temperature;
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }
  return body;
}
