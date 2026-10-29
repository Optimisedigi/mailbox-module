import crypto from "node:crypto";
import os from "node:os";
import type { OAuthCredential } from "../types";

const KIMI_CLI_VERSION = "1.36.0";
const OAUTH_HOST = "https://auth.kimi.com";
const OAUTH_DEVICE_AUTH_URL = `${OAUTH_HOST}/api/oauth/device_authorization`;
const OAUTH_TOKEN_URL = `${OAUTH_HOST}/api/oauth/token`;
const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const OAUTH_REFRESH_GRANT = "refresh_token";
const REFRESH_SAFETY_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
const REFRESH_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const REFRESH_MAX_RETRIES = 3;

export const KIMI_CODING_API_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_CODING_MODEL_ID = "kimi-for-coding";

export interface KimiDeviceAuth {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  deviceId: string;
}

interface RawDeviceAuth {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

interface KimiModelInfo {
  id: string;
  display_name?: string;
  context_length?: number;
}

interface ModelDiscovery {
  modelId?: string;
  contextLength?: number;
  modelDisplay?: string;
}

function asciiHeaderValue(value: string, fallback = "unknown"): string {
  const sanitized = value.replace(/[^\x20-\x7e]/g, "").trim();
  return sanitized || fallback;
}

function kimiDeviceModel(): string {
  const system = os.type();
  const release = os.release();
  const machine = os.machine?.() ?? os.arch();
  if (system === "Darwin") return `macOS ${release} ${machine}`;
  if (system === "Windows_NT") return `Windows ${release} ${machine}`;
  return `${system} ${release} ${machine}`.trim();
}

function deviceIdFromCredential(credential?: OAuthCredential): string {
  if (credential?.deviceId) return credential.deviceId;
  return crypto.randomUUID().replace(/-/g, "");
}

export function kimiCodingHeaders(credential?: OAuthCredential): Record<string, string> {
  const version = KIMI_CLI_VERSION;
  return {
    "User-Agent": `KimiCLI/${version}`,
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": version,
    "X-Msh-Device-Name": asciiHeaderValue(os.hostname() || "unknown"),
    "X-Msh-Device-Model": asciiHeaderValue(kimiDeviceModel()),
    "X-Msh-Device-Id": deviceIdFromCredential(credential),
    "X-Msh-Os-Version": asciiHeaderValue(os.version?.() || `${os.type()} ${os.release()}`),
  };
}

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function postForm<T>(
  url: string,
  params: Record<string, string>,
  deviceId: string,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...kimiCodingHeaders({
        kind: "oauth",
        provider: "kimi-coding",
        accessToken: "",
        refreshToken: "",
        expiresAt: 0,
        clientId: OAUTH_CLIENT_ID,
        scope: "kimi-code",
        obtainedAt: Date.now(),
        deviceId,
      }),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formBody(params),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`kimi oauth: non-JSON response from ${url} (status ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const body = json as { error?: string; error_description?: string };
    const err = new Error(`kimi oauth ${body.error ?? res.status}: ${body.error_description ?? text}`) as Error & {
      code?: string;
      status?: number;
    };
    err.code = body.error;
    err.status = res.status;
    throw err;
  }
  return json as T;
}

export async function beginKimiDeviceLogin(): Promise<KimiDeviceAuth> {
  const deviceId = crypto.randomUUID().replace(/-/g, "");
  const raw = await postForm<RawDeviceAuth>(OAUTH_DEVICE_AUTH_URL, { client_id: OAUTH_CLIENT_ID }, deviceId);
  return {
    deviceCode: raw.device_code,
    userCode: raw.user_code,
    verificationUri: raw.verification_uri_complete ?? raw.verification_uri,
    expiresIn: raw.expires_in,
    interval: raw.interval,
    deviceId,
  };
}

async function listModels(accessToken: string, deviceId: string): Promise<KimiModelInfo[]> {
  const credential: OAuthCredential = {
    kind: "oauth",
    provider: "kimi-coding",
    accessToken,
    refreshToken: "",
    expiresAt: 0,
    clientId: OAUTH_CLIENT_ID,
    scope: "kimi-code",
    obtainedAt: Date.now(),
    deviceId,
  };
  const res = await fetch(`${KIMI_CODING_API_BASE_URL}/models`, {
    headers: {
      ...kimiCodingHeaders(credential),
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`kimi list-models ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { data?: KimiModelInfo[] };
  return Array.isArray(json.data) ? json.data.filter((m) => typeof m?.id === "string") : [];
}

function pickModelInfo(models: KimiModelInfo[]): ModelDiscovery {
  const picked = models.find((m) => m.id === KIMI_CODING_MODEL_ID) ?? models[0];
  if (!picked) return {};
  return {
    modelId: picked.id,
    contextLength: picked.context_length,
    modelDisplay: picked.display_name,
  };
}

function credentialFromTokens(tokens: TokenResponse, refreshToken: string, deviceId: string, discovery: ModelDiscovery): OAuthCredential {
  return {
    kind: "oauth",
    provider: "kimi-coding",
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: Date.now() + tokens.expires_in * 1000 - REFRESH_SAFETY_WINDOW_MS,
    clientId: OAUTH_CLIENT_ID,
    scope: "kimi-code",
    obtainedAt: Date.now(),
    deviceId,
    kimiModelId: discovery.modelId,
    kimiContextLength: discovery.contextLength,
    kimiModelDisplay: discovery.modelDisplay,
  };
}

export async function pollKimiDeviceToken(
  deviceCode: string,
  deviceId: string,
): Promise<
  | { status: "pending" | "slow_down" }
  | { status: "expired" | "denied" }
  | { status: "connected"; credential: OAuthCredential }
> {
  try {
    const tokens = await postForm<TokenResponse>(OAUTH_TOKEN_URL, {
      client_id: OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: OAUTH_DEVICE_GRANT,
    }, deviceId);
    if (!tokens.refresh_token) throw new Error("kimi oauth: token response missing refresh_token");
    let discovery: ModelDiscovery = {};
    try {
      discovery = pickModelInfo(await listModels(tokens.access_token, deviceId));
    } catch {
      // Non-fatal: the chat request can still use the default wire model.
    }
    return { status: "connected", credential: credentialFromTokens(tokens, tokens.refresh_token, deviceId, discovery) };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "authorization_pending") return { status: "pending" };
    if (code === "slow_down") return { status: "slow_down" };
    if (code === "expired_token") return { status: "expired" };
    if (code === "access_denied") return { status: "denied" };
    throw err;
  }
}

