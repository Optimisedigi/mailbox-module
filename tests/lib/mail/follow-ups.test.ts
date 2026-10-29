import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'
import { MAIL_FOLLOW_UPS_TABLE } from '../../helpers/mail-tables'
import {
  checkFollowUps,
  countDueFollowUps,
  createFollowUp,
  dismissFollowUp,
  followUpDb,
  isReplied,
  listFollowUps,
  parseFollowUpDays,
  parseRemindAt,
  snoozeFollowUp,
  type FollowUpCheckDeps,
} from '@/lib/mail/follow-ups'
import type { ThreadReplyHeader } from '@/lib/mail/gmail-mail'

// A real in-memory SQLite database with the migration's own SQL, so the
// conditional UPDATEs (one notification per due reminder) are exercised.
let client: Client
let payload: Payload
let create: ReturnType<typeof vi.fn>

const NOW = new Date('2026-10-21T02:00:00.000Z')
const SENT = new Date('2026-10-16T02:00:00.000Z')
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000)
const OWN = 'me@ourteam.example'

function header(overrides: Partial<ThreadReplyHeader> = {}): ThreadReplyHeader {
  return { messageId: 'm', from: 'Jo <jo@client.com>', internalDate: SENT.getTime() + 60_000, labelIds: ['INBOX'], ...overrides }
}

async function track(overrides: Partial<{ ownerId: number; sentMessageId: string; remindAt: Date; threadId: string }> = {}) {
  return createFollowUp(followUpDb(payload), {
    ownerId: overrides.ownerId ?? 1,
    clientId: 3,
    threadId: overrides.threadId ?? 't1',
    sentMessageId: overrides.sentMessageId ?? 's1',
    to: 'jo@client.com',
    subject: 'Proposal',
    sentAt: SENT,
    remindAt: overrides.remindAt ?? hours(-1),
  })
}

async function statusOf(id: number | null) {
  const res = await client.execute({ sql: 'select status, notified_at, last_checked_at from mail_follow_ups where id = ?', args: [id] })
  return res.rows[0] as unknown as { status: string; notified_at: string | null; last_checked_at: string | null }
}

function deps(thread: ThreadReplyHeader[] | (() => Promise<ThreadReplyHeader[]>), now = NOW): FollowUpCheckDeps {
  return {
    now: () => now,
    getToken: async () => ({ ok: true, accessToken: 'tok', email: OWN, userEmail: OWN }),
    getThreadHeaders: vi.fn(typeof thread === 'function' ? thread : async () => thread),
  }
}

beforeEach(async () => {
  client = createClient({ url: ':memory:' })
  await client.execute('create table users (id integer primary key)')
  await client.execute('insert into users (id) values (1), (2)')
  await client.execute('create table clients (id integer primary key, name text)')
  await client.execute("insert into clients (id, name) values (3, 'Acme Pty Ltd')")
  for (const statement of MAIL_FOLLOW_UPS_TABLE) await client.execute(statement)
  create = vi.fn(async () => ({ id: 1 }))
  payload = { db: { drizzle: drizzle(client) }, create } as unknown as Payload
})
afterEach(() => client.close())

describe('parseRemindAt', () => {
  it('accepts a time between an hour and 60 days ahead', () => {
    expect(parseRemindAt(hours(2).toISOString(), NOW)).toEqual({ ok: true, date: hours(2) })
    expect(parseRemindAt(hours(24 * 59).toISOString(), NOW).ok).toBe(true)
  })
  it('rejects missing, invalid, too-soon and too-far times', () => {
    expect(parseRemindAt('', NOW).ok).toBe(false)
    expect(parseRemindAt('soon', NOW).ok).toBe(false)
    expect(parseRemindAt(hours(0.5).toISOString(), NOW).ok).toBe(false)
    expect(parseRemindAt(hours(-3).toISOString(), NOW).ok).toBe(false)
    expect(parseRemindAt(hours(24 * 61).toISOString(), NOW).ok).toBe(false)
    expect(parseRemindAt(42, NOW).ok).toBe(false)
  })
  it('only takes the offered business-day choices for scheduled sends', () => {
    expect(parseFollowUpDays(3)).toBe(3)
    expect(parseFollowUpDays(4)).toBeNull()
    expect(parseFollowUpDays('3')).toBeNull()
  })
})

describe('isReplied', () => {
  it('counts a later message from someone else', () => {
    expect(isReplied([header()], SENT, [OWN])).toBe(true)
  })
  it('ignores the user’s own messages, earlier messages, drafts and automated replies', () => {
    expect(isReplied([header({ from: `Me <${OWN.toUpperCase()}>` })], SENT, [OWN])).toBe(false)
    expect(isReplied([header({ internalDate: SENT.getTime() - 60_000 })], SENT, [OWN])).toBe(false)
    expect(isReplied([header({ labelIds: ['DRAFT'] })], SENT, [OWN])).toBe(false)
    expect(isReplied([header({ autoSubmitted: 'auto-replied' })], SENT, [OWN])).toBe(false)
    expect(isReplied([header({ from: 'noreply@client.com' })], SENT, [OWN])).toBe(false)
    expect(isReplied([header({ listId: '<news.client.com>' })], SENT, [OWN])).toBe(false)
  })
})

