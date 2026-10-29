/**
 * Credential resolver. The single entry point every adapter uses to obtain
 * an auth header for an outbound LLM call.
 *
 * Resolution semantics (Option B per the build conversation 2026-05-07):
 *
 *   1. If the provider supports OAuth AND no force-fallback flag AND a
 *      stored OAuth credential exists, refresh it if needed and return it.
 *      Mark source='oauth'.
 *   2. If step 1 threw (token revoked, refresh failed, OAuth-endpoint
 *      network error), DO NOT silently fall through to the env API key.
 *      Log an oauth-failed event to the activity log and throw
 *      OAuthFailedError. The agent loop classifies this as non-retryable
 *      and walks down fallbackModels (typically Kimi -> MiniMax).
 *   3. If no OAuth credential is stored for this provider (i.e. OAuth was
 *      never connected, not a failure), use the env-var API key with
 *      source='api-key'. This is a chosen path, not a fallback.
 *   4. If neither OAuth nor API key is available, throw NoCredentialError;
 *      the agent loop walks down the chain.
 *
 * Why the asymmetry: OAuth being silently swapped for billed Anthropic API
 * was a footgun (silent cost surprise, user couldn't see when it happened).
 * The user explicitly wants OAuth failures to fall through to a different
 * provider entirely, with visibility on every transition.
 */

import { PROVIDER_CONFIG, type ProviderName } from "../registry";
import {
  getCredential,
  setCredential,
  isForceFallback,
  setRefreshLock,
  getRefreshLock,
} from "./store";
import {
  isCodexExpiringSoon,
  refreshCodexCredential,
  codexAuthHeaders,
} from "./oauth/openai-codex";
import {
  isXaiGrokExpiringSoon,
  refreshXaiGrokCredential,
  xaiGrokAuthHeaders,
} from "./oauth/xai-grok";
import {
  isKimiExpiringSoon,
  refreshKimiCredential,
  kimiAuthHeaders,
} from "./oauth/kimi-coding";
import { NoCredentialError, type ResolvedAuth, type OAuthCredential } from "./types";
import { recordAuthEvent } from "./events";

export class OAuthFailedError extends Error {
  constructor(
    public provider: ProviderName,
    public reason: string,
    public originalError: unknown,
  ) {
    super(`OAuth resolution failed for ${provider}: ${reason}`);
    this.name = "OAuthFailedError";
  }
}

function envApiKeyFor(provider: ProviderName): string | undefined {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "moonshot":
      return process.env.KIMI_API_KEY;
    case "kimi-coding":
      // Kimi For Coding is subscription OAuth-only; the billed KIMI_API_KEY path
      // remains the separate `moonshot` provider.
      return undefined;
    case "minimax":
      return process.env.MINIMAX_API_KEY;
    case "mimo":
      return process.env.MIMO_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "xai-api":
      return process.env.XAI_API_KEY;
    case "openai-codex":
      // Codex is OAuth-only — there is no API key for the subscription path.
      // Returning undefined makes the resolver throw NoCredentialError when
      // OAuth isn't connected, which the agent loop walks past.
      return undefined;
    case "xai-grok":
      // SuperGrok subscription is OAuth-only — the billed XAI_API_KEY hits a
      // different surface (api.x.ai), not this proxy. No API-key fallback here.
      return undefined;
    default: {
      const _exhaust: never = provider;
      void _exhaust;
      return undefined;
    }
  }
}

