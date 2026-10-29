import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { beginCodexLogin } from "@/lib/ai/llm/auth/oauth/openai-codex";

const STATE_COOKIE = "agent-auth-state";
const STATE_TTL_SECONDS = 600; // 10 minutes is plenty for the paste flow

/**
 * POST /api/ai-auth/begin
 * Body: { provider: "openai-codex" }
 *
 * Starts the ChatGPT (Codex OAuth) PKCE paste flow. The verifier and state go
 * in an httpOnly cookie (10 minutes) so /complete can validate the pasted
 * callback URL. The Codex CLI client id is registered for loopback redirects
 * only, so the user copies the localhost callback URL back into the page.
 * Auth: requires a logged-in user.
 */
export async function POST(req: NextRequest) {
  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });
  const { user } = await payload.auth({ headers: req.headers });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { provider?: string };
  const provider = body.provider ?? "openai-codex";

  if (provider !== "openai-codex") {
    return NextResponse.json({ error: "Unsupported provider. Use 'openai-codex'." }, { status: 400 });
  }

  const login = beginCodexLogin();

  const cookieValue = JSON.stringify({
    provider,
    state: login.state,
    codeVerifier: login.codeVerifier,
  });
  const res = NextResponse.json({
    provider,
    authorizeUrl: login.authorizeUrl,
    state: login.state,
  });
  res.cookies.set(STATE_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: STATE_TTL_SECONDS,
    path: "/",
  });
  return res;
}
