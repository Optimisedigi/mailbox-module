/**
 * Anthropic-compatible API adapter for providers that expose /v1/messages but
 * authenticate with a standard Bearer API key. Today: MiniMax M3.
 */

import { resolveCredential } from "../auth/resolver";
import { withRetry, HttpError } from "../retry";
import { toAnthropic } from "../transformers/to-anthropic";
import { fromAnthropic } from "../transformers/from-anthropic";
import type { ProviderName } from "../registry";
import type { CallLLMOptions, LLMResponse } from "../types";

const DEFAULT_LLM_TIMEOUT_MS = 90_000;

export async function callAnthropicCompatible(
  opts: CallLLMOptions,
  providerModel: string,
  config: { provider: ProviderName; baseUrl: string },
): Promise<LLMResponse> {
  const auth = await resolveCredential(config.provider);
  const body = toAnthropic(opts, providerModel);

  // MiniMax-M3 defaults extended thinking ON and emits `thinking` content
  // blocks that must be replayed unchanged (with their signature) on every
  // subsequent tool-use turn. Our canonical pipeline now carries thinking
  // blocks end-to-end (from-anthropic captures them, to-anthropic replays the
  // signed ones), so we explicitly request adaptive thinking — the mode
  // MiniMax-M3 documents for "thinking on, model decides how much".
  //
  // Anthropic-format thinking is incompatible with a custom temperature, so we
  // drop it while thinking is enabled. Leaving temperature set
  // makes the endpoint reject the request.
  if (config.provider === "minimax") {
    body.thinking = { type: "adaptive" };
    delete body.temperature;
  }

  const json = await withRetry(async () => {
    const res = await fetch(`${config.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // MiniMax's Anthropic-compatible endpoint requires the Anthropic
        // Messages API version header (the official Anthropic SDK
        // always sends it). Our Bearer-only auth header omits
        // it, which 400s the request. Send it explicitly here since this
        // adapter always speaks the Anthropic wire format.
        "anthropic-version": "2023-06-01",
        ...auth.authHeader,
      },
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
