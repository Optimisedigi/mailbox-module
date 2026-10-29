import { google, type gmail_v1 } from "googleapis";
import { parseGmailFullMessage, readGmailHeader, type GmailFullMessage } from "@/lib/gmail-search";
import type { MailFolder } from "@/lib/mail/folders";
import { findTagByName, parseTagId, type MailTag } from "@/lib/mail/tags";
import {
  attachmentForPart,
  findAttachmentPart,
  listInlineImageParts,
  listMessageAttachments,
  type MessageAttachment,
} from "@/lib/mail/message-attachments";

/**
 * Gmail API calls for the CMS Mail view. Pure transport: no matching, no
 * storage, no model calls. Never logs message content or tokens.
 */

export interface InboxThreadSummary {
  threadId: string;
  /** The message shown in the list (see listFolderThreads). */
  messageId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  messageCount: number;
}

export class GmailHistoryExpiredError extends Error {}

/**
 * Per-request limit for Gmail calls. googleapis has no timeout by default, so
 * a stuck request held the function open until Vercel's maxDuration. Generous
 * enough for sending or downloading a message with large attachments.
 */
export const GMAIL_REQUEST_TIMEOUT_MS = 30_000;

function gmailApi(accessToken: string): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth, timeout: GMAIL_REQUEST_TIMEOUT_MS });
}

function isoDate(value: string, internalDate?: string | null): string {
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  const internal = Number(internalDate);
  return Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : "";
}

/** Run `fn` over items with a small concurrency cap (Gmail per-user rate limits). */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const SKIP_LABELS = new Set(["DRAFT", "SPAM", "TRASH", "CHAT"]);

export function isSyncableLabelSet(labelIds: string[] | null | undefined): boolean {
  return !(labelIds ?? []).some((label) => SKIP_LABELS.has(label));
}

/** Gmail system label behind each Mail folder. */
const FOLDER_LABELS: Record<MailFolder, string> = { inbox: "INBOX", sent: "SENT", drafts: "DRAFT" };

/**
 * The account's own messages: what it sent (exactly what the Sent view lists,
 * send-as aliases included) and unsent drafts. Judged by Gmail's labels, not
 * the From address, so mail that only claims your address (a website form,
 * say) still arrives in the Inbox.
 */
function isOwnMessage(message: gmail_v1.Schema$Message): boolean {
  return (message.labelIds ?? []).some((label) => label === "SENT" || label === "DRAFT");
}

/**
 * Threads in one folder, newest first (Gmail order). Each row describes the
 * message shown in the list: for the inbox that is the latest message from
 * someone else, so your reply never shows as an incoming row, and a thread
 * holding only your own messages is left out (it is in Sent); for Sent and
 * Drafts it is the latest message carrying that label, so a sent thread shows
 * what you sent (not an incoming reply) and a drafts row's `messageId` is the
 * draft message itself (what `/api/gmail/draft` opens). `messageCount` and
 * `unread` always cover the whole thread, and opening a row loads every
 * message, your replies included. `labelId` (a Mail tag) lists that label's
 * threads instead, archived ones included.
 */
