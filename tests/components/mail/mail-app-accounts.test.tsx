import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

type NavItem = { label: unknown; url?: string }
const nav: { items: NavItem[] } = { items: [] }
vi.mock('@payloadcms/ui', () => ({
  useStepNav: () => ({
    setStepNav: (items: NavItem[]) => {
      nav.items = items
    },
    stepNav: [],
  }),
}))
vi.mock('@/components/mail/ComposeWindow', () => ({ default: () => <div data-testid="compose" /> }))
vi.mock('@/components/mail/EmailBody', () => ({ default: () => <div /> }))

const { default: MailApp } = await import('@/components/mail/MailApp')

const thread = {
  threadId: 't1', messageId: 'm1', from: 'Jo Smith <jo@acme.com.au>', to: 'me@team.test', subject: 'Hello there',
  snippet: 'snippet', date: new Date().toISOString(), unread: false, messageCount: 1, client: { id: 1, name: 'Acme' },
}
const message = { ...thread, cc: '', body: 'Body text', html: '', stored: null, match: { id: 1, name: 'Acme', matchedOn: 'acme.com.au' } }

let calls: Array<{ url: string; init?: RequestInit }> = []
// What the sender-client route last saved; the inbox route returns it, as the server does.
let savedSenderClients: Array<{ sender: string; clientIds: number[] }> = []

beforeEach(() => {
  calls = []
  savedSenderClients = []
  localStorage.clear()
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const account = (init?.headers as Record<string, string> | undefined)?.['x-mail-account'] ?? ''
    const body = url.startsWith('/api/mail/inbox')
      ? { threads: [thread], nextPageToken: null, account: account || 'me@team.test', senderClients: savedSenderClients }
      : url.startsWith('/api/mail/thread/')
        ? { messages: [message] }
        : url.startsWith('/api/mail/contacts')
          ? {
              contacts: [{ email: 'casey@acmeclient.com.au', name: 'Casey Morgan' }],
              senders: [{ email: 'rebecca@acmeclient.com.au', name: 'Rebecca Stone' }],
            }
        : url.startsWith('/api/mail/counts')
          ? { inboxUnread: 0, drafts: 0 }
          : url.startsWith('/api/mail/accounts')
            ? { primary: 'me@team.test', accounts: [{ email: 'sales@team.test' }], addUrl: '/api/gmail/connect?add=1', canAdd: true }
            : url.startsWith('/api/mail/sender-client')
              ? senderClientReply(JSON.parse(String(init?.body)) as { sender: string; clientIds: number[] })
              : {}
    return { ok: true, json: async () => body } as Response
  }) as unknown as typeof fetch
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  nav.items = []
})

const CLIENTS = [
  { id: 1, name: 'Acme' },
  { id: 2, name: 'Beta' },
]

function senderClientReply(body: { sender: string; clientIds: number[] }) {
  const clients = CLIENTS.filter((client) => body.clientIds.includes(client.id))
  savedSenderClients = [{ sender: body.sender, clientIds: body.clientIds }]
  return {
    senderClients: savedSenderClients,
    client: clients.length === 1 ? clients[0] : null,
    clients,
    moved: clients.length === 1 ? 3 : 0,
  }
}

