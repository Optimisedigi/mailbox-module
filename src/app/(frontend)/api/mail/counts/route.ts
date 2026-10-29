import { NextRequest, NextResponse } from "next/server";
import { getFolderCounts } from "@/lib/mail/gmail-mail";
import { gmailErrorResponse, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";
import { countScheduledEmails, scheduleDb } from "@/lib/mail/scheduled";
import { countDueFollowUps, followUpDb } from "@/lib/mail/follow-ups";

/**
 * GET /api/mail/counts
 * Badge numbers for the Mail tabs: unread Inbox threads, Drafts, and emails
 * waiting in the Scheduled queue, plus follow-up reminders that are due
 * (Awaiting reply). Sent is not counted. Two Gmail label lookups and two
 * count queries; no message content is read.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;
  try {
    const [folders, scheduled, followUpsDue] = await Promise.all([
      getFolderCounts(token.accessToken),
      countScheduledEmails(scheduleDb(ctx.payload), ctx.user.id, token.account),
      countDueFollowUps(followUpDb(ctx.payload), ctx.user.id, new Date(), token.account),
    ]);
    return NextResponse.json({ ...folders, scheduled, followUpsDue });
  } catch (err) {
    return gmailErrorResponse(err, "Could not load the mail counts.");
  }
}
