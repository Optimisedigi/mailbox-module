/**
 * Model registry. Maps canonical model names (what agents declare in their
 * config) to the (provider, providerModelId) tuple used by the adapters.
 *
 * Adding a new model is one new line here. Adding a new provider is a new
 * key in PROVIDER_CONFIG plus a new adapter under providers/.
 */

/**
 * Canonical model registry. Maps display-friendly model names (used by
 * agents and the chat picker) to the (provider, providerModelId) tuple.
 *
 * Adding a new model is one line here. Adding a new provider needs a new
 * entry in PROVIDER_CONFIG plus a new adapter under providers/.
 *
 * Last reviewed: 2026-10-08 (added Claude Sonnet 5.5 / Haiku 5.5 and Kimi K2.7 Code;
 * Kimi K2 series deprecates 2026-05-25).
 */
/**
 * Reasoning-effort levels for the GPT-5.5-class models served over the Codex
 * Responses backend. The Codex API takes this as a per-request
 * `reasoning.effort` value.
 */
export type CodexEffort = "none" | "low" | "medium" | "high" | "xhigh";

export const MODEL_REGISTRY = {
  // Anthropic, via ANTHROPIC_API_KEY.
  "claude-sonnet-5.5": { provider: "anthropic", model: "claude-sonnet-5-5" },
  "claude-opus-5.5": { provider: "anthropic", model: "claude-opus-5-5" },
  "claude-haiku-5.5": { provider: "anthropic", model: "claude-haiku-5-5" },

  // Moonshot / Kimi, via KIMI_API_KEY (OpenAI-compatible).
  "kimi-k2.6": { provider: "moonshot", model: "kimi-k2.6" },

  // Kimi via the kimi-cli device-code OAuth login (Kimi coding subscription,
  // `scope: kimi-code`). K3 is Kimi's flagship (wire id `k3`, up to 1M
  // context); kimi-for-coding is K2.7 Code.
  "kimi-k3": { provider: "kimi-coding", model: "k3" },
  "kimi-for-coding": { provider: "kimi-coding", model: "kimi-for-coding" },

  // MiniMax, via MINIMAX_API_KEY (Anthropic-compatible API).
  "minimax-m3": { provider: "minimax", model: "MiniMax-M3" },

  // Xiaomi MiMo, via MIMO_API_KEY.
  "mimo-v2.6-pro": { provider: "mimo", model: "mimo-v2.6-pro" },
  "mimo-v2.6-flash": { provider: "mimo", model: "mimo-v2.6-flash" },

  // OpenAI, via OPENAI_API_KEY.
  "gpt-6-astra": { provider: "openai", model: "gpt-6-astra" },
  "gpt-6-sol": { provider: "openai", model: "gpt-6-sol" },
  "gpt-6-luna": { provider: "openai", model: "gpt-6-luna" },

  // GPT over the Codex Responses backend, served by a ChatGPT plan via the
  // Codex OAuth login. Reasoning effort is chosen per request.
  "gpt-5.5-codex": { provider: "openai-codex", model: "gpt-5.5" },

  // xAI: grok-4.7 via XAI_API_KEY; grok-4.6 via the SuperGrok OAuth login
  // (grok-cli proxy at cli-chat-proxy.grok.com).
  "grok-4.7": { provider: "xai-api", model: "grok-4.7" },
  "grok-4.6": { provider: "xai-grok", model: "grok-4.6" },
} as const;

export type CanonicalModelName = keyof typeof MODEL_REGISTRY;
export type ProviderName =
  | "anthropic"
  | "moonshot"
  | "kimi-coding"
  | "minimax"
  | "mimo"
  | "openai"
  | "openai-codex"
  | "xai-api"
  | "xai-grok";

export interface AnthropicProviderConfig {
  handler: "callAnthropic";
  supportsOAuth: false;
}

export interface AnthropicCompatibleProviderConfig {
  handler: "callAnthropicCompatible";
  baseUrl: string;
  supportsOAuth: false;
}

export interface OpenAICompatibleProviderConfig {
  handler: "callOpenAICompatible";
  baseUrl: string;
  supportsOAuth: false;
}

export interface KimiCodingProviderConfig {
  handler: "callKimiCoding";
  baseUrl: string;
  supportsOAuth: true;
}

export interface OpenAICodexProviderConfig {
  handler: "callOpenAICodex";
  /** Base for the Codex Responses endpoint, e.g. https://chatgpt.com/backend-api. */
  baseUrl: string;
  supportsOAuth: true;
}

export interface XaiGrokProviderConfig {
  handler: "callXaiGrok";
  /** Base for the grok-cli proxy Responses endpoint, e.g. https://cli-chat-proxy.grok.com/v1. */
  baseUrl: string;
  /** Sent as `x-grok-client-version`; the proxy 426s outdated/missing versions. */
  clientVersion: string;
  supportsOAuth: true;
}

