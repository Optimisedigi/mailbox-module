import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const listFolderThreads = vi.fn(async () => ({
  threads: [{ threadId: 't1', messageId: 'm1', from: 'me@team.test', to: 'jo@client.com', cc: '', subject: 'Hi', snippet: '', date: '', unread: false, messageCount: 1 }],
  nextPageToken: null,
}))

vi.mock('@/lib/mail/gmail-mail', () => ({ listFolderThreads }))
vi.mock('@/lib/mail/client-matching', () => ({
  matchMessageToClient: vi.fn(() => null),
  chosenClientsFor: vi.fn(() => []),
  extractEmailAddresses: vi.fn(() => []),
}))
vi.mock('@/lib/mail/store', () => ({ loadClientDomainIndex: vi.fn(async () => ({})) }))
vi.mock('@/lib/mail/hidden-senders', () => ({
  loadHiddenSenders: vi.fn(async () => ['@news.com']),
  hiddenSendersQuery: vi.fn(() => '-from:news.com'),
  isHiddenSender: vi.fn((from: string) => from.endsWith('@news.com>')),
}))
vi.mock('@/lib/mail/client-senders', () => ({ loadClientSenders: vi.fn(async () => []) }))
vi.mock('@/lib/mail/sender-clients', () => ({ loadSenderClients: vi.fn(async () => []) }))
vi.mock('@/lib/mail/route-helpers', () => ({
  requireMailUser: vi.fn(async () => ({ payload: {}, user: { id: 1 } })),
  requireGmailToken: vi.fn(async () => ({ accessToken: 'tok', email: 'me@team.test', userEmail: 'me@team.test' })),
  gmailErrorResponse: vi.fn(),
}))

const { GET } = await import('@/app/(frontend)/api/mail/inbox/route')

const request = (query: string) => new NextRequest(`https://mail.test/api/mail/inbox${query}`)

// `count` list rows with ids `${prefix}${from}`, `${prefix}${from + 1}`, ...
const rows = (prefix: string, from: number, count: number, unread: boolean) =>
  Array.from({ length: count }, (_, i) => ({
    threadId: `${prefix}${from + i}`, messageId: `m-${prefix}${from + i}`, from: 'Jo <jo@client.com>', to: 'me@team.test', cc: '',
    subject: 's', snippet: '', date: '', unread, messageCount: 1,
  }))

afterEach(() => {
  vi.clearAllMocks()
  listFolderThreads.mockReset()
  listFolderThreads.mockImplementation(async () => ({ threads: rows('t', 1, 1, false), nextPageToken: null }))
})

