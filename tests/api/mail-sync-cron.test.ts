import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockPayload = {
  find: vi.fn(async () => ({ docs: [{ user: 7 }] })),
  findByID: vi.fn(async () => ({ id: 7, role: 'admin' })),
}
const syncMailbox = vi.fn(async () => ({ stored: 2, skipped: 1, more: false }))
const findExpiredEmailIds = vi.fn(async () => ({ ids: [5, 6], more: false }))
const deleteClientEmails = vi.fn(async () => 2)

vi.mock('payload', () => ({ getPayload: vi.fn(async () => mockPayload) }))
vi.mock('@/payload.config', () => ({ default: Promise.resolve({}) }))
vi.mock('@/lib/user-gmail-tokens', () => ({
  getValidGmailToken: vi.fn(async () => ({ ok: true, accessToken: 'tok', email: 'p@x.com', userEmail: 'p@x.com' })),
}))
vi.mock('@/lib/access', () => ({ userHasFeature: vi.fn(() => true) }))
vi.mock('@/lib/mail/store', () => ({ syncMailbox }))
vi.mock('@/lib/mail/cleanup', () => ({ findExpiredEmailIds, deleteClientEmails }))
vi.mock('@/lib/mail/route-helpers', () => ({ MAIL_FEATURE: 'nav:mail' }))

const { GET } = await import('@/app/(frontend)/api/mail/sync/cron/route')

const request = (auth?: string) =>
  new NextRequest('https://mail.test/api/mail/sync/cron', { headers: auth ? { authorization: auth } : {} })

afterEach(() => {
  delete process.env.CRON_SECRET
  vi.clearAllMocks()
})

describe('GET /api/mail/sync/cron', () => {
  it('rejects requests without the cron secret and does no work', async () => {
    process.env.CRON_SECRET = 'secret'
    expect((await GET(request())).status).toBe(401)
    expect((await GET(request('Bearer wrong!'))).status).toBe(401)
    expect(syncMailbox).not.toHaveBeenCalled()
    expect(deleteClientEmails).not.toHaveBeenCalled()
  })

  it('fails closed when CRON_SECRET is not configured', async () => {
    expect((await GET(request('Bearer anything'))).status).toBe(500)
    expect(syncMailbox).not.toHaveBeenCalled()
  })

  it('syncs mailboxes and deletes expired emails across all owners', async () => {
    process.env.CRON_SECRET = 'secret'
    const res = await GET(request('Bearer secret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      mailboxes: [{ userId: 7, status: 'synced', stored: 2, skipped: 1 }],
      expiredDeleted: 2,
    })
    expect(deleteClientEmails).toHaveBeenCalledWith(mockPayload, [5, 6])
  })
})
