import { cleanSignOff } from "@/lib/mail/signature";
import { sql } from "@payloadcms/db-sqlite";
import type { Payload } from "payload";
import { parseMailComposeContent } from "@/lib/mail/compose-content";
import { deliverMail, type DeliverInput, type DeliverResult } from "@/lib/mail/deliver";
import { createFollowUp, followUpDb, parseFollowUpDays } from "@/lib/mail/follow-ups";
import { addBusinessDaysInZone } from "@/lib/mail/schedule-times";

/**
 * Scheduled send for the Mail view. Gmail's API cannot schedule, so the email
 * is kept in the `scheduled_emails` table and /api/mail/schedule/tick sends it
 * once `scheduled_for` passes.
 *
 * Every state change is one conditional UPDATE/DELETE, so a cancel, a
 * reschedule, "send now" and the cron cannot act on the same email twice: an
 * email is claimed (pending -> sending) by exactly one sender, and a claimed
 * or sent email can no longer be cancelled. Dates are stored as ISO strings,
 * which sort the same as the instants they name.
 */

export const SCHEDULE_MIN_LEAD_MS = 60_000;
export const SCHEDULE_MAX_LEAD_MS = 366 * 24 * 60 * 60 * 1000;
/** A "sending" email older than this lost its sender (crash/timeout). */
export const STALE_SENDING_MS = 15 * 60 * 1000;
export const MAX_SEND_ATTEMPTS = 3;
const DUE_BATCH = 20;

export type ScheduledStatus = "pending" | "sending" | "sent" | "failed";

type SqlResult = { rows?: unknown[]; rowsAffected?: number };
export type ScheduleDb = { run: (query: ReturnType<typeof sql>) => Promise<SqlResult> };

export function scheduleDb(payload: Payload): ScheduleDb {
  return payload.db.drizzle as unknown as ScheduleDb;
}

/** What the compose window posted, kept so the cron can rebuild the email. */
export interface StoredMailContent {
  html: string;
  /** Blind copy recipients (kept here rather than in a column). */
  bcc?: string;
  /** Edited sign-off from the compose window. */
  signOff?: string;
  /** Signature toggle off: send without the Gmail signature. */
  noSignature?: boolean;
  /**
   * "Remind me if no reply" in business days, counted from when the email
   * actually goes out (the send time can still move). Computed on send in
   * Sydney time (AEST/AEDT), skipping Sydney weekends.
   */
  followUpDays?: number;
  inlineImages?: unknown;
  attachments?: unknown;
}

export interface ScheduledEmailItem {
  id: number;
  to: string;
  cc: string;
  subject: string;
  scheduledFor: string;
  status: ScheduledStatus;
  lastError: string;
  attachmentCount: number;
  isReply: boolean;
}

export type ScheduleTimeResult = { ok: true; date: Date } | { ok: false; error: string };

export function parseScheduledFor(raw: unknown, now: Date): ScheduleTimeResult {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "Choose a time to send." };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { ok: false, error: "That send time is not a valid date." };
  const lead = date.getTime() - now.getTime();
  if (lead < SCHEDULE_MIN_LEAD_MS) return { ok: false, error: "Choose a send time at least a minute from now." };
  if (lead > SCHEDULE_MAX_LEAD_MS) return { ok: false, error: "Emails can be scheduled up to a year ahead." };
  return { ok: true, date };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rowsOf(result: SqlResult): Array<Record<string, unknown>> {
  return (result.rows ?? []) as Array<Record<string, unknown>>;
}

function changed(result: SqlResult): boolean {
  return Number(result.rowsAffected ?? 0) > 0;
}

function parseStored(raw: unknown): StoredMailContent | null {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && typeof value === "object" && typeof (value as StoredMailContent).html === "string"
      ? (value as StoredMailContent)
      : null;
  } catch {
    return null;
  }
}

function toItem(row: Record<string, unknown>): ScheduledEmailItem {
  const stored = parseStored(row.content);
  return {
    id: Number(row.id),
    to: text(row.to),
    cc: text(row.cc),
    subject: text(row.subject),
    scheduledFor: text(row.scheduled_for),
    status: text(row.status) as ScheduledStatus,
    lastError: text(row.last_error),
    attachmentCount: Array.isArray(stored?.attachments) ? stored.attachments.length : 0,
    isReply: text(row.reply_to_message_id) !== "",
  };
}

/**
 * SQL filter for one Gmail account's rows: `account` "" = the user's main
 * Gmail (column empty or NULL); undefined = every account.
 */
function accountFilter(account: string | undefined) {
  return account === undefined ? sql`` : sql` and coalesce(account, '') = ${account}`;
}

