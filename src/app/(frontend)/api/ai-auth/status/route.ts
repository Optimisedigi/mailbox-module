import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { getCredential, isForceFallback } from "@/lib/ai/llm/auth/store";
import { getLastFailure } from "@/lib/ai/llm/auth/events";

/**
 * GET /api/ai-auth/status
 *
 * Returns per-provider credential status for the admin UI:
 *   - whether OAuth is connected
 *   - last refresh timestamp
 *   - force-fallback flag
 *   - whether an env-var API key is set
 *
 * Auth: requires a logged-in CMS user.
 */
export async function GET(req: NextRequest) {
  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });
  const { user } = await payload.auth({ headers: req.headers });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const providers = ["anthropic", "moonshot", "kimi-coding", "minimax", "openai", "openai-codex", "xai-grok"] as const;
  const status = await Promise.all(
    providers.map(async (provider) => {
      const cred = await getCredential(provider);
      const force = await isForceFallback(provider);
      const lastFailure = await getLastFailure(provider);
      const envKey =
        provider === "anthropic"
          ? Boolean(process.env.ANTHROPIC_API_KEY)
          : provider === "moonshot"
          ? Boolean(process.env.KIMI_API_KEY)
          : provider === "kimi-coding"
          ? false
          : provider === "minimax"
          ? Boolean(process.env.MINIMAX_API_KEY)
          : provider === "openai"
          ? Boolean(process.env.OPENAI_API_KEY)
          : // openai-codex is OAuth-only — no API key path.
            false;
      // A stored OAuth row is NOT the same as a usable one. Anthropic
      // credentials whose access AND refresh tokens have both lapsed still sit
      // in the collection, so reporting a bare `oauthConnected: true` told the
      // user "connected" while every call 401'd. Surface the expiry explicitly.
      const oauthExpired =
        cred?.kind === "oauth" && typeof cred.expiresAt === "number"
          ? cred.expiresAt <= Date.now()
          : false;
      return {
        provider,
        oauthConnected: cred?.kind === "oauth",
        oauthExpired,
        oauthExpiresAt: cred?.kind === "oauth" ? cred.expiresAt : null,
        oauthObtainedAt: cred?.kind === "oauth" ? cred.obtainedAt : null,
        oauthAccountId:
          cred?.kind === "oauth" && cred.accountId ? true : false,
        forceFallback: force,
        envApiKeyPresent: envKey,
        lastFailure: lastFailure
          ? {
              timestamp: lastFailure.timestamp,
              message: lastFailure.message,
            }
          : null,
      };
    }),
  );

  return NextResponse.json({ providers: status });
}
