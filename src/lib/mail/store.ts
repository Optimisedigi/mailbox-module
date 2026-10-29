import type { Payload } from 'payload'
import {
  buildClientDomainIndex,
  extractEmailAddresses,
  matchAddress,
  matchMessageToClient,
  messageDirection,
  type ClientDomainIndex,
  type MatchableClient,
} from './client-matching'
import {
  GmailHistoryExpiredError,
  getFullMessage,
  getMailboxProfile,
  getMessageHeaders,
  gmailMessageLink,
  isSyncableLabelSet,
  listAddedMessageIdsSince,
  listRecentMessageIds,
  mapLimited,
} from './gmail-mail'
import type { GmailFullMessage } from '@/lib/gmail-search'
import { isHiddenSender, loadHiddenSenders } from './hidden-senders'
import { loadSenderClients } from './sender-clients'
import { cachedMatchableClients } from './client-index-cache'
import type { SenderClientOverride } from './client-matching'
import { isAutomatedMessage } from './automated-senders'
import {
  MAX_ALERTS_PER_SYNC,
  createClientEmailAlert,
  type ClientEmailAlertInput,
} from './client-email-alerts'

/**
 * Deterministic storage + sync for client emails. No model calls here, ever:
 * matching and storing are plain code (see client-matching.ts).
 */

export const INITIAL_SYNC_DAYS = 14
export const INITIAL_SYNC_MAX = 200
export const MAX_BODY_STORED = 100_000
/** Header-like fields stay well under Payload's 40,000-char text default. */
export const MAX_HEADER_STORED = 4_000

const cap = (value: string | null | undefined, max: number) => (value ?? '').slice(0, max)

type PayloadLike = Pick<Payload, 'find' | 'create' | 'update'>

export interface ClientEmailInput {
  gmailMessageId: string
  gmailThreadId: string
  clientId: number
  ownerId: number
  direction: 'inbound' | 'outbound'
  matchedBy: 'auto' | 'manual'
  matchedOn: string
  from: string
  to: string
  cc: string
  subject: string
  date: string
  body: string
  gmailLink: string
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /unique|already exists|duplicate/i.test(message)
}

/** Ids from `ids` that already have a client-emails row. */
export async function findStoredMessageIds(
  payload: PayloadLike,
  ids: string[],
): Promise<Set<string>> {
  const stored = new Set<string>()
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const res = await payload.find({
      collection: 'client-emails',
      where: { gmailMessageId: { in: chunk } },
      limit: chunk.length,
      depth: 0,
      pagination: false,
      overrideAccess: true,
      select: { gmailMessageId: true },
    } as never)
    for (const doc of (res as { docs: Array<{ gmailMessageId?: string }> }).docs) {
      if (doc.gmailMessageId) stored.add(doc.gmailMessageId)
    }
  }
  return stored
}

/**
 * Save one email against a client. Deduped by Gmail message id: an existing
 * row is returned untouched, and a concurrent insert that trips the unique
 * index is treated as "already stored".
 */