export async function listFolderThreads(
  accessToken: string,
  folder: MailFolder,
  options: { pageToken?: string; q?: string; maxResults?: number; labelId?: string } = {},
): Promise<{ threads: InboxThreadSummary[]; nextPageToken: string | null }> {
  const gmail = gmailApi(accessToken);
  // A tag (user label) lists that label instead of the folder's, rows chosen as for the folder.
  const label = options.labelId ?? FOLDER_LABELS[folder];
  const maxResults = Math.min(Math.max(options.maxResults ?? 25, 1), 50);
  const page = options.pageToken ? { pageToken: options.pageToken } : {};
  let ids: string[];
  let nextPageToken: string | null;
  // Sent is listed by message too: threads.list orders a thread by its latest
  // message of any kind, so an incoming reply pushed an older sent email above
  // newer ones. messages.list on SENT orders threads by your latest sent message,
  // which is the message (and date) each Sent row shows.
  if (options.q || (folder === "sent" && !options.labelId)) {
    // threads.list with any `q` (even "in:inbox") returns threads out of date
    // order and silently drops some recent ones; messages.list with the same
    // query is newest first. Rows are its threads in first-seen order. A thread
    // can reappear on a later page, so callers dedupe when appending.
    const list = await gmail.users.messages.list({ userId: "me", labelIds: [label], maxResults, ...(options.q ? { q: options.q } : {}), ...page });
    ids = [...new Set((list.data.messages ?? []).map((message) => message.threadId).filter((id): id is string => Boolean(id)))];
    nextPageToken = list.data.nextPageToken ?? null;
  } else {
    const list = await gmail.users.threads.list({ userId: "me", labelIds: [label], maxResults, ...page });
    ids = (list.data.threads ?? []).map((thread) => thread.id).filter((id): id is string => Boolean(id));
    nextPageToken = list.data.nextPageToken ?? null;
  }
  // A page (20 threads) is read in one round: about 0.4 s, against about 1.2 s at 8 at a time.
  const rows = await mapLimited(ids, THREAD_READ_CONCURRENCY, async (id): Promise<InboxThreadSummary | null> => {
    const res = await gmail.users.threads.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
    });
    const messages = res.data.messages ?? [];
    const latest = messages[messages.length - 1];
    const shown =
      folder === "inbox"
        ? [...messages].reverse().find((message) => !isOwnMessage(message))
        : ([...messages].reverse().find((message) => (message.labelIds ?? []).includes(label)) ?? latest);
    // Nothing from anyone else: the thread is only your own mail, so not an Inbox row.
    if (folder === "inbox" && !shown) return null;
    const first = messages[0];
    const headers = shown?.payload?.headers;
    return {
      threadId: id,
      messageId: shown?.id ?? "",
      from: readGmailHeader(headers, "From"),
      to: readGmailHeader(headers, "To"),
      cc: readGmailHeader(headers, "Cc"),
      subject: readGmailHeader(first?.payload?.headers, "Subject") || readGmailHeader(headers, "Subject"),
      snippet: shown?.snippet ?? "",
      date: isoDate(readGmailHeader(headers, "Date"), shown?.internalDate),
      unread: messages.some((message) => (message.labelIds ?? []).includes("UNREAD")),
      messageCount: messages.length,
    } satisfies InboxThreadSummary;
  });
  const threads = rows.filter((row): row is InboxThreadSummary => row !== null);
  return { threads, nextPageToken };
}

/** Thread reads in parallel for a list page; within Gmail's per-user rate limit for one page. */
const THREAD_READ_CONCURRENCY = 20;

export interface MailFolderCounts {
  /** Inbox threads with unread mail (Gmail's own count, includes hidden senders). */
  inboxUnread: number;
  /** Draft threads, the same unit as the Drafts list rows. */
  drafts: number;
}

/** Two label lookups, no message reads. Sent is deliberately not counted. */
export async function getFolderCounts(accessToken: string): Promise<MailFolderCounts> {
  const gmail = gmailApi(accessToken);
  const [inbox, drafts] = await Promise.all([
    gmail.users.labels.get({ userId: "me", id: FOLDER_LABELS.inbox }),
    gmail.users.labels.get({ userId: "me", id: FOLDER_LABELS.drafts }),
  ]);
  return { inboxUnread: inbox.data.threadsUnread ?? 0, drafts: drafts.data.threadsTotal ?? 0 };
}

export async function listInboxThreads(
  accessToken: string,
  options: { pageToken?: string; q?: string; maxResults?: number } = {},
): Promise<{ threads: InboxThreadSummary[]; nextPageToken: string | null }> {
  return listFolderThreads(accessToken, "inbox", options);
}

export async function getThreadMessages(accessToken: string, threadId: string): Promise<GmailFullMessage[]> {
  const gmail = gmailApi(accessToken);
  const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  return (res.data.messages ?? []).map(parseGmailFullMessage);
}

const CALENDAR_MAX_BYTES = 256 * 1024;

/** The message's calendar part (inline text/calendar preferred, else an .ics file), if any. */
function findCalendarPart(message: gmail_v1.Schema$Message): gmail_v1.Schema$MessagePart | undefined {
  const parts: gmail_v1.Schema$MessagePart[] = [];
  const walk = (part: gmail_v1.Schema$MessagePart) => {
    parts.push(part);
    part.parts?.forEach(walk);
  };
  if (message.payload) walk(message.payload);
  const isIcs = (part: gmail_v1.Schema$MessagePart) =>
    part.mimeType === "application/ics" || /\.ics$/i.test(part.filename ?? "");
  // Prefer the inline text/calendar part; it carries the METHOD.
  return parts.find((p) => p.mimeType === "text/calendar") ?? parts.find(isIcs);
}

