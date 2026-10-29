import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { beginGrokDeviceLogin } from "@/lib/ai/llm/auth/oauth/xai-grok";

const DEVICE_COOKIE = "grok-device-code";

/**
 * POST /api/ai-auth/grok/begin
 *
 * Starts the xAI Grok (SuperGrok subscription) OAuth Device Authorization
 * Grant. Returns the verification URL + user code the operator approves in
 * their browser, and stashes the device_code in an httpOnly cookie so the
 * matching /grok/poll call can complete the exchange.
 *
 * Auth: requires a logged-in CMS user.
 */
export async function POST(req: NextRequest) {
  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });
  const { user } = await payload.auth({ headers: req.headers });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let result;
  try {
    result = await beginGrokDeviceLogin();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }

  const res = NextResponse.json({
    userCode: result.userCode,
    verificationUri: result.verificationUri,
    expiresIn: result.expiresIn,
    interval: result.interval,
  });
  res.cookies.set(DEVICE_COOKIE, result.deviceCode, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    // A touch beyond the device_code's own ~10 min lifetime.
    maxAge: result.expiresIn + 60,
    path: "/",
  });
  return res;
}
