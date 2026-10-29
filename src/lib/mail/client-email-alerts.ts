import type { Payload } from 'payload'
import { mailThreadPath, MAIL_THREAD_QUERY_PARAM } from './drafts'
import { MAIL_ACCOUNT_QUERY_PARAM } from './accounts-shared'
import type { ThreadReplyHeader } from './gmail-mail'

/**
 * "Client email – please read" alerts.
 *
 * When a mailbox sync stores a NEW inbound email from a known client, one
 * `notifications` row is created for the mailbox owner (and nobody else).
 * They are listed in the top-bar bell like any notification; one that
 * arrives while the CMS is open also drops down once under the bell
 * (ClientEmailAlert). Opening it sets `readAt`.
 *
 * Noise limits (all plain code, no model):
 *  - Only inbound mail whose SENDER is a client (an email that only copies a
 *    client in does not count), after the sync's hidden-sender and
 *    automated-mail filters.
 *  - Only the user's main Gmail; extra accounts in Mail never alert.
 *  - Only during incremental syncs (never the 14-day first sync or a
 *    history-expired re-sync, which would flood the user with old mail).
 *  - Only emails dated within ALERT_MAX_AGE_MS.
 *  - At most MAX_ALERTS_PER_SYNC rows per sync; the rest stay in Mail.
 *  - One row per Gmail message (deduped on recipient + kind + url).
 *  - Never for calendar invites (any email carrying a text/calendar or .ics
 *    part: invitations, updates, cancellations, RSVPs).
 *  - Never from people at google.com (Google reps). Google service mailboxes
 *    such as googlecloud@google.com still alert.
 *
 * The email itself is still stored on the client's timeline in every case;
 * these rules only decide whether the bell lights up.
 *
 * Once the email is read, its alert is deleted: straight away when it is
 * opened or marked read in Mail (removeClientEmailAlertsForThreads), and on the
 * next alert sync when it was read in Gmail itself (removeAlertsForReadEmails).
 */

export const CLIENT_EMAIL_ALERT_KIND = 'client-email-received'
export const ALERT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const MAX_ALERTS_PER_SYNC = 5

type PayloadLike = Pick<Payload, 'find' | 'create'>

export interface ClientEmailAlertInput {
  ownerId: number
  clientId: number
  clientName: string
  from: string
  subject: string
  gmailThreadId: string
  gmailMessageId: string
  /** Email date (ISO or RFC 2822). Unknown dates count as fresh. */
  date: string
  /** Extra Gmail account the email arrived in, so the alert opens Mail on it; omitted = main Gmail. */
  account?: string
  /** True when the email carries a calendar invite (text/calendar or .ics part). */
  calendarInvite?: boolean
}

/** Display name from a From header: `Jo Smith <jo@x.com>` -> `Jo Smith`. */
export function senderLabel(from: string): string {
  const trimmed = (from ?? '').trim()
  const named = trimmed.match(/^"?([^"<]+?)"?\s*<[^>]+>$/)
  if (named?.[1]) return named[1].trim()
  return trimmed.replace(/^<|>$/g, '')
}

/** Google mailboxes that are services, not people: their notices still alert. */
const GOOGLE_SERVICE_LOCAL_PART_RE =
  /^(?:google[a-z0-9.-]*|cloud[a-z0-9.-]*|workspace[a-z0-9.-]*|payments?[a-z0-9.-]*|billing[a-z0-9.-]*|ads[a-z0-9.-]*|analytics[a-z0-9.-]*|support[a-z0-9.-]*|accounts?[a-z0-9.-]*|security[a-z0-9.-]*|[a-z0-9.-]*no-?reply[a-z0-9.-]*)$/i

/** A person at google.com (a Google rep), as opposed to a Google service mailbox. */
export function isGoogleRepSender(from: string): boolean {
  const address = (from ?? '').match(/<([^>]+)>/)?.[1] ?? (from ?? '').trim()
  const [local = '', domain = ''] = address.toLowerCase().split('@')
  if (domain !== 'google.com' || !local) return false
  return !GOOGLE_SERVICE_LOCAL_PART_RE.test(local)
}

export function isFreshEmail(date: string, now: Date): boolean {
  if (!date) return true
  const time = new Date(date).getTime()
  if (Number.isNaN(time)) return true
  return now.getTime() - time <= ALERT_MAX_AGE_MS
}