export async function createScheduledEmail(
  db: ScheduleDb,
  input: {
    ownerId: number;
    /** Extra Gmail account it sends from; "" or omitted = the main Gmail. */
    account?: string;
    to: string;
    cc: string;
    subject: string;
    replyToMessageId: string | null;
    scheduledFor: Date;
    content: StoredMailContent;
  },
): Promise<number> {
  const result = await db.run(
    sql`insert into scheduled_emails
          (owner_id, account, status, scheduled_for, "to", cc, subject, reply_to_message_id, content, attempts)
        values (${input.ownerId}, ${input.account || null}, 'pending', ${input.scheduledFor.toISOString()}, ${input.to}, ${input.cc},
                ${input.subject}, ${input.replyToMessageId}, ${JSON.stringify(input.content)}, 0)
        returning id`,
  );
  return Number(rowsOf(result)[0]?.id);
}

/** The user's queued emails (pending, sending, failed), soonest first; `account` limits them to one Gmail account. */
export async function listScheduledEmails(db: ScheduleDb, ownerId: number, account?: string): Promise<ScheduledEmailItem[]> {
  const result = await db.run(
    sql`select id, "to", cc, subject, scheduled_for, status, last_error, reply_to_message_id, content
        from scheduled_emails
        where owner_id = ${ownerId} and status in ('pending', 'sending', 'failed')${accountFilter(account)}
        order by scheduled_for asc, id asc
        limit 200`,
  );
  return rowsOf(result).map(toItem);
}

/** Emails still waiting to go out (what Gmail shows as the Scheduled count). */
export async function countScheduledEmails(db: ScheduleDb, ownerId: number, account?: string): Promise<number> {
  const result = await db.run(
    sql`select count(*) as n from scheduled_emails where owner_id = ${ownerId} and status in ('pending', 'sending')${accountFilter(account)}`,
  );
  return Number(rowsOf(result)[0]?.n ?? 0);
}

/** One queued email with its content, for the Scheduled tab's reading pane and Edit. Null if not the owner's or already sent. */
export async function getScheduledEmail(
  db: ScheduleDb,
  id: number,
  ownerId: number,
): Promise<{ item: ScheduledEmailItem; replyToMessageId: string | null; content: StoredMailContent | null } | null> {
  const row = rowsOf(
    await db.run(
      sql`select id, "to", cc, subject, scheduled_for, status, last_error, reply_to_message_id, content
          from scheduled_emails
          where id = ${id} and owner_id = ${ownerId} and status in ('pending', 'sending', 'failed')`,
    ),
  )[0];
  if (!row) return null;
  return { item: toItem(row), replyToMessageId: text(row.reply_to_message_id) || null, content: parseStored(row.content) };
}

/**
 * Replace an unsent (or failed) email's recipients, subject and content, and
 * optionally its time; it is queued again. The reply it belongs to is kept.
 * False if it is sending, sent, cancelled or not the owner's.
 */
export async function updateScheduledEmail(
  db: ScheduleDb,
  id: number,
  ownerId: number,
  input: { to: string; cc: string; subject: string; content: StoredMailContent; scheduledFor: Date | null },
  now: Date,
): Promise<boolean> {
  const time = input.scheduledFor ? sql`, scheduled_for = ${input.scheduledFor.toISOString()}` : sql``;
  return changed(
    await db.run(
      sql`update scheduled_emails
          set "to" = ${input.to}, cc = ${input.cc}, subject = ${input.subject}, content = ${JSON.stringify(input.content)},
              status = 'pending', attempts = 0, last_error = null, updated_at = ${now.toISOString()}${time}
          where id = ${id} and owner_id = ${ownerId} and status in ('pending', 'failed')`,
    ),
  );
}

const EDITABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const CONTENT_ID_RE = /^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9.-]{1,128}$/;

export interface EditableScheduledContent {
  /** Body HTML with inline images as data: URLs, as the compose editor holds them. */
  html: string;
  attachments: Array<{ name: string; mediaType: string; data: string }>;
  bcc: string;
  signOff?: string;
  noSignature?: boolean;
  /** "Remind me if no reply" business days, when set. */
  followUpDays?: number;
}