describe('GET /api/mail/inbox folders', () => {
  it('defaults to the inbox and applies the hidden-sender filter there', async () => {
    const res = await GET(request(''))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ folder: 'inbox', threads: [{ threadId: 't1', client: null }] })
    expect(listFolderThreads).toHaveBeenCalledWith('tok', 'inbox', { pageToken: undefined, q: '-from:news.com -in:sent is:unread', maxResults: 20 })
    // t1 is already listed, so the read part still asks for a full page.
    expect(listFolderThreads).toHaveBeenCalledWith('tok', 'inbox', { pageToken: undefined, q: '-from:news.com -in:sent -is:unread', maxResults: 19 })
  })

  it('lists every unread thread before any read one, across pages', async () => {
    // Page 1: more unread threads than fit, so only unread ones come back (page filled to 20).
    listFolderThreads.mockResolvedValueOnce({ threads: rows('u', 0, 20, true), nextPageToken: 'g2' })
    const first = await (await GET(request(''))).json()
    expect(first.threads).toHaveLength(20)
    expect(first.threads.every((t: { unread: boolean }) => t.unread)).toBe(true)
    expect(first.nextPageToken).toBe('u:g2')
    expect(listFolderThreads).toHaveBeenCalledTimes(1)

    // Page 2: the last unread threads, then the read ones start in the same page (no duplicates).
    listFolderThreads
      .mockResolvedValueOnce({ threads: rows('u', 20, 3, true), nextPageToken: null })
      .mockResolvedValueOnce({ threads: [...rows('u', 22, 1, true), ...rows('r', 0, 17, false)], nextPageToken: 'g9' })
    const second = await (await GET(request('?pageToken=u:g2'))).json()
    expect(listFolderThreads).toHaveBeenNthCalledWith(2, 'tok', 'inbox', { pageToken: 'g2', q: '-from:news.com -in:sent is:unread', maxResults: 20 })
    expect(listFolderThreads).toHaveBeenNthCalledWith(3, 'tok', 'inbox', { pageToken: undefined, q: '-from:news.com -in:sent -is:unread', maxResults: 17 })
    expect(second.threads.slice(0, 3).map((t: { threadId: string }) => t.threadId)).toEqual(['u20', 'u21', 'u22'])
    expect(second.threads).toHaveLength(20)
    expect(listFolderThreads).toHaveBeenCalledTimes(3)
    expect(second.nextPageToken).toBe('r:g9')

    // Page 3: read threads only.
    listFolderThreads.mockResolvedValueOnce({ threads: rows('r', 17, 1, false), nextPageToken: null })
    const third = await (await GET(request('?pageToken=r:g9&q=budget'))).json()
    expect(listFolderThreads).toHaveBeenLastCalledWith('tok', 'inbox', { pageToken: 'g9', q: '{budget from:budget} -from:news.com -in:sent -is:unread', maxResults: 20 })
    expect(third).toMatchObject({ threads: [{ threadId: 'r17' }], nextPageToken: null })
  })

  it('inbox search matches the sender address as well as the subject', async () => {
    const res = await GET(request(`?q=${encodeURIComponent('jo@client.com')}`))
    expect(res.status).toBe(200)
    expect(listFolderThreads).toHaveBeenCalledWith('tok', 'inbox', {
      pageToken: undefined,
      q: '{jo@client.com from:jo@client.com} -from:news.com -in:sent is:unread',
      maxResults: 20,
    })
    // A hand-written Gmail search is sent as typed.
    await GET(request(`?q=${encodeURIComponent('subject:invoice')}`))
    expect(listFolderThreads).toHaveBeenCalledWith('tok', 'inbox', {
      pageToken: undefined,
      q: 'subject:invoice -from:news.com -in:sent is:unread',
      maxResults: 20,
    })
  })

  it('adds the people the Mail page matched to part of a name as from: matches', async () => {
    const res = await GET(request(`?q=rebe&senders=${encodeURIComponent('rebecca@acmeclient.com.au,not-an-address')}`))
    expect(res.status).toBe(200)
    expect(listFolderThreads).toHaveBeenCalledWith('tok', 'inbox', {
      pageToken: undefined,
      q: '{rebe from:rebe from:rebecca@acmeclient.com.au} -from:news.com -in:sent is:unread',
      maxResults: 20,
    })
  })

  it('a search’s first page asks for unread and read mail at the same time, showing read only once unread runs out', async () => {
    const unreadQ = '{budget from:budget} -from:news.com -in:sent is:unread'
    const readQ = '{budget from:budget} -from:news.com -in:sent -is:unread'
    // Both lookups are in flight before either answers.
    const pending: Array<() => void> = []
    listFolderThreads.mockImplementation(async (_token: string, _folder: string, options: { q?: string }) => {
      await new Promise<void>((resolve) => pending.push(resolve))
      return options.q === unreadQ
        ? { threads: rows('u', 0, 2, true), nextPageToken: null }
        : { threads: [...rows('u', 1, 1, true), ...rows('r', 0, 20, false)], nextPageToken: 'g5' }
    })
    const response = GET(request('?q=budget'))
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(listFolderThreads).toHaveBeenNthCalledWith(1, 'tok', 'inbox', { pageToken: undefined, q: unreadQ, maxResults: 20 })
    expect(listFolderThreads).toHaveBeenNthCalledWith(2, 'tok', 'inbox', { pageToken: undefined, q: readQ, maxResults: 20 })
    pending.forEach((resolve) => resolve())
    const page = await (await response).json()
    // Unread first, then the read mail (u1 only once), and the next page carries on after it.
    expect(page.threads.map((t: { threadId: string }) => t.threadId)).toEqual(['u0', 'u1', ...rows('r', 0, 20, false).map((r) => r.threadId)])
    expect(page.nextPageToken).toBe('r:g5')
    expect(listFolderThreads).toHaveBeenCalledTimes(2)
  })

  it('drops the early read results when unread mail fills the search page, so the next page still starts with unread', async () => {
    listFolderThreads.mockImplementation(async (_token: string, _folder: string, options: { q?: string }) =>
      options.q?.endsWith(' is:unread')
        ? { threads: rows('u', 0, 20, true), nextPageToken: 'g2' }
        : { threads: rows('r', 0, 20, false), nextPageToken: 'g9' },
    )
    const page = await (await GET(request('?q=budget'))).json()
    expect(page.threads).toHaveLength(20)
    expect(page.threads.every((t: { unread: boolean }) => t.unread)).toBe(true)
    expect(page.nextPageToken).toBe('u:g2')
    // Later pages and plain inbox loads still go one part at a time.
    listFolderThreads.mockClear()
    await GET(request('?q=budget&pageToken=u:g2'))
    await GET(request(''))
    expect(listFolderThreads.mock.calls.every(([, , options]) => (options as { q: string }).q.endsWith(' is:unread'))).toBe(true)
  })

  it('tops up a short page (one thread can fill several Gmail results) before showing Load more', async () => {
    // Gmail pages count messages: 20 results here were only 10 threads.
    listFolderThreads
      .mockResolvedValueOnce({ threads: [], nextPageToken: null })
      .mockResolvedValueOnce({ threads: rows('r', 0, 10, false), nextPageToken: 'a' })
      .mockResolvedValueOnce({ threads: rows('r', 10, 8, false), nextPageToken: 'b' })
      .mockResolvedValueOnce({ threads: rows('r', 18, 2, false), nextPageToken: 'c' })
    const page = await (await GET(request(''))).json()
    expect(page.threads).toHaveLength(20)
    expect(page.nextPageToken).toBe('r:c')
    expect(listFolderThreads).toHaveBeenNthCalledWith(3, 'tok', 'inbox', { pageToken: 'a', q: '-from:news.com -in:sent -is:unread', maxResults: 10 })
    expect(listFolderThreads).toHaveBeenNthCalledWith(4, 'tok', 'inbox', { pageToken: 'b', q: '-from:news.com -in:sent -is:unread', maxResults: 2 })
  })

  it('stops after a few Gmail calls even if the page is still short', async () => {
    listFolderThreads.mockResolvedValue({ threads: [], nextPageToken: 'more' })
    const page = await (await GET(request('?pageToken=r:x'))).json()
    expect(listFolderThreads).toHaveBeenCalledTimes(4)
    expect(page.nextPageToken).toBe('r:more')
  })

  it('carries on with the read part next page when unread fills this one exactly', async () => {
    listFolderThreads.mockResolvedValueOnce({ threads: rows('u', 0, 20, true), nextPageToken: null })
    const page = await (await GET(request(''))).json()
    expect(listFolderThreads).toHaveBeenCalledTimes(1)
    expect(page.nextPageToken).toBe('r:')
  })

  it('lists Sent and Drafts without the hidden-sender filter', async () => {
    expect((await GET(request('?folder=sent&q=budget'))).status).toBe(200)
    expect(listFolderThreads).toHaveBeenLastCalledWith('tok', 'sent', { pageToken: undefined, q: '{budget to:budget cc:budget bcc:budget}', maxResults: 20 })
    expect(await (await GET(request('?folder=drafts&pageToken=p2'))).json()).toMatchObject({ folder: 'drafts' })
    expect(listFolderThreads).toHaveBeenLastCalledWith('tok', 'drafts', { pageToken: 'p2', q: undefined, maxResults: 20 })
  })

  it('lists a tag (user label) instead of the inbox, with the same filters', async () => {
    expect((await GET(request('?tag=Label_7'))).status).toBe(200)
    expect(listFolderThreads).toHaveBeenCalledWith('tok', 'inbox', {
      pageToken: undefined,
      q: '-from:news.com -in:sent is:unread',
      maxResults: 20,
      labelId: 'Label_7',
    })
  })

  it('refuses system labels as tags, and tags outside the inbox, before touching Gmail', async () => {
    for (const query of ['?tag=TRASH', '?tag=', '?tag=Label_1%20OR', '?folder=sent&tag=Label_7']) {
      expect((await GET(request(query))).status).toBe(400)
    }
    expect(listFolderThreads).not.toHaveBeenCalled()
  })

  it('rejects unknown folders before touching Gmail', async () => {
    const res = await GET(request('?folder=spam'))
    expect(res.status).toBe(400)
    expect(listFolderThreads).not.toHaveBeenCalled()
  })
})