export function alertUrl(input: Pick<ClientEmailAlertInput, 'gmailThreadId' | 'account'>): string {
  return mailThreadPath(input.gmailThreadId, input.account)
}

/** Alerts checked against Gmail per sync; the newest ones first. */
export const MAX_ALERTS_RECONCILED = 50

/**
 * Delete the owner's alerts for these threads, e.g. after they were marked
 * read in Mail. `account` is the extra Gmail account the threads are in ("" or
 * omitted = main Gmail). Returns the number of alerts removed.
 */
export async function removeClientEmailAlertsForThreads(
  payload: Pick<Payload, 'delete'>,
  ownerId: number,
  threadIds: readonly string[],
  account?: string | null,
): Promise<number> {
  const urls = [...new Set(threadIds.filter(Boolean).map((id) => mailThreadPath(id, account || null)))]
  if (urls.length === 0) return 0
  const res = await payload.delete({
    collection: 'notifications',
    where: {
      and: [
        { recipient: { equals: ownerId } },
        { kind: { equals: CLIENT_EMAIL_ALERT_KIND } },
        { url: { in: urls } },
      ],
    },
    overrideAccess: true,
  } as never)
  return (res as { docs?: unknown[] }).docs?.length ?? 0
}

/** Thread id from a main-Gmail alert URL (`/admin/mail?thread=…`), or null. */
export function alertThreadId(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url, 'https://mail.local')
    if (parsed.pathname !== '/admin/mail' || parsed.searchParams.has(MAIL_ACCOUNT_QUERY_PARAM)) return null
    return parsed.searchParams.get(MAIL_THREAD_QUERY_PARAM) || null
  } catch {
    return null
  }
}

/**
 * Delete the owner's alerts whose email has been read in Gmail (no message in
 * the thread still carries UNREAD) or deleted from Gmail. Only main-Gmail
 * alerts are checked, matching where alerts are raised. A Gmail error on one
 * thread leaves that alert alone. Returns the number of alerts removed.
 */
export async function removeAlertsForReadEmails(
  payload: Pick<Payload, 'find' | 'delete'>,
  ownerId: number,
  accessToken: string,
  deps: { getThreadHeaders: (accessToken: string, threadId: string) => Promise<ThreadReplyHeader[]> },
): Promise<number> {
  const res = await payload.find({
    collection: 'notifications',
    where: {
      and: [
        { recipient: { equals: ownerId } },
        { kind: { equals: CLIENT_EMAIL_ALERT_KIND } },
      ],
    },
    sort: '-createdAt',
    limit: MAX_ALERTS_RECONCILED,
    depth: 0,
    overrideAccess: true,
    select: { url: true },
  } as never)
  const threadIds = [
    ...new Set(
      ((res as { docs: Array<{ url?: string | null }> }).docs)
        .map((doc) => alertThreadId(doc.url))
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const read: string[] = []
  for (const threadId of threadIds) {
    try {
      const messages = await deps.getThreadHeaders(accessToken, threadId)
      if (!messages.some((message) => message.labelIds.includes('UNREAD'))) read.push(threadId)
    } catch {
      // Can't tell right now; check again on the next sync.
    }
  }
  return read.length > 0 ? removeClientEmailAlertsForThreads(payload, ownerId, read) : 0
}

/**
 * Create the alert row for one stored inbound client email.
 * Returns true when a row was created.
 */
export async function createClientEmailAlert(
  payload: PayloadLike,
  input: ClientEmailAlertInput,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isFreshEmail(input.date, now)) return false
  if (input.calendarInvite) return false
  if (isGoogleRepSender(input.from)) return false
  const url = alertUrl(input)

  const existing = await payload.find({
    collection: 'notifications',
    where: {
      and: [
        { recipient: { equals: input.ownerId } },
        { kind: { equals: CLIENT_EMAIL_ALERT_KIND } },
        { url: { equals: url } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  } as never)
  if ((existing as { docs: unknown[] }).docs.length > 0) return false

  const sender = senderLabel(input.from) || 'Unknown sender'
  const subject = (input.subject || '(no subject)').slice(0, 200)
  await payload.create({
    collection: 'notifications',
    overrideAccess: true,
    data: {
      recipient: input.ownerId,
      kind: CLIENT_EMAIL_ALERT_KIND,
      title: `Client email – please read: ${input.clientName || 'Client'}`.slice(0, 200),
      body: `${sender.slice(0, 120)} · ${subject}`,
      url,
      relatedClient: input.clientId,
    },
  } as never)
  return true
}