export async function storeClientEmail(
  payload: PayloadLike,
  input: ClientEmailInput,
): Promise<{ created: boolean; id: number | null }> {
  const existing = await payload.find({
    collection: 'client-emails',
    where: { gmailMessageId: { equals: input.gmailMessageId } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  } as never)
  const found = (existing as { docs: Array<{ id: number }> }).docs[0]
  if (found) return { created: false, id: found.id }

  try {
    const doc = await payload.create({
      collection: 'client-emails',
      overrideAccess: true,
      data: {
        gmailMessageId: input.gmailMessageId,
        gmailThreadId: input.gmailThreadId,
        client: input.clientId,
        owner: input.ownerId,
        direction: input.direction,
        matchedBy: input.matchedBy,
        matchedOn: cap(input.matchedOn, 500),
        from: cap(input.from, MAX_HEADER_STORED),
        to: cap(input.to, MAX_HEADER_STORED),
        cc: cap(input.cc, MAX_HEADER_STORED),
        subject: cap(input.subject, 1_000),
        date: input.date || null,
        body: cap(input.body, MAX_BODY_STORED),
        gmailLink: cap(input.gmailLink, 1_000),
      },
    } as never)
    return { created: true, id: (doc as { id: number }).id }
  } catch (err) {
    if (isUniqueViolation(err)) return { created: false, id: null }
    throw err
  }
}

/**
 * Client matching index. With `userId`, that user's own sender → client
 * choices (sender-clients.ts) are applied on top of automatic matching.
 */
export async function loadClientDomainIndex(
  payload: Pick<Payload, 'find'>,
  ownAddresses: string[],
  /** `overrides`: the user's sender → client choices, when the caller already loaded them. */
  options: { userId?: number; overrides?: SenderClientOverride[] } = {},
): Promise<ClientDomainIndex> {
  const [overrides, clients] = await Promise.all([
    options.overrides ?? (options.userId === undefined ? [] : loadSenderClients(payload, options.userId)),
    // Read on nearly every Mail request, so shared for a minute (client-index-cache.ts).
    cachedMatchableClients(async () => {
      const res = await payload.find({
        collection: 'clients',
        limit: 0,
        pagination: false,
        depth: 0,
        overrideAccess: true,
        select: {
          name: true,
          websiteUrl: true,
          contactEmail: true,
          additionalContacts: true,
          isActive: true,
        },
      } as never)
      return (res as { docs: MatchableClient[] }).docs
    }),
  ])
  return buildClientDomainIndex(clients, { ownAddresses, overrides })
}

export function toClientEmailInput(args: {
  message: GmailFullMessage
  clientId: number
  ownerId: number
  matchedBy: 'auto' | 'manual'
  matchedOn: string
  ownAddresses: string[]
  gmailAccount: string
}): ClientEmailInput {
  const { message } = args
  return {
    gmailMessageId: message.messageId,
    gmailThreadId: message.threadId,
    clientId: args.clientId,
    ownerId: args.ownerId,
    direction: messageDirection(message.from, args.ownAddresses),
    matchedBy: args.matchedBy,
    matchedOn: args.matchedOn,
    from: message.from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    date: message.date,
    body: message.body,
    gmailLink: gmailMessageLink(message.messageId, args.gmailAccount),
  }
}

export interface SyncDeps {
  getMailboxProfile: typeof getMailboxProfile
  listAddedMessageIdsSince: typeof listAddedMessageIdsSince
  listRecentMessageIds: typeof listRecentMessageIds
  getMessageHeaders: typeof getMessageHeaders
  getFullMessage: typeof getFullMessage
}

const defaultDeps: SyncDeps = {
  getMailboxProfile,
  listAddedMessageIdsSince,
  listRecentMessageIds,
  getMessageHeaders,
  getFullMessage,
}

export interface SyncResult {
  mode: 'incremental' | 'initial' | 'history-expired'
  checked: number
  stored: number
  alreadyStored: number
  unmatched: number
  /** Client-matched emails not stored: from a hidden sender or automated. */
  skipped: number
  /** Matched emails that could not be saved; the rest of the sync still completes. */
  failed: number
  /** "Client email – please read" alerts raised for the mailbox owner (see client-email-alerts.ts). */
  alerts: number
  /** True when Gmail had more new mail than one sync takes; the next sync continues. */
  more: boolean
}

/**
 * Pull new mail since the last sync and store client-matched messages.
 * Uses Gmail history (incremental) when a cursor exists; otherwise the last
 * INITIAL_SYNC_DAYS days. The cursor only moves forward after a clean run.
 *
 * Client-matched emails from the user's hidden senders, and automated ones
 * (see automated-senders.ts), are not stored.
 */
/**
 * Where a mailbox's sync cursor lives: mail-sync-states for the user's main
 * Gmail, or the mail-accounts row for one of their extra Gmail accounts.
 */
export interface SyncStateStore {
  load(): Promise<{ historyId: string | null } | null>
  save(data: { gmailAddress: string; historyId: string; lastSyncAt: string }): Promise<void>
  fail(message: string): Promise<void>
}

/** The main Gmail's cursor (one mail-sync-states row per user). */
export function mainSyncStateStore(payload: PayloadLike, userId: number): SyncStateStore {
  let stateId: number | null = null
  return {
    async load() {
      const stateRes = await payload.find({
        collection: 'mail-sync-states',
        where: { user: { equals: userId } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
      } as never)
      const state = (stateRes as { docs: Array<{ id: number; historyId?: string | null }> }).docs[0]
      stateId = state?.id ?? null
      return state ? { historyId: state.historyId ?? null } : null
    },
    async save(data) {
      const stateData = { user: userId, ...data, lastError: null }
      if (stateId !== null) {
        await payload.update({ collection: 'mail-sync-states', id: stateId, overrideAccess: true, data: stateData } as never)
      } else {
        await payload.create({ collection: 'mail-sync-states', overrideAccess: true, data: stateData } as never)
      }
    },
    async fail(message) {
      if (stateId === null) return
      await payload.update({ collection: 'mail-sync-states', id: stateId, overrideAccess: true, data: { lastError: message } } as never)
    },
  }
}

/** An extra Gmail account's cursor, kept on its mail-accounts row. */
export function extraAccountSyncStateStore(payload: PayloadLike, row: { id: number; historyId: string | null }): SyncStateStore {
  return {
    async load() {
      return { historyId: row.historyId }
    },
    async save(data) {
      await payload.update({
        collection: 'mail-accounts',
        id: row.id,
        overrideAccess: true,
        data: { historyId: data.historyId, lastSyncAt: data.lastSyncAt, lastError: null },
      } as never)
    },
    async fail(message) {
      await payload.update({ collection: 'mail-accounts', id: row.id, overrideAccess: true, data: { lastError: message } } as never)
    },
  }
}

export async function syncMailbox(args: {
  payload: PayloadLike
  userId: number
  accessToken: string
  userEmail?: string
  /** The user's hidden senders; loaded from their preferences when omitted. */
  hiddenSenders?: string[]
  /** Cursor storage; the main Gmail's mail-sync-states row when omitted. */
  stateStore?: SyncStateStore
  /** Extra Gmail account being synced (its alerts open Mail on that account); "" = main Gmail. */
  account?: string
  deps?: Partial<SyncDeps>
}): Promise<SyncResult> {
  const deps = { ...defaultDeps, ...args.deps }
  const { payload, userId, accessToken } = args
  const store = args.stateStore ?? mainSyncStateStore(payload, userId)
  const state = await store.load()

  try {
    // Read the cursor before listing, so nothing that arrives mid-sync is skipped next time.
    const profile = await deps.getMailboxProfile(accessToken)
    const ownAddresses = [profile.emailAddress, args.userEmail ?? ''].filter(Boolean)

    let mode: SyncResult['mode'] = 'initial'
    let ids: string[]
    let resumeHistoryId: string | null = null
    if (state?.historyId) {
      try {
        const added = await deps.listAddedMessageIdsSince(accessToken, state.historyId)
        ids = added.ids
        resumeHistoryId = added.resumeHistoryId
        mode = 'incremental'
      } catch (err) {
        if (!(err instanceof GmailHistoryExpiredError)) throw err
        ids = await deps.listRecentMessageIds(accessToken, INITIAL_SYNC_DAYS, INITIAL_SYNC_MAX)
        mode = 'history-expired'
      }
    } else {
      ids = await deps.listRecentMessageIds(accessToken, INITIAL_SYNC_DAYS, INITIAL_SYNC_MAX)
    }

    const uniqueIds = [...new Set(ids)]
    const already = await findStoredMessageIds(payload, uniqueIds)
    const fresh = uniqueIds.filter((id) => !already.has(id))

    let stored = 0
    let unmatched = 0
    let skipped = 0
    let failed = 0
    let alerts = 0
    const alertCandidates: ClientEmailAlertInput[] = []
    if (fresh.length > 0) {
      const index = await loadClientDomainIndex(payload, ownAddresses, { userId })
      const hiddenSenders = args.hiddenSenders ?? (await loadHiddenSenders(payload, userId))
      const headers = await deps.getMessageHeaders(accessToken, fresh)
      const all = headers
        .filter((header) => isSyncableLabelSet(header.labelIds))
        .map((header) => ({ header, match: matchMessageToClient(index, header) }))
      unmatched = all.filter((entry) => !entry.match).length
      const matched = all.filter(
        ({ header, match }) => match && !isHiddenSender(header.from, hiddenSenders) && !isAutomatedMessage(header),
      )
      skipped = all.filter((entry) => entry.match).length - matched.length

      // One email that cannot be fetched or saved must not block every other
      // client email, so each is isolated. Only the error text is logged
      // (never the email content).
      const results = await mapLimited(
        matched,
        4,
        async ({ header, match }) => {
          try {
            const message = await deps.getFullMessage(accessToken, header.messageId)
            const emailInput = toClientEmailInput({
              message,
              clientId: match!.clientId,
              ownerId: userId,
              matchedBy: 'auto',
              matchedOn: match!.matchedOn,
              ownAddresses,
              gmailAccount: profile.emailAddress,
            })
            const result = await storeClientEmail(payload, emailInput)
            // Only a brand-new inbound email from an incremental sync of the MAIN
            // Gmail can alert, and only when the sender is the client (not mail
            // from someone else that merely copies a client in).
            const senderClient = args.account ? null : matchAddress(index, extractEmailAddresses(emailInput.from)[0] ?? '')
            if (result.created && emailInput.direction === 'inbound' && mode === 'incremental' && senderClient) {
              alertCandidates.push({
                ownerId: userId,
                clientId: senderClient.clientId,
                clientName: senderClient.clientName,
                from: emailInput.from,
                subject: emailInput.subject,
                gmailThreadId: emailInput.gmailThreadId,
                gmailMessageId: emailInput.gmailMessageId,
                date: emailInput.date,
                ...(args.account ? { account: args.account } : {}),
                ...(message.hasCalendarInvite ? { calendarInvite: true } : {}),
              })
            }
            return result
          } catch (err) {
            const status = Number(
              (err as { code?: number; status?: number }).code ??
                (err as { status?: number }).status ??
                0,
            )
            // Auth/permission failures affect every message: stop and surface them.
            if (status === 401 || status === 403) throw err
            console.error(
              `[mail] could not save message ${header.messageId}:`,
              (err instanceof Error ? err.message : String(err)).slice(0, 200),
            )
            return { created: false, id: null, failed: true as const }
          }
        },
      )
      stored = results.filter((result) => result.created).length
      failed = results.filter((result) => 'failed' in result).length

      // Newest first, capped, so a burst of client mail raises a few alerts, not dozens.
      const now = new Date()
      const ordered = [...alertCandidates].sort(
        (a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0),
      )
      for (const candidate of ordered) {
        if (alerts >= MAX_ALERTS_PER_SYNC) break
        try {
          if (await createClientEmailAlert(payload, candidate, now)) alerts++
        } catch (err) {
          // An alert failing must never fail the sync or move the cursor back.
          console.error(
            `[mail] could not create client email alert for ${candidate.gmailMessageId}:`,
            (err instanceof Error ? err.message : String(err)).slice(0, 200),
          )
        }
      }
    }

    await store.save({
      gmailAddress: profile.emailAddress,
      historyId: resumeHistoryId ?? profile.historyId,
      lastSyncAt: new Date().toISOString(),
    })

    return {
      mode,
      checked: uniqueIds.length,
      stored,
      alreadyStored: already.size,
      unmatched,
      skipped,
      failed,
      alerts,
      more: resumeHistoryId !== null,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : 'Sync failed'
    await store.fail(message).catch(() => undefined)
    throw err
  }
}
