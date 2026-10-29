import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const getUnsubscribeHeaders = vi.fn(async (_token: string, ids: string[]) =>
  ids
    .filter((id) => id !== 'gone')
    .map((id) => ({
      messageId: id,
      listUnsubscribe: id === 'mailonly' ? '<mailto:u@list.com>' : `<https://list.com/u/${id}>`,
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
    })),
)
const postOneClickUnsubscribe = vi.fn(async (url: URL) => (url.pathname.endsWith('/bad') ? 'failed' : 'unsubscribed'))

vi.mock('@/lib/mail/gmail-mail', async (importOriginal) => ({
  mapLimited: (await importOriginal<typeof import('@/lib/mail/gmail-mail')>()).mapLimited,
  getUnsubscribeHeaders: (token: string, ids: string[]) => getUnsubscribeHeaders(token, ids),
}))
vi.mock('@/lib/mail/unsubscribe', async (importOriginal) => ({
  oneClickUnsubscribeUrl: (await importOriginal<typeof import('@/lib/mail/unsubscribe')>()).oneClickUnsubscribeUrl,
  postOneClickUnsubscribe: (url: URL) => postOneClickUnsubscribe(url),
}))
vi.mock('@/lib/mail/route-helpers', async (importOriginal) => ({
  parseGmailId: (await importOriginal<typeof import('@/lib/mail/route-helpers')>()).parseGmailId,
  readJson: async (req: NextRequest) => req.json(),
  requireMailUser: vi.fn(async () => ({ payload: {}, user: { id: 1 } })),
  requireGmailToken: vi.fn(async () => ({ accessToken: 'tok', email: 'me@team.test', userEmail: 'me@team.test' })),
  gmailErrorResponse: vi.fn(() => new Response(JSON.stringify({ error: 'gmail' }), { status: 502 })),
}))

const { POST } = await import('@/app/(frontend)/api/mail/triage/unsubscribe/route')

const post = (body: unknown) =>
  new NextRequest('https://mail.test/api/mail/triage/unsubscribe', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => vi.clearAllMocks())

describe('POST /api/mail/triage/unsubscribe', () => {
  it('reads the links from Gmail, never from the request, and reports each sender', async () => {
    const res = await POST(post({ messageIds: ['m1', 'bad', 'mailonly', 'gone'], url: 'https://evil.test/x' }))
    expect(res.status).toBe(200)
    expect(getUnsubscribeHeaders).toHaveBeenCalledWith('tok', ['m1', 'bad', 'mailonly', 'gone'])
    expect(postOneClickUnsubscribe.mock.calls.map(([url]) => url.toString())).toEqual(['https://list.com/u/m1', 'https://list.com/u/bad'])
    expect((await res.json()).results).toEqual([
      { messageId: 'm1', status: 'unsubscribed' },
      { messageId: 'bad', status: 'failed' },
      { messageId: 'mailonly', status: 'unavailable' },
      { messageId: 'gone', status: 'unavailable' },
    ])
  })

  it('refuses bad ids and more than 25 senders, touching nothing', async () => {
    for (const messageIds of [undefined, [], ['../x'], Array.from({ length: 26 }, (_, i) => `m${i}`)]) {
      expect((await POST(post({ messageIds }))).status).toBe(400)
    }
    expect(getUnsubscribeHeaders).not.toHaveBeenCalled()
  })
})
