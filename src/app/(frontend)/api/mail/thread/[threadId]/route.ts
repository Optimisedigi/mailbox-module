import { NextRequest, NextResponse } from "next/server";
import { getThreadMessagesWithCalendar } from "@/lib/mail/gmail-mail";
import { pickThreadInvite } from "@/lib/mail/calendar-invite";
import { matchMessageToClient } from "@/lib/mail/client-matching";
import { loadClientDomainIndex } from "@/lib/mail/store";
import { buildEmailDocument } from "@/lib/mail/email-html";
import { gmailErrorResponse, parseGmailId, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * GET /api/mail/thread/[threadId]
 *
 * Full thread for the reading pane, plus for each message the stored
 * client-email row (if any) and the deterministic client match, and the
 * calendar invite in the thread (if any). Display only;
 * nothing here goes to a model.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const threadId = parseGmailId((await params).threadId);
  if (!threadId) return NextResponse.json({ error: "Invalid thread id." }, { status: 400 });
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  try {
    const [messages, index] = await Promise.all([
      getThreadMessagesWithCalendar(token.accessToken, threadId),
      loadClientDomainIndex(ctx.payload, [token.email, token.userEmail].filter(Boolean), { userId: ctx.user.id }),
    ]);
    const stored = await ctx.payload.find({
      collection: "client-emails",
      where: { gmailMessageId: { in: messages.map((message) => message.messageId) } },
      depth: 1,
      limit: messages.length || 1,
      overrideAccess: false,
      user: ctx.user,
      select: { gmailMessageId: true, client: true },
    } as never);
    const byMessage = new Map<string, { id: number; client: { id: number; name?: string } | number }>();
    for (const doc of (stored as unknown as { docs: Array<{ id: number; gmailMessageId: string; client: { id: number; name?: string } | number }> }).docs) {
      byMessage.set(doc.gmailMessageId, doc);
    }

    return NextResponse.json({
      threadId,
      // Calendar invite card for the top of the reading pane, or null.
      invite: pickThreadInvite(messages, [token.email, token.userEmail]),
      messages: messages.map((message) => {
        const saved = byMessage.get(message.messageId);
        const match = matchMessageToClient(index, message);
        const savedClient = saved && typeof saved.client === "object" ? saved.client : null;
        return {
          messageId: message.messageId,
          threadId: message.threadId,
          from: message.from,
          to: message.to,
          cc: message.cc,
          subject: message.subject,
          date: message.date,
          body: message.body,
          // Sanitised standalone document for the sandboxed reading-pane iframe.
          html: message.bodyHtml ? buildEmailDocument(message.bodyHtml, { inlineImages: message.inlineImages }) : "",
          // Files to download (names and sizes only; the bytes come from /api/mail/message/[id]/attachment).
          attachments: message.attachments,
          unread: message.labelIds.includes("UNREAD"),
          stored: saved
            ? { id: saved.id, clientId: savedClient?.id ?? saved.client, clientName: savedClient?.name ?? "" }
            : null,
          match: match ? { id: match.clientId, name: match.clientName, matchedOn: match.matchedOn } : null,
        };
      }),
    });
  } catch (err) {
    return gmailErrorResponse(err, "Could not load that thread from Gmail.");
  }
}