/** Stored content turned back into what the compose window edits (like reopening a Gmail draft). */
export function toEditableScheduledContent(stored: StoredMailContent | null): EditableScheduledContent {
  if (!stored) return { html: "", attachments: [], bcc: "" };
  let html = stored.html;
  const images = Array.isArray(stored.inlineImages) ? (stored.inlineImages as Array<Record<string, unknown>>) : [];
  for (const image of images) {
    const contentId = text(image?.contentId);
    const mediaType = text(image?.mediaType);
    const data = text(image?.data);
    if (!CONTENT_ID_RE.test(contentId) || !EDITABLE_IMAGE_TYPES.has(mediaType) || !BASE64_RE.test(data)) continue;
    html = html.split(`cid:${contentId}`).join(`data:${mediaType};base64,${data}`);
  }
  const files = Array.isArray(stored.attachments) ? (stored.attachments as Array<Record<string, unknown>>) : [];
  const attachments = files
    .map((file) => ({ name: text(file?.name), mediaType: text(file?.mediaType), data: text(file?.data) }))
    .filter((file) => file.name && BASE64_RE.test(file.data));
  const signOff = cleanSignOff(stored.signOff);
  const followUpDays = parseFollowUpDays(stored.followUpDays);
  return {
    html,
    attachments,
    bcc: text(stored.bcc),
    ...(signOff !== undefined ? { signOff } : {}),
    ...(stored.noSignature === true ? { noSignature: true } : {}),
    ...(followUpDays !== null ? { followUpDays } : {}),
  };
}

/** Remove an email that has not been claimed by a sender. False if it already went out or is gone. */
export async function cancelScheduledEmail(db: ScheduleDb, id: number, ownerId: number): Promise<boolean> {
  return changed(
    await db.run(
      sql`delete from scheduled_emails where id = ${id} and owner_id = ${ownerId} and status in ('pending', 'failed')`,
    ),
  );
}

/** Move an unsent (or failed) email to a new time; failed ones are queued again. */
export async function rescheduleScheduledEmail(
  db: ScheduleDb,
  id: number,
  ownerId: number,
  scheduledFor: Date,
  now: Date,
): Promise<boolean> {
  return changed(
    await db.run(
      sql`update scheduled_emails
          set scheduled_for = ${scheduledFor.toISOString()}, status = 'pending', attempts = 0,
              last_error = null, updated_at = ${now.toISOString()}
          where id = ${id} and owner_id = ${ownerId} and status in ('pending', 'failed')`,
    ),
  );
}

/** pending -> sending, for exactly one caller. `dueBy` limits the claim to emails whose time has come. */
async function claim(db: ScheduleDb, id: number, now: Date, opts: { ownerId?: number; dueBy?: Date }): Promise<boolean> {
  const owner = opts.ownerId === undefined ? sql`` : sql` and owner_id = ${opts.ownerId}`;
  const due = opts.dueBy ? sql` and scheduled_for <= ${opts.dueBy.toISOString()}` : sql``;
  return changed(
    await db.run(
      sql`update scheduled_emails
          set status = 'sending', attempts = coalesce(attempts, 0) + 1, updated_at = ${now.toISOString()}
          where id = ${id} and status = 'pending'${owner}${due}`,
    ),
  );
}

async function finish(
  db: ScheduleDb,
  id: number,
  now: Date,
  outcome: { status: "sent"; messageId: string } | { status: "failed" | "pending"; error: string },
): Promise<void> {
  const at = now.toISOString();
  if (outcome.status === "sent") {
    await db.run(
      sql`update scheduled_emails
          set status = 'sent', sent_at = ${at}, sent_message_id = ${outcome.messageId}, content = null,
              last_error = null, updated_at = ${at}
          where id = ${id}`,
    );
    return;
  }
  await db.run(
    sql`update scheduled_emails set status = ${outcome.status}, last_error = ${outcome.error.slice(0, 500)}, updated_at = ${at}
        where id = ${id}`,
  );
}

/** Emails stuck in "sending" are marked failed, never resent: they may already be in Sent. */
export async function failStaleSending(db: ScheduleDb, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_SENDING_MS).toISOString();
  const result = await db.run(
    sql`update scheduled_emails
        set status = 'failed', updated_at = ${now.toISOString()},
            last_error = 'Sending was interrupted. Check Sent before sending again.'
        where status = 'sending' and updated_at < ${cutoff}`,
  );
  return Number(result.rowsAffected ?? 0);
}

export interface SendDeps {
  now: () => Date;
  /** `account`: the extra Gmail account the email sends from; undefined = the main Gmail. */
  getToken: (ownerId: number, account?: string) => Promise<
    { ok: true; accessToken: string; email: string; userEmail: string } | { ok: false; reason: string }
  >;
  deliver: (input: DeliverInput) => Promise<DeliverResult>;
}

export const defaultSendDeps = (getToken: SendDeps["getToken"]): SendDeps => ({
  now: () => new Date(),
  getToken,
  deliver: deliverMail,
});

export type SendOutcome =
  | { status: "sent"; messageId: string }
  | { status: "failed" | "retry"; error: string }
  | { status: "skipped" };

/** HTTP status Gmail returned, when the error carries one. */
function httpStatus(error: unknown): number {
  const e = error as { code?: unknown; status?: unknown } | null;
  return Number(e?.code ?? e?.status ?? 0) || 0;
}

