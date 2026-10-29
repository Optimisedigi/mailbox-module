/**
 * Top-level LLM entry point. Looks up the model in the registry, dispatches
 * to the right provider adapter, and walks the fallbackModels chain on
 * recoverable errors.
 *
 *   const response = await callLLM({
 *     model: 'claude-sonnet-5.5',
 *     fallbackModels: ['kimi-k3', 'minimax-m3'],
 *     system: '...',
 *     messages: [...],
 *     tools: [...],
 *   })
 */

import { MODEL_REGISTRY, PROVIDER_CONFIG, type CanonicalModelName } from "./registry";
import { classifyError, isRetryable } from "./retry";
import { callAnthropic } from "./providers/anthropic";
import { callAnthropicCompatible } from "./providers/anthropic-compatible";
import { callOpenAICompatible } from "./providers/openai-compatible";
import { callOpenAICodex } from "./providers/openai-codex";
import { callXaiGrok } from "./providers/xai-grok";
import { callKimiCoding } from "./providers/kimi-coding";
import { NoCredentialError } from "./auth/types";
import { OAuthFailedError } from "./auth/resolver";
import type { CallLLMOptions, LLMResponse } from "./types";

/** Compact single-model failure description for the aggregate error message. */
function describeChainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();
  if (!trimmed) return "unknown error";
  // Provider bodies can be multi-KB of JSON; keep the chain message readable.
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

export class AggregateLLMError extends Error {
  constructor(
    public readonly tried: string[],
    public readonly errors: Array<{ model: string; error: unknown }>,
  ) {
    // Report EVERY model's error, not just the last one. Showing only the tail
    // error made triage impossible: a chain where Anthropic's OAuth had expired,
    // ChatGPT was over its usage cap and MiniMax was out of credits all rendered
    // as one MiniMax 429, which looks like a single provider having a bad day.
    const detail = errors
      .map(({ model, error }) => `${model}: ${describeChainError(error)}`)
      .join(" | ");
    super(
      `All models failed (${tried.join(", ")}). ${detail || "No error detail captured."}`,
    );
    this.name = "AggregateLLMError";
  }
}

type RegistryEntry = (typeof MODEL_REGISTRY)[CanonicalModelName];
type ProviderCfg = (typeof PROVIDER_CONFIG)[RegistryEntry["provider"]];

/** Dispatch one canonical model to its provider adapter. */
function callProvider(
  opts: CallLLMOptions,
  modelName: string,
  entry: RegistryEntry,
  provCfg: ProviderCfg,
): Promise<LLMResponse> {
  const scoped = { ...opts, model: modelName };
  if (provCfg.handler === "callAnthropic") {
    return callAnthropic(scoped, entry.model);
  }
  if (provCfg.handler === "callOpenAICodex") {
    return callOpenAICodex(scoped, entry.model, { baseUrl: provCfg.baseUrl });
  }
  if (provCfg.handler === "callXaiGrok") {
    return callXaiGrok(scoped, entry.model, {
      baseUrl: provCfg.baseUrl,
      clientVersion: provCfg.clientVersion,
    });
  }
  if (provCfg.handler === "callKimiCoding") {
    return callKimiCoding(scoped, entry.model, { baseUrl: provCfg.baseUrl });
  }
  if (provCfg.handler === "callAnthropicCompatible") {
    return callAnthropicCompatible(scoped, entry.model, {
      provider: entry.provider,
      baseUrl: provCfg.baseUrl,
    });
  }
  return callOpenAICompatible(scoped, entry.model, {
    provider: entry.provider,
    baseUrl: provCfg.baseUrl,
  });
}

/** One-line human reason a chain model failed, for the failover pill/event. */
function toFallbackReason({ model, error }: { model: string; error: unknown }): {
  model: string;
  reason: string;
} {
  const cls = classifyError(error);
  const message = error instanceof Error ? error.message : String(error);
  if (cls === "timeout") return { model, reason: "request timed out" };
  return { model, reason: message || `${cls} error` };
}

export async function callLLM(opts: CallLLMOptions): Promise<LLMResponse> {
  const chain = [...new Set([opts.model, ...(opts.fallbackModels ?? [])])];
  const tried: string[] = [];
  const errors: Array<{ model: string; error: unknown }> = [];

  for (const modelName of chain) {
    if (!(modelName in MODEL_REGISTRY)) {
      errors.push({ model: modelName, error: new Error(`Unknown model: ${modelName}`) });
      continue;
    }
    const entry = MODEL_REGISTRY[modelName as CanonicalModelName];
    const provCfg = PROVIDER_CONFIG[entry.provider];
    tried.push(modelName);

    try {
      const served = await callProvider(opts, modelName, entry, provCfg);
      // Attach why the earlier models in the chain bowed out so the caller can
      // tell the user *why* it failed over, not merely that it did.
      return errors.length > 0
        ? { ...served, fallbackFrom: errors.map(toFallbackReason) }
        : served;
    } catch (err) {
      const cls = classifyError(err);
      errors.push({ model: modelName, error: err });

      // Context overflow aborts immediately: the prompt is too big and every
      // model in the chain would reject the same oversized request, so trying
      // them wastes time and money. The caller wants to know to compact.
      if (cls === "context-overflow") {
        throw err;
      }
      // A plain 400 (invalid-request) is NOT necessarily fatal across the
      // chain: it is frequently provider-specific (e.g. MiniMax's
      // Anthropic-compatible endpoint 400s on tool-call shapes that Anthropic
      // and Kimi accept). Fall through to the next model rather than failing
      // the whole turn. If every model 400s, the AggregateLLMError at the end
      // still surfaces each provider's error for debugging.
      if (cls === "invalid-request") {
        continue;
      }
      // NoCredentialError, OAuthFailedError, rate limits, transient errors:
      // try the next model. OAuthFailedError specifically encodes the user's
      // Option B preference: when Anthropic OAuth dies, walk to Kimi rather
      // than silently switching to billed Anthropic API.
      if (
        err instanceof NoCredentialError ||
        err instanceof OAuthFailedError ||
        isRetryable(cls) ||
        cls === "auth" ||
        cls === "unknown"
      ) {
        continue;
      }
      // Anything else: also fall through, the loop tries the next model.
      continue;
    }
  }

  throw new AggregateLLMError(tried, errors);
}

export type { CallLLMOptions, LLMResponse } from "./types";
