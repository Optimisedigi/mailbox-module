/**
 * Credential types.
 *
 * Two kinds: OAuth (subscription logins: ChatGPT via Codex, xAI Grok, Kimi)
 * and API key (env vars). The resolver
 * returns ResolvedAuth in either case so adapters never branch on credential
 * type.
 */

import type { ProviderName } from "../registry";

export interface OAuthCredential {
  kind: "oauth";
  provider: "openai-codex" | "xai-grok" | "kimi-coding";
  accessToken: string;
  refreshToken: string;
  /** Unix ms. */
  expiresAt: number;
  /** Stored so a rotated OAuth client id can be detected. */
  clientId: string;
  scope: string;
  obtainedAt: number;
  /**
   * ChatGPT account id, extracted from the Codex OAuth id_token JWT
   * (`https://api.openai.com/auth`.chatgpt_account_id). Sent as the
   * `chatgpt-account-id` header on every Codex Responses request. Only set
   * for the `openai-codex` provider.
   */
  accountId?: string;
  /** Kimi For Coding device fingerprint; OAuth tokens are expected to reuse it. */
  deviceId?: string;
  /** Server-discovered Kimi wire model for this subscription tier. */
  kimiModelId?: string;
  kimiContextLength?: number;
  kimiModelDisplay?: string;
}

export interface ApiKeyCredential {
  kind: "api-key";
  provider: ProviderName;
  apiKey: string;
  /** 'primary' | 'rotation-2' | etc. Reserved for future per-client keys. */
  label?: string;
}

export type Credential = OAuthCredential | ApiKeyCredential;

export interface ResolvedAuth {
  /** Ready to spread into fetch headers. */
  authHeader: Record<string, string>;
  source: "oauth" | "api-key" | "api-key-fallback";
  credential: Credential;
}

export class NoCredentialError extends Error {
  constructor(public provider: ProviderName) {
    super(`No credential available for ${provider}`);
    this.name = "NoCredentialError";
  }
}
