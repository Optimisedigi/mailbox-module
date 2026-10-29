import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const checkFollowUps = vi.fn(async () => ({ checked: 0, replied: 0, gone: 0, due: 0, notified: 0, skipped: 0, errors: 0 }))
const createFollowUp = vi.fn(async () => 1)
const dismissFollowUp = vi.fn(async () => true)
const snoozeFollowUp = vi.fn(async () => true)
const deliverMail = vi.fn(async () => ({ ok: true as const, messageId: 'gm1', threadId: 'gt1', client: { id: 3, name: 'Acme' } }))

vi.mock('payload', () => ({ getPayload: vi.fn(async () => ({})) }))
vi.mock('@/payload.config', () => ({ default: Promise.resolve({}) }))
vi.mock('@/lib/user-gmail-tokens', () => ({
  getValidGmailToken: vi.fn(async () => ({ ok: true, accessToken: 'tok', email: 'me@team.test', userEmail: 'me@team.test' })),
}))
vi.mock('@/lib/mail/follow-ups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail/follow-ups')>()),
  checkFollowUps,
  createFollowUp,
  dismissFollowUp,
  snoozeFollowUp,
  followUpDb: vi.fn(() => ({})),
}))
vi.mock('@/lib/mail/deliver', () => ({ deliverMail }))
vi.mock('@/lib/mail/route-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail/route-helpers')>()),
  requireMailUser: vi.fn(async () => ({ payload: {}, user: { id: 5 } })),
  requireGmailToken: vi.fn(async () => ({ accessToken: 'tok', email: 'me@team.test', userEmail: 'me@team.test' })),
}))

const cron = await import('@/app/(frontend)/api/mail/follow-ups/cron/route')
const send = await import('@/app/(frontend)/api/mail/send/route')
const item = await import('@/app/(frontend)/api/mail/follow-ups/[id]/route')

const json = (url: string, method: string, body: unknown) =>
  new NextRequest(`https://mail.test${url}`, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()
const email = { to: 'jo@acme.com', subject: 'Proposal', html: '<p>Hello</p>' }
const params = (id: string) => ({ params: Promise.resolve({ id }) })

afterEach(() => {
  delete process.env.CRON_SECRET
  vi.clearAllMocks()
})

describe('GET /api/mail/follow-ups/cron', () => {
  it('rejects a missing or wrong secret and does no work', async () => {
    process.env.CRON_SECRET = 'secret'
    const req = (auth?: string) => new NextRequest('https://mail.test/api/mail/follow-ups/cron', { headers: auth ? { authorization: auth } : {} })
    expect((await cron.GET(req())).status).toBe(401)
    expect((await cron.GET(req('Bearer wrong!'))).status).toBe(401)
    expect(checkFollowUps).not.toHaveBeenCalled()
    expect((await cron.GET(req('Bearer secret'))).status).toBe(200)
    expect(checkFollowUps).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/mail/send with followUpAt', () => {
  it('tracks the sent email with the delivered ids and client', async () => {
    const remindAt = inHours(72)
    const res = await send.POST(json('/api/mail/send', 'POST', { ...email, followUpAt: remindAt }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ messageId: 'gm1', followUpNote: null })
    expect(createFollowUp).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ ownerId: 5, clientId: 3, threadId: 'gt1', sentMessageId: 'gm1', to: 'jo@acme.com', subject: 'Proposal', remindAt: new Date(remindAt) }),
    )
  })

  it('still sends (200) when tracking fails, with a note', async () => {
    createFollowUp.mockRejectedValueOnce(new Error('db down'))
    const res = await send.POST(json('/api/mail/send', 'POST', { ...email, followUpAt: inHours(72) }))
    expect(res.status).toBe(200)
    expect((await res.json()).followUpNote).toMatch(/reminder could not be set/)
    expect(deliverMail).toHaveBeenCalledTimes(1)
  })

  it('does not track without followUpAt, and rejects a bad time before sending', async () => {
    expect((await send.POST(json('/api/mail/send', 'POST', email))).status).toBe(200)
    expect(createFollowUp).not.toHaveBeenCalled()
    expect((await send.POST(json('/api/mail/send', 'POST', { ...email, followUpAt: inHours(-1) }))).status).toBe(400)
    expect(deliverMail).toHaveBeenCalledTimes(1)
  })
})

describe('PATCH /api/mail/follow-ups/:id', () => {
  it('dismisses and snoozes the user’s own reminders', async () => {
    expect((await item.PATCH(json('/api/mail/follow-ups/9', 'PATCH', { action: 'dismiss' }), params('9'))).status).toBe(200)
    expect(dismissFollowUp).toHaveBeenCalledWith({}, 9, 5, expect.any(Date))
    const when = inHours(48)
    expect((await item.PATCH(json('/api/mail/follow-ups/9', 'PATCH', { action: 'snooze', remindAt: when }), params('9'))).status).toBe(200)
    expect(snoozeFollowUp).toHaveBeenCalledWith({}, 9, 5, new Date(when), expect.any(Date))
  })

  it('rejects bad input and closed reminders', async () => {
    expect((await item.PATCH(json('/api/mail/follow-ups/x', 'PATCH', { action: 'dismiss' }), params('x'))).status).toBe(400)
    expect((await item.PATCH(json('/api/mail/follow-ups/9', 'PATCH', { action: 'snooze', remindAt: inHours(-1) }), params('9'))).status).toBe(400)
    expect((await item.PATCH(json('/api/mail/follow-ups/9', 'PATCH', { action: 'nope' }), params('9'))).status).toBe(400)
    dismissFollowUp.mockResolvedValueOnce(false)
    expect((await item.PATCH(json('/api/mail/follow-ups/9', 'PATCH', { action: 'dismiss' }), params('9'))).status).toBe(404)
  })
})
