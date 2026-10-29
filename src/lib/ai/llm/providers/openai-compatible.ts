/**
 * OpenAI-compatible API adapter.
 *
 * One adapter for any provider that exposes the OpenAI Chat Completions
 * shape. Today: Moonshot (Kimi), MiniMax. Parameterised by baseUrl + provider.
 */

import { resolveCredential } from "../auth/resolver";
import { withRetry, HttpError } from "../retry";
import { toOpenAI } from "../transformers/to-openai";
import { fromOpenAI } from "../transformers/from-openai";
import type { CallLLMOptions, LLMResponse } from "../types";
import type { ProviderName } from "../registry";

const DEFAULT_LLM_TIMEOUT_MS = 90_000;

/**
 * True when an HTTP error body is OpenAI's "this model only allows the default
 * temperature" rejection. The proactive guard in toOpenAI() strips temperature
 * for known reasoning-model ids; this catches the same rejection reactively for
 * any model id we haven't enumerated (or future ones), so temperature is never
 * the reason a call ultimately fails.
 */
function isTemperatureRejection(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  const body = typeof err.bodyText === "string" ? err.bodyText.toLowerCase() : "";
  return body.includes("temperature") && body.includes("only 1");
}

export async function callOpenAICompatible(
  opts: CallLLMOptions,
  providerModel: string,
  config: { provider: ProviderName; baseUrl: string },
): Promise<LLMResponse> {
  const auth = await resolveCredential(config.provider);

  const send = async (callOpts: CallLLMOptions): Promise<unknown> => {
    const body = toOpenAI(callOpts, providerModel);
    return withRetry(async () => {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...auth.authHeader,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(callOpts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new HttpError(res.status, await res.text(), { headers: res.headers });
      }
      return res.json();
    });
  };

  let json: unknown;
  try {
    json = await send(opts);
  } catch (err) {
    // Reactive recovery: some OpenAI models reject any non-default temperature.
    // If that's why this failed, retry once with temperature removed entirely.
    if (isTemperatureRejection(err) && opts.temperature !== undefined) {
      const { temperature: _omit, ...withoutTemperature } = opts;
      json = await send(withoutTemperature);
    } else {
      throw err;
    }
  }

  return fromOpenAI(json, opts.model, auth.source);
}
