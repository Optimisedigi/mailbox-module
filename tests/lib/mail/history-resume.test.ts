import { describe, expect, it, vi } from 'vitest'

const historyList = vi.fn()
vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: class { setCredentials() {} } },
    gmail: () => ({ users: { history: { list: historyList } } }),
  },
}))

const { listAddedMessageIdsSince } = await import('@/lib/mail/gmail-mail')

const entry = (id: number, messageIds: string[]) => ({
  id: String(id),
  messagesAdded: messageIds.map((messageId) => ({ message: { id: messageId, labelIds: ['INBOX'] } })),
})

describe('listAddedMessageIdsSince', () => {
  it('reads everything when under the cap', async () => {
    historyList.mockReset()
    historyList.mockResolvedValueOnce({ data: { history: [entry(101, ['a']), entry(102, ['b'])] } })
    expect(await listAddedMessageIdsSince('tok', '100', 5)).toEqual({ ids: ['a', 'b'], resumeHistoryId: null })
  })

  it('stops at the cap and returns where to resume, across pages', async () => {
    historyList.mockReset()
    historyList
      .mockResolvedValueOnce({ data: { history: [entry(101, ['a']), entry(102, ['b'])], nextPageToken: 'p2' } })
      .mockResolvedValueOnce({ data: { history: [entry(103, ['c']), entry(104, ['d'])] } })
    expect(await listAddedMessageIdsSince('tok', '100', 3)).toEqual({ ids: ['a', 'b', 'c'], resumeHistoryId: '103' })
  })

  it('does not ask to resume when the cap is hit on the very last record', async () => {
    historyList.mockReset()
    historyList.mockResolvedValueOnce({ data: { history: [entry(101, ['a']), entry(102, ['b'])] } })
    expect(await listAddedMessageIdsSince('tok', '100', 2)).toEqual({ ids: ['a', 'b'], resumeHistoryId: null })
  })
})
