import { NextRequest, NextResponse } from "next/server";
import { getValidGmailToken } from "@/lib/user-gmail-tokens";
import { CLIENT_EMAIL_ALERT_KIND, removeAlertsForReadEmails } from "@/lib/mail/client-email-alerts";
import { getThreadReplyHeaders } from "@/lib/mail/gmail-mail";
import { syncMailbox } from "@/lib/mail/store";
import { requireMailUser } from "@/lib/mail/route-helpers";

/**
 * GET /api/mail/client-alerts[?sync=1]
 *
 * Powers the "Client email – please read" panel. Returns the signed-in
 * user's undismissed client-email alerts (their own mailbox only), newest
 * first.
 *
 * With `sync=1` it first runs the normal incremental Mail sync for the
 * user's own mailbox, at most once per SYNC_MIN_INTERVAL_MS (shared across
 * tabs via mail-sync-states.lastSyncAt). The same pass removes alerts whose
 * email has since been read in Gmail itself. Sync problems never fail the
 * request: the panel still gets whatever alerts already exist.
 * Plain code only: no model calls.
 */
export const maxDuration = 60;

/**
 * Gmail is synced from here at most every 5 minutes per mailbox (any tab). The
 * panel still polls every minute, which is a cheap database read; the Mail page
 * runs its own sync when open, so new mail shows there straight away.
 */
export const SYNC_MIN_INTERVAL_MS = 5 * 60_000;
const MAX_ALERTS_RETURNED = 10;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const { payload, user } = ctx;

  let synced = false;
  if (req.nextUrl.searchParams.get("sync") === "1") {
    try {
      const stateRes = await payload.find({
        collection: "mail-sync-states",
        where: { user: { equals: user.id } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        select: { lastSyncAt: true },
      } as never);
      const last = (stateRes as unknown as { docs: Array<{ lastSyncAt?: string | null }> }).docs[0]?.lastSyncAt;
      const due = !last || Date.now() - new Date(last).getTime() >= SYNC_MIN_INTERVAL_MS;
      if (due) {
        const token = await getValidGmailToken(user.id);
        if (token.ok) {
          await syncMailbox({ payload, userId: user.id, accessToken: token.accessToken, userEmail: token.userEmail });
          synced = true;
          await removeAlertsForReadEmails(payload, user.id, token.accessToken, { getThreadHeaders: getThreadReplyHeaders });
        }
      }
    } catch (err) {
      // Never log email content; the panel keeps working off stored alerts.
      console.error("[mail-alerts] sync failed:", (err instanceof Error ? err.message : String(err)).slice(0, 200));
    }
  }

  const res = await payload.find({
    collection: "notifications" as never,
    where: {
      and: [
        { recipient: { equals: user.id } },
        { kind: { equals: CLIENT_EMAIL_ALERT_KIND } },
        { readAt: { exists: false } },
      ],
    } as never,
    sort: "-createdAt",
    limit: MAX_ALERTS_RETURNED,
    depth: 0,
    overrideAccess: true,
    select: { id: true, title: true, body: true, url: true, createdAt: true } as never,
  });

  return NextResponse.json({
    synced,
    total: res.totalDocs ?? res.docs.length,
    alerts: (res.docs as unknown as Array<Record<string, unknown>>).map((doc) => ({
      id: doc.id,
      title: doc.title,
      body: doc.body ?? "",
      url: doc.url ?? "/admin/mail",
      createdAt: doc.createdAt,
    })),
  });
}
