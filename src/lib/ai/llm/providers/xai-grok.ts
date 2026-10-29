/**
 * xAI Grok (SuperGrok subscription) Responses adapter.
 *
 * Resolves the `xai-grok` OAuth credential (no API-key path exists for this
 * provider — it's the subscription proxy, not the billed XAI_API_KEY), builds
 * an OpenAI Responses request body, sends the grok-cli header set, POSTs to
 * cli-chat-proxy.grok.com/v1/responses (non-streaming), and assembles a single
 * LLMResponse.
 *
 * The proxy requires this exact header set (verified live; missing/old version
 * returns HTTP 426):
 *   - Authorization: Bearer <access_token>       (from the resolver)
 *   - X-XAI-Token-Auth: xai-grok-cli             (validate as a CLI session token)
 *   - x-grok-client-version: <clientVersion>
 *   - x-grok-model-override: <model>             (proxy routes by header, not body)
 *   - Content-Type: application/json
 *
 * The request body reuses the Codex Responses transformer (`toCodex`) — the
 * grok proxy speaks the same Responses input shape — but we force
 * `stream:false` and read the single JSON document with `fromXaiGrok`.
 *
 * Any non-OK response throws HttpError so the callLLM fallback chain engages.
 */

import { resolveCredential } from "../auth/resolver";
import { withRetry, HttpError } from "../retry";
import { toCodex } from "../transformers/to-codex";
import { fromXaiGrok } from "../transformers/from-xai-grok";
import type { CallLLMOptions, LLMResponse, ReasoningMode } from "../types";

const XAI_GROK_TOKEN_AUTH = "xai-grok-cli";
const RESPONSES_PATH = "/responses";
const DEFAULT_LLM_TIMEOUT_MS = 90_000;

export async function callXaiGrok(
  opts: CallLLMOptions,
  providerModel: string,
  config: { baseUrl: string; clientVersion: string },
): Promise<LLMResponse> {
  const auth = await resolveCredential("xai-grok");

  // Reuse the Codex Responses body builder (same `input` item shape), then
  // force non-streaming — the proxy returns one JSON document we parse directly.
  const body: Record<string, unknown> = {
    ...toCodex(opts, providerModel, { reasoningMode: (opts.reasoningMode ?? "off") as ReasoningMode }),
    stream: false,
  };
  // Unlike the Codex backend, the grok-cli proxy rejects Codex-only reasoning
  // request fields. Keep the shared Responses input shape, but strip reasoning
  // controls here so Codex behaviour remains unchanged.
  delete body.reasoning;
  delete body.reasoningEffort;
  // Unlike the Codex backend, the grok-cli proxy 400s when `tool_choice` is set
  // but no tools are supplied. Drop the tool-routing fields when there are no
  // tools so plain chat/probe turns are accepted.
  if (!opts.tools || opts.tools.length === 0) {
    delete body.tool_choice;
    delete body.parallel_tool_calls;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-XAI-Token-Auth": XAI_GROK_TOKEN_AUTH,
    "x-grok-client-version": config.clientVersion,
    "x-grok-model-override": providerModel,
    ...auth.authHeader,
  };

  const url = `${config.baseUrl.replace(/\/+$/, "")}${RESPONSES_PATH}`;

  const json = await withRetry(async () => {
    const res = await fetch(url, {
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

  return fromXaiGrok(json, opts.model, auth.source);
}