/** The iCalendar text of a message (text/calendar part or .ics file), or "". */
async function readCalendarText(gmail: gmail_v1.Gmail, message: gmail_v1.Schema$Message): Promise<string> {
  const part = findCalendarPart(message);
  if (!part?.body || (part.body.size ?? 0) > CALENDAR_MAX_BYTES) return "";
  let data = part.body.data ?? "";
  if (!data && part.body.attachmentId && message.id) {
    const attachment = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: message.id,
      id: part.body.attachmentId,
    });
    data = attachment.data.data ?? "";
  }
  return data ? Buffer.from(data, "base64url").toString("utf-8") : "";
}

/**
 * Raw bytes of inline (cid:) images embedded into one thread response. Base64
 * adds a third, so this keeps the JSON under Vercel's 4.5 MB response limit.
 * Images past the budget are listed as attachments instead.
 */
const INLINE_IMAGE_BUDGET_BYTES = 2_500_000;

/**
 * Thread messages plus each one's iCalendar text ("" when it has none),
 * attachments and inline images (cid -> data: URL). For the reading pane.
 */
export async function getThreadMessagesWithCalendar(
  accessToken: string,
  threadId: string,
): Promise<Array<GmailFullMessage & { calendarIcs: string; attachments: MessageAttachment[]; inlineImages: Record<string, string> }>> {
  const gmail = gmailApi(accessToken);
  const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  const messages = res.data.messages ?? [];
  const parsed = messages.map((message) => parseGmailFullMessage(message));

  // Budget newest message first: that's the one the reading pane opens on.
  const inlineByIndex = messages.map(() => ({ images: {} as Record<string, string>, skipped: [] as MessageAttachment[] }));
  let budget = INLINE_IMAGE_BUDGET_BYTES;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const entry = inlineByIndex[i];
    const html = parsed[i]?.bodyHtml ?? "";
    if (!message || !entry || !html) continue;
    for (const image of listInlineImageParts(message.payload ?? undefined, html)) {
      const size = image.part.body?.size ?? 0;
      if (size > budget) {
        entry.skipped.push(attachmentForPart(image.part));
        continue;
      }
      const data = await readPartData(gmail, message.id ?? "", image.part).catch(() => "");
      if (!data) {
        entry.skipped.push(attachmentForPart(image.part));
        continue;
      }
      const bytes = Buffer.from(data, "base64url");
      budget -= bytes.length;
      entry.images[image.contentId] = `data:${image.mimeType};base64,${bytes.toString("base64")}`;
    }
  }

  return Promise.all(
    messages.map(async (message, i) => {
      const message_ = parsed[i] ?? parseGmailFullMessage(message);
      const inline = inlineByIndex[i] ?? { images: {}, skipped: [] };
      return {
        ...message_,
        calendarIcs: await readCalendarText(gmail, message).catch(() => ""),
        attachments: [...listMessageAttachments(message.payload ?? undefined, message_.bodyHtml), ...inline.skipped],
        inlineImages: inline.images,
      };
    }),
  );
}

/** A part's base64url data, fetched from Gmail when it is stored as an attachment. */
async function readPartData(gmail: gmail_v1.Gmail, messageId: string, part: gmail_v1.Schema$MessagePart): Promise<string> {
  if (part.body?.data) return part.body.data;
  if (!part.body?.attachmentId || !messageId) return "";
  const attachment = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: part.body.attachmentId });
  return attachment.data.data ?? "";
}

/**
 * One attachment of a message, found by its MIME part id (Gmail's attachment
 * ids change on every read). Null when the message has no such file part;
 * "too-large" when it is over maxBytes (checked before downloading it).
 */