function apiKeyAuthHeader(
  provider: ProviderName,
  apiKey: string,
): Record<string, string> {
  if (provider === "anthropic") {
    // Anthropic API key auth uses x-api-key, not Authorization.
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  if (provider === "mimo") return { "api-key": apiKey };
  // OpenAI/Anthropic-compatible third-party providers use Bearer.
  return { Authorization: `Bearer ${apiKey}` };
}

function isOAuthExpiringSoon(cred: OAuthCredential): boolean {
  if (cred.provider === "openai-codex") return isCodexExpiringSoon(cred);
  if (cred.provider === "xai-grok") return isXaiGrokExpiringSoon(cred);
  if (cred.provider === "kimi-coding") return isKimiExpiringSoon(cred);
  return true;
}

async function refreshOAuthCredential(cred: OAuthCredential): Promise<OAuthCredential> {
  if (cred.provider === "openai-codex") return refreshCodexCredential(cred);
  if (cred.provider === "xai-grok") return refreshXaiGrokCredential(cred);
  if (cred.provider === "kimi-coding") return refreshKimiCredential(cred);
  throw new Error(`OAuth is not supported for ${cred.provider}.`);
}

async function refreshIfNeeded(cred: OAuthCredential): Promise<OAuthCredential> {
  if (!isOAuthExpiringSoon(cred)) return cred;
  const inFlight = getRefreshLock(cred.provider);
  if (inFlight) {
    const result = (await inFlight) as OAuthCredential;
    return result;
  }
  const refreshPromise = (async () => {
    const refreshed = await refreshOAuthCredential(cred);
    await setCredential(cred.provider, refreshed);
    return refreshed;
  })();
  return setRefreshLock(cred.provider, refreshPromise);
}

export async function resolveCredential(provider: ProviderName): Promise<ResolvedAuth> {
  const provCfg = PROVIDER_CONFIG[provider];

  if (provCfg.supportsOAuth) {
    // "Force fallback" on the AI Auth page skips the stored login entirely.
    const forced = await isForceFallback(provider);
    const stored = forced ? null : await getCredential(provider);

    if (stored?.kind === "oauth") {
      // OAuth was connected. We MUST use it or hard-fail; we never silently
      // fall through to billed API for the same provider.
      try {
        const refreshed = await refreshIfNeeded(stored);
        let authHeader: Record<string, string> | null = null;
        if (provider === "openai-codex") {
          // Bearer token + chatgpt-account-id. The adapter composes the rest
          // (OpenAI-Beta, originator, User-Agent, Content-Type).
          authHeader = codexAuthHeaders(refreshed);
        } else if (provider === "xai-grok") {
          // Bearer token only. The adapter composes the rest (X-XAI-Token-Auth,
          // x-grok-client-version, x-grok-model-override, Content-Type).
          authHeader = xaiGrokAuthHeaders(refreshed);
        } else if (provider === "kimi-coding") {
          // Bearer token + kimi-cli device headers. The adapter adds Content-Type.
          authHeader = kimiAuthHeaders(refreshed);
        }
        if (authHeader) {
          // Record success quietly; only failures get a notification.
          await recordAuthEvent({
            provider,
            kind: "oauth-success",
            message: "OAuth credential refreshed and used.",
          }).catch(() => {});
          return { authHeader, source: "oauth", credential: refreshed };
        }
      } catch (err) {
        const reason = (err as Error).message ?? "unknown";
        console.warn(
          `[resolver] OAuth resolution failed for ${provider}: ${reason}. Throwing OAuthFailedError; agent loop will fall through to next provider.`,
        );
        // Loud audit trail. The chat surface and ai-auth page both read
        // these events to surface the failure to the user.
        await recordAuthEvent({
          provider,
          kind: "oauth-failed",
          message: reason,
        }).catch(() => {});
        throw new OAuthFailedError(provider, reason, err);
      }
    }
  }

  // API key path. Reached when:
  //  (a) provider doesn't support OAuth (Kimi, MiniMax), OR
  //  (b) OAuth was never connected for this provider, OR
  //  (c) force-fallback toggle is on (admin emergency switch).
  // This is NOT reached after an OAuth refresh failure; that throws above.
  const envKey = envApiKeyFor(provider);
  if (envKey) {
    return {
      authHeader: apiKeyAuthHeader(provider, envKey),
      source: "api-key",
      credential: { kind: "api-key", provider, apiKey: envKey, label: "env" },
    };
  }

  // Stored API key (future per-client keys go here too)
  const stored = await getCredential(provider);
  if (stored?.kind === "api-key" && stored.apiKey) {
    return {
      authHeader: apiKeyAuthHeader(provider, stored.apiKey),
      source: "api-key",
      credential: stored,
    };
  }

  throw new NoCredentialError(provider);
}
