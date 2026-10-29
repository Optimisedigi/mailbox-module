import { kimiAuthHeaders, KIMI_CODING_MODEL_ID } from "../auth/oauth/kimi-coding";
import { resolveCredential } from "../auth/resolver";
import { withRetry, HttpError } from "../retry";
import { fromOpenAI } from "../transformers/from-openai";
import { toOpenAI } from "../transformers/to-openai";
import type { CallLLMOptions, LLMResponse, ReasoningMode } from "../types";

const DEFAULT_LLM_TIMEOUT_MS = 120_000;
const CHAT_COMPLETIONS_PATH = "/chat/completions";
const PROMPT_CACHE_KEY = "mailbox-module";

// Kimi's router serves the `k3` wire model only when Thinking is on; a request
// with thinking disabled is silently downgraded to K2.6 server-side. Autonomous
// runs (cron, scheduled tasks) call this adapter without a reasoning mode, so
// force thinking on for K3 at the cheapest effort to guarantee we get K3.
const KIMI_K3_WIRE_MODEL = "k3";

type KimiRequestBody = ReturnType<typeof toOpenAI> & {
  prompt_cache_key?: string;
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: "low" | "medium" | "high";
};

function applyReasoning(
  body: KimiRequestBody,
  reasoningMode: ReasoningMode | undefined,
  wireModel: string,
): void {
  if (!reasoningMode || reasoningMode === "off") {
    // K3 must never go out with thinking disabled or Kimi routes it to K2.6.
    if (wireModel === KIMI_K3_WIRE_MODEL) {
      body.thinking = { type: "enabled" };
      body.reasoning_effort = "low";
      return;
    }
    body.thinking = { type: "disabled" };
    delete body.reasoning_effort;
    return;
  }
  body.thinking = { type: "enabled" };
  body.reasoning_effort = reasoningMode;
}

export async function callKimiCoding(
  opts: CallLLMOptions,
  providerModel: string,
  config: { baseUrl: string },
): Promise<LLMResponse> {
  const auth = await resolveCredential("kimi-coding");
  if (auth.credential.kind !== "oauth") {
    throw new Error("Kimi For Coding requires OAuth credentials.");
  }

  const credential = auth.credential;
  // The credential's discovered kimiModelId corrects the wire id for the generic
  // K2.7 Code default. An explicit registry model (e.g. `k3`) must win over it so
  // distinct models on the same subscription route to the right one.
  const wireModel =
    providerModel && providerModel !== KIMI_CODING_MODEL_ID
      ? providerModel
      : credential.kimiModelId ?? providerModel;
  const body: KimiRequestBody = toOpenAI(opts, wireModel);
  body.prompt_cache_key = PROMPT_CACHE_KEY;
  // Kimi For Coding rejects arbitrary temperatures, and the accepted value
  // differs per model: K2.x only takes 0.6, while K3 only takes 1 (verified
  // live: k3 returns 400 "invalid temperature: only 1 is allowed for this
  // model"). Callers may pass another temperature, so normalize it.
  if (body.temperature !== undefined) {
    body.temperature = wireModel === KIMI_K3_WIRE_MODEL ? 1 : 0.6;
  }
  applyReasoning(body, opts.reasoningMode, wireModel);

  const json = await withRetry(async () => {
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, "")}${CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...kimiAuthHeaders(credential),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new HttpError(res.status, await res.text(), { headers: res.headers });
    }
    return res.json();
  });

  return fromOpenAI(json, opts.model, auth.source);
}