export function isKimiExpiringSoon(cred: OAuthCredential): boolean {
  return Date.now() + REFRESH_SAFETY_WINDOW_MS >= cred.expiresAt;
}

export async function refreshKimiCredential(cred: OAuthCredential): Promise<OAuthCredential> {
  let lastError: unknown;
  const deviceId = deviceIdFromCredential(cred);
  for (let attempt = 0; attempt < REFRESH_MAX_RETRIES; attempt++) {
    try {
      const tokens = await postForm<TokenResponse>(OAUTH_TOKEN_URL, {
        client_id: OAUTH_CLIENT_ID,
        refresh_token: cred.refreshToken,
        grant_type: OAUTH_REFRESH_GRANT,
      }, deviceId);
      let discovery: ModelDiscovery = {};
      try {
        discovery = pickModelInfo(await listModels(tokens.access_token, deviceId));
      } catch {
        // Keep existing discovery below.
      }
      return credentialFromTokens(tokens, tokens.refresh_token ?? cred.refreshToken, deviceId, {
        modelId: discovery.modelId ?? cred.kimiModelId,
        contextLength: discovery.contextLength ?? cred.kimiContextLength,
        modelDisplay: discovery.modelDisplay ?? cred.kimiModelDisplay,
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      const retryable = status === undefined || REFRESH_RETRYABLE_STATUSES.has(status);
      lastError = err;
      if (!retryable || attempt === REFRESH_MAX_RETRIES - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("kimi oauth: token refresh failed");
}

export function kimiAuthHeaders(cred: OAuthCredential): Record<string, string> {
  return {
    ...kimiCodingHeaders(cred),
    Authorization: `Bearer ${cred.accessToken}`,
  };
}
