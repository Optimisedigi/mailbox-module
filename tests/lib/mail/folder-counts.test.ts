import { describe, expect, it, vi } from 'vitest'

const labelsGet = vi.fn()
vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: class { setCredentials() {} } },
    gmail: () => ({ users: { labels: { get: labelsGet } } }),
  },
}))

const { getFolderCounts } = await import('@/lib/mail/gmail-mail')

describe('getFolderCounts', () => {
  it('reads unread Inbox threads and Draft threads from Gmail labels, and nothing for Sent', async () => {
    labelsGet.mockReset().mockImplementation(async ({ id }: { id: string }) => ({
      data: id === 'INBOX' ? { threadsUnread: 7, threadsTotal: 900 } : { threadsTotal: 3, messagesTotal: 5 },
    }))
    expect(await getFolderCounts('tok')).toEqual({ inboxUnread: 7, drafts: 3 })
    expect(labelsGet.mock.calls.map(([args]) => args.id).sort()).toEqual(['DRAFT', 'INBOX'])
  })

  it('treats missing counts as zero', async () => {
    labelsGet.mockReset().mockResolvedValue({ data: {} })
    expect(await getFolderCounts('tok')).toEqual({ inboxUnread: 0, drafts: 0 })
  })
})
