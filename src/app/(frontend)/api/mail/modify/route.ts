import { NextRequest, NextResponse } from "next/server";
import { mapLimited, modifyThreadLabels, trashThread } from "@/lib/mail/gmail-mail";
import { gmailErrorResponse, parseGmailId, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";
import { removeClientEmailAlertsForThreads } from "@/lib/mail/client-email-alerts";

/**
 * POST /api/mail/modify
 * Body: { threadId, action: "archive" | "read" | "unread" | "trash" | "untrash" }
 *    or { threadIds: [...up to 50], action: "read" | "unread" | "trash" | "untrash" }
 *       (inbox multi-select "Mark as read" / "Mark as unread" / "Delete", and its Undo)
 *
 * Archive only removes the INBOX label. Trash moves the thread to Gmail's Bin
 * (Gmail empties it after 30 days) and untrash brings it back (the Undo);
 * nothing is deleted outright. Bulk never archives. Requires the
 * gmail.modify scope.
 *
 * Marking threads read also removes their "Client email – please read"
 * notifications from the bell.
 */
const CHANGES = {
  archive: { remove: ["INBOX"] },
  read: { remove: ["UNREAD"] },
  unread: { add: ["UNREAD"] },
} as const;

/** Single-thread actions that move the thread to or from the Bin instead of changing labels. */
const BIN_ACTIONS = ["trash", "untrash"] as const;
type BinAction = (typeof BIN_ACTIONS)[number];
const isBinAction = (value: unknown): value is BinAction => (BIN_ACTIONS as readonly unknown[]).includes(value);

const MAX_BULK_THREADS = 50;
/** The only actions allowed on many threads at once. */
const BULK_ACTIONS: readonly string[] = ["read", "unread", "trash", "untrash"];

/** 1 to MAX_BULK_THREADS valid Gmail ids, without repeats; null otherwise. */
function cleanThreadIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK_THREADS) return null;
  const ids = value.map(parseGmailId);
  if (ids.some((id) => id === null)) return null;
  return [...new Set(ids as string[])];
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ threadId?: unknown; threadIds?: unknown; action?: unknown }>(req);
  const binAction = isBinAction(body?.action) ? body.action : null;
  const action = binAction ?? (typeof body?.action === "string" && body.action in CHANGES ? (body.action as keyof typeof CHANGES) : null);
  const bulk = body?.threadIds !== undefined;
  const threadIds = bulk ? cleanThreadIds(body?.threadIds) : null;
  const threadId = bulk ? null : parseGmailId(body?.threadId);
  if (bulk && (!threadIds || !action || !BULK_ACTIONS.includes(action))) {
    return NextResponse.json({ error: `Send 1 to ${MAX_BULK_THREADS} thread ids with action "read", "unread", "trash" or "untrash".` }, { status: 400 });
  }
  if (!bulk && (!threadId || !action)) {
    return NextResponse.json({ error: "threadId and action (archive, read, unread, trash, untrash) are required." }, { status: 400 });
  }
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  if (binAction) {
    try {
      // Gmail has no batch call for threads: a few at a time stays under its rate limit.
      await mapLimited(threadIds ?? [threadId as string], 5, (id) => trashThread(token.accessToken, id, binAction === "untrash"));
      return NextResponse.json({ ok: true });
    } catch (err) {
      const what = bulk ? "those emails" : "that thread";
      return gmailErrorResponse(err, binAction === "trash" ? `Gmail could not delete ${what}.` : `Gmail could not restore ${what}.`);
    }
  }

  try {
    const change = CHANGES[action as keyof typeof CHANGES];
    const labels = {
      add: "add" in change ? [...change.add] : [],
      remove: "remove" in change ? [...change.remove] : [],
    };
    const ids = threadIds ?? [threadId as string];
    // Gmail has no batch call for threads: a few at a time stays under its rate limit.
    await mapLimited(ids, 5, (id) => modifyThreadLabels(token.accessToken, id, labels));
    let alertsRemoved = 0;
    if (action === "read") {
      try {
        alertsRemoved = await removeClientEmailAlertsForThreads(ctx.payload, ctx.user.id, ids, token.account);
      } catch (err) {
        // Gmail already changed; a stale bell alert must not fail the request.
        console.error("[mail-modify] could not remove read client email alerts:", (err instanceof Error ? err.message : String(err)).slice(0, 200));
      }
    }
    return NextResponse.json({ ok: true, alertsRemoved });
  } catch (err) {
    return gmailErrorResponse(err, bulk ? `Gmail could not mark those emails ${action}.` : "Gmail could not update that thread.");
  }
}
