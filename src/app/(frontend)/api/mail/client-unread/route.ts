import { NextRequest, NextResponse } from "next/server";
import { listInboxThreads, mapLimited } from "@/lib/mail/gmail-mail";
import {
  clientUnreadQueries,
  clientUnreadTerms,
  loadClientSenders,
  unreadClientThreads,
} from "@/lib/mail/client-senders";
import { loadHiddenSenders } from "@/lib/mail/hidden-senders";
import { gmailErrorResponse, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";
import { loadClientDomainIndex } from "@/lib/mail/store";

/**
 * GET /api/mail/client-unread
 *
 * Powers the dashboard's "Unread client emails" panel. Reads the signed-in
 * user's own Gmail inbox live (metadata only) and returns unread threads whose
 * sender is a client: either a sender they starred in Mail, or an address that
 * automatic client matching resolves to a client (the client's Website URL
 * domain or contact domains/addresses). Non-client and read mail is never
 * returned. With no client senders at all, Gmail is not queried.
 * No model calls, nothing stored, nothing changed in Gmail.
 */

const GMAIL_PAGE_SIZE = 10;
const GMAIL_PARALLEL_SEARCHES = 2;
const MAX_EMAILS_RETURNED = 8;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  const [clientSenders, hiddenSenders, index] = await Promise.all([
    loadClientSenders(ctx.payload, ctx.user.id),
    loadHiddenSenders(ctx.payload, ctx.user.id),
    loadClientDomainIndex(ctx.payload, [token.email, token.userEmail].filter(Boolean), { userId: ctx.user.id }),
  ]);
  const terms = clientUnreadTerms(index, clientSenders);
  const queries = clientUnreadQueries(terms);
  if (queries.length === 0) {
    return NextResponse.json({ account: token.email, clientSenderCount: 0, emails: [], more: false });
  }

  try {
    const pages = await mapLimited(queries, GMAIL_PARALLEL_SEARCHES, (q) =>
      listInboxThreads(token.accessToken, { q, maxResults: GMAIL_PAGE_SIZE }),
    );
    const byId = new Map<string, (typeof pages)[number]["threads"][number]>();
    for (const page of pages) {
      for (const thread of page.threads) byId.set(thread.threadId, thread);
    }
    // Newest first across all searches; thread id breaks ties deterministically.
    const threads = [...byId.values()].sort(
      (a, b) => b.date.localeCompare(a.date) || a.threadId.localeCompare(b.threadId),
    );
    const matches = unreadClientThreads(threads, clientSenders, { index, hidden: hiddenSenders });
    return NextResponse.json({
      account: token.email,
      clientSenderCount: terms.length,
      more: matches.length > MAX_EMAILS_RETURNED || pages.some((page) => Boolean(page.nextPageToken)),
      emails: matches.slice(0, MAX_EMAILS_RETURNED).map((thread) => ({
        threadId: thread.threadId,
        from: thread.from,
        subject: thread.subject,
        date: thread.date,
        messageCount: thread.messageCount,
      })),
    });
  } catch (err) {
    return gmailErrorResponse(err, "Could not load unread client emails from Gmail.");
  }
}
