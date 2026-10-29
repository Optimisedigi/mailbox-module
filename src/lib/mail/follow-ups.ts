import { sql } from "@payloadcms/db-sqlite";
import type { Payload } from "payload";
import { isAutomatedMessage } from "./automated-senders";
import { extractEmailAddresses } from "./client-matching";
import type { ThreadReplyHeader } from "./gmail-mail";
import { FOLLOW_UP_DAY_OPTIONS } from "./schedule-times";

export { DEFAULT_FOLLOW_UP_DAYS, FOLLOW_UP_DAY_OPTIONS } from "./schedule-times";

/**
 * Follow-up reminders for the Mail view ("Remind me if no reply"). A row in
 * `mail_follow_ups` tracks one sent email; the hourly cron (checkFollowUps)
 * marks it `replied` once someone outside the user's own addresses answers in
 * the thread, and moves it `waiting -> due` once `remind_at` passes. Due
 * reminders show in Mail's Awaiting panel; they raise no bell notification.
 * Like scheduled.ts, every state change is one conditional UPDATE, so two cron
 * runs can never double-process a row. Dates are ISO strings, which sort the
 * same as the instants they name.
 */

export const FOLLOW_UP_MIN_LEAD_MS = 60 * 60 * 1000;
export const FOLLOW_UP_MAX_LEAD_MS = 60 * 24 * 60 * 60 * 1000;
/** Threads checked against Gmail per cron run (oldest-checked first). */
export const FOLLOW_UP_CHECK_BATCH = 100;

export type FollowUpStatus = "waiting" | "due" | "replied" | "dismissed";

type SqlResult = { rows?: unknown[]; rowsAffected?: number };
export type FollowUpDb = { run: (query: ReturnType<typeof sql>) => Promise<SqlResult> };

export function followUpDb(payload: Payload): FollowUpDb {
  return payload.db.drizzle as unknown as FollowUpDb;
}

export interface FollowUpItem {
  id: number;
  threadId: string;
  sentMessageId: string;
  to: string;
  subject: string;
  clientId: number | null;
  clientName: string;
  sentAt: string;
  remindAt: string;
  status: FollowUpStatus;
}

export type RemindAtResult = { ok: true; date: Date } | { ok: false; error: string };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rowsOf(result: SqlResult): Array<Record<string, unknown>> {
  return (result.rows ?? []) as Array<Record<string, unknown>>;
}

function changed(result: SqlResult): boolean {
  return Number(result.rowsAffected ?? 0) > 0;
}

/** A reminder time from the browser: a valid instant 1 hour to 60 days ahead. */
export function parseRemindAt(raw: unknown, now: Date): RemindAtResult {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "Choose when to be reminded." };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { ok: false, error: "That reminder time is not a valid date." };
  const lead = date.getTime() - now.getTime();
  if (lead < FOLLOW_UP_MIN_LEAD_MS) return { ok: false, error: "Choose a reminder at least an hour from now." };
  if (lead > FOLLOW_UP_MAX_LEAD_MS) return { ok: false, error: "Reminders can be set up to 60 days ahead." };
  return { ok: true, date };
}

/** Business days for a scheduled send's reminder (stored with the email), or null for none. */
export function parseFollowUpDays(raw: unknown): number | null {
  return typeof raw === "number" && (FOLLOW_UP_DAY_OPTIONS as readonly number[]).includes(raw) ? raw : null;
}

/** Track one sent email. Idempotent on the sent message id; returns the row id, or null if already tracked. */
export async function createFollowUp(
  db: FollowUpDb,
  input: {
    ownerId: number;
    /** Extra Gmail account it was sent from; omitted = the main Gmail. */
    account?: string;
    clientId: number | null;
    threadId: string;
    sentMessageId: string;
    to: string;
    subject: string;
    sentAt: Date;
    remindAt: Date;
  },
): Promise<number | null> {
  const result = await db.run(
    sql`insert into mail_follow_ups
          (owner_id, account, client_id, gmail_thread_id, sent_message_id, "to", subject, sent_at, remind_at, status)
        values (${input.ownerId}, ${input.account || null}, ${input.clientId}, ${input.threadId}, ${input.sentMessageId},
                ${input.to.slice(0, 1_000)}, ${input.subject.slice(0, 1_000)}, ${input.sentAt.toISOString()},
                ${input.remindAt.toISOString()}, 'waiting')
        on conflict (sent_message_id) do nothing
        returning id`,
  );
  const id = rowsOf(result)[0]?.id;
  return id === undefined || id === null ? null : Number(id);
}