export async function getMessageAttachment(
  accessToken: string,
  messageId: string,
  partId: string,
  maxBytes: number,
): Promise<{ filename: string; mimeType: string; bytes: Buffer } | "too-large" | null> {
  const gmail = gmailApi(accessToken);
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const part = findAttachmentPart(res.data.payload ?? undefined, partId);
  if (!part?.body) return null;
  if ((part.body.size ?? 0) > maxBytes) return "too-large";
  let data = part.body.data ?? "";
  if (!data && part.body.attachmentId) {
    const attachment = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: part.body.attachmentId });
    data = attachment.data.data ?? "";
  }
  const bytes = Buffer.from(data, "base64url");
  if (bytes.length > maxBytes) return "too-large";
  return { filename: (part.filename ?? "").trim() || "attachment", mimeType: part.mimeType || "application/octet-stream", bytes };
}

/** One message plus its iCalendar text ("" when it has none). */
export async function getMessageWithCalendar(
  accessToken: string,
  messageId: string,
): Promise<GmailFullMessage & { calendarIcs: string }> {
  const gmail = gmailApi(accessToken);
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return { ...parseGmailFullMessage(res.data), calendarIcs: await readCalendarText(gmail, res.data) };
}

/** Send a prebuilt base64url MIME message (calendar RSVPs). Needs gmail.compose. */
export async function sendRawMessage(accessToken: string, raw: string, threadId?: string): Promise<string> {
  const gmail = gmailApi(accessToken);
  const res = await gmail.users.messages.send({ userId: "me", requestBody: threadId ? { raw, threadId } : { raw } });
  return res.data.id ?? "";
}

/**
 * The message exactly as Gmail stores it (RFC 822), for an .eml download.
 * Returns null when it is bigger than maxBytes (checked before downloading it).
 */
export async function getRawMessage(accessToken: string, messageId: string, maxBytes: number): Promise<Buffer | null> {
  const gmail = gmailApi(accessToken);
  const size = await gmail.users.messages.get({ userId: "me", id: messageId, format: "minimal" });
  if ((size.data.sizeEstimate ?? 0) > maxBytes) return null;
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "raw" });
  const raw = Buffer.from(res.data.raw ?? "", "base64url");
  return raw.length > maxBytes ? null : raw;
}

export async function getFullMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailFullMessage & { hasCalendarInvite?: boolean }> {
  const gmail = gmailApi(accessToken);
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  return { ...parseGmailFullMessage(res.data), hasCalendarInvite: Boolean(findCalendarPart(res.data)) };
}

export interface MessageHeadersOnly {
  messageId: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  labelIds: string[];
  /** Bulk/auto headers used to skip automated mail (see automated-senders.ts). */
  autoSubmitted?: string;
  precedence?: string;
  listId?: string;
  listUnsubscribe?: string;
}

/**
 * Headers for each message id. Messages Gmail no longer has (404: deleted
 * forever after they were listed or recorded in history) are left out, so one
 * vanished email cannot fail the whole sync and pin the history cursor.
 *
 * `concurrency` defaults to 8, gentle enough for the long background sync; a
 * short burst (the search box's people list) can use more.
 */
export async function getMessageHeaders(accessToken: string, ids: string[], concurrency = 8): Promise<MessageHeadersOnly[]> {
  const gmail = gmailApi(accessToken);
  const results = await mapLimited(ids, concurrency, async (id): Promise<MessageHeadersOnly | null> => {
    const res = await gmail.users.messages
      .get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Cc", "Auto-Submitted", "Precedence", "List-Id", "List-Unsubscribe"],
      })
      .catch((err: unknown) => {
        const status = Number((err as { code?: number; status?: number }).code ?? (err as { status?: number }).status ?? 0);
        if (status === 404) return null;
        throw err;
      });
    if (!res) return null;
    const headers = res.data.payload?.headers;
    return {
      messageId: res.data.id ?? id,
      threadId: res.data.threadId ?? "",
      from: readGmailHeader(headers, "From"),
      to: readGmailHeader(headers, "To"),
      cc: readGmailHeader(headers, "Cc"),
      labelIds: res.data.labelIds ?? [],
      autoSubmitted: readGmailHeader(headers, "Auto-Submitted"),
      precedence: readGmailHeader(headers, "Precedence"),
      listId: readGmailHeader(headers, "List-Id"),
      listUnsubscribe: readGmailHeader(headers, "List-Unsubscribe"),
    };
  });
  return results.filter((header): header is MessageHeadersOnly => header !== null);
}

export interface MessageSenderSubject {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  /** Bulk-mail headers: a cheap newsletter/marketing hint, never the body. */
  listId?: string;
  listUnsubscribe?: string;
  /** "List-Unsubscribe=One-Click" when the sender offers one-click unsubscribe (RFC 8058). */
  listUnsubscribePost?: string;
  precedence?: string;
}