/**
 * Claims and sends one queued email. `onlyDue` is the cron's rule; "send now"
 * passes false. Skipped means someone else already claimed, cancelled or sent it.
 */
export async function sendScheduledEmail(
  payload: Payload,
  id: number,
  deps: SendDeps,
  opts: { ownerId?: number; onlyDue: boolean },
): Promise<SendOutcome> {
  const db = scheduleDb(payload);
  const now = deps.now();
  if (!(await claim(db, id, now, { ownerId: opts.ownerId, dueBy: opts.onlyDue ? now : undefined }))) {
    return { status: "skipped" };
  }
  const fail = async (error: string, retry = false): Promise<SendOutcome> => {
    await finish(db, id, deps.now(), { status: retry ? "pending" : "failed", error });
    return { status: retry ? "retry" : "failed", error };
  };

  const rows = rowsOf(
    await db.run(
      sql`select owner_id, account, "to", cc, subject, reply_to_message_id, content, attempts from scheduled_emails where id = ${id}`,
    ),
  );
  const row = rows[0];
  if (!row) return { status: "skipped" };

  const stored = parseStored(row.content);
  const parsed = stored ? parseMailComposeContent(stored) : null;
  if (!parsed?.ok) return fail(parsed ? parsed.error : "The saved email content could not be read.");

  const ownerId = Number(row.owner_id);
  // Sent from the Gmail account it was scheduled in, never silently from another one.
  const account = text(row.account);
  const token = account ? await deps.getToken(ownerId, account) : await deps.getToken(ownerId);
  if (!token.ok) {
    return fail(
      account
        ? `${account} is not connected. Add it again from the Mail account menu, then reschedule this email.`
        : "Gmail is not connected. Reconnect Gmail, then reschedule this email.",
    );
  }

  const result = await deps.deliver({
    payload,
    ownerId,
    token,
    to: text(row.to),
    cc: text(row.cc),
    bcc: text(stored?.bcc),
    signOff: cleanSignOff(stored?.signOff),
    noSignature: stored?.noSignature === true,
    subject: text(row.subject),
    content: parsed.value,
    replyToMessageId: text(row.reply_to_message_id) || null,
  });
  if (result.ok) {
    const sentAt = deps.now();
    await finish(db, id, sentAt, { status: "sent", messageId: result.messageId });
    const followUpDays = parseFollowUpDays(stored?.followUpDays);
    if (followUpDays !== null) {
      // The email is sent either way; a tracking failure only loses the reminder.
      await createFollowUp(followUpDb(payload), {
        ownerId,
        ...(account ? { account } : {}),
        clientId: result.client?.id ?? null,
        threadId: result.threadId,
        sentMessageId: result.messageId,
        to: text(row.to),
        subject: text(row.subject),
        sentAt,
        remindAt: addBusinessDaysInZone(sentAt, followUpDays),
      }).catch((err: unknown) => console.warn("[mail] follow-up tracking failed:", (err as Error).message?.slice(0, 200)));
    }
    return { status: "sent", messageId: result.messageId };
  }
  if (result.stage === "recipient") return fail("There is no recipient on this email.");
  const code = httpStatus(result.error);
  if (code === 401 || code === 403) return fail("Gmail refused the request. Reconnect Gmail, then reschedule this email.");
  const retryable = (code === 429 || code === 503) && Number(row.attempts ?? 1) < MAX_SEND_ATTEMPTS;
  return fail(
    result.stage === "reply" ? "Could not load the email being replied to." : "Gmail could not send the email.",
    retryable,
  );
}

/** Cron entry: send every email whose time has come (oldest first, bounded per run). */
export async function sendDueScheduledEmails(
  payload: Payload,
  deps: SendDeps,
): Promise<{ sent: number; failed: number; retrying: number; skipped: number; stale: number }> {
  const db = scheduleDb(payload);
  const now = deps.now();
  const stale = await failStaleSending(db, now);
  const due = rowsOf(
    await db.run(
      sql`select id from scheduled_emails where status = 'pending' and scheduled_for <= ${now.toISOString()}
          order by scheduled_for asc, id asc limit ${DUE_BATCH}`,
    ),
  );
  const tally = { sent: 0, failed: 0, retrying: 0, skipped: 0, stale };
  for (const row of due) {
    const outcome = await sendScheduledEmail(payload, Number(row.id), deps, { onlyDue: true });
    if (outcome.status === "sent") tally.sent++;
    else if (outcome.status === "failed") tally.failed++;
    else if (outcome.status === "retry") tally.retrying++;
    else tally.skipped++;
  }
  return tally;
}
