import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { exchangeCalendarCode, getCalendarUserEmail } from "@/lib/calendar-service";

const STATE_COOKIE = "oauth_state_calendar";

/**
 * Constant-time comparison of two hex-encoded state strings.
 */
function safeStateEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  const queryState = req.nextUrl.searchParams.get("state");
  const storedState = req.cookies.get(STATE_COOKIE)?.value;

  const clearStateCookie = (res: NextResponse) => {
    res.cookies.set(STATE_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
    return res;
  };

  if (error) {
    return clearStateCookie(
      NextResponse.redirect(
        new URL(
          `/admin/globals/calendar-auth?calendar_error=${encodeURIComponent(error)}`,
          req.url
        )
      )
    );
  }

  // Validate state BEFORE doing any work (CSRF + OAuth hijack protection).
  if (
    !storedState ||
    !queryState ||
    !safeStateEqual(storedState, queryState)
  ) {
    return clearStateCookie(
      NextResponse.redirect(new URL("/admin?error=oauth_state_mismatch", req.url))
    );
  }

  if (!code) {
    return clearStateCookie(
      NextResponse.json({ error: "Missing authorization code" }, { status: 400 })
    );
  }

  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });

  // Re-check admin session on callback — defence in depth.
  const { user } = await payload.auth({ headers: req.headers });
  if (!user || user.role !== "admin") {
    return clearStateCookie(
      NextResponse.redirect(new URL("/admin?error=unauthorized", req.url))
    );
  }

  // Build redirect URI — must match what was used in the connect step
  const redirectUri =
    process.env.CALENDAR_REDIRECT_URI ||
    new URL("/api/calendar/callback", req.url).toString();

  try {
    const tokens = await exchangeCalendarCode(code, redirectUri);

    // Try to get user email — don't fail the whole connection if this fails
    let email = "";
    try {
      email = await getCalendarUserEmail(tokens.accessToken);
    } catch (emailErr) {
      console.warn("[calendar-callback] Could not fetch user email:", emailErr);
      email = "(connected)";
    }

    await payload.updateGlobal({
      slug: "calendar-auth" as any,
      data: {
        refreshToken: tokens.refreshToken,
        connectedEmail: email,
        connectedAt: new Date().toISOString(),
      } as any,
      overrideAccess: true,
    });

    return clearStateCookie(
      NextResponse.redirect(new URL("/admin/globals/calendar-auth", req.url))
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "OAuth exchange failed";
    console.error("[calendar-callback]", message);
    return clearStateCookie(
      NextResponse.redirect(
        new URL(
          `/admin/globals/calendar-auth?calendar_error=${encodeURIComponent(message)}`,
          req.url
        )
      )
    );
  }
}
