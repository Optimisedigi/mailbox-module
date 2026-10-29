import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const getRawMessage = vi.fn(async (): Promise<Buffer | null> => Buffer.from('From: a@b.com\r\nSubject: Hi\r\n\r\nBody'))

vi.mock('@/lib/mail/gmail-mail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail/gmail-mail')>()),
  getRawMessage,
}))
vi.mock('@/lib/mail/route-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mail/route-helpers')>()),
  requireMailUser: vi.fn(async () => ({ payload: {}, user: { id: 5 } })),
  requireGmailToken: vi.fn(async () => ({ accessToken: 'tok', email: 'me@team.test', userEmail: 'me@team.test', account: '' })),
}))

const route = await import('@/app/(frontend)/api/mail/message/[messageId]/eml/route')
const get = (id: string) => route.GET(new NextRequest(`https://mail.test/api/mail/message/${id}/eml`), { params: Promise.resolve({ messageId: id }) })

afterEach(() => vi.clearAllMocks())

describe('GET /api/mail/message/:id/eml', () => {
  it('returns the raw Gmail message as an .eml download', async () => {
    const res = await get('1a1609dbf79a742f')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('message/rfc822')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(await res.text()).toBe('From: a@b.com\r\nSubject: Hi\r\n\r\nBody')
    expect(getRawMessage).toHaveBeenCalledWith('tok', '1a1609dbf79a742f', 25 * 1024 * 1024)
  })

  it('streams emails over Vercel’s 4.5 MB single-response limit in full, byte for byte', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024 + 123)
    for (let i = 0; i < big.length; i++) big[i] = i % 251
    getRawMessage.mockResolvedValueOnce(big)
    const res = await get('abc123')
    expect(res.status).toBe(200)
    expect(res.body).toBeInstanceOf(ReadableStream)
    // Several chunks, not one buffered body.
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    const chunks: Uint8Array[] = []
    for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value)
    expect(chunks.length).toBe(7)
    expect(Buffer.concat(chunks).equals(big)).toBe(true)
  })

  it('rejects bad ids and explains emails too large to download', async () => {
    expect((await get('../x')).status).toBe(400)
    getRawMessage.mockResolvedValueOnce(null)
    const res = await get('abc123')
    expect(res.status).toBe(413)
    expect((await res.json()).error).toMatch(/too large/)
  })
})