export type ProviderConfig =
  | AnthropicProviderConfig
  | AnthropicCompatibleProviderConfig
  | OpenAICompatibleProviderConfig
  | KimiCodingProviderConfig
  | OpenAICodexProviderConfig
  | XaiGrokProviderConfig;

export const PROVIDER_CONFIG: Record<ProviderName, ProviderConfig> = {
  anthropic: {
    handler: "callAnthropic",
    // API key only (ANTHROPIC_API_KEY).
    supportsOAuth: false,
  },
  moonshot: {
    handler: "callOpenAICompatible",
    baseUrl: "https://api.moonshot.ai/v1",
    supportsOAuth: false,
  },
  "kimi-coding": {
    handler: "callKimiCoding",
    baseUrl: "https://api.kimi.com/coding/v1",
    supportsOAuth: true,
  },
  minimax: {
    handler: "callAnthropicCompatible",
    // MiniMax M3 uses MiniMax's Anthropic-compatible international endpoint.
    baseUrl: "https://api.minimax.io/anthropic",
    supportsOAuth: false,
  },
  mimo: {
    handler: "callOpenAICompatible",
    baseUrl: "https://api.xiaomimimo.com/v1",
    supportsOAuth: false,
  },
  openai: {
    handler: "callOpenAICompatible",
    baseUrl: "https://api.openai.com/v1",
    supportsOAuth: false,
  },
  "openai-codex": {
    handler: "callOpenAICodex",
    // The Codex Responses endpoint is <baseUrl>/codex/responses.
    baseUrl: "https://chatgpt.com/backend-api",
    supportsOAuth: true,
  },
  "xai-api": {
    handler: "callOpenAICompatible",
    baseUrl: "https://api.x.ai/v1",
    supportsOAuth: false,
  },
  "xai-grok": {
    handler: "callXaiGrok",
    // The grok-cli proxy Responses endpoint is <baseUrl>/responses.
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
    // Mirrors the installed grok CLI; the proxy rejects missing/old versions
    // with HTTP 426. Bump if the proxy raises its minimum.
    clientVersion: "1.0.46",
    supportsOAuth: true,
  },
};

export function isCanonicalModel(name: string): name is CanonicalModelName {
  return name in MODEL_REGISTRY;
}

/**
 * Models offered in Mail Settings → Email assistant model, in dropdown order.
 */
export const CHAT_PICKER_MODELS: ReadonlyArray<{
  canonical: CanonicalModelName;
  label: string;
  hint?: string;
  /**
   * Model whose flagship behaviour only exists with reasoning enabled. Kimi's
   * router serves `k3` only when Thinking is on; a no-thinking request silently
   * routes to K2.6 instead, so reasoning is forced on for these models.
   */
  requiresReasoning?: boolean;
}> = [
  { canonical: "claude-sonnet-5.5", label: "Claude Sonnet 5.5 (API key)", hint: "Billed to ANTHROPIC_API_KEY." },
  { canonical: "claude-opus-5.5", label: "Claude Opus 5.5 (API key)", hint: "Latest Opus. Billed to ANTHROPIC_API_KEY." },
  { canonical: "claude-haiku-5.5", label: "Claude Haiku 5.5 (API key)", hint: "Fastest Claude. Billed to ANTHROPIC_API_KEY." },
  { canonical: "kimi-k3", label: "Kimi K3 (Kimi OAuth)", hint: "Kimi's flagship. Long-horizon coding, up to 1M context. Reasoning is always on for K3. No API tokens billed.", requiresReasoning: true },
  { canonical: "kimi-for-coding", label: "Kimi For Coding (Kimi OAuth)", hint: "Kimi K2.7 Code via device-code OAuth. No API tokens billed." },
  { canonical: "minimax-m3", label: "MiniMax M3", hint: "Latest MiniMax fallback for agentic workflows." },
  { canonical: "mimo-v2.6-pro", label: "MiMo V2.6 Pro (API key)", hint: "Xiaomi flagship. Billed to MIMO_API_KEY; requires an API key." },
  { canonical: "mimo-v2.6-flash", label: "MiMo V2.6 Flash (API key)", hint: "Faster Xiaomi model. Billed to MIMO_API_KEY; requires an API key." },
  { canonical: "gpt-6-astra", label: "GPT-6 Astra (API key)", hint: "Latest flagship. Billed to OPENAI_API_KEY; not ChatGPT OAuth." },
  { canonical: "gpt-6-sol", label: "GPT-6 Sol (API key)", hint: "Balanced GPT-6. Billed to OPENAI_API_KEY; not ChatGPT OAuth." },
  { canonical: "gpt-6-luna", label: "GPT-6 Luna (API key)", hint: "Fast GPT-6. Billed to OPENAI_API_KEY; not ChatGPT OAuth." },
  { canonical: "grok-4.7", label: "Grok 4.7 (API key)", hint: "Latest Grok. Billed to XAI_API_KEY; not SuperGrok OAuth." },
  { canonical: "grok-4.6", label: "Grok 4.6 (SuperGrok OAuth)", hint: "xAI Grok 4.6 via your SuperGrok subscription. No API tokens billed." },
];

