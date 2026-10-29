import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { pollGrokDeviceToken } from "@/lib/ai/llm/auth/oauth/xai-grok";
import { setCredential } from "@/lib/ai/llm/auth/store";
import { recordAuthEvent } from "@/lib/ai/llm/auth/events";

const DEVICE_COOKIE = "grok-device-code";

/**
 * POST /api/ai-auth/grok/poll
 *
 * Polled by the admin page after /grok/begin. Reads the device_code cookie and
 * exchanges it once. Returns:
 *   - { status: "pending" | "slow_down" }  -> keep polling
 *   - { status: "connected" }              -> credential stored; stop
 *   - { status: "expired" | "denied" }     -> stop; restart the flow
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

  const deviceCode = req.cookies.get(DEVICE_COOKIE)?.value;
  if (!deviceCode) {
    return NextResponse.json(
      { error: "No Grok login in progress; click Begin login again." },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await pollGrokDeviceToken(deviceCode);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }

  if (result.status === "connected") {
    await setCredential("xai-grok", result.credential);
    await recordAuthEvent({
      provider: "xai-grok",
      kind: "oauth-connected",
      message: "Connected to xAI Grok via SuperGrok device-code OAuth.",
    }).catch(() => {});
    const res = NextResponse.json({ status: "connected" });
    res.cookies.delete(DEVICE_COOKIE);
    return res;
  }

  if (result.status === "expired" || result.status === "denied") {
    const res = NextResponse.json({ status: result.status });
    res.cookies.delete(DEVICE_COOKIE);
    return res;
  }

  return NextResponse.json({ status: result.status });
}
