import { describe, expect, it, vi } from 'vitest'

const messagesGet = vi.fn()
vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: class { setCredentials() {} } },
    gmail: () => ({ users: { messages: { get: messagesGet } } }),
  },
}))

const { getMessageHeaders } = await import('@/lib/mail/gmail-mail')

const found = (id: string) => ({ data: { id, threadId: `t-${id}`, labelIds: ['INBOX'], payload: { headers: [] } } })

describe('getMessageHeaders', () => {
  it('skips messages Gmail no longer has (404) instead of failing the sync', async () => {
    messagesGet.mockReset()
    messagesGet.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'gone') throw Object.assign(new Error('Requested entity was not found.'), { code: 404 })
      return found(id)
    })
    const headers = await getMessageHeaders('tok', ['a', 'gone', 'b'])
    expect(headers.map((h) => h.messageId)).toEqual(['a', 'b'])
  })

  it('still surfaces auth failures', async () => {
    messagesGet.mockReset()
    messagesGet.mockRejectedValue(Object.assign(new Error('Forbidden'), { code: 403 }))
    await expect(getMessageHeaders('tok', ['a'])).rejects.toMatchObject({ code: 403 })
  })
})
