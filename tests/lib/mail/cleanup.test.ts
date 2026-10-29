import { describe, expect, it, vi } from 'vitest'
import { deleteClientEmails, findCleanupCandidates, findExpiredEmailIds } from '@/lib/mail/cleanup'

type Row = Record<string, any> & { id: number }

function matches(row: Row, where: any): boolean {
  if (!where) return true
  if (where.and) return where.and.every((w: any) => matches(row, w))
  return Object.entries(where).every(([field, cond]: [string, any]) => {
    const value = row[field]
    if ('equals' in cond) return value === cond.equals
    if ('not_equals' in cond) return value !== cond.not_equals
    if ('in' in cond) return cond.in.includes(value)
    if ('less_than' in cond) return value < cond.less_than
    return true
  })
}

function fakePayload(emails: Row[], summaries: Row[] = []) {
  const tables: Record<string, Row[]> = { 'client-emails': emails, 'client-email-summaries': summaries }
  return {
    tables,
    find: vi.fn(async (args: any) => {
      const docs = tables[args.collection]!.filter((row) => matches(row, args.where))
      return { docs: args.limit ? docs.slice(0, args.limit) : docs }
    }),
    delete: vi.fn(async (args: any) => {
      const table = tables[args.collection]!
      const gone = table.filter((row) => matches(row, args.where))
      tables[args.collection] = table.filter((row) => !gone.includes(row))
      return { docs: gone }
    }),
  }
}

const email = (id: number, from: string, extra: Partial<Row> = {}): Row => ({
  id,
  gmailMessageId: `m${id}`,
  from,
  owner: 10,
  matchedBy: 'auto',
  date: '2026-10-14T00:00:00.000Z',
  ...extra,
})

describe('findCleanupCandidates', () => {
  it('finds hidden and automated emails in the user\'s own mailbox, keeping manual and summarised ones', async () => {
    const payload = fakePayload(
      [
        email(1, 'Jo <jo@bakehouse.com.au>'),
        email(2, 'deals@multiscreenstore.com'),
        email(3, 'no-reply@multiscreensite.com'),
        email(4, 'health@aws.com'),
        email(5, 'no-reply@multiscreensite.com', { matchedBy: 'manual' }),
        email(6, 'no-reply@multiscreensite.com'),
        email(7, 'no-reply@multiscreensite.com', { owner: 11 }),
      ],
      [{ id: 1, email: 6 }],
    )
    const getMessageHeaders = vi.fn(async (_t: string, [id]: string[]) => [
      { messageId: id!, threadId: '', from: '', to: '', cc: '', labelIds: [], autoSubmitted: id === 'm4' ? 'auto-generated' : '' },
    ])
    const found = await findCleanupCandidates({
      payload: payload as never,
      userId: 10,
      accessToken: 'tok',
      hiddenSenders: ['@multiscreenstore.com'],
      deps: { getMessageHeaders },
    })
    expect(found).toEqual({ hidden: [2], automated: [3, 4], more: false })
  })

  it('stops on a Gmail permission error rather than under-counting', async () => {
    const payload = fakePayload([email(1, 'jo@client.com')])
    await expect(
      findCleanupCandidates({
        payload: payload as never,
        userId: 10,
        accessToken: 'tok',
        hiddenSenders: [],
        deps: { getMessageHeaders: vi.fn(async () => { throw Object.assign(new Error('forbidden'), { code: 403 }) }) },
      }),
    ).rejects.toThrow('forbidden')
  })
})

describe('retention and deletion', () => {
  it('finds emails older than 12 months, except manual or summarised ones', async () => {
    const payload = fakePayload(
      [
        email(1, 'a@x.com', { date: '2025-09-01T00:00:00.000Z' }),
        email(2, 'a@x.com', { date: '2025-09-01T00:00:00.000Z', matchedBy: 'manual' }),
        email(3, 'a@x.com', { date: '2025-09-01T00:00:00.000Z' }),
        email(4, 'a@x.com', { date: '2026-01-01T00:00:00.000Z' }),
      ],
      [{ id: 1, email: 3 }],
    )
    expect(await findExpiredEmailIds(payload as never, new Date('2026-10-15T00:00:00.000Z'))).toEqual({ ids: [1], more: false })
  })

  it('only deletes rows owned by the user and never manual ones', async () => {
    const payload = fakePayload([email(1, 'a@x.com'), email(2, 'a@x.com', { owner: 11 }), email(3, 'a@x.com', { matchedBy: 'manual' })])
    expect(await deleteClientEmails(payload as never, [1, 2, 3], 10)).toBe(1)
    expect(payload.tables['client-emails'].map((row) => row.id)).toEqual([2, 3])
  })
})