describe('createFollowUp / list / count', () => {
  it('is idempotent on the sent message id', async () => {
    const first = await track()
    expect(first).toEqual(expect.any(Number))
    expect(await track()).toBeNull()
    const count = await client.execute('select count(*) as n from mail_follow_ups')
    expect(Number(count.rows[0]?.n)).toBe(1)
  })

  it('lists only the owner’s open reminders with the client name, soonest first', async () => {
    await track({ sentMessageId: 'later', remindAt: hours(48) })
    await track({ sentMessageId: 'sooner', remindAt: hours(2) })
    await track({ sentMessageId: 'other-user', ownerId: 2 })
    const closed = await track({ sentMessageId: 'closed' })
    await dismissFollowUp(followUpDb(payload), Number(closed), 1, NOW)
    const items = await listFollowUps(followUpDb(payload), 1)
    expect(items.map((item) => item.sentMessageId)).toEqual(['sooner', 'later'])
    expect(items[0]).toMatchObject({ clientId: 3, clientName: 'Acme Pty Ltd', status: 'waiting', threadId: 't1' })
  })

  it('counts reminders whose time has come', async () => {
    await track({ sentMessageId: 'past', remindAt: hours(-1) })
    await track({ sentMessageId: 'future', remindAt: hours(5) })
    expect(await countDueFollowUps(followUpDb(payload), 1, NOW)).toBe(1)
  })

  it('snooze and dismiss only touch the owner’s open reminders', async () => {
    const id = Number(await track())
    expect(await snoozeFollowUp(followUpDb(payload), id, 2, hours(48), NOW)).toBe(false)
    expect(await snoozeFollowUp(followUpDb(payload), id, 1, hours(48), NOW)).toBe(true)
    expect(await dismissFollowUp(followUpDb(payload), id, 1, NOW)).toBe(true)
    expect(await dismissFollowUp(followUpDb(payload), id, 1, NOW)).toBe(false)
    expect((await statusOf(id)).status).toBe('dismissed')
  })
})

describe('checkFollowUps', () => {
  it('resolves a replied thread without notifying', async () => {
    const id = await track()
    const result = await checkFollowUps(payload, deps([header({ from: OWN, internalDate: SENT.getTime() }), header()]))
    expect(result).toMatchObject({ checked: 1, replied: 1, due: 0 })
    expect((await statusOf(id)).status).toBe('replied')
    expect(create).not.toHaveBeenCalled()
  })

  it('moves a due reminder to due once, without a bell notification, and not again on the next run', async () => {
    const id = await track()
    const thread = [header({ from: OWN, internalDate: SENT.getTime() })]
    const first = await checkFollowUps(payload, deps(thread))
    expect(first).toMatchObject({ due: 1 })
    expect(create).not.toHaveBeenCalled()
    expect(await statusOf(id)).toMatchObject({ status: 'due', notified_at: NOW.toISOString() })

    const second = await checkFollowUps(payload, deps(thread, hours(1)))
    expect(second).toMatchObject({ due: 0 })
    expect(create).not.toHaveBeenCalled()
  })

  it('leaves reminders that are not due yet waiting', async () => {
    const id = await track({ remindAt: hours(5) })
    const result = await checkFollowUps(payload, deps([header({ from: OWN, internalDate: SENT.getTime() })]))
    expect(result).toMatchObject({ checked: 1, due: 0 })
    expect(await statusOf(id)).toMatchObject({ status: 'waiting', last_checked_at: NOW.toISOString() })
  })

  it('closes reminders whose thread is gone from Gmail', async () => {
    const id = await track()
    expect(await checkFollowUps(payload, deps([]))).toMatchObject({ gone: 1, due: 0 })
    expect((await statusOf(id)).status).toBe('dismissed')
  })

  it('checks a reminder with the Gmail account its email was sent from', async () => {
    const db = followUpDb(payload)
    const id = await createFollowUp(db, {
      ownerId: 1,
      account: 'sales@team.test',
      clientId: 3,
      threadId: 't9',
      sentMessageId: 's9',
      to: 'jo@client.com',
      subject: 'Quote',
      sentAt: SENT,
      remindAt: hours(-1),
    })
    expect(await listFollowUps(db, 1, '')).toEqual([])
    expect((await listFollowUps(db, 1, 'sales@team.test')).map((item) => item.id)).toEqual([id])
    expect(await countDueFollowUps(db, 1, NOW, 'sales@team.test')).toBe(1)
    expect(await countDueFollowUps(db, 1, NOW, '')).toBe(0)

    const getToken = vi.fn(async () => ({ ok: true as const, accessToken: 'sales-tok', email: 'sales@team.test', userEmail: OWN }))
    const getThreadHeaders = vi.fn(async () => [header({ from: 'Sales <sales@team.test>' })])
    expect(await checkFollowUps(payload, { now: () => NOW, getToken, getThreadHeaders })).toMatchObject({ due: 1 })
    expect(getToken).toHaveBeenCalledWith(1, 'sales@team.test')
    expect(getThreadHeaders).toHaveBeenCalledWith('sales-tok', 't9')
    expect(create).not.toHaveBeenCalled()
  })

  it('skips owners without Gmail and keeps going after a Gmail error', async () => {
    const noGmail = await track({ ownerId: 2, sentMessageId: 'a' })
    const failing = await track({ sentMessageId: 'b' })
    const result = await checkFollowUps(payload, {
      now: () => NOW,
      getToken: async (ownerId) => (ownerId === 2 ? { ok: false, reason: 'not-connected' } : { ok: true, accessToken: 'tok', email: OWN, userEmail: OWN }),
      getThreadHeaders: async () => {
        throw new Error('Gmail 500')
      },
    })
    expect(result).toMatchObject({ skipped: 1, errors: 1, due: 0 })
    expect((await statusOf(noGmail)).status).toBe('waiting')
    expect((await statusOf(failing)).status).toBe('waiting')
  })
})