describe('MailApp layout', () => {
  it('clearing the search brings the whole inbox back without a refresh', async () => {
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    const search = screen.getByRole('combobox', { name: 'Search inbox' })
    fireEvent.change(search, { target: { value: 'acme' } })
    fireEvent.submit(search.closest('form') as HTMLFormElement)
    await waitFor(() => expect(calls.some((call) => call.url.includes('q=acme'))).toBe(true))
    calls = []
    // The search box's × clears it: same as emptying the text.
    fireEvent.change(search, { target: { value: '' } })
    await waitFor(() => expect(calls.some((call) => call.url.startsWith('/api/mail/inbox'))).toBe(true))
    const url = new URL(calls.find((call) => call.url.startsWith('/api/mail/inbox'))?.url ?? '', 'https://mail.test')
    expect(url.searchParams.get('q')).toBeNull()
    expect(url.searchParams.get('folder')).toBe('inbox')
  })

  it('ticking inbox emails offers Mark as read, which marks them all read at once', async () => {
    const baseFetch = global.fetch
    const unread = [
      { ...thread, threadId: 't1', subject: 'First', unread: true },
      { ...thread, threadId: 't2', messageId: 'm2', subject: 'Second', unread: true },
      { ...thread, threadId: 't3', messageId: 'm3', subject: 'Third', unread: true },
    ]
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/mail/inbox')) {
        calls.push({ url, init })
        return { ok: true, json: async () => ({ threads: unread, nextPageToken: null, account: 'me@team.test', senderClients: [] }) } as Response
      }
      return baseFetch(url, init)
    }) as unknown as typeof fetch
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('First')
    expect(screen.queryByRole('button', { name: 'Mark as read' })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: /First/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Second/ }))
    expect(screen.getByText('2 selected')).toBeTruthy()
    calls = []
    fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }))
    await screen.findByText('Marked 2 emails read')
    const modify = calls.filter((call) => call.url === '/api/mail/modify')
    expect(modify).toHaveLength(1)
    expect(JSON.parse(String(modify[0]?.init?.body))).toEqual({ threadIds: ['t1', 't2'], action: 'read' })
    // Marked rows lose their unread style and the selection clears; the third stays unread.
    expect(screen.queryByText('2 selected')).toBeNull()
    const rows = screen.getAllByRole('listitem').map((li) => li.querySelector('button'))
    expect(rows.filter((row) => row?.className.includes('unread'))).toHaveLength(1)
  })

  it('ticking read inbox emails offers Mark as unread, without opening them', async () => {
    const baseFetch = global.fetch
    const read = [
      { ...thread, threadId: 't1', subject: 'First', unread: false },
      { ...thread, threadId: 't2', messageId: 'm2', subject: 'Second', unread: false },
      { ...thread, threadId: 't3', messageId: 'm3', subject: 'Third', unread: false },
    ]
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/mail/inbox')) {
        calls.push({ url, init })
        return { ok: true, json: async () => ({ threads: read, nextPageToken: null, account: 'me@team.test', senderClients: [] }) } as Response
      }
      return baseFetch(url, init)
    }) as unknown as typeof fetch
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('First')
    fireEvent.click(screen.getByRole('checkbox', { name: /First/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Third/ }))
    calls = []
    fireEvent.click(screen.getByRole('button', { name: 'Mark as unread' }))
    await screen.findByText('Marked 2 emails unread')
    const modify = calls.filter((call) => call.url === '/api/mail/modify')
    expect(modify).toHaveLength(1)
    expect(JSON.parse(String(modify[0]?.init?.body))).toEqual({ threadIds: ['t1', 't3'], action: 'unread' })
    // Nothing was opened, the two rows now look unread and the selection clears.
    expect(calls.some((call) => call.url.startsWith('/api/mail/thread'))).toBe(false)
    expect(screen.queryByText('2 selected')).toBeNull()
    const rows = screen.getAllByRole('listitem').map((li) => li.querySelector('button'))
    expect(rows.filter((row) => row?.className.includes('unread'))).toHaveLength(2)
  })

  it('ticking inbox emails offers Delete, which bins them all at once, with Undo', async () => {
    const baseFetch = global.fetch
    const rows = [
      { ...thread, threadId: 't1', subject: 'First' },
      { ...thread, threadId: 't2', messageId: 'm2', subject: 'Second' },
      { ...thread, threadId: 't3', messageId: 'm3', subject: 'Third' },
    ]
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/mail/inbox')) {
        calls.push({ url, init })
        return { ok: true, json: async () => ({ threads: rows, nextPageToken: null, account: 'me@team.test', senderClients: [] }) } as Response
      }
      return baseFetch(url, init)
    }) as unknown as typeof fetch
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('First')
    expect(screen.queryByText(/emails? shown/)).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: /First/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Third/ }))
    calls = []
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByText('Deleted 2 emails. They stay in Gmail’s Bin for 30 days.')
    const modify = calls.filter((call) => call.url === '/api/mail/modify')
    expect(modify).toHaveLength(1)
    expect(JSON.parse(String(modify[0]?.init?.body))).toEqual({ threadIds: ['t1', 't3'], action: 'trash' })
    expect(screen.queryByText('First')).toBeNull()
    expect(screen.getByText('Second')).toBeTruthy()
    calls = []
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/mail/modify')).toBe(true))
    const undo = calls.filter((call) => call.url === '/api/mail/modify')
    expect(JSON.parse(String(undo[0]?.init?.body))).toEqual({ threadIds: ['t1', 't3'], action: 'untrash' })
  })

  it('a row delete icon moves the thread to the Bin, with Undo bringing it back', async () => {
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    calls = []
    fireEvent.click(screen.getByRole('button', { name: 'Delete Jo Smith: Hello there' }))
    await screen.findByText(/Deleted “Hello there”/)
    // The row leaves the list straight away.
    expect(screen.queryByRole('button', { name: 'Delete Jo Smith: Hello there' })).toBeNull()
    const modify = calls.filter((call) => call.url === '/api/mail/modify')
    expect(JSON.parse(String(modify[0]?.init?.body))).toEqual({ threadId: 't1', action: 'trash' })
    calls = []
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(calls.some((call) => call.url.startsWith('/api/mail/inbox'))).toBe(true))
    const undo = calls.filter((call) => call.url === '/api/mail/modify')
    expect(JSON.parse(String(undo[0]?.init?.body))).toEqual({ threadId: 't1', action: 'untrash' })
    expect(await screen.findByRole('button', { name: 'Delete Jo Smith: Hello there' })).toBeTruthy()
  })

  it('the open email has a Delete icon in its actions', async () => {
    render(<MailApp clients={CLIENTS} />)
    fireEvent.click(await screen.findByText('Hello there'))
    const reader = await screen.findByTestId('mail-reader')
    await within(reader).findByRole('button', { name: 'Reply' })
    calls = []
    fireEvent.click(within(reader).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(within(reader).getByText('Select an email to read it.')).toBeTruthy())
    expect(JSON.parse(String(calls.find((call) => call.url === '/api/mail/modify')?.init?.body))).toEqual({ threadId: 't1', action: 'trash' })
  })

  it('Select all ticks only the emails loaded so far, not ones still behind Load more', async () => {
    const baseFetch = global.fetch
    const page1 = [
      { ...thread, threadId: 't1', subject: 'First', unread: true },
      { ...thread, threadId: 't2', messageId: 'm2', subject: 'Second', unread: true },
    ]
    const page2 = [{ ...thread, threadId: 't3', messageId: 'm3', subject: 'Third', unread: true }]
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/mail/inbox')) {
        const more = url.includes('pageToken=')
        return {
          ok: true,
          json: async () => ({ threads: more ? page2 : page1, nextPageToken: more ? null : 'r:next', account: 'me@team.test', senderClients: [] }),
        } as Response
      }
      return baseFetch(url, init)
    }) as unknown as typeof fetch
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Second')
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('2 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText('Third')
    // The newly loaded email is not ticked; the earlier ones stay ticked.
    expect((screen.getByRole('checkbox', { name: /Third/ }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText('2 selected')).toBeTruthy()
    // Select all again now takes in all three loaded, then Unselect all clears them.
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('3 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unselect all' }))
    expect(screen.queryByText(/selected$/)).toBeNull()
  })

  it('puts the search box at the top of the email list, right above the first email', async () => {
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    const search = screen.getByRole('combobox', { name: 'Search inbox' })
    const list = screen.getByRole('list', { name: 'Inbox' })
    // Search, then the Select all bar, then the first email.
    const selectAll = search.closest('form')?.nextElementSibling
    expect(selectAll?.querySelector('button')?.textContent).toBe('Select all')
    expect(selectAll?.nextElementSibling).toBe(list)
    expect(search.closest('[class*="toolbar"]')).toBeNull()
  })

  it('suggests regular senders as you type and lists their mail when one is picked', async () => {
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    const search = screen.getByRole('combobox', { name: 'Search inbox' })
    fireEvent.focus(search)
    fireEvent.change(search, { target: { value: 'rebe' } })
    const option = await screen.findByRole('option', { name: /Rebecca Stone/ })
    calls = []
    fireEvent.click(option)
    await waitFor(() => expect(calls.some((call) => call.url.startsWith('/api/mail/inbox'))).toBe(true))
    const url = new URL(calls.find((call) => call.url.startsWith('/api/mail/inbox'))?.url ?? '', 'https://mail.test')
    expect(url.searchParams.get('q')).toBe('rebecca@acmeclient.com.au')
    expect((search as HTMLInputElement).value).toBe('rebecca@acmeclient.com.au')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('searching part of a name also asks for mail from the people it matches', async () => {
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    const search = screen.getByRole('combobox', { name: 'Search inbox' })
    fireEvent.change(search, { target: { value: 'acmec' } })
    calls = []
    fireEvent.submit(search.closest('form') as HTMLFormElement)
    await waitFor(() => expect(calls.some((call) => call.url.startsWith('/api/mail/inbox'))).toBe(true))
    const url = new URL(calls.find((call) => call.url.startsWith('/api/mail/inbox'))?.url ?? '', 'https://mail.test')
    expect(url.searchParams.get('q')).toBe('acmec')
    expect(url.searchParams.get('senders')).toBe('rebecca@acmeclient.com.au,casey@acmeclient.com.au')
  })

  it('does not hold a search back while the people list is still loading, then widens it', async () => {
    const baseFetch = global.fetch
    let releaseContacts: () => void = () => undefined
    const contactsGate = new Promise<void>((resolve) => {
      releaseContacts = resolve
    })
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/mail/contacts')) await contactsGate
      return baseFetch(url, init)
    }) as unknown as typeof fetch
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    const search = screen.getByRole('combobox', { name: 'Search inbox' })
    fireEvent.change(search, { target: { value: 'acmec' } })
    calls = []
    fireEvent.submit(search.closest('form') as HTMLFormElement)
    const searches = () => calls.filter((call) => call.url.startsWith('/api/mail/inbox')).map((call) => new URL(call.url, 'https://mail.test'))
    await waitFor(() => expect(searches()).toHaveLength(1))
    expect(searches()[0]?.searchParams.get('q')).toBe('acmec')
    expect(searches()[0]?.searchParams.get('senders')).toBeNull()
    releaseContacts()
    await waitFor(() => expect(searches()).toHaveLength(2))
    expect(searches()[1]?.searchParams.get('senders')).toBe('rebecca@acmeclient.com.au,casey@acmeclient.com.au')
  })

  it('searches with the people saved in this browser straight away, without waiting for Gmail, and saves the refreshed list', async () => {
    localStorage.setItem(
      'mail-search-people:main',
      JSON.stringify({ savedAt: Date.now(), contacts: [], senders: [{ email: 'casey@acmeclient.com.au', name: 'Casey Morgan' }] }),
    )
    const baseFetch = global.fetch
    // The fresh list never arrives during the search.
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/mail/contacts')) return new Promise<Response>(() => undefined)
      return baseFetch(url, init)
    }) as unknown as typeof fetch
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    const search = screen.getByRole('combobox', { name: 'Search inbox' })
    fireEvent.focus(search)
    fireEvent.change(search, { target: { value: 'case' } })
    // Suggestions come from the saved list at once.
    expect(await screen.findByRole('option', { name: /Casey Morgan/ })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'acmec' } })
    calls = []
    fireEvent.submit(search.closest('form') as HTMLFormElement)
    const searches = () => calls.filter((call) => call.url.startsWith('/api/mail/inbox')).map((call) => new URL(call.url, 'https://mail.test'))
    await waitFor(() => expect(searches()).toHaveLength(1))
    expect(searches()[0]?.searchParams.get('senders')).toBe('casey@acmeclient.com.au')
    // No second, late search.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(searches()).toHaveLength(1)
  })

  it('has no Search in picker: one search looks at the person, subject and text, closest match first', async () => {
    const baseFetch = global.fetch
    const results = [
      { ...thread, threadId: 't1', subject: 'Notes from Rebecca', from: 'Sam <sam@x.com>' },
      { ...thread, threadId: 't2', messageId: 'm2', subject: 'Catch up', from: 'Rebecca Stone <rebecca@acmeclient.com.au>' },
    ]
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    expect(screen.queryByRole('combobox', { name: 'Search in' })).toBeNull()
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/mail/inbox')) {
        calls.push({ url, init })
        return { ok: true, json: async () => ({ threads: results, nextPageToken: null, account: 'me@team.test', senderClients: [] }) } as Response
      }
      return baseFetch(url, init)
    }) as unknown as typeof fetch
    const search = screen.getByRole('combobox', { name: 'Search inbox' })
    fireEvent.change(search, { target: { value: 'rebecca' } })
    calls = []
    fireEvent.submit(search.closest('form') as HTMLFormElement)
    await screen.findByText('Catch up')
    const searches = calls.filter((call) => call.url.startsWith('/api/mail/inbox')).map((call) => new URL(call.url, 'https://mail.test'))
    expect(searches[0]?.searchParams.get('scope')).toBeNull()
    // The sender match ranks above the subject match.
    const subjects = screen.getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(subjects.findIndex((t) => t.includes('Catch up'))).toBeLessThan(subjects.findIndex((t) => t.includes('Notes from Rebecca')))
  })

  it('suggests people you email as well as regular senders, from an @ and a domain', async () => {
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    const search = screen.getByRole('combobox', { name: 'Search inbox' })
    fireEvent.focus(search)
    fireEvent.change(search, { target: { value: '@acmec' } })
    expect(await screen.findByRole('option', { name: /Rebecca Stone/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Casey Morgan/ })).toBeTruthy()
  })

  it('saves the people list from Gmail for next time', async () => {
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    fireEvent.focus(screen.getByRole('combobox', { name: 'Search inbox' }))
    await waitFor(() => expect(localStorage.getItem('mail-search-people:main')).toContain('rebecca@acmeclient.com.au'))
  })

  it('keeps Download thread, Mark as client and Hide sender in a ⋯ menu on the open email, and names the compose button Write message', async () => {
    render(<MailApp clients={CLIENTS} />)
    expect(screen.getByRole('button', { name: 'Write message' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Draft with AI' })).toBeNull()
    fireEvent.click(await screen.findByText('Hello there'))
    const more = await screen.findByRole('button', { name: 'More actions for this email' })
    // Not shown in the action row any more.
    for (const name of [/Download thread/, /Mark as client/, /^Hide sender$/]) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy()

    fireEvent.click(more)
    const menu = screen.getByRole('menu', { name: 'More actions for this email' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Archive',
      'Download thread (.md)',
      '☆ Mark as client',
      'Hide sender',
    ])
    // A sender with a domain still gets the address-or-domain choice, shown inline.
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Hide sender' }))
    expect(screen.getByRole('button', { name: 'Hide all @acme.com.au' })).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('starts the Gmail sync only after the first list has loaded', async () => {
    render(<MailApp clients={CLIENTS} />)
    await waitFor(() => expect(calls.some((call) => call.url.startsWith('/api/mail/sync'))).toBe(true))
    const inboxAt = calls.findIndex((call) => call.url.startsWith('/api/mail/inbox'))
    const syncAt = calls.findIndex((call) => call.url.startsWith('/api/mail/sync'))
    expect(inboxAt).toBeGreaterThanOrEqual(0)
    expect(syncAt).toBeGreaterThan(inboxAt)
  })

  it('marks the folder you are on as the active tab', async () => {
    render(<MailApp clients={CLIENTS} />)
    const inbox = screen.getByRole('tab', { name: 'Inbox' })
    expect(inbox.getAttribute('aria-selected')).toBe('true')
    expect(inbox.className).toMatch(/folderActive/)
    fireEvent.click(screen.getByRole('tab', { name: 'Sent' }))
    expect(screen.getByRole('tab', { name: 'Sent' }).className).toMatch(/folderActive/)
    expect(screen.getByRole('tab', { name: 'Inbox' }).className).not.toMatch(/folderActive/)
    expect(screen.getByRole('tab', { name: 'Sent' }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('MailApp links opened while Mail is open (client email alert, bell)', () => {
  it('clears the search, shows the whole inbox again and opens the linked email', async () => {
    const { openMailLink } = await import('@/lib/mail/drafts')
    window.history.replaceState(null, '', '/admin/mail')
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    const search = screen.getByRole('combobox', { name: 'Search inbox' })
    fireEvent.change(search, { target: { value: 'invoice' } })
    fireEvent.submit(search.closest('form') as HTMLFormElement)
    await waitFor(() => expect(calls.some((call) => call.url.includes('q=invoice'))).toBe(true))
    calls = []

    const push = vi.fn()
    expect(openMailLink('/admin/mail?thread=t9', push)).toBe(true)
    expect(push).not.toHaveBeenCalled()
    await waitFor(() => expect(calls.some((call) => call.url === '/api/mail/thread/t9')).toBe(true))
    expect((search as HTMLInputElement).value).toBe('')
    const inbox = calls.find((call) => call.url.startsWith('/api/mail/inbox'))
    expect(inbox).toBeTruthy()
    expect(new URL(inbox?.url ?? '', 'https://mail.test').searchParams.get('q')).toBeNull()
  })

  it('navigates normally when Mail is not open', async () => {
    const { openMailLink } = await import('@/lib/mail/drafts')
    window.history.replaceState(null, '', '/admin/clients')
    const push = vi.fn()
    expect(openMailLink('/admin/mail?thread=t9', push)).toBe(false)
    expect(push).toHaveBeenCalledWith('/admin/mail?thread=t9')
    window.history.replaceState(null, '', '/')
  })
})

describe('MailApp breadcrumb account switcher', () => {
  it('offers one Add email account button that asks for the address and signs it in', async () => {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/mail/accounts')) {
        return {
          ok: true,
          json: async () => ({
            primary: 'me@team.test',
            accounts: [],
            addUrl: '/api/gmail/connect?add=1',
            canAdd: true,
          }),
        } as Response
      }
      return baseFetch(url, init)
    }) as unknown as typeof fetch
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    await waitFor(() => expect(nav.items).toHaveLength(2))
    const crumb = render(<>{nav.items[1]?.label as React.ReactElement}</>)
    fireEvent.click(await within(crumb.container).findByRole('button', { name: /me@team\.test/ }))
    const menu = await screen.findByRole('menu', { name: 'Gmail accounts' })
    const adds = within(menu).getAllByRole('menuitem').filter((item) => item.textContent?.startsWith('+'))
    expect(adds.map((item) => item.textContent)).toEqual(['+ Add email account'])
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location)
    fireEvent.click(adds[0] as HTMLElement)
    const box = within(menu).getByRole('textbox', { name: 'Email account to add' })
    // Not an address, or one already in Mail: stays in the menu with a message.
    fireEvent.change(box, { target: { value: 'pat' } })
    fireEvent.submit(box.closest('form') as HTMLFormElement)
    expect(within(menu).getByRole('alert').textContent).toBe('Enter a full email address.')
    fireEvent.change(box, { target: { value: 'ME@team.test' } })
    fireEvent.submit(box.closest('form') as HTMLFormElement)
    expect(within(menu).getByRole('alert').textContent).toBe('That account is already in Mail.')
    fireEvent.change(box, { target: { value: ' Pat@PartnerCo.com.au ' } })
    fireEvent.submit(box.closest('form') as HTMLFormElement)
    expect(assign).toHaveBeenCalledWith('/api/gmail/connect?add=1&email=pat%40partnerco.com.au')
  })

  it('shows Mail / <email> in the breadcrumb and switches every request to the chosen account', async () => {
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    await waitFor(() => expect(nav.items).toHaveLength(2))
    expect(nav.items[0]).toEqual({ label: 'Mail', url: '/admin/mail' })

    // Render the breadcrumb's email (the switcher) the way the admin header would.
    const crumb = render(<>{nav.items[1]?.label as React.ReactElement}</>)
    const button = await within(crumb.container).findByRole('button', { name: /me@team\.test/ })
    fireEvent.click(button)
    const menu = await screen.findByRole('menu', { name: 'Gmail accounts' })
    expect(within(menu).getByRole('menuitem', { name: '+ Add email account' })).toBeTruthy()
    calls = []
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^sales@team\.test/ }))

    await waitFor(() => expect(calls.some((call) => call.url.startsWith('/api/mail/inbox'))).toBe(true))
    for (const call of calls.filter((entry) => entry.url.startsWith('/api/mail/'))) {
      expect((call.init?.headers as Record<string, string>)['x-mail-account']).toBe('sales@team.test')
    }
  })

  it('opens on the account named in the link (?account=), e.g. from an alert', async () => {
    window.history.replaceState(null, '', '/admin/mail?account=sales%40team.test')
    render(<MailApp clients={CLIENTS} />)
    await waitFor(() => expect(calls.some((call) => call.url.startsWith('/api/mail/inbox'))).toBe(true))
    const inbox = calls.find((call) => call.url.startsWith('/api/mail/inbox'))
    expect((inbox?.init?.headers as Record<string, string>)['x-mail-account']).toBe('sales@team.test')
    expect(window.location.search).toBe('')
  })
})

describe('MailApp client pill for a sender', () => {
  it('changes which client a sender is added to', async () => {
    render(<MailApp clients={CLIENTS} />)
    fireEvent.click(await screen.findByText('Hello there'))
    fireEvent.click(await screen.findByRole('button', { name: 'Client: Acme ▾' }))
    fireEvent.change(screen.getByLabelText('Which emails'), { target: { value: 'jo@acme.com.au' } })
    fireEvent.change(screen.getByLabelText('Client for this sender'), { target: { value: 'clients' } })
    fireEvent.click(screen.getByLabelText('Beta'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/Emails from jo@acme\.com\.au now go to Beta\. Moved 3 saved emails to it\./)
    const post = calls.find((call) => call.url === '/api/mail/sender-client')
    expect(JSON.parse(String(post?.init?.body))).toEqual({ sender: 'jo@acme.com.au', clientIds: [2] })
  })

  it('links an agency sender to several clients and names them all on the pill', async () => {
    render(<MailApp clients={CLIENTS} />)
    fireEvent.click(await screen.findByText('Hello there'))
    fireEvent.click(await screen.findByRole('button', { name: 'Client: Acme ▾' }))
    fireEvent.change(screen.getByLabelText('Client for this sender'), { target: { value: 'clients' } })
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Acme'))
    fireEvent.click(screen.getByLabelText('Beta'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/is linked to Acme, Beta\. Assign each email to the right client\./)
    const post = calls.find((call) => call.url === '/api/mail/sender-client')
    expect(JSON.parse(String(post?.init?.body)).clientIds).toEqual([1, 2])
    expect(await screen.findByRole('button', { name: 'Client: Acme, Beta ▾' })).toBeTruthy()
  })
})

describe('MailApp "Open in new window"', () => {
  it('opens the open email in its own window, on the account on screen', async () => {
    window.history.replaceState(null, '', '/admin/mail?account=sales%40team.test')
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    render(<MailApp clients={CLIENTS} />)
    fireEvent.click(await screen.findByText('Hello there'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open in new window' }))
    expect(open).toHaveBeenCalledWith('/admin/mail/window?thread=t1&account=sales%40team.test', 'mail-t1', 'popup,width=1000,height=900')
  })

  it('says so when the browser blocks the window', async () => {
    window.history.replaceState(null, '', '/admin/mail')
    vi.spyOn(window, 'open').mockReturnValue(null)
    render(<MailApp clients={CLIENTS} />)
    fireEvent.click(await screen.findByText('Hello there'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open in new window' }))
    expect(await screen.findByText(/blocked the new window/)).toBeTruthy()
  })

  it('the window shows only that email, with reply and the other actions, and keeps its URL', async () => {
    window.history.replaceState(null, '', '/admin/mail/window?thread=t1&account=sales%40team.test')
    render(<MailApp clients={CLIENTS} windowMode />)
    const reader = await screen.findByTestId('mail-reader')
    await within(reader).findByRole('heading', { name: 'Hello there' })
    // No folder tabs, inbox list or account breadcrumb; no inbox loads or syncs.
    expect(screen.queryByRole('tablist', { name: 'Mail folders' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Search inbox' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open in new window' })).toBeNull()
    expect(calls.some((call) => call.url.startsWith('/api/mail/inbox') || call.url.startsWith('/api/mail/sync'))).toBe(false)
    // The thread is read on the account from the URL, and the URL stays for a reload.
    const threadCall = calls.find((call) => call.url === '/api/mail/thread/t1')
    expect((threadCall?.init?.headers as Record<string, string>)['x-mail-account']).toBe('sales@team.test')
    expect(window.location.search).toBe('?thread=t1&account=sales%40team.test')
    expect(document.title).toBe('Hello there · Mail')
    // Delete and Mark read/unread act on the window's one row, built once the thread loads.
    expect(await within(reader).findByRole('button', { name: 'Delete' })).toBeTruthy()
    for (const name of ['Reply', 'Reply all', 'Forward', 'Mark unread']) {
      expect(within(reader).getByRole('button', { name })).toBeTruthy()
    }
    fireEvent.click(within(reader).getByRole('button', { name: 'Reply' }))
    expect(await screen.findByTestId('compose')).toBeTruthy()
  })

  it('after Delete in the window, offers Undo, which brings the email back', async () => {
    window.history.replaceState(null, '', '/admin/mail/window?thread=t1')
    render(<MailApp clients={CLIENTS} windowMode />)
    const reader = await screen.findByTestId('mail-reader')
    await within(reader).findByRole('heading', { name: 'Hello there' })
    const del = await within(reader).findByRole('button', { name: 'Delete' })
    calls = []
    fireEvent.click(del)
    expect(await within(reader).findByText(/Deleted “Hello there”/)).toBeTruthy()
    expect(within(reader).getByRole('button', { name: 'Close window' })).toBeTruthy()
    fireEvent.click(within(reader).getByRole('button', { name: 'Undo' }))
    await within(reader).findByRole('heading', { name: 'Hello there' })
    const modify = calls.filter((call) => call.url === '/api/mail/modify').map((call) => JSON.parse(String(call.init?.body)))
    expect(modify).toEqual([
      { threadId: 't1', action: 'trash' },
      { threadId: 't1', action: 'untrash' },
    ])
  })
})

describe('MailApp Drafts bulk actions', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/admin/mail')
  })
  const drafts = [
    { ...thread, threadId: 'd1', messageId: 'dm1', to: 'a@x.com', subject: 'Draft one' },
    { ...thread, threadId: 'd2', messageId: 'dm2', to: 'b@x.com', subject: 'Draft two' },
    { ...thread, threadId: 'd3', messageId: 'dm3', to: 'c@x.com', subject: 'Draft three' },
  ]
  function mockDrafts(failOn?: string) {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/mail/inbox')) {
        calls.push({ url, init })
        const isDrafts = new URL(url, 'https://mail.test').searchParams.get('folder') === 'drafts'
        return { ok: true, json: async () => ({ threads: isDrafts ? drafts : [thread], nextPageToken: null, account: 'me@team.test', senderClients: [] }) } as Response
      }
      if (url.startsWith('/api/gmail/draft')) {
        calls.push({ url, init })
        const id = new URL(url, 'https://mail.test').searchParams.get('messageId')
        if (id === failOn) return { ok: false, status: 502, json: async () => ({ error: 'Gmail is down.' }) } as Response
        return { ok: true, json: async () => ({ ok: true, draftId: `g-${id}` }) } as Response
      }
      return baseFetch(url, init)
    }) as unknown as typeof fetch
  }

  it('ticking drafts offers Delete (no Mark as read), which deletes them after one confirm', async () => {
    mockDrafts()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    fireEvent.click(screen.getByRole('tab', { name: /Drafts/ }))
    await screen.findByText('Draft one')
    fireEvent.click(screen.getByRole('checkbox', { name: /Draft one/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Draft two/ }))
    expect(screen.getByText('2 selected')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Mark as read' })).toBeNull()
    // The bulk Delete is a bin icon (no visible text), so Clear fits beside it.
    const bulkDelete = within(screen.getByRole('toolbar', { name: 'Selected drafts' })).getByRole('button', { name: 'Delete' })
    expect(bulkDelete.textContent).toBe('')
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy()
    calls = []
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByText('Deleted 2 drafts')
    expect(confirm).toHaveBeenCalledTimes(1)
    const deletes = calls.filter((call) => call.url.startsWith('/api/gmail/draft'))
    expect(deletes.map((call) => [call.url, call.init?.method])).toEqual([
      ['/api/gmail/draft?messageId=dm1', 'DELETE'],
      ['/api/gmail/draft?messageId=dm2', 'DELETE'],
    ])
    expect(screen.queryByText('Draft one')).toBeNull()
    expect(screen.queryByText('Draft two')).toBeNull()
    expect(screen.getByText('Draft three')).toBeTruthy()
    expect(screen.queryByText('2 selected')).toBeNull()
  })

  it('Select all then Delete removes every draft; cancelling the confirm deletes nothing', async () => {
    mockDrafts()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true)
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    fireEvent.click(screen.getByRole('tab', { name: /Drafts/ }))
    await screen.findByText('Draft one')
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('3 selected')).toBeTruthy()
    calls = []
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(confirm).toHaveBeenCalledWith('Delete 3 drafts? This can’t be undone.')
    expect(calls.filter((call) => call.url.startsWith('/api/gmail/draft'))).toHaveLength(0)
    expect(screen.getByText('3 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByText('Deleted 3 drafts')
    expect(calls.filter((call) => call.url.startsWith('/api/gmail/draft'))).toHaveLength(3)
    expect(screen.getByText('No drafts.')).toBeTruthy()
  })

  it('stops at a failed draft, says how many went, and keeps the rest ticked', async () => {
    mockDrafts('dm2')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    fireEvent.click(screen.getByRole('tab', { name: /Drafts/ }))
    await screen.findByText('Draft one')
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByText('2 selected')
    expect(screen.queryByText('Draft one')).toBeNull()
    expect(screen.getByText('Draft two')).toBeTruthy()
    expect(screen.getByText('Draft three')).toBeTruthy()
  })
})

describe('Inbox row read/unread toggle', () => {
  it('marks a read row unread and back again from the row, without opening it', async () => {
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    calls = []
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread: Jo Smith: Hello there' }))
    expect(await screen.findByRole('button', { name: 'Mark read: Jo Smith: Hello there' })).toBeTruthy()
    await waitFor(() =>
      expect(calls.some((call) => call.url === '/api/mail/modify' && JSON.parse(String(call.init?.body)).action === 'unread')).toBe(true),
    )
    expect(calls.some((call) => call.url.startsWith('/api/mail/thread/'))).toBe(false)
    const modify = calls.find((call) => call.url === '/api/mail/modify')
    expect(JSON.parse(String(modify?.init?.body))).toEqual({ threadId: 't1', action: 'unread' })

    await waitFor(() => expect((screen.getByRole('button', { name: 'Mark read: Jo Smith: Hello there' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Mark read: Jo Smith: Hello there' }))
    expect(await screen.findByRole('button', { name: 'Mark unread: Jo Smith: Hello there' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete Jo Smith: Hello there' })).toBeTruthy()
  })

  it('puts the row back when Gmail refuses', async () => {
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('Hello there')
    const ok = global.fetch
    global.fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url === '/api/mail/modify'
        ? ({ ok: false, status: 500, json: async () => ({ error: 'Gmail said no.' }) } as Response)
        : ok(url, init),
    ) as unknown as typeof fetch
    fireEvent.click(screen.getByRole('button', { name: 'Mark unread: Jo Smith: Hello there' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'Mark unread: Jo Smith: Hello there' }) as HTMLButtonElement).disabled).toBe(false))
  })
})

describe('Mail drag-select', () => {
  const rows = [
    { ...thread, threadId: 't1', subject: 'First' },
    { ...thread, threadId: 't2', messageId: 'm2', subject: 'Second' },
    { ...thread, threadId: 't3', messageId: 'm3', subject: 'Third' },
    { ...thread, threadId: 't4', messageId: 'm4', subject: 'Fourth' },
  ]
  async function mountRows() {
    const baseFetch = global.fetch
    global.fetch = vi.fn(async (url: string, init?: RequestInit) =>
      url.startsWith('/api/mail/inbox')
        ? ({ ok: true, json: async () => ({ threads: rows, nextPageToken: null, account: 'me@team.test', senderClients: [] }) } as Response)
        : baseFetch(url, init),
    ) as unknown as typeof fetch
    render(<MailApp clients={CLIENTS} />)
    await screen.findByText('First')
  }
  const box = (name: RegExp) => screen.getByRole('checkbox', { name }) as HTMLInputElement
  const li = (name: RegExp) => box(name).closest('li') as HTMLElement
  // jsdom has no layout: point elementFromPoint at the row being dragged over.
  function dragOver(target: HTMLElement) {
    document.elementFromPoint = vi.fn(() => target) as unknown as typeof document.elementFromPoint
    fireEvent.pointerMove(document, { clientX: 1, clientY: 1 })
  }

  it('ticks every row from the start checkbox to the one the pointer is released on', async () => {
    await mountRows()
    fireEvent.pointerDown(box(/First/).closest('label')!, { button: 0, pointerType: 'mouse' })
    dragOver(li(/Second/))
    dragOver(li(/Third/))
    fireEvent.pointerUp(document)
    fireEvent.click(li(/Third/))
    expect([/First/, /Second/, /Third/, /Fourth/].map((name) => box(name).checked)).toEqual([true, true, true, false])
    expect(screen.getByText('3 selected')).toBeTruthy()
  })

  it('dragging back up unticks rows it passed, and a drag that starts on a ticked row unticks', async () => {
    await mountRows()
    fireEvent.pointerDown(box(/First/).closest('label')!, { button: 0, pointerType: 'mouse' })
    dragOver(li(/Fourth/))
    dragOver(li(/Second/))
    fireEvent.pointerUp(document)
    expect([/First/, /Second/, /Third/, /Fourth/].map((name) => box(name).checked)).toEqual([true, true, false, false])
    await new Promise((resolve) => setTimeout(resolve, 0))

    fireEvent.pointerDown(box(/Second/).closest('label')!, { button: 0, pointerType: 'mouse' })
    dragOver(li(/First/))
    fireEvent.pointerUp(document)
    // The click that ends the drag on the start checkbox does not flip it back.
    fireEvent.click(box(/Second/))
    expect([/First/, /Second/].map((name) => box(name).checked)).toEqual([false, false])
  })

  it('a plain click still ticks one row, and touch does not start a drag', async () => {
    await mountRows()
    fireEvent.pointerDown(box(/Third/).closest('label')!, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(document)
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.click(box(/Third/))
    expect(box(/Third/).checked).toBe(true)

    fireEvent.pointerDown(box(/First/).closest('label')!, { button: 0, pointerType: 'touch' })
    dragOver(li(/Second/))
    expect(box(/Second/).checked).toBe(false)
  })
})
