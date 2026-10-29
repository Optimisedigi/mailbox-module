/**
 * Resolve a logged-in user's Gmail OAuth credentials, refreshing the access
 * token when it's expired. The main Gmail lives on the `users` row; extra
 * accounts live in `mail-accounts`.
 */

import { getPayload } from "payload";
import payloadConfig from "@/payload.config";
import { refreshGmailAccessToken } from "@/lib/gmail-service";
import { findMailAccount, updateMailAccount } from "@/lib/mail/accounts";
import { normaliseMailAccount } from "@/lib/mail/accounts-shared";

interface UserDoc {
  id: number;
  email?: string;
  gmailConnected?: boolean;
  gmailEmail?: string;
  gmailAccessToken?: string;
  gmailRefreshToken?: string;
  gmailTokenExpiry?: string | null;
}

export interface GmailTokenResult {
  ok: true;
  accessToken: string;
  email: string; // the connected gmail address
  userEmail: string; // the user's CMS email (fallback recipient)
  /** The extra Gmail account (mail-accounts email) this token is for; "" = the user's main Gmail. */
  account?: string;
}

export interface GmailTokenError {
  ok: false;
  reason: string;
}

function isExpired(expiry: string | null | undefined): boolean {
  if (!expiry) return true;
  return new Date(expiry).getTime() <= Date.now() + 30_000; // 30s safety
}

async function loadUser(userId: number): Promise<UserDoc | null> {
  const cfg = await payloadConfig;
  const payload = await getPayload({ config: cfg });
  try {
    return (await payload.findByID({
      collection: "users",
      id: userId,
      overrideAccess: true,
    })) as unknown as UserDoc;
  } catch {
    return null;
  }
}

async function persistRefreshedToken(
  userId: number,
  data: { accessToken: string; expiry: string | null },
): Promise<void> {
  const cfg = await payloadConfig;
  const payload = await getPayload({ config: cfg });
  await payload.update({
    collection: "users",
    id: userId,
    overrideAccess: true,
    data: {
      gmailAccessToken: data.accessToken,
      gmailTokenExpiry: data.expiry,
    } as never,
  });
}

/** Token for one of the user's extra Gmail accounts (mail-accounts), refreshed on expiry. */
async function getExtraAccountToken(user: UserDoc, account: string): Promise<GmailTokenResult | GmailTokenError> {
  const payload = await getPayload({ config: await payloadConfig });
  const row = await findMailAccount(payload, user.id, account);
  if (!row) {
    return { ok: false, reason: `${account} is not connected to your Mail. Add it from the account menu in the Mail breadcrumb.` };
  }
  if (!row.refreshToken.trim()) return { ok: false, reason: `${account} has no Gmail refresh token saved. Add it again.` };
  let accessToken = row.accessToken;
  if (isExpired(row.tokenExpiry) || !accessToken) {
    try {
      const refreshed = await refreshGmailAccessToken(row.refreshToken.trim(), row.email);
      await updateMailAccount(payload, row.id, { accessToken: refreshed.accessToken, tokenExpiry: refreshed.expiry });
      accessToken = refreshed.accessToken;
    } catch (err) {
      return { ok: false, reason: `Gmail token refresh failed for ${account}: ${(err as Error).message}` };
    }
  }
  return { ok: true, accessToken, email: row.email, userEmail: user.email ?? "", account: row.email };
}

/**
 * Get a valid Gmail access token for the given CMS user. Refreshes on expiry
 * and writes the new token back to the user record.
 *
 * `account` picks one of the user's extra Gmail accounts (Mail's account
 * switcher). Omitted, empty, or the user's main Gmail address → the main
 * Gmail, so every existing caller keeps its behaviour.
 */
export async function getValidGmailToken(
  userId: number | undefined | null,
  account?: string | null,
): Promise<GmailTokenResult | GmailTokenError> {
  if (userId === undefined || userId === null) {
    return { ok: false, reason: "No user id provided." };
  }

  const user = await loadUser(userId);
  if (!user) return { ok: false, reason: `User ${userId} not found.` };
  const wanted = normaliseMailAccount(account ?? "");
  if (wanted && wanted !== (user.gmailEmail ?? "").trim().toLowerCase()) {
    return getExtraAccountToken(user, wanted);
  }
  if (!user.gmailConnected) {
    return {
      ok: false,
      reason:
        "Gmail not connected for this user. Connect via /api/gmail/connect from the admin UI before scheduling tasks.",
    };
  }

  const refreshToken = (user.gmailRefreshToken ?? "").trim();
  if (!refreshToken) {
    return {
      ok: false,
      reason: "User has no Gmail refresh token saved. Reconnect Gmail.",
    };
  }

  let accessToken = user.gmailAccessToken ?? "";
  if (isExpired(user.gmailTokenExpiry) || !accessToken) {
    try {
      const refreshed = await refreshGmailAccessToken(refreshToken, user.gmailEmail ?? "");
      await persistRefreshedToken(userId, refreshed);
      accessToken = refreshed.accessToken;
    } catch (err) {
      return {
        ok: false,
        reason: `Gmail token refresh failed: ${(err as Error).message}`,
      };
    }
  }

  return {
    ok: true,
    accessToken,
    email: user.gmailEmail ?? "",
    userEmail: user.email ?? "",
    account: "",
  };
}
