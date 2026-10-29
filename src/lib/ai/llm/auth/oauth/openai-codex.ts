/**
 * Codex (ChatGPT subscription) OAuth — Authorization Code + PKCE flow.
 *
 * Serves GPT models from a flat-rate ChatGPT plan via the
 * Codex CLI OAuth client + the private `chatgpt.com/backend-api/codex/responses`
 * endpoint, instead of a billed OPENAI_API_KEY. This is the "Sign in with
 * ChatGPT" subscription-reuse pattern. OpenAI can revoke tokens, rotate the client id, or change the server-side
 * Codex-prompt check at any time. The resolver + callLLM fallback chain means
 * any failure here walks down fallbackModels (Kimi -> MiniMax -> Claude).
 *
 * Adapted from gg-framework (MIT, see THIRD_PARTY_NOTICES.md). It is the
 * standard browser PKCE flow the Codex CLI uses by default — NOT the device-code flow, which requires an
 * account-level "device code login" toggle most users don't have enabled.
 *
 * The Codex CLI's `client_id` is registered for loopback redirects only, so we
 * hard-code `http://localhost:1455/auth/callback` as the `redirect_uri`. The
 * browser will land on a page the user's machine isn't running; the admin page
 * asks the user to copy the full callback URL (or `code#state`) and paste it
 * into the completion field. The PKCE `code_verifier` is generated here and
 * round-tripped via an httpOnly cookie so the completion route can exchange
 * the code.
 *
 * Flow:
 *   1. GET  https://auth.openai.com/oauth/authorize?... (browser, user signs in)
 *   2. OpenAI redirects to localhost:1455 (unreachable); user pastes the URL.
 *   3. POST https://auth.openai.com/oauth/token  grant_type=authorization_code
 *        (+ code_verifier, redirect_uri) -> { id_token, access_token,
 *        refresh_token, expires_in }
 *   4. Extract chatgpt_account_id from the access_token JWT.
 */

import { generateChallenge } from "../pkce";
import { CODEX_ORIGINATOR } from "../../codex-identity";
import type { OAuthCredential } from "../types";

/** The Codex CLI's public OAuth client id. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Codex CLI's `client_id` is registered for loopback redirects only. The
 *  browser lands here after consent; the user's machine is not running a
 *  listener, and the admin page asks the user to paste the full URL instead. */
const REDIRECT_URI = "http://localhost:1455/auth/callback";
/** Scopes the Codex CLI requests. */
const SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
/** JWT claim namespace OpenAI uses for ChatGPT account/org identity. */
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** Refresh ~5 minutes early to avoid 401s on the boundary. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface OAuthTokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

/** Output of beginCodexLogin — given to the admin page so it can render the
 *  consent link and remember the verifier + state across the paste step. */
export interface BeginCodexLoginResult {
  authorizeUrl: string;
  state: string;
  codeVerifier: string;
}

/**
 * Step 1: build the authorize URL + PKCE verifier. Uses the Codex CLI's
 * query params (including the codex-specific flags that
 * make OpenAI mint a Codex-capable token).
 */
export function beginCodexLogin(): BeginCodexLoginResult {
  const { codeVerifier, codeChallenge } = generateChallenge();
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", CODEX_ORIGINATOR);

  return { authorizeUrl: url.toString(), state, codeVerifier };
}

/**
 * Parse the user's pasted authorization input. Accepts (in this
 * order): a full callback URL, a `code#state` string, a raw query string
 * containing `code=`, or a bare code. Returns the extracted code + state.
 */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  // Full URL
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }

  // code#state
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  // Query string with code=
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  // Raw code
  return { code: value };
}

/**
 * Decode a JWT payload without verifying the signature. We only read claims
 * (account id); authenticity comes from the token having been issued by the
 * OAuth token endpoint over TLS. Returns null on malformed input.
 */
function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Extract the ChatGPT account id from a Codex access_token JWT. Reads `["https://api.openai.com/auth"].chatgpt_account_id` from the access
 * token. We keep org-id fallbacks so a token missing the primary claim still
 * resolves a usable account scope; returns "" when nothing is found.
 */
