import type { Payload } from 'payload'
import { isHiddenSender } from './hidden-senders'
import { isAutomatedMessage, isAutomatedLocalPart } from './automated-senders'
import { getMessageHeaders, mapLimited } from './gmail-mail'

/**
 * Removal of stored client emails the user does not want kept. Gmail is never
 * touched: only rows in the CMS `client-emails` collection are deleted.
 *
 * Always kept, whatever the category:
 *  - emails assigned to a client by hand (matchedBy "manual"), and
 *  - emails that have a timeline summary (client-email-summaries).
 *
 * Categories:
 *  - hidden:    from one of the user's hidden senders (their own mailbox only)
 *  - automated: no-reply / notification / bulk mail (their own mailbox only)
 *  - expired:   email date older than RETENTION_DAYS (all mailboxes; daily cron)
 */

export const RETENTION_DAYS = 365
/** Rows checked per cleanup run; the rest are picked up by the next run. */
export const CLEANUP_SCAN_LIMIT = 1000

type PayloadLike = Pick<Payload, 'find' | 'delete'>

interface StoredRow {
  id: number
  gmailMessageId: string
  from?: string | null
  matchedBy?: string | null
}

export interface CleanupCandidates {
  hidden: number[]
  automated: number[]
  /** Rows not checked because the scan limit was reached. */
  more: boolean
}

export interface CleanupDeps {
  getMessageHeaders: typeof getMessageHeaders
}

const defaultDeps: CleanupDeps = { getMessageHeaders }

/** Ids (of `ids`) that have a timeline summary; those emails stay with their client. */
export async function summarisedIds(payload: Pick<Payload, 'find'>, ids: number[]): Promise<Set<number>> {
  const out = new Set<number>()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const res = await payload.find({
      collection: 'client-email-summaries',
      where: { email: { in: chunk } },
      limit: 0,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { email: true },
    } as never)
    for (const doc of (res as unknown as { docs: Array<{ email?: number | { id: number } | null }> }).docs) {
      const email = doc.email
      const id = typeof email === 'object' && email ? email.id : email
      if (typeof id === 'number') out.add(id)
    }
  }
  return out
}

/** Auto-matched, unsummarised rows; `ownerId` limits them to one mailbox. */
async function deletableRows(
  payload: PayloadLike,
  where: Record<string, unknown>,
  limit: number,
): Promise<{ rows: StoredRow[]; more: boolean }> {
  const res = await payload.find({
    collection: 'client-emails',
    where: { and: [where, { matchedBy: { not_equals: 'manual' } }] },
    limit: limit + 1,
    sort: 'date',
    depth: 0,
    overrideAccess: true,
    select: { gmailMessageId: true, from: true, matchedBy: true },
  } as never)
  const docs = (res as unknown as { docs: StoredRow[] }).docs
  const rows = docs.slice(0, limit)
  const summarised = await summarisedIds(payload, rows.map((row) => row.id))
  return { rows: rows.filter((row) => !summarised.has(row.id)), more: docs.length > limit }
}

/**
 * Hidden-sender and automated emails stored from one user's mailbox.
 * Automated checks read the email's bulk headers from Gmail; if Gmail no
 * longer has the email, only the sender name is checked.
 */
export async function findCleanupCandidates(args: {
  payload: PayloadLike
  userId: number
  accessToken: string
  hiddenSenders: string[]
  deps?: Partial<CleanupDeps>
}): Promise<CleanupCandidates> {
  const deps = { ...defaultDeps, ...args.deps }
  const { rows, more } = await deletableRows(args.payload, { owner: { equals: args.userId } }, CLEANUP_SCAN_LIMIT)

  const hidden = rows.filter((row) => isHiddenSender(row.from, args.hiddenSenders))
  const rest = rows.filter((row) => !isHiddenSender(row.from, args.hiddenSenders))
  const automated = await mapLimited(rest, 8, async (row) => {
    if (isAutomatedLocalPart(row.from ?? '')) return row
    try {
      const [headers] = await deps.getMessageHeaders(args.accessToken, [row.gmailMessageId])
      return headers && isAutomatedMessage(headers) ? row : null
    } catch (err) {
      const status = Number((err as { code?: number; status?: number }).code ?? (err as { status?: number }).status ?? 0)
      // Auth problems affect every email: stop rather than report a partial count.
      if (status === 401 || status === 403) throw err
      return null
    }
  })
  return {
    hidden: hidden.map((row) => row.id),
    automated: automated.filter((row): row is StoredRow => row !== null).map((row) => row.id),
    more,
  }
}

/** Stored emails past the retention window, across all mailboxes. */
export async function findExpiredEmailIds(
  payload: PayloadLike,
  now: Date,
): Promise<{ ids: number[]; more: boolean }> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { rows, more } = await deletableRows(payload, { date: { less_than: cutoff } }, CLEANUP_SCAN_LIMIT)
  return { ids: rows.map((row) => row.id), more }
}

/**
 * Delete the given rows. `ownerId` is re-checked in the delete query itself,
 * so a user can only ever delete rows from their own mailbox; manual rows
 * are excluded again here as well.
 */
export async function deleteClientEmails(
  payload: PayloadLike,
  ids: number[],
  ownerId?: number,
): Promise<number> {
  let deleted = 0
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const res = await payload.delete({
      collection: 'client-emails',
      where: {
        and: [
          { id: { in: chunk } },
          { matchedBy: { not_equals: 'manual' } },
          ...(ownerId === undefined ? [] : [{ owner: { equals: ownerId } }]),
        ],
      },
      overrideAccess: true,
    } as never)
    deleted += ((res as unknown as { docs?: unknown[] }).docs ?? []).length
  }
  return deleted
}