/**
 * Gmail's "slow down" answers: 429, or 403 with a rate/quota reason (Gmail uses
 * 403 for "Quota exceeded for quota metric ... per minute per user"). These
 * are not permission problems, so they must not ask the user to reconnect.
 */
export function isGmailRateLimitError(err: unknown): boolean {
  const e = err as { code?: number; status?: number; message?: string; errors?: Array<{ reason?: string }> } | null;
  const status = Number(e?.code ?? e?.status ?? 0);
  if (status === 429) return true;
  if (status !== 403) return false;
  const reasons = (e?.errors ?? []).map((item) => item.reason ?? "");
  return (
    reasons.some((reason) => /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reason)) ||
    /quota exceeded|rate limit/i.test(e?.message ?? "")
  );
}

/**
 * Gmail allows 6,000 quota units per user per minute and a metadata read costs
 * 20 (Gmail API usage limits), so at most 300 reads a minute. Triage reads at
 * 250 a minute, leaving room for the Mail view loading at the same time.
 */
export const TRIAGE_READS_PER_MINUTE = 250;

export interface PacedReadOptions {
  concurrency?: number;
  /** Most reads started per minute. */
  perMinute?: number;
  /** Retries of one read when Gmail says to slow down (waits 1, 2, 4, 8, 16 s, plus up to 1 s). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sender and subject (plus bulk-mail headers) for each message id, for inbox
 * triage. Metadata only: no bodies or snippets are fetched. Messages Gmail no
 * longer has (404) are left out. Reads are spaced to stay under Gmail's
 * per-user rate limit, and a read Gmail turns away for going too fast is
 * retried after a growing wait.
 */
export async function getMessageSenderSubjects(
  accessToken: string,
  ids: string[],
  options: PacedReadOptions = {},
): Promise<MessageSenderSubject[]> {
  const { concurrency = 10, perMinute = TRIAGE_READS_PER_MINUTE, retries = 5 } = options;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const gmail = gmailApi(accessToken);
  // Start times are handed out one gap apart, whichever worker asks.
  const gap = 60_000 / Math.max(1, perMinute);
  let nextStart = now();
  const waitTurn = async () => {
    const at = Math.max(nextStart, now());
    nextStart = at + gap;
    const wait = at - now();
    if (wait > 0) await sleep(wait);
  };
  const read = async (id: string) => {
    for (let attempt = 0; ; attempt++) {
      await waitTurn();
      try {
        return await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "List-Id", "List-Unsubscribe", "List-Unsubscribe-Post", "Precedence"],
        });
      } catch (err) {
        if (!isGmailRateLimitError(err) || attempt >= retries) throw err;
        await sleep(Math.min(2 ** attempt * 1000, 32_000) + Math.floor(random() * 1000));
      }
    }
  };
  const results = await mapLimited(ids, concurrency, async (id): Promise<MessageSenderSubject | null> => {
    const res = await read(id).catch((err: unknown) => {
      const status = Number((err as { code?: number; status?: number }).code ?? (err as { status?: number }).status ?? 0);
      if (status === 404) return null;
      throw err;
    });
    if (!res) return null;
    const headers = res.data.payload?.headers;
    return {
      messageId: res.data.id ?? id,
      threadId: res.data.threadId ?? "",
      from: readGmailHeader(headers, "From"),
      subject: readGmailHeader(headers, "Subject"),
      listId: readGmailHeader(headers, "List-Id"),
      listUnsubscribe: readGmailHeader(headers, "List-Unsubscribe"),
      listUnsubscribePost: readGmailHeader(headers, "List-Unsubscribe-Post"),
      precedence: readGmailHeader(headers, "Precedence"),
    };
  });
  return results.filter((row): row is MessageSenderSubject => row !== null);
}

export interface MessageUnsubscribeHeaders {
  messageId: string;
  listUnsubscribe: string;
  listUnsubscribePost: string;
}

