/**
 * xAI Grok (SuperGrok subscription) OAuth — Device Authorization Grant.
 *
 * Lets the app serve Grok models from a flat-rate SuperGrok
 * subscription via the grok-cli OAuth client + the private
 * `cli-chat-proxy.grok.com/v1/responses` endpoint, instead of a billed
 * XAI_API_KEY. This is the subscription-reuse pattern the grok CLI uses.
 *
 * Unlike the Anthropic / Codex flows (Authorization Code + PKCE with a pasted
 * callback), xAI's CLI uses the OAuth 2.0 Device Authorization Grant
 * (RFC 8628). That fits a server cleanly: there is no localhost callback to
 * catch — we request a device code, show the user a verification URL + code,
 * and poll the token endpoint until they approve in their browser.
 *
 * Verified working with a standard ("tier 1") SuperGrok subscription against
 * cli-chat-proxy.grok.com — NOT subject to the SuperGrok-Heavy allowlist that
 * gates the accounts.x.ai OAuth surface other tools use.
 *
 * xAI can rotate the client id, the proxy contract, or revoke tokens at any
 * time; a failure then shows as an error on that AI request and on AI Auth.
 *
 * Flow:
 *   1. POST https://auth.x.ai/oauth2/device/code  client_id + scope
 *        -> { device_code, user_code, verification_uri_complete, expires_in, interval }
 *   2. User opens verification_uri_complete and approves.
 *   3. POST https://auth.x.ai/oauth2/token
 *        grant_type=urn:ietf:params:oauth:grant-type:device_code + device_code + client_id
 *        -> 400 { error: authorization_pending | slow_down | expired_token | access_denied }
 *           until approved, then { access_token, refresh_token, expires_in, scope }
 */

import type { OAuthCredential } from "../types";

/**
 * grok-cli public OAuth client id. Lifted from the access-token JWT the
 * installed grok CLI mints (`aud` / `client_id` claim). Public by design for
 * a device-flow native client.
 */
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const ISSUER = "https://auth.x.ai";
const DEVICE_CODE_URL = `${ISSUER}/oauth2/device/code`;
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** Scope set the grok CLI requests. `offline_access` enables silent refresh;
 *  `grok-cli:access` + `api:access` unlock the cli-chat-proxy inference path. */
const SCOPE = "openid profile email offline_access api:access grok-cli:access";

/** Refresh ~5 minutes early so a long agent run doesn't 401 mid-flight. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

interface OAuthErrorResponse {
  error?: string;
  error_description?: string;
}

/** Output of beginGrokDeviceLogin — given to the admin page so it can render
 *  the verification link and remember the device_code across the poll step. */
export interface BeginGrokDeviceLoginResult {
  deviceCode: string;
  userCode: string;
  /** Pre-filled URL the user opens to approve (falls back to verification_uri). */
  verificationUri: string;
  /** Seconds until the device_code expires. */
  expiresIn: number;
  /** Minimum seconds between polls (defaults to 5 per RFC 8628). */
  interval: number;
}

/**
 * Step 1: request a device + user code. The caller shows `userCode` and opens
 * `verificationUri`, then polls pollGrokDeviceToken with `deviceCode`.
 */
export async function beginGrokDeviceLogin(): Promise<BeginGrokDeviceLoginResult> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Grok device-code request failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as DeviceCodeResponse;
  const verificationUri = data.verification_uri_complete ?? data.verification_uri;
  if (!data.device_code || !data.user_code || !verificationUri) {
    throw new Error("Grok device-code response missing required fields.");
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri,
    expiresIn: data.expires_in ?? 600,
    interval: data.interval ?? 5,
  };
}

export type GrokPollStatus =
  | { status: "connected"; credential: OAuthCredential }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "expired" }
  | { status: "denied" };

/**
 * Step 3 (polled): exchange the device_code for tokens once. Returns a
 * discriminated status so the caller can keep polling on `pending`/`slow_down`,
 * stop on `expired`/`denied`, and store the credential on `connected`.
 */
export async function pollGrokDeviceToken(deviceCode: string): Promise<GrokPollStatus> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: DEVICE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: CLIENT_ID,
    }).toString(),
  });

  if (res.ok) {
    const data = (await res.json()) as OAuthTokenResponse;
    return { status: "connected", credential: buildCredential(data) };
  }

  // RFC 8628: pending/slow_down/expired_token/access_denied arrive as 400s.
  const err = (await res.json().catch(() => ({}))) as OAuthErrorResponse;
  switch (err.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      throw new Error(
        `Grok token poll failed (${res.status}): ${err.error ?? "unknown"}${
          err.error_description ? ` — ${err.error_description}` : ""
        }`,
      );
  }
}

function buildCredential(data: OAuthTokenResponse): OAuthCredential {
  const now = Date.now();
  return {
    kind: "oauth",
    provider: "xai-grok",
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + data.expires_in * 1000 - REFRESH_MARGIN_MS,
    clientId: CLIENT_ID,
    scope: data.scope ?? SCOPE,
    obtainedAt: now,
  };
}

/** Refresh the access token using the stored refresh token. Caller persists
 *  via setCredential() and serialises calls via the refresh-lock map. */
export async function refreshXaiGrokCredential(cred: OAuthCredential): Promise<OAuthCredential> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cred.clientId || CLIENT_ID,
      refresh_token: cred.refreshToken,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Grok token refresh failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as OAuthTokenResponse;
  const now = Date.now();
  return {
    ...cred,
    accessToken: data.access_token,
    // xAI rotates refresh tokens; keep the old one if a refresh omits it.
    refreshToken: data.refresh_token ?? cred.refreshToken,
    expiresAt: now + data.expires_in * 1000 - REFRESH_MARGIN_MS,
    scope: data.scope ?? cred.scope,
  };
}

/** True if the credential is at or past `expiresAt` (which already has
 *  REFRESH_MARGIN_MS subtracted). Mirrors the Codex helper of the same name. */
export function isXaiGrokExpiringSoon(cred: OAuthCredential): boolean {
  return Date.now() >= cred.expiresAt;
}

/**
 * Build the auth identity header for a grok-cli proxy request. The adapter
 * composes the rest (X-XAI-Token-Auth, x-grok-client-version,
 * x-grok-model-override, Content-Type).
 */
export function xaiGrokAuthHeaders(cred: OAuthCredential): Record<string, string> {
  return { Authorization: `Bearer ${cred.accessToken}` };
}
