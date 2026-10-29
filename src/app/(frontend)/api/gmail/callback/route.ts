import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getPayload } from "payload";
import config from "@/payload.config";
import { exchangeGmailCode } from "@/lib/gmail-service";
import { OAUTH_NONCE_COOKIE, verifyOAuthState } from "@/lib/oauth-state";
import { saveMailAccountTokens } from "@/lib/mail/accounts";
import { GMAIL_EXTRA_APP_COOKIE, GMAIL_EXTRA_APPS, gmailAppMatchesEmail, type GmailOAuthApp } from "@/lib/gmail-oauth-apps";

/**
 * Gmail OAuth callback.
 *
 * Validates the HMAC-signed `state` (OAuth CSRF protection) before persisting any
 * tokens onto the target user row. For Gmail, target == initiator: only the
 * user themselves may (re)bind their own Gmail tokens. Three independent
 * checks must pass:
 *   1. State signature (`PAYLOAD_SECRET` HMAC).
 *   2. Nonce cookie match.
 *   3. Current session must equal `initiatorUserId` (which equals `targetId`).
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const stateRaw = req.nextUrl.searchParams.get("state");
  const oauthError = req.nextUrl.searchParams.get("error");

  const redirectTo = (params: Record<string, string>) => {
    const u = new URL("/admin/ai-auth", req.url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return NextResponse.redirect(u);
  };

  if (oauthError) {
    return redirectTo({ gmail_error: oauthError });
  }
  if (!code || !stateRaw) {
    return NextResponse.json(
      { error: "Missing code or state parameter" },
      { status: 400 },
    );
  }

  const verified = verifyOAuthState(stateRaw);
  if (!verified.ok) return redirectTo({ gmail_error: verified.reason });

  const { nonce, targetId, initiatorUserId } = verified;
  if (targetId !== initiatorUserId) {
    // Defence-in-depth: Gmail flows always self-bind. A mismatched pair
    // would mean the state was minted by something other than our connect
    // route (or a bug in it) \u2014 refuse.
    return redirectTo({ gmail_error: "target_initiator_mismatch" });
  }

  const cookieStore = await cookies();
  // Which connect flow minted this state: the main Gmail, an extra Mail account,
  // or an extra account through one of the extra Gmail apps. Read from the nonce
  // cookie the connect route set, never from a URL parameter.
  const extraApp = GMAIL_EXTRA_APPS.find((candidate) => {
    const value = cookieStore.get(GMAIL_EXTRA_APP_COOKIE[candidate])?.value;
    return Boolean(value) && value === nonce;
  });
  const addNonce = cookieStore.get(OAUTH_NONCE_COOKIE.gmailAdd)?.value;
  const adding = Boolean(extraApp) || (Boolean(addNonce) && addNonce === nonce);
  const app: GmailOAuthApp = extraApp ?? "main";
  const cookieName = extraApp ? GMAIL_EXTRA_APP_COOKIE[extraApp] : adding ? OAUTH_NONCE_COOKIE.gmailAdd : OAUTH_NONCE_COOKIE.gmail;
  const cookieNonce = cookieStore.get(cookieName)?.value;
  if (!cookieNonce || cookieNonce !== nonce) {
    return redirectTo({ gmail_error: "nonce_mismatch" });
  }
  cookieStore.delete(cookieName);

  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });
  const { user } = await payload.auth({ headers: req.headers });
  if (!user || String(user.id) !== initiatorUserId) {
    return redirectTo({ gmail_error: "user_mismatch" });
  }

  const userId = Number(targetId);
  if (!Number.isFinite(userId) || userId <= 0) {
    return redirectTo({ gmail_error: "invalid_state" });
  }

  try {
    const tokens = await exchangeGmailCode(code, app);
    // Token refresh picks the app by the account's domain, so only keep tokens whose
    // domain belongs to the app that issued them (see gmail-oauth-apps.ts).
    if (!gmailAppMatchesEmail(app, tokens.email)) {
      throw new Error(
        app !== "main"
          ? `${tokens.email} is not an account this sign-in option is set up for. Pick the option for ${tokens.email} in the Mail account menu.`
          : `${tokens.email} must be added with its own sign-in option in the Mail account menu.`,
      );
    }

    if (adding) {
      const mailRedirect = (params: Record<string, string>) => {
        const u = new URL("/admin/mail", req.url);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        return NextResponse.redirect(u);
      };
      const current = (await payload.findByID({ collection: "users", id: userId, depth: 0, overrideAccess: true })) as {
        gmailConnected?: boolean;
        gmailEmail?: string | null;
      };
      const isMain = (current.gmailEmail ?? "").trim().toLowerCase() === tokens.email.trim().toLowerCase();
      // With no main Gmail yet, or the main address picked again, it is (re)connected as the main account.
      if (!current.gmailConnected || isMain) {
        await payload.update({
          collection: "users",
          id: userId,
          overrideAccess: true,
          data: {
            gmailConnected: true,
            gmailEmail: tokens.email,
            gmailAccessToken: tokens.accessToken,
            gmailRefreshToken: tokens.refreshToken,
            gmailTokenExpiry: tokens.expiry,
          },
        });
        return mailRedirect({ mail_account_added: tokens.email });
      }
      const saved = await saveMailAccountTokens(payload, userId, tokens);
      if (!saved.ok) return mailRedirect({ mail_account_error: saved.error });
      return mailRedirect({ account: tokens.email.trim().toLowerCase(), mail_account_added: tokens.email });
    }

    await payload.update({
      collection: "users",
      id: userId,
      overrideAccess: true,
      data: {
        gmailConnected: true,
        gmailEmail: tokens.email,
        gmailAccessToken: tokens.accessToken,
        gmailRefreshToken: tokens.refreshToken,
        gmailTokenExpiry: tokens.expiry,
      },
    });

    return redirectTo({ gmail_connected: "1" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "OAuth exchange failed";
    console.error("[gmail-callback]", message);
    if (adding) {
      const u = new URL("/admin/mail", req.url);
      u.searchParams.set("mail_account_error", message);
      return NextResponse.redirect(u);
    }
    return redirectTo({ gmail_error: message });
  }
}