/**
 * SQL filter for one Gmail account's rows: `account` "" = the user's main
 * Gmail (column empty or NULL); undefined = every account.
 */
function accountFilter(column: "account" | "f.account", account: string | undefined) {
  if (account === undefined) return sql``;
  return column === "f.account" ? sql` and coalesce(f.account, '') = ${account}` : sql` and coalesce(account, '') = ${account}`;
}

/** The user's open reminders (waiting or due), soonest first; `account` limits them to one Gmail account. */
export async function listFollowUps(db: FollowUpDb, ownerId: number, account?: string): Promise<FollowUpItem[]> {
  const result = await db.run(
    sql`select f.id, f.gmail_thread_id, f.sent_message_id, f."to", f.subject, f.client_id, c.name as client_name,
               f.sent_at, f.remind_at, f.status
        from mail_follow_ups f
        left join clients c on c.id = f.client_id
        where f.owner_id = ${ownerId} and f.status in ('waiting', 'due')${accountFilter("f.account", account)}
        order by f.remind_at asc, f.id asc
        limit 200`,
  );
  return rowsOf(result).map((row) => ({
    id: Number(row.id),
    threadId: text(row.gmail_thread_id),
    sentMessageId: text(row.sent_message_id),
    to: text(row.to),
    subject: text(row.subject),
    clientId: row.client_id === null || row.client_id === undefined ? null : Number(row.client_id),
    clientName: text(row.client_name),
    sentAt: text(row.sent_at),
    remindAt: text(row.remind_at),
    status: text(row.status) as FollowUpStatus,
  }));
}

/** Open reminders whose time has come (the Awaiting reply tab badge). */
export async function countDueFollowUps(db: FollowUpDb, ownerId: number, now: Date, account?: string): Promise<number> {
  const result = await db.run(
    sql`select count(*) as n from mail_follow_ups
        where owner_id = ${ownerId}
          and (status = 'due' or (status = 'waiting' and remind_at <= ${now.toISOString()}))${accountFilter("account", account)}`,
  );
  return Number(rowsOf(result)[0]?.n ?? 0);
}

/** "Done": stop tracking. False if it is not the owner's or already closed. */
export async function dismissFollowUp(db: FollowUpDb, id: number, ownerId: number, now: Date): Promise<boolean> {
  return changed(
    await db.run(
      sql`update mail_follow_ups set status = 'dismissed', updated_at = ${now.toISOString()}
          where id = ${id} and owner_id = ${ownerId} and status in ('waiting', 'due')`,
    ),
  );
}

/** Push the reminder out; it waits again and can notify once more when the new time passes. */
export async function snoozeFollowUp(
  db: FollowUpDb,
  id: number,
  ownerId: number,
  remindAt: Date,
  now: Date,
): Promise<boolean> {
  return changed(
    await db.run(
      sql`update mail_follow_ups
          set remind_at = ${remindAt.toISOString()}, status = 'waiting', notified_at = null, updated_at = ${now.toISOString()}
          where id = ${id} and owner_id = ${ownerId} and status in ('waiting', 'due')`,
    ),
  );
}

/**
 * True when someone other than the user answered after `sentAt`: a later
 * message whose sender is not one of `ownAddresses`, ignoring drafts and
 * automated mail (out-of-office, notifications, lists).
 */
export function isReplied(messages: ThreadReplyHeader[], sentAt: Date, ownAddresses: string[]): boolean {
  const own = new Set(ownAddresses.map((address) => address.trim().toLowerCase()).filter(Boolean));
  return messages.some((message) => {
    if (message.internalDate <= sentAt.getTime()) return false;
    if (message.labelIds.includes("DRAFT")) return false;
    const sender = extractEmailAddresses(message.from)[0];
    if (!sender || own.has(sender.toLowerCase())) return false;
    return !isAutomatedMessage({
      from: message.from,
      autoSubmitted: message.autoSubmitted,
      precedence: message.precedence,
      listId: message.listId,
      listUnsubscribe: message.listUnsubscribe,
    });
  });
}

