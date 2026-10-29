import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getPayload } from "payload";
import config from "@/payload.config";
import { getGmailOAuthUrl } from "@/lib/gmail-service";
import { GMAIL_EXTRA_APP_COOKIE, gmailAppForEmail, parseGmailExtraApp } from "@/lib/gmail-oauth-apps";
import { normaliseMailAccount } from "@/lib/mail/accounts-shared";
import { OAUTH_NONCE_COOKIE, signOAuthState } from "@/lib/oauth-state";

/**
 * Initiate Gmail OAuth for the currently logged-in user.
 *
 * Requires an admin session. Signs an HMAC `state` binding (nonce, userId,
 * initiatorUserId) where target == initiator \u2014 only the user themselves can
 * (re)bind their own Gmail tokens. See `src/lib/oauth-state.ts`.
 *
 * `?add=1` connects another Gmail address as an extra Mail account (see
 * src/lib/mail/accounts.ts); the main Gmail on the user record is untouched.
 * `?add=1&app=alt` (or alt2, alt3) does the same through one of the extra
 * Gmail apps, for accounts the main app cannot sign in: another Google
 * Workspace, or a personal Gmail (see src/lib/gmail-oauth-apps.ts).
 * `?add=1&email=<address>` (Mail's single "Add email account" button) picks
 * that app from the address itself and pre-fills it in Google's sign-in;
 * the callback still checks the address that actually signed in.
 */
export async function GET(req: NextRequest) {
  if (
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET ||
    !process.env.GMAIL_REDIRECT_URI
  ) {
    return NextResponse.json(
      {
        error:
          "Gmail OAuth credentials not configured (need GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_REDIRECT_URI).",
      },
      { status: 500 },
    );
  }

  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });
  const { user } = await payload.auth({ headers: req.headers });

  if (!user || user.role !== "admin") {
    return NextResponse.json(
      { error: "You must be signed in as an admin to connect Gmail." },
      { status: 401 },
    );
  }

  const { state, nonce } = signOAuthState(user.id, user.id);
  // ?add=1 (Mail account menu): connect another Gmail as an extra account
  // instead of replacing the main one. The flow is marked by which nonce
  // cookie is set, so the callback knows without trusting a URL parameter.
  const adding = req.nextUrl.searchParams.get("add") === "1";
  const requestedApp = adding ? req.nextUrl.searchParams.get("app") : null;
  const emailParam = adding && !requestedApp ? req.nextUrl.searchParams.get("email") : null;
  const email = emailParam === null ? "" : normaliseMailAccount(emailParam);
  if (emailParam !== null && !email) {
    return NextResponse.json({ error: "Enter a valid email address to add." }, { status: 400 });
  }
  const appForEmail = email ? gmailAppForEmail(email) : "main";
  // Only an extra app that is fully set up; anything else is refused rather than falling back.
  const extraApp = requestedApp ? parseGmailExtraApp(requestedApp) : appForEmail === "main" ? null : appForEmail;
  if (requestedApp && !extraApp) {
    return NextResponse.json({ error: "That Gmail sign-in option is not set up." }, { status: 400 });
  }

  const cookieStore = await cookies();
  cookieStore.set(extraApp ? GMAIL_EXTRA_APP_COOKIE[extraApp] : adding ? OAUTH_NONCE_COOKIE.gmailAdd : OAUTH_NONCE_COOKIE.gmail, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  return NextResponse.redirect(
    getGmailOAuthUrl(state, { selectAccount: adding, app: extraApp ?? "main", ...(email ? { loginHint: email } : {}) }),
  );
}