export function extractAccountId(token: string): string {
  const claims = decodeJwt(token);
  if (!claims) return "";
  const authClaim = claims[JWT_CLAIM_PATH] as
    | {
        chatgpt_account_id?: string;
        organization_id?: string;
        organizations?: Array<{ id?: string; is_default?: boolean }>;
      }
    | undefined;
  if (authClaim?.chatgpt_account_id) return authClaim.chatgpt_account_id;
  if (authClaim?.organization_id) return authClaim.organization_id;
  const orgs = authClaim?.organizations;
  if (Array.isArray(orgs) && orgs.length > 0) {
    const def = orgs.find((o) => o.is_default) ?? orgs[0];
    if (def?.id) return def.id;
  }
  const topOrg = claims.organization_id;
  if (typeof topOrg === "string" && topOrg) return topOrg;
  return "";
}

/**
 * Step 3: validate the pasted code against the expected state, then exchange
 * it for tokens. The `expectedState` / `codeVerifier` come from the cookie set
 * at beginCodexLogin. If the paste carried a state, it must match; a missing
 * state in the paste (raw code) is tolerated, so we only enforce a
 * mismatch when one is present.
 */
export async function completeCodexLogin(opts: {
  pasteString: string;
  expectedState: string;
  codeVerifier: string;
}): Promise<OAuthCredential> {
  const parsed = parseAuthorizationInput(opts.pasteString);
  if (!parsed.code) {
    throw new Error("No authorization code found in input. Paste the code, code#state, or full callback URL.");
  }
  if (parsed.state && parsed.state !== opts.expectedState) {
    throw new Error("State mismatch. Please retry the login flow.");
  }
  return exchangeCodexCode({
    authorizationCode: parsed.code,
    codeVerifier: opts.codeVerifier,
  });
}

/** Exchange an authorization code for tokens at the OAuth token endpoint and
 *  build the stored credential. Account id is read from the access_token. */
export async function exchangeCodexCode(opts: {
  authorizationCode: string;
  codeVerifier: string;
}): Promise<OAuthCredential> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: opts.authorizationCode,
      redirect_uri: REDIRECT_URI,
      code_verifier: opts.codeVerifier,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`OpenAI token exchange failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as OAuthTokenResponse;
  const now = Date.now();
  // The account id comes from the access_token (not id_token); treat a missing account id as a hard error.
  const accountId = extractAccountId(data.access_token);
  if (!accountId) {
    throw new Error("Failed to extract accountId from OpenAI token.");
  }
  return {
    kind: "oauth",
    provider: "openai-codex",
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + data.expires_in * 1000 - REFRESH_MARGIN_MS,
    clientId: CLIENT_ID,
    scope: data.scope ?? SCOPE,
    obtainedAt: now,
    accountId,
  };
}

/** Refresh the access token using the stored refresh token. Preserves
 *   the existing account id when
 *  a refreshed token omits the claim). Caller persists via setCredential() and
 *  serialises calls via the refresh-lock map. */
export async function refreshCodexCredential(cred: OAuthCredential): Promise<OAuthCredential> {
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
    throw new Error(`OpenAI token refresh failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as OAuthTokenResponse;
  const now = Date.now();
  const refreshedAccountId = extractAccountId(data.access_token);
  return {
    ...cred,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? cred.refreshToken,
    expiresAt: now + data.expires_in * 1000 - REFRESH_MARGIN_MS,
    scope: data.scope ?? cred.scope,
    accountId: refreshedAccountId || cred.accountId,
  };
}

/** True if the credential is at or past `expiresAt`. `expiresAt` already has
 *  REFRESH_MARGIN_MS subtracted (see exchange/refresh), so don't subtract it
 *  a second time. Mirrors the Anthropic module's helper of the same name. */
export function isCodexExpiringSoon(cred: OAuthCredential): boolean {
  return Date.now() >= cred.expiresAt;
}

/**
 * Build the auth identity headers for a Codex Responses request. The adapter
 * composes the rest (OpenAI-Beta, originator, User-Agent, Content-Type). We
 * return the Bearer token and, when known, the chatgpt-account-id header.
 */
export function codexAuthHeaders(cred: OAuthCredential): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.accessToken}`,
  };
  if (cred.accountId) headers["chatgpt-account-id"] = cred.accountId;
  return headers;
}