export interface FollowUpCheckDeps {
  now: () => Date;
  /** `account`: the extra Gmail account the email was sent from; undefined = the main Gmail. */
  getToken: (ownerId: number, account?: string) => Promise<
    { ok: true; accessToken: string; email: string; userEmail: string } | { ok: false; reason: string }
  >;
  getThreadHeaders: (accessToken: string, threadId: string) => Promise<ThreadReplyHeader[]>;
}

export interface FollowUpCheckResult {
  checked: number;
  replied: number;
  gone: number;
  due: number;
  skipped: number;
  errors: number;
}

/**
 * Cron entry: check the open reminders least recently checked. Replied
 * threads close; a waiting reminder past its time moves to due (the
 * conditional UPDATE guarantees one transition per due cycle). When the
 * owner's Gmail is disconnected the reminder is left as it is.
 */
export async function checkFollowUps(payload: Payload, deps: FollowUpCheckDeps): Promise<FollowUpCheckResult> {
  const db = followUpDb(payload);
  const tally: FollowUpCheckResult = { checked: 0, replied: 0, gone: 0, due: 0, skipped: 0, errors: 0 };
  const rows = rowsOf(
    await db.run(
      sql`select id, owner_id, account, client_id, gmail_thread_id, "to", subject, sent_at, remind_at, status
          from mail_follow_ups
          where status in ('waiting', 'due')
          order by coalesce(last_checked_at, '') asc, id asc
          limit ${FOLLOW_UP_CHECK_BATCH}`,
    ),
  );

  // One token per owner and Gmail account ("" = the main Gmail).
  const tokenKey = (row: Record<string, unknown>) => `${Number(row.owner_id)}|${text(row.account)}`;
  const tokens = new Map<string, Awaited<ReturnType<FollowUpCheckDeps["getToken"]>>>();
  const keys = [...new Set(rows.map(tokenKey))].sort();
  for (const key of keys) {
    const [owner = "", account = ""] = key.split("|");
    const ownerId = Number(owner);
    const fetch = account ? deps.getToken(ownerId, account) : deps.getToken(ownerId);
    tokens.set(key, await fetch.catch(() => ({ ok: false as const, reason: "token-error" })));
  }

  for (const row of rows) {
    const id = Number(row.id);
    const token = tokens.get(tokenKey(row));
    const now = deps.now();
    const at = now.toISOString();
    if (!token?.ok) {
      tally.skipped++;
      await db.run(sql`update mail_follow_ups set last_checked_at = ${at} where id = ${id}`);
      continue;
    }
    try {
      const threadId = text(row.gmail_thread_id);
      const messages = threadId ? await deps.getThreadHeaders(token.accessToken, threadId) : [];
      tally.checked++;
      if (messages.length === 0) {
        // The thread was deleted from Gmail: nothing left to follow up.
        if (changed(await db.run(
          sql`update mail_follow_ups set status = 'dismissed', last_checked_at = ${at}, updated_at = ${at}
              where id = ${id} and status in ('waiting', 'due')`,
        ))) tally.gone++;
        continue;
      }
      const sentAt = new Date(text(row.sent_at));
      if (!Number.isNaN(sentAt.getTime()) && isReplied(messages, sentAt, [token.email, token.userEmail])) {
        if (changed(await db.run(
          sql`update mail_follow_ups set status = 'replied', last_checked_at = ${at}, updated_at = ${at}
              where id = ${id} and status in ('waiting', 'due')`,
        ))) tally.replied++;
        continue;
      }
      await db.run(sql`update mail_follow_ups set last_checked_at = ${at} where id = ${id}`);
      if (text(row.status) !== "waiting" || text(row.remind_at) > at) continue;
      const claimed = changed(
        await db.run(
          sql`update mail_follow_ups set status = 'due', notified_at = ${at}, updated_at = ${at}
              where id = ${id} and status = 'waiting' and remind_at <= ${at}`,
        ),
      );
      if (claimed) tally.due++;
    } catch (err) {
      tally.errors++;
      console.warn("[mail] follow-up check failed:", (err as Error).message?.slice(0, 200));
      await db.run(sql`update mail_follow_ups set last_checked_at = ${at} where id = ${id}`).catch(() => undefined);
    }
  }
  return tally;
}
