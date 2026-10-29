import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { getValidGmailToken } from "@/lib/user-gmail-tokens";
import { userHasFeature } from "@/lib/access";
import { extraAccountSyncStateStore, syncMailbox } from "@/lib/mail/store";
import { findMailAccount, listAllMailAccounts } from "@/lib/mail/accounts";
import { deleteClientEmails, findExpiredEmailIds } from "@/lib/mail/cleanup";
import { MAIL_FEATURE } from "@/lib/mail/route-helpers";

/**
 * GET /api/mail/sync/cron (Vercel cron, daily). Auth: `Authorization: Bearer <CRON_SECRET>`.
 *
 * 1. Syncs every mailbox that has opened Mail at least once (has a
 *    mail-sync-states row) and still has the Mail feature, so client emails
 *    are stored even when nobody opens Mail. Same plain-code sync as the
 *    Mail view: no model calls.
 * 2. Deletes stored client emails older than 12 months, except ones assigned
 *    by hand or with a timeline summary. Gmail is never touched.
 *
 * Idempotent; safe to run more than once a day.
 */
export const maxDuration = 300;

function authorised(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
  const expected = Buffer.from(cronSecret);
  const provided = Buffer.from(token);
  if (!token || expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function relationId(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "number") {
    return (value as { id: number }).id;
  }
  return null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = authorised(req);
  if (denied) return denied;

  const payload = await getPayload({ config: await config });
  const states = await payload.find({
    collection: "mail-sync-states",
    limit: 0,
    pagination: false,
    depth: 0,
    overrideAccess: true,
    select: { user: true },
  } as never);
  const userIds = [
    ...new Set(
      (states as unknown as { docs: Array<{ user?: unknown }> }).docs
        .map((doc) => relationId(doc.user))
        .filter((id): id is number => id !== null),
    ),
  ].sort((a, b) => a - b);

  const mailboxes: Array<{ userId: number; status: string; stored?: number; skipped?: number; more?: boolean }> = [];
  for (const userId of userIds) {
    try {
      const user = await payload.findByID({ collection: "users", id: userId, depth: 0, overrideAccess: true });
      if (!userHasFeature(user, MAIL_FEATURE)) {
        mailboxes.push({ userId, status: "no-mail-access" });
        continue;
      }
      const token = await getValidGmailToken(userId);
      if (!token.ok) {
        mailboxes.push({ userId, status: "gmail-not-connected" });
        continue;
      }
      const result = await syncMailbox({ payload, userId, accessToken: token.accessToken, userEmail: token.userEmail });
      mailboxes.push({ userId, status: "synced", stored: result.stored, skipped: result.skipped, more: result.more });
    } catch (err) {
      // One mailbox failing must not stop the others. Never log email content.
      console.error(`[mail-cron] sync failed for user ${userId}:`, (err instanceof Error ? err.message : String(err)).slice(0, 200));
      mailboxes.push({ userId, status: "failed" });
    }
  }

  // Extra Gmail accounts (mail-accounts) sync the same way, each on its own cursor.
  const extraAccounts: Array<{ userId: number; email: string; status: string; stored?: number; more?: boolean }> = [];
  for (const { ownerId, email } of await listAllMailAccounts(payload).catch(() => [])) {
    try {
      const user = await payload.findByID({ collection: "users", id: ownerId, depth: 0, overrideAccess: true });
      if (!userHasFeature(user, MAIL_FEATURE)) {
        extraAccounts.push({ userId: ownerId, email, status: "no-mail-access" });
        continue;
      }
      const row = await findMailAccount(payload, ownerId, email);
      const token = row ? await getValidGmailToken(ownerId, email) : null;
      if (!row || !token?.ok) {
        extraAccounts.push({ userId: ownerId, email, status: "gmail-not-connected" });
        continue;
      }
      const result = await syncMailbox({
        payload,
        userId: ownerId,
        accessToken: token.accessToken,
        userEmail: token.userEmail,
        stateStore: extraAccountSyncStateStore(payload, row),
        account: row.email,
      });
      extraAccounts.push({ userId: ownerId, email, status: "synced", stored: result.stored, more: result.more });
    } catch (err) {
      console.error(`[mail-cron] sync failed for an extra account of user ${ownerId}:`, (err instanceof Error ? err.message : String(err)).slice(0, 200));
      extraAccounts.push({ userId: ownerId, email, status: "failed" });
    }
  }

  let expiredDeleted = 0;
  let expiredMore = false;
  try {
    const expired = await findExpiredEmailIds(payload, new Date());
    expiredDeleted = await deleteClientEmails(payload, expired.ids);
    expiredMore = expired.more;
  } catch (err) {
    console.error("[mail-cron] retention cleanup failed:", (err instanceof Error ? err.message : String(err)).slice(0, 200));
  }

  console.info(`[mail-cron] synced ${mailboxes.filter((m) => m.status === "synced").length}/${userIds.length} mailboxes; deleted ${expiredDeleted} expired emails`);
  return NextResponse.json({ mailboxes, extraAccounts, expiredDeleted, expiredMore });
}
