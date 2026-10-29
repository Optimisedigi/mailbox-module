import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const batchModifyMessages = vi.fn(async (_token: string, _ids: string[], _change: unknown) => undefined)

vi.mock('@/lib/mail/gmail-mail', () => ({
  batchModifyMessages: (token: string, ids: string[], change: unknown) => batchModifyMessages(token, ids, change),
}))
vi.mock('@/lib/mail/route-helpers', async (importOriginal) => ({
  parseGmailId: (await importOriginal<typeof import('@/lib/mail/route-helpers')>()).parseGmailId,
  readJson: async (req: NextRequest) => req.json(),
  requireMailUser: vi.fn(async () => ({ payload: {}, user: { id: 1 } })),
  requireGmailToken: vi.fn(async () => ({ accessToken: 'tok', email: 'me@team.test', userEmail: 'me@team.test' })),
  gmailErrorResponse: vi.fn(() => new Response(JSON.stringify({ error: 'gmail' }), { status: 502 })),
}))

const { POST } = await import('@/app/(frontend)/api/mail/triage/apply/route')

const post = (body: unknown) =>
  new NextRequest('https://mail.test/api/mail/triage/apply', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => vi.clearAllMocks())

describe('POST /api/mail/triage/apply', () => {
  it('archives by removing INBOX', async () => {
    expect((await POST(post({ messageIds: ['m1', 'm2'], action: 'archive' }))).status).toBe(200)
    expect(batchModifyMessages).toHaveBeenCalledWith('tok', ['m1', 'm2'], { remove: ['INBOX'] })
  })

  it('deletes by moving to the Bin (TRASH label), never deleting for good', async () => {
    expect((await POST(post({ messageIds: ['m1', 'm2'], action: 'trash' }))).status).toBe(200)
    expect(batchModifyMessages).toHaveBeenCalledWith('tok', ['m1', 'm2'], { add: ['TRASH'], remove: ['INBOX'] })
    expect((await POST(post({ messageIds: ['m1'], action: 'delete' }))).status).toBe(400)
  })

  it('tags by adding the user label, removing nothing', async () => {
    expect((await POST(post({ messageIds: ['m1', 'm1', 'm3'], action: 'tag', tagId: 'Label_42' }))).status).toBe(200)
    expect(batchModifyMessages).toHaveBeenCalledWith('tok', ['m1', 'm3'], { add: ['Label_42'] })
  })

  it('refuses a missing tag or a system label as a tag, touching nothing', async () => {
    for (const tagId of [undefined, 'TRASH', 'SPAM', 'INBOX', 'Label_x']) {
      expect((await POST(post({ messageIds: ['m1'], action: 'tag', tagId }))).status).toBe(400)
    }
    expect(batchModifyMessages).not.toHaveBeenCalled()
  })
})