/** The unsubscribe headers of each message, read from Gmail (metadata only). Messages Gmail no longer has (404) are left out. */
export async function getUnsubscribeHeaders(accessToken: string, ids: string[]): Promise<MessageUnsubscribeHeaders[]> {
  const gmail = gmailApi(accessToken);
  const results = await mapLimited(ids, 5, async (id): Promise<MessageUnsubscribeHeaders | null> => {
    const res = await gmail.users.messages
      .get({ userId: "me", id, format: "metadata", metadataHeaders: ["List-Unsubscribe", "List-Unsubscribe-Post"] })
      .catch((err: unknown) => {
        const status = Number((err as { code?: number; status?: number }).code ?? (err as { status?: number }).status ?? 0);
        if (status === 404) return null;
        throw err;
      });
    if (!res) return null;
    const headers = res.data.payload?.headers;
    return {
      messageId: res.data.id ?? id,
      listUnsubscribe: readGmailHeader(headers, "List-Unsubscribe"),
      listUnsubscribePost: readGmailHeader(headers, "List-Unsubscribe-Post"),
    };
  });
  return results.filter((row): row is MessageUnsubscribeHeaders => row !== null);
}

/** Label change on up to 1,000 messages in one Gmail call (archive = remove INBOX). Needs gmail.modify. */
export async function batchModifyMessages(
  accessToken: string,
  messageIds: string[],
  change: { add?: string[]; remove?: string[] },
): Promise<void> {
  if (messageIds.length === 0) return;
  const gmail = gmailApi(accessToken);
  for (let i = 0; i < messageIds.length; i += 1000) {
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: { ids: messageIds.slice(i, i + 1000), addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] },
    });
  }
}

/** Most tags whose email counts are looked up (one Gmail call each). */
const MAX_TAG_COUNTS = 50;

/**
 * The account's own Gmail labels (the Mail tags), sorted by name, with
 * total/unread counts for the first MAX_TAG_COUNTS. System labels are left out.
 */
