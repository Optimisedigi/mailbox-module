/**
 * Folders the Mail view can list. Client-safe: no Gmail API calls, no server
 * imports. Each folder maps to one Gmail system label (see gmail-mail.ts).
 */

export type MailFolder = "inbox" | "sent" | "drafts";

export const MAIL_FOLDERS: readonly MailFolder[] = ["inbox", "sent", "drafts"];

export function parseMailFolder(raw: unknown): MailFolder | null {
  return typeof raw === "string" && (MAIL_FOLDERS as readonly string[]).includes(raw) ? (raw as MailFolder) : null;
}

/**
 * Tabs in the Mail view: the Gmail folders plus the CMS-held Scheduled queue
 * and Awaiting reply (sent emails with a follow-up reminder).
 */
export type MailTab = MailFolder | "scheduled" | "awaiting";

export const MAIL_TABS: readonly MailTab[] = ["inbox", "sent", "drafts", "scheduled", "awaiting"];

const TAB_LABELS: Record<MailTab, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  scheduled: "Scheduled",
  awaiting: "Awaiting reply",
};

export interface MailTabCounts {
  /** Unread Inbox threads. */
  inboxUnread: number;
  /** Draft threads. */
  drafts: number;
  /** Emails waiting in the Scheduled queue. */
  scheduled?: number;
  /** Follow-up reminders whose time has come with no reply. */
  followUpsDue?: number;
}

/**
 * Tab text with its badge, e.g. "Inbox (3)". Inbox (unread), Drafts,
 * Scheduled (waiting to send) and Awaiting reply (reminders due) carry a
 * count, and a zero or unknown count shows no badge, like Gmail. Sent never does.
 */
export function mailTabLabel(tab: MailTab, counts: MailTabCounts | null): string {
  const count = mailTabCount(tab, counts);
  return count === null ? TAB_LABELS[tab] : `${TAB_LABELS[tab]} (${count})`;
}

/** The tab's name without its count, e.g. "Awaiting reply". */
export function mailTabName(tab: MailTab): string {
  return TAB_LABELS[tab];
}

/** The tab's badge number, or null when there is nothing to show. */
export function mailTabCount(tab: MailTab, counts: MailTabCounts | null): number | null {
  const byTab: Partial<Record<MailTab, number | undefined>> = {
    inbox: counts?.inboxUnread,
    drafts: counts?.drafts,
    scheduled: counts?.scheduled,
    awaiting: counts?.followUpsDue,
  };
  const count = byTab[tab];
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : null;
}

/**
 * Unread threads first, otherwise keeping Gmail's newest-first order (stable).
 * Applied when a list loads, not when a thread is opened, so a row that was
 * just read stays where it is until the next refresh.
 */
export function unreadFirst<T extends { unread: boolean }>(threads: readonly T[]): T[] {
  return [...threads.filter((thread) => thread.unread), ...threads.filter((thread) => !thread.unread)];
}

/**
 * The inbox lists every unread thread before any read one (each part newest
 * first), across pages: it pages through the unread threads first, then the
 * read ones. The page token says which part it is in: "u:<gmail token>" or
 * "r:<gmail token>". A bare token (older client) continues the read part.
 */
export type InboxPagePart = "unread" | "read";

export function parseInboxPageToken(raw: string | null | undefined): { part: InboxPagePart; token?: string } {
  const value = (raw ?? "").trim();
  if (!value) return { part: "unread" };
  if (value.startsWith("u:")) return value.length > 2 ? { part: "unread", token: value.slice(2) } : { part: "unread" };
  if (value.startsWith("r:")) return value.length > 2 ? { part: "read", token: value.slice(2) } : { part: "read" };
  return { part: "read", token: value };
}

/** Token for the next page: `part` from `token`, or from the start of that part when there is no token ("r:"). */
export function inboxPageToken(part: InboxPagePart, token: string | null | undefined): string {
  return `${part === "unread" ? "u" : "r"}:${token ?? ""}`;
}

/**
 * Email rows per page of the Mail list. Gmail pages count messages, and a
 * search returns several messages of one thread, so the list route keeps
 * asking Gmail (at most MAIL_LIST_MAX_GMAIL_CALLS times) until it has this
 * many threads or the folder runs out, so "Load more" doesn't come early.
 * Each row costs one Gmail threads.get, and Gmail rate-limits per user, so
 * keep this small: it sets how long the list takes to appear.
 */
export const MAIL_LIST_PAGE_SIZE = 20;
export const MAIL_LIST_MAX_GMAIL_CALLS = 4;

/** Rows of `next` whose thread is not already in `seen` (in order), recording them. */
export function newThreadsOnly<T extends { threadId: string }>(next: readonly T[], seen: Set<string>): T[] {
  const out: T[] = [];
  for (const row of next) {
    if (seen.has(row.threadId)) continue;
    seen.add(row.threadId);
    out.push(row);
  }
  return out;
}
