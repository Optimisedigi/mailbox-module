/**
 * Anthropic native API adapter (API key auth via ANTHROPIC_API_KEY).
 */

import { resolveCredential } from "../auth/resolver";
import { withRetry, HttpError } from "../retry";
import { addConversationCacheBreakpoint, toAnthropic } from "../transformers/to-anthropic";
import { fromAnthropic } from "../transformers/from-anthropic";
import type { CallLLMOptions, LLMResponse } from "../types";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_LLM_TIMEOUT_MS = 90_000;

export async function callAnthropic(
  opts: CallLLMOptions,
  providerModel: string,
): Promise<LLMResponse> {
  const auth = await resolveCredential("anthropic");
  const body = toAnthropic(opts, providerModel);
  addConversationCacheBreakpoint(body);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...auth.authHeader,
  };

  const json = await withRetry(async () => {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new HttpError(res.status, await res.text(), { headers: res.headers });
    }
    return res.json();
  });

  return fromAnthropic(json, opts.model, auth.source);
}
