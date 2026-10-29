import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { pollKimiDeviceToken } from "@/lib/ai/llm/auth/oauth/kimi-coding";
import { setCredential } from "@/lib/ai/llm/auth/store";
import { recordAuthEvent } from "@/lib/ai/llm/auth/events";

const DEVICE_COOKIE = "kimi-device-code";
const DEVICE_ID_COOKIE = "kimi-device-id";

export async function POST(req: NextRequest) {
  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });
  const { user } = await payload.auth({ headers: req.headers });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const deviceCode = req.cookies.get(DEVICE_COOKIE)?.value;
  const deviceId = req.cookies.get(DEVICE_ID_COOKIE)?.value;
  if (!deviceCode || !deviceId) {
    return NextResponse.json(
      { error: "No Kimi login in progress; click Begin login again." },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await pollKimiDeviceToken(deviceCode, deviceId);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }

  if (result.status === "connected") {
    await setCredential("kimi-coding", result.credential);
    await recordAuthEvent({
      provider: "kimi-coding",
      kind: "oauth-connected",
      message: "Connected to Kimi For Coding via device-code OAuth.",
    }).catch(() => {});
    const res = NextResponse.json({ status: "connected" });
    res.cookies.delete(DEVICE_COOKIE);
    res.cookies.delete(DEVICE_ID_COOKIE);
    return res;
  }

  if (result.status === "expired" || result.status === "denied") {
    const res = NextResponse.json({ status: result.status });
    res.cookies.delete(DEVICE_COOKIE);
    res.cookies.delete(DEVICE_ID_COOKIE);
    return res;
  }

  return NextResponse.json({ status: result.status });
}
