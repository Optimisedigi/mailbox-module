import { NextRequest, NextResponse } from "next/server";
import { listFolderThreads, type InboxThreadSummary } from "@/lib/mail/gmail-mail";
import {
  MAIL_LIST_MAX_GMAIL_CALLS,
  MAIL_LIST_PAGE_SIZE,
  inboxPageToken,
  newThreadsOnly,
  parseInboxPageToken,
  parseMailFolder,
} from "@/lib/mail/folders";
import { chosenClientsFor, extractEmailAddresses, matchMessageToClient } from "@/lib/mail/client-matching";
import { loadClientDomainIndex } from "@/lib/mail/store";
import { hiddenSendersQuery, isHiddenSender, loadHiddenSenders } from "@/lib/mail/hidden-senders";
import { mailSearchQuery, parseSearchScope, parseSearchSenders } from "@/lib/mail/inbox-search";
import { parseTagId } from "@/lib/mail/tags";

/** Your own sent messages never bring a thread into the inbox list. */
const INBOX_EXCLUDE_OWN_MAIL = "-in:sent";
import { loadClientSenders } from "@/lib/mail/client-senders";
import { loadSenderClients } from "@/lib/mail/sender-clients";
import { gmailErrorResponse, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * GET /api/mail/inbox?folder=inbox|sent|drafts&pageToken=&q=&scope=&senders=&tag=
 *
 * `tag` (inbox only) is a Mail tag's Gmail label id ("Label_…"): the list
 * shows that tag's emails instead of the inbox, archived ones included,
 * with the same unread-first paging, search and hidden-sender filter.
 *
 * Thread list for the Mail view, read live from Gmail (metadata only).
 * `folder` defaults to the inbox. Each row carries a deterministic client
 * match from headers (with the user's own sender → client choices). No model calls.
 *
 * The inbox always lists unread threads first: it pages through the unread
 * threads (`is:unread`), and once they run out the same response continues
 * with the read ones (`-is:unread`), so an old unread email is never stuck
 * below newer read mail on a later page. The page token says which part the
 * next page is in (see parseInboxPageToken).
 * A search's first page fetches both parts at once (see below), so it can
 * hold up to two pages of rows when the unread matches run out on it.
 *
 * Every page holds MAIL_LIST_PAGE_SIZE threads (unless the folder runs out):
 * Gmail pages by message and a search can return one thread several times,
 * so short pages are topped up with further Gmail pages (bounded).
 *
 * The user's hidden senders are excluded from the inbox via the Gmail search
 * itself, so paging and search keep working (view-only; nothing changes in
 * Gmail). Sent and Drafts are all from the user, so the filter is not applied
 * there. The starred client senders (dashboard panel filter) and the sender →
 * client choices are returned too.
 *
 * The search (`q`) looks where `scope` says: all (the default), person,
 * subject or body (see mailSearchQuery). It matches the person (the sender
 * in the Inbox, the recipients in Sent / Drafts) as well as the words, plus
 * the addresses in `senders` (people whose name or address starts with the
 * typed text, matched by the Mail page, since Gmail only matches whole words).
 * Hand-written Gmail searches are passed through as typed.
 *
 * The inbox lists mail from other people only: its Gmail search leaves out
 * your own sent messages (`-in:sent`, matched per message, so a thread you
 * replied to still lists through the incoming mail), and each row shows the
 * latest incoming message (see listFolderThreads). Your messages stay in Sent.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  const folderParam = req.nextUrl.searchParams.get("folder");
  const folder = folderParam === null ? "inbox" : parseMailFolder(folderParam);
  if (!folder) return NextResponse.json({ error: "Invalid folder." }, { status: 400 });
  const tagParam = req.nextUrl.searchParams.get("tag");
  const tag = tagParam === null ? undefined : parseTagId(tagParam);
  if (tag === null || (tag && folder !== "inbox")) return NextResponse.json({ error: "Invalid tag." }, { status: 400 });
  const pageToken = req.nextUrl.searchParams.get("pageToken") ?? undefined;
  const search = (req.nextUrl.searchParams.get("q") ?? "").slice(0, 200);
  const searchSenders = parseSearchSenders(req.nextUrl.searchParams.get("senders"));
  const searchScope = parseSearchScope(req.nextUrl.searchParams.get("scope"));
  const searchQuery = mailSearchQuery(search, { folder, scope: searchScope, senderAddresses: searchSenders });
  const [hiddenSenders, clientSenders, senderClients] = await Promise.all([
    loadHiddenSenders(ctx.payload, ctx.user.id),
    loadClientSenders(ctx.payload, ctx.user.id),
    loadSenderClients(ctx.payload, ctx.user.id),
  ]);
  const join = (...parts: string[]) => parts.filter(Boolean).join(" ") || undefined;

  try {
    const indexLoad = loadClientDomainIndex(ctx.payload, [token.email, token.userEmail].filter(Boolean), {
      userId: ctx.user.id,
      overrides: senderClients,
    });
    // Awaited below; this only stops a Gmail failure first leaving it unhandled.
    indexLoad.catch(() => undefined);
    const accessToken = token.accessToken;
    const threads: InboxThreadSummary[] = [];
    // Threads on this page so far; a thread can match both the unread and the read search.
    const seen = new Set<string>();
    type Filled = { rows: InboxThreadSummary[]; token: string | null; exhausted: boolean; calls: number };
    // Collects up to `want` new threads (not in `known`, which it records) from `q`, starting at
    // `startToken`, until the query runs out (`token` null) or `maxCalls` Gmail calls are spent.
    const fill = async (
      q: string | undefined,
      startToken: string | undefined,
      want: number,
      maxCalls: number,
      known: Set<string>,
    ): Promise<Filled> => {
      const rows: InboxThreadSummary[] = [];
      let cursor = startToken;
      let calls = 0;
      while (rows.length < want && calls < maxCalls) {
        calls++;
        const page = await listFolderThreads(accessToken, folder, {
          pageToken: cursor,
          q,
          maxResults: Math.min(50, want - rows.length),
          labelId: tag,
        });
        rows.push(...newThreadsOnly(page.threads, known));
        if (!page.nextPageToken) return { rows, token: null, exhausted: true, calls };
        cursor = page.nextPageToken;
      }
      return { rows, token: cursor ?? null, exhausted: false, calls };
    };
    let nextPageToken: string | null;
    if (folder === "inbox") {
      const base = join(searchQuery, hiddenSendersQuery(hiddenSenders), INBOX_EXCLUDE_OWN_MAIL) ?? "";
      const readQuery = join(base, "-is:unread");
      const page = parseInboxPageToken(pageToken);
      if (page.part === "unread") {
        // A search's first page asks Gmail for the unread and the read mail at the same time
        // instead of one after the other (about 0.5 s faster). The read mail is only shown
        // when the unread mail runs out on this page, so nothing is skipped, and that page
        // can then hold up to two pages' worth of rows. Without a search, unread mail
        // usually fills the page, so the read lookup would mostly be wasted.
        const together = search.trim() !== "" && !page.token;
        const readSeen = new Set<string>();
        const [unread, early] = await Promise.all([
          fill(join(base, "is:unread"), page.token, MAIL_LIST_PAGE_SIZE, MAIL_LIST_MAX_GMAIL_CALLS, seen),
          together ? fill(readQuery, undefined, MAIL_LIST_PAGE_SIZE, MAIL_LIST_MAX_GMAIL_CALLS, readSeen) : Promise.resolve(null),
        ]);
        threads.push(...unread.rows);
        if (!unread.exhausted) {
          nextPageToken = inboxPageToken("unread", unread.token);
        } else if (early) {
          threads.push(...newThreadsOnly(early.rows, seen));
          nextPageToken = early.exhausted ? null : inboxPageToken("read", early.token);
        } else if (threads.length < MAIL_LIST_PAGE_SIZE && unread.calls < MAIL_LIST_MAX_GMAIL_CALLS) {
          // Unread threads ran out: carry on with the read ones (from the start) in this same page.
          const read = await fill(
            readQuery,
            undefined,
            MAIL_LIST_PAGE_SIZE - threads.length,
            MAIL_LIST_MAX_GMAIL_CALLS - unread.calls,
            seen,
          );
          threads.push(...read.rows);
          nextPageToken = read.exhausted ? null : inboxPageToken("read", read.token);
        } else {
          nextPageToken = inboxPageToken("read", null);
        }
      } else {
        const read = await fill(readQuery, page.token, MAIL_LIST_PAGE_SIZE, MAIL_LIST_MAX_GMAIL_CALLS, seen);
        threads.push(...read.rows);
        nextPageToken = read.exhausted ? null : inboxPageToken("read", read.token);
      }
    } else {
      const result = await fill(join(searchQuery), pageToken, MAIL_LIST_PAGE_SIZE, MAIL_LIST_MAX_GMAIL_CALLS, seen);
      threads.push(...result.rows);
      nextPageToken = result.exhausted ? null : result.token;
    }
    const index = await indexLoad;
    return NextResponse.json({
      account: token.email,
      folder,
      hiddenSenders,
      clientSenders,
      senderClients,
      nextPageToken,
      // A thread with older mail from others still matches the search, so drop
      // rows whose shown (latest) message is from a hidden sender.
      threads: threads
        .filter((thread) => folder !== "inbox" || !isHiddenSender(thread.from, hiddenSenders))
        .map((thread) => {
          const match = matchMessageToClient(index, thread);
          if (match) return { ...thread, client: { id: match.clientId, name: match.clientName } };
          // An agency sender the user linked to several clients: the pill names them all.
          const several = chosenClientsFor(index, extractEmailAddresses(thread.from)[0] ?? "");
          const first = several[0];
          return { ...thread, client: first ? { id: first.id, name: several.map((c) => c.name).join(", ") } : null };
        }),
    });
  } catch (err) {
    return gmailErrorResponse(err, `Could not load ${folder === "inbox" ? "the inbox" : folder} from Gmail.`);
  }
}
