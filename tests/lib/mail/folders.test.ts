import { describe, expect, it, vi } from 'vitest'

const threadsList = vi.fn()
const threadsGet = vi.fn()
const messagesList = vi.fn()
vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: class { setCredentials() {} } },
    gmail: () => ({ users: { threads: { list: threadsList, get: threadsGet }, messages: { list: messagesList } } }),
  },
}))

const { listFolderThreads } = await import('@/lib/mail/gmail-mail')
const { parseMailFolder } = await import('@/lib/mail/folders')

const message = (id: string, labelIds: string[], from: string, to: string, date: string) => ({
  id,
  labelIds,
  snippet: `snippet ${id}`,
  internalDate: String(Date.parse(date)),
  payload: {
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: to },
      { name: 'Subject', value: 'Hello' },
      { name: 'Date', value: date },
    ],
  },
})

const thread = {
  messages: [
    message('m1', ['SENT'], 'me@team.test', 'jo@client.com', '2026-10-01T10:00:00Z'),
    message('m2', ['INBOX', 'UNREAD'], 'jo@client.com', 'me@team.test', '2026-10-02T10:00:00Z'),
    message('m3', ['DRAFT'], 'me@team.test', 'jo@client.com', '2026-10-03T10:00:00Z'),
  ],
}

describe('parseMailFolder', () => {
  it('accepts only the known folders', () => {
    expect(parseMailFolder('inbox')).toBe('inbox')
    expect(parseMailFolder('sent')).toBe('sent')
    expect(parseMailFolder('drafts')).toBe('drafts')
    expect(parseMailFolder('spam')).toBeNull()
    expect(parseMailFolder(undefined)).toBeNull()
  })
})

