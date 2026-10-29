import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { beginKimiDeviceLogin } from "@/lib/ai/llm/auth/oauth/kimi-coding";

const DEVICE_COOKIE = "kimi-device-code";
const DEVICE_ID_COOKIE = "kimi-device-id";

export async function POST(req: NextRequest) {
  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });
  const { user } = await payload.auth({ headers: req.headers });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let result;
  try {
    result = await beginKimiDeviceLogin();
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }

  const res = NextResponse.json({
    userCode: result.userCode,
    verificationUri: result.verificationUri,
    expiresIn: result.expiresIn,
    interval: result.interval,
  });
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: result.expiresIn + 60,
    path: "/",
  };
  res.cookies.set(DEVICE_COOKIE, result.deviceCode, cookieOptions);
  res.cookies.set(DEVICE_ID_COOKIE, result.deviceId, cookieOptions);
  return res;
}
