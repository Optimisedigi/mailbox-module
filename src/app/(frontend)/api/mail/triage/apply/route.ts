import { NextRequest, NextResponse } from "next/server";
import { batchModifyMessages } from "@/lib/mail/gmail-mail";
import { parseTagId } from "@/lib/mail/tags";
import { gmailErrorResponse, parseGmailId, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

/** Messages per request; the triage panel sends bigger selections in several requests. */
const MAX_TRIAGE_APPLY_IDS = 1000;

const CHANGES = {
  archive: { remove: ["INBOX"] },
  read: { remove: ["UNREAD"] },
  // Gmail's Bin: recoverable there for 30 days, then Gmail empties it.
  trash: { add: ["TRASH"], remove: ["INBOX"] },
} as const;

/**
 * POST /api/mail/triage/apply
 * Body: { messageIds: string[], action: "archive" | "read" | "trash" }
 *    or { messageIds: string[], action: "tag", tagId: "Label_…" }
 *
 * Applies the user's triage choice to the messages they ticked. Archive only
 * removes the INBOX label; trash moves the emails to Gmail's Bin (they can be
 * restored from there for 30 days; nothing is deleted for good here); tag adds
 * one of the user's own labels (never a system label). Needs the gmail.modify
 * scope.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ messageIds?: unknown; action?: unknown; tagId?: unknown }>(req);
  const action =
    body?.action === "archive" || body?.action === "read" || body?.action === "trash" || body?.action === "tag" ? body.action : null;
  const tagId = action === "tag" ? parseTagId(body?.tagId) : null;
  if (action === "tag" && !tagId) return NextResponse.json({ error: "tagId (one of your Mail tags) is required." }, { status: 400 });
  const raw = Array.isArray(body?.messageIds) ? body.messageIds : null;
  const messageIds = raw ? [...new Set(raw.map(parseGmailId))] : [];
  if (!action || !raw || raw.length === 0 || messageIds.some((id) => id === null)) {
    return NextResponse.json({ error: "messageIds (Gmail ids) and action (archive, read, trash or tag) are required." }, { status: 400 });
  }
  if (messageIds.length > MAX_TRIAGE_APPLY_IDS) {
    return NextResponse.json({ error: `At most ${MAX_TRIAGE_APPLY_IDS} emails per request.` }, { status: 400 });
  }
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  try {
    const change =
      action === "tag"
        ? { add: [tagId as string] }
        : action === "trash"
          ? { add: [...CHANGES.trash.add], remove: [...CHANGES.trash.remove] }
          : { remove: [...CHANGES[action].remove] };
    await batchModifyMessages(token.accessToken, messageIds.filter((id): id is string => id !== null), change);
    return NextResponse.json({ ok: true, count: messageIds.length });
  } catch (err) {
    return gmailErrorResponse(err, "Gmail could not update those emails.");
  }
}