export async function listUserLabels(accessToken: string): Promise<MailTag[]> {
  const gmail = gmailApi(accessToken);
  const res = await gmail.users.labels.list({ userId: "me" });
  const labels = (res.data.labels ?? [])
    .filter((label) => label.type === "user" && parseTagId(label.id) && label.name)
    .map((label) => ({ id: label.id as string, name: label.name as string }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const counted = await mapLimited(labels.slice(0, MAX_TAG_COUNTS), 5, async (label): Promise<MailTag> => {
    try {
      const full = await gmail.users.labels.get({ userId: "me", id: label.id });
      return { ...label, total: full.data.messagesTotal ?? 0, unread: full.data.messagesUnread ?? 0 };
    } catch {
      return { ...label, total: null, unread: null };
    }
  });
  return [...counted, ...labels.slice(MAX_TAG_COUNTS).map((label) => ({ ...label, total: null, unread: null }))];
}

/** Create a Gmail label for a new tag; if one with that name already exists, return it instead. */
export async function createUserLabel(accessToken: string, name: string): Promise<MailTag> {
  const gmail = gmailApi(accessToken);
  try {
    const res = await gmail.users.labels.create({
      userId: "me",
      requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    const id = parseTagId(res.data.id);
    if (!id) throw new Error("Gmail returned no label id.");
    return { id, name: res.data.name ?? name, total: 0, unread: 0 };
  } catch (err) {
    // 409: the label already exists (Gmail compares names without case).
    if (Number((err as { code?: number }).code) !== 409) throw err;
    const existing = findTagByName(await listUserLabels(accessToken), name);
    if (!existing) throw err;
    return existing;
  }
}

/**
 * Move a whole thread to Gmail's Bin (`untrash` puts it back). Gmail empties
 * the Bin after 30 days; nothing is deleted outright. Needs gmail.modify.
 */
export async function trashThread(accessToken: string, threadId: string, restore = false): Promise<void> {
  const gmail = gmailApi(accessToken);
  if (restore) await gmail.users.threads.untrash({ userId: "me", id: threadId });
  else await gmail.users.threads.trash({ userId: "me", id: threadId });
}

export interface ThreadReplyHeader {
  messageId: string;
  from: string;
  /** Gmail internalDate in ms since the epoch (0 if missing). */
  internalDate: number;
  labelIds: string[];
  autoSubmitted?: string;
  precedence?: string;
  listId?: string;
  listUnsubscribe?: string;
}

/**
 * Just enough of every message in a thread to tell whether someone replied
 * (follow-up reminders): sender, time and bulk/auto headers, no bodies.
 * A thread Gmail no longer has (404) returns [].
 */
export async function getThreadReplyHeaders(accessToken: string, threadId: string): Promise<ThreadReplyHeader[]> {
  const gmail = gmailApi(accessToken);
  const res = await gmail.users.threads
    .get({
      userId: "me",
      id: threadId,
      format: "metadata",
      metadataHeaders: ["From", "Auto-Submitted", "Precedence", "List-Id", "List-Unsubscribe"],
    })
    .catch((err: unknown) => {
      const status = Number((err as { code?: number; status?: number }).code ?? (err as { status?: number }).status ?? 0);
      if (status === 404) return null;
      throw err;
    });
  if (!res) return [];
  return (res.data.messages ?? []).map((message) => {
    const headers = message.payload?.headers;
    return {
      messageId: message.id ?? "",
      from: readGmailHeader(headers, "From"),
      internalDate: Number(message.internalDate ?? 0) || 0,
      labelIds: message.labelIds ?? [],
      autoSubmitted: readGmailHeader(headers, "Auto-Submitted"),
      precedence: readGmailHeader(headers, "Precedence"),
      listId: readGmailHeader(headers, "List-Id"),
      listUnsubscribe: readGmailHeader(headers, "List-Unsubscribe"),
    };
  });
}

/** Archive = remove INBOX. Read/unread = remove/add UNREAD. Needs gmail.modify. */
export async function modifyThreadLabels(
  accessToken: string,
  threadId: string,
  change: { add?: string[]; remove?: string[] },
): Promise<void> {
  const gmail = gmailApi(accessToken);
  await gmail.users.threads.modify({
    userId: "me",
    id: threadId,
    requestBody: { addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] },
  });
}

export async function getMailboxProfile(accessToken: string): Promise<{ emailAddress: string; historyId: string }> {
  const gmail = gmailApi(accessToken);
  const res = await gmail.users.getProfile({ userId: "me" });
  return { emailAddress: res.data.emailAddress ?? "", historyId: String(res.data.historyId ?? "") };
}

/**
 * Message ids added since `startHistoryId` (Gmail incremental sync).
 * Throws GmailHistoryExpiredError when Gmail no longer has that history (404),
 * so the caller can fall back to a recent-window sync.
 *
 * Stops after about `maxIds` ids. When it stops early, `resumeHistoryId` is
 * the last history record it read, so the next sync carries on from there
 * instead of jumping to the newest point and skipping the rest.
 */
export async function listAddedMessageIdsSince(
  accessToken: string,
  startHistoryId: string,
  maxIds = 500,
): Promise<{ ids: string[]; resumeHistoryId: string | null }> {
  const gmail = gmailApi(accessToken);
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let resumeHistoryId: string | null = null;
  try {
    pages: do {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        maxResults: 500,
        ...(pageToken ? { pageToken } : {}),
      });
      const history = res.data.history ?? [];
      for (const [index, entry] of history.entries()) {
        for (const added of entry.messagesAdded ?? []) {
          const message = added.message;
          if (message?.id && isSyncableLabelSet(message.labelIds)) ids.add(message.id);
        }
        const more = index < history.length - 1 || Boolean(res.data.nextPageToken);
        if (ids.size >= maxIds && more && entry.id) {
          resumeHistoryId = String(entry.id);
          break pages;
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    if (status === 404) throw new GmailHistoryExpiredError("Gmail history expired");
    throw err;
  }
  return { ids: [...ids], resumeHistoryId };
}

/** Recent message ids (received and sent) for the first sync or after history expiry. */
export async function listRecentMessageIds(accessToken: string, days: number, maxIds: number): Promise<string[]> {
  const gmail = gmailApi(accessToken);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: `newer_than:${days}d -in:chats -in:drafts -in:spam -in:trash`,
      maxResults: Math.min(100, maxIds - ids.length),
      ...(pageToken ? { pageToken } : {}),
    });
    for (const message of res.data.messages ?? []) if (message.id) ids.push(message.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < maxIds);
  return ids.slice(0, maxIds);
}

/** Message ids matching a Gmail search, newest first, up to `maxIds`. */
export async function listMessageIdsMatching(accessToken: string, q: string, maxIds: number): Promise<string[]> {
  const gmail = gmailApi(accessToken);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: Math.min(100, maxIds - ids.length),
      ...(pageToken ? { pageToken } : {}),
    });
    for (const message of res.data.messages ?? []) if (message.id) ids.push(message.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < maxIds);
  return ids.slice(0, maxIds);
}

