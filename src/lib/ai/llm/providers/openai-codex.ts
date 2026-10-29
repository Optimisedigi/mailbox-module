/**
 * Codex (ChatGPT subscription) Responses adapter.
 *
 * Resolves the `openai-codex` OAuth credential (no API-key path exists for
 * this provider — it's OAuth-only), builds the Codex Responses request body
 * with the per-model reasoning effort, sends the Codex CLI header set, POSTs
 * to chatgpt.com/backend-api/codex/responses, consumes the SSE stream to
 * completion, and assembles a single LLMResponse.
 *
 * Request shape adapted from gg-framework (MIT, see THIRD_PARTY_NOTICES.md):
 *   - Authorization: Bearer <access_token>
 *   - chatgpt-account-id: <id from JWT claims>   (from the resolver)
 *   - OpenAI-Beta: responses=experimental
 *   - originator / User-Agent: CODEX_ORIGINATOR
 *   - session_id + x-client-request-id pinned to the prompt cache scope so
 *     consecutive requests hit the same Codex cache shard
 *   - Content-Type: application/json, Accept: text/event-stream
 * The system prompt is the top-level `instructions` string (set by to-codex.ts).
 *
 * Any non-OK response throws HttpError so the callLLM fallback chain engages.
 */

import os from "node:os";
import { resolveCredential } from "../auth/resolver";
import { withRetry, HttpError } from "../retry";
import { toCodex } from "../transformers/to-codex";
import { fromCodex, type CodexEvent } from "../transformers/from-codex";
import type { CallLLMOptions, LLMResponse } from "../types";
import type { ReasoningMode } from "../types";
import { CODEX_ORIGINATOR } from "../codex-identity";

function codexUserAgent(): string {
  try {
    return `${CODEX_ORIGINATOR} (${os.platform()} ${os.release()}; ${os.arch()})`;
  } catch {
    return CODEX_ORIGINATOR;
  }
}

/** Prompt-cache scope key, pinned on both the body `prompt_cache_key` and the session_id/x-client-request-id
 *  headers so the Codex backend routes to the same cache shard. */
const CODEX_CACHE_SCOPE = CODEX_ORIGINATOR;

const CODEX_RESPONSES_PATH = "/codex/responses";
const DEFAULT_LLM_TIMEOUT_MS = 90_000;

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

function codexRequestId(headers: Headers): string | undefined {
  return (
    headers.get("x-request-id") ??
    headers.get("x-openai-request-id") ??
    headers.get("cf-ray") ??
    undefined
  );
}

function describeCodexHttpError(status: number, bodyText: string, headers: Headers): string {
  const parsed = parseJsonObject(bodyText);
  const bodyMessage = bodyText.trim();
  const rawMessage =
    getNestedString(parsed, ["error", "message"]) ??
    getNestedString(parsed, ["error", "code"]) ??
    getNestedString(parsed, ["detail"]) ??
    getNestedString(parsed, ["message"]) ??
    (bodyMessage.length > 0 ? bodyMessage : `HTTP ${status}`);

  const lower = rawMessage.toLowerCase();
  const hints: string[] = [];
  if (status === 429 || /usage|rate.?limit|quota|too many requests|capacity/.test(lower)) {
    hints.push("ChatGPT subscription usage limit or rate limit reached; retry after the reset window or use a fallback model.");
  }
  if (status === 404 || /model|not available|not found|unsupported|does not exist|not enabled/.test(lower)) {
    hints.push("Codex model may be unavailable for this ChatGPT account; choose another GPT Codex model in Mail Settings.");
  }
  if (status === 401 || status === 403 || /unauthorized|forbidden|account|subscription/.test(lower)) {
    hints.push("Reconnect ChatGPT OAuth or verify the account has Codex access.");
  }

  const requestId = codexRequestId(headers);
  return [rawMessage, ...hints, requestId ? `request_id=${requestId}` : undefined].filter(Boolean).join(" ");
}

/**
 * Parse a Codex SSE stream body to a flat list of JSON events. Reads the
 * stream to completion (the agent loop sees a single response, not a stream).
 */
async function parseCodexSSE(body: ReadableStream<Uint8Array>): Promise<CodexEvent[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: CodexEvent[] = [];
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n")
          .trim();
        if (data && data !== "[DONE]") {
          try {
            events.push(JSON.parse(data) as CodexEvent);
          } catch {
            // Ignore malformed SSE chunks; a terminal event still drives the result.
          }
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
  return events;
}

export async function callOpenAICodex(
  opts: CallLLMOptions,
  providerModel: string,
  config: { baseUrl: string },
): Promise<LLMResponse> {
  const auth = await resolveCredential("openai-codex");
  const body = toCodex(opts, providerModel, { reasoningMode: (opts.reasoningMode ?? "off") as ReasoningMode });
  // Pin the prompt cache scope on the body.
  body.prompt_cache_key = CODEX_CACHE_SCOPE;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    originator: CODEX_ORIGINATOR,
    "User-Agent": codexUserAgent(),
    // The chatgpt.com codex backend routes prompt-cache lookups by header, not
    // body — pinning both makes consecutive requests hit the same cache shard.
    session_id: CODEX_CACHE_SCOPE,
    "x-client-request-id": CODEX_CACHE_SCOPE,
    ...auth.authHeader,
  };

  const url = `${config.baseUrl.replace(/\/+$/, "")}${CODEX_RESPONSES_PATH}`;

  const events = await withRetry(async () => {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS),
    });
    if (!res.ok) {
      const bodyText = await res.text();
      throw new HttpError(res.status, bodyText, {
        headers: res.headers,
        message: describeCodexHttpError(res.status, bodyText, res.headers),
      });
    }
    if (!res.body) {
      throw new HttpError(502, "Codex response had no body", { headers: res.headers });
    }
    return parseCodexSSE(res.body);
  });

  return fromCodex(events, opts.model, auth.source);
}
