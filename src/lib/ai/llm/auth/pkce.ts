/**
 * PKCE helpers for OAuth Authorization Code + PKCE flow.
 */

import crypto from "crypto";

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateChallenge(): { codeVerifier: string; codeChallenge: string } {
  // 64 random bytes -> 86-char base64url verifier, matching the Codex CLI's
  // PKCE length. OpenAI's Hydra auth server rejects shorter verifiers with
  // `authorize_hydra_invalid_request`.
  const verifierBytes = crypto.randomBytes(64);
  const codeVerifier = base64Url(verifierBytes);
  const challengeBytes = crypto.createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = base64Url(challengeBytes);
  return { codeVerifier, codeChallenge };
}