export interface MessageFilePart {
  filename: string;
  mimeType: string;
  /** Content-ID without angle brackets, for images the HTML shows via cid:. */
  contentId: string;
  /** Standard base64 (not base64url). */
  data: string;
  size: number;
}

export interface MessageContentParts {
  html: string;
  text: string;
  inline: MessageFilePart[];
  attachments: MessageFilePart[];
  /** True when the files exceed `maxBytes`; no file data is returned then. */
  tooLarge: boolean;
}

/**
 * HTML, inline images and attachments of one message, for re-editing a draft
 * in the Mail compose window. Stops fetching once the files pass `maxBytes`.
 */
export async function getMessageContentParts(
  accessToken: string,
  messageId: string,
  maxBytes: number,
): Promise<MessageContentParts> {
  const gmail = gmailApi(accessToken);
  const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const decode = (data: string) => Buffer.from(data, "base64url");
  const header = (part: gmail_v1.Schema$MessagePart, name: string) =>
    readGmailHeader(part.headers ?? undefined, name);

  const out: MessageContentParts = { html: "", text: "", inline: [], attachments: [], tooLarge: false };
  const files: Array<{ part: gmail_v1.Schema$MessagePart; inline: boolean }> = [];
  const walk = (part: gmail_v1.Schema$MessagePart) => {
    const contentId = header(part, "Content-ID").replace(/^<|>$/g, "");
    const isFile = Boolean(part.filename) || Boolean(part.body?.attachmentId);
    if (isFile) {
      const disposition = header(part, "Content-Disposition").toLowerCase();
      files.push({ part, inline: Boolean(contentId) && !disposition.startsWith("attachment") });
    } else if (part.mimeType === "text/html" && part.body?.data && !out.html) {
      out.html = decode(part.body.data).toString("utf-8");
    } else if (part.mimeType === "text/plain" && part.body?.data && !out.text) {
      out.text = decode(part.body.data).toString("utf-8");
    }
    part.parts?.forEach(walk);
  };
  if (res.data.payload) walk(res.data.payload);

  let total = 0;
  for (const { part, inline } of files) {
    total += part.body?.size ?? 0;
    if (total > maxBytes) {
      out.tooLarge = true;
      out.inline = [];
      out.attachments = [];
      return out;
    }
    let data = part.body?.data ?? "";
    if (!data && part.body?.attachmentId) {
      const attachment = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: part.body.attachmentId,
      });
      data = attachment.data.data ?? "";
    }
    const content = decode(data);
    const file: MessageFilePart = {
      filename: part.filename || "attachment",
      mimeType: part.mimeType || "application/octet-stream",
      contentId: header(part, "Content-ID").replace(/^<|>$/g, ""),
      data: content.toString("base64"),
      size: content.length,
    };
    (inline ? out.inline : out.attachments).push(file);
  }
  return out;
}

/**
 * Gmail draft id for a draft's message id. Gmail links only carry
 * the message id, but updating or deleting a draft needs the draft id.
 * Returns null when no draft holds that message (sent, discarded or not a draft).
 */
export async function findDraftIdByMessageId(accessToken: string, messageId: string): Promise<string | null> {
  const gmail = gmailApi(accessToken);
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const res = await gmail.users.drafts.list({ userId: "me", maxResults: 500, ...(pageToken ? { pageToken } : {}) });
    const match = (res.data.drafts ?? []).find((draft) => draft.message?.id === messageId);
    if (match?.id) return match.id;
    pageToken = res.data.nextPageToken ?? undefined;
    pages++;
  } while (pageToken && pages < 5);
  return null;
}

/** Delete a draft (after it has been sent from the Mail view). Needs gmail.compose. */
export async function deleteDraft(accessToken: string, draftId: string): Promise<void> {
  const gmail = gmailApi(accessToken);
  await gmail.users.drafts.delete({ userId: "me", id: draftId });
}

export function gmailMessageLink(messageId: string, account?: string): string {
  const user = account ? encodeURIComponent(account) : "0";
  return `https://mail.google.com/mail/u/${user}/#all/${messageId}`;
}