describe('listFolderThreads', () => {
  it('lists the inbox by its label and shows the latest incoming message, not your reply or draft', async () => {
    threadsList.mockReset().mockResolvedValueOnce({ data: { threads: [{ id: 't1' }], nextPageToken: 'next' } })
    threadsGet.mockReset().mockResolvedValueOnce({ data: thread })
    const result = await listFolderThreads('tok', 'inbox')
    expect(threadsList).toHaveBeenCalledWith(expect.objectContaining({ labelIds: ['INBOX'] }))
    expect(result.nextPageToken).toBe('next')
    // The whole thread still counts (and opens) with your messages in it.
    expect(result.threads[0]).toMatchObject({
      threadId: 't1',
      messageId: 'm2',
      from: 'jo@client.com',
      snippet: 'snippet m2',
      date: '2026-10-02T10:00:00.000Z',
      unread: true,
      messageCount: 3,
    })
  })

  it('shows the incoming message when your sent reply is the newest one in the thread', async () => {
    const replied = {
      messages: [
        message('m1', ['INBOX'], 'Jo <jo@client.com>', 'me@team.test', '2026-10-01T10:00:00Z'),
        message('m2', ['SENT'], 'me@team.test', 'jo@client.com', '2026-10-02T10:00:00Z'),
      ],
    }
    threadsList.mockReset().mockResolvedValueOnce({ data: { threads: [{ id: 't1' }] } })
    threadsGet.mockReset().mockResolvedValueOnce({ data: replied })
    const result = await listFolderThreads('tok', 'inbox')
    expect(result.threads).toEqual([expect.objectContaining({ messageId: 'm1', from: 'Jo <jo@client.com>', messageCount: 2 })])
  })

  it('leaves threads that hold only your own mail out of the inbox (they show in Sent)', async () => {
    const own = {
      messages: [
        // Sent to yourself: Gmail labels it both SENT and INBOX.
        message('s1', ['SENT', 'INBOX'], 'me@team.test', 'me@team.test', '2026-10-01T10:00:00Z'),
        message('s2', ['DRAFT'], 'me@team.test', 'me@team.test', '2026-10-02T10:00:00Z'),
      ],
    }
    threadsList.mockReset().mockResolvedValueOnce({ data: { threads: [{ id: 'own' }, { id: 't1' }] } })
    threadsGet.mockReset().mockImplementation(async ({ id }: { id: string }) => ({ data: id === 'own' ? own : thread }))
    const inbox = await listFolderThreads('tok', 'inbox')
    expect(inbox.threads.map((row) => row.threadId)).toEqual(['t1'])

    messagesList.mockReset().mockResolvedValueOnce({ data: { messages: [{ id: 's1', threadId: 'own' }] } })
    const sent = await listFolderThreads('tok', 'sent')
    expect(sent.threads).toEqual([expect.objectContaining({ threadId: 'own', messageId: 's1', from: 'me@team.test' })])
  })

  // Regression: threads.list with a query returned threads out of date order and
  // dropped recent ones, so hidden-sender filtering hid new mail from the inbox.
  it('lists filtered folders via messages.list, newest first, one row per thread', async () => {
    threadsList.mockReset()
    messagesList.mockReset().mockResolvedValueOnce({
      data: {
        messages: [
          { id: 'a', threadId: 't2' },
          { id: 'b', threadId: 't1' },
          { id: 'c', threadId: 't2' },
        ],
        nextPageToken: 'p2',
      },
    })
    threadsGet.mockReset().mockResolvedValue({ data: thread })
    const result = await listFolderThreads('tok', 'inbox', { q: '-from:x.com' })
    expect(threadsList).not.toHaveBeenCalled()
    expect(messagesList).toHaveBeenCalledWith(expect.objectContaining({ labelIds: ['INBOX'], q: '-from:x.com' }))
    expect(result.threads.map((row) => row.threadId)).toEqual(['t2', 't1'])
    expect(result.nextPageToken).toBe('p2')
  })

  it('shows the latest sent message in Sent, not the incoming reply or the draft', async () => {
    messagesList.mockReset().mockResolvedValueOnce({ data: { messages: [{ id: 'm1', threadId: 't1' }] } })
    threadsGet.mockReset().mockResolvedValueOnce({ data: thread })
    const result = await listFolderThreads('tok', 'sent')
    expect(messagesList).toHaveBeenCalledWith(expect.objectContaining({ labelIds: ['SENT'] }))
    expect(result.threads[0]).toMatchObject({
      messageId: 'm1',
      from: 'me@team.test',
      to: 'jo@client.com',
      snippet: 'snippet m1',
      date: '2026-10-01T10:00:00.000Z',
    })
  })

  it('uses the draft message id for Drafts rows so the compose window can open it', async () => {
    threadsList.mockReset().mockResolvedValueOnce({ data: { threads: [{ id: 't1' }] } })
    threadsGet.mockReset().mockResolvedValueOnce({ data: thread })
    const result = await listFolderThreads('tok', 'drafts')
    expect(threadsList).toHaveBeenCalledWith(expect.objectContaining({ labelIds: ['DRAFT'] }))
    expect(result.threads[0]).toMatchObject({ messageId: 'm3', to: 'jo@client.com' })
    expect(result.nextPageToken).toBeNull()
  })

  // Regression: threads.list ordered Sent by each thread's latest message, incoming
  // replies included, so an older sent email with a new reply sat above newer sent mail.
  it('orders Sent by your latest sent message, newest first, via messages.list', async () => {
    threadsList.mockReset()
    messagesList.mockReset().mockResolvedValueOnce({
      data: {
        messages: [
          { id: 'new', threadId: 'tNew' },
          { id: 'old', threadId: 'tOld' },
          { id: 'older', threadId: 'tNew' },
        ],
        nextPageToken: 'p2',
      },
    })
    threadsGet.mockReset().mockResolvedValue({ data: thread })
    const result = await listFolderThreads('tok', 'sent')
    expect(threadsList).not.toHaveBeenCalled()
    expect(messagesList).toHaveBeenCalledWith(expect.not.objectContaining({ q: expect.anything() }))
    expect(messagesList).toHaveBeenCalledWith(expect.objectContaining({ labelIds: ['SENT'] }))
    expect(result.threads.map((row) => row.threadId)).toEqual(['tNew', 'tOld'])
    expect(result.nextPageToken).toBe('p2')
  })
})
