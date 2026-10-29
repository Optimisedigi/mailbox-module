import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('@payloadcms/ui', () => ({ useStepNav: () => ({ setStepNav: () => undefined, stepNav: [] }) }))
// Shows what the compose window was opened with: the body and the Write with AI box.
vi.mock('@/components/mail/ComposeWindow', () => ({
  default: ({ initial }: { initial: { html: string; aiPrompt?: string } }) => (
    <div data-testid="compose" data-html={initial.html} data-ai-prompt={initial.aiPrompt ?? ''} />
  ),
}))
vi.mock('@/components/mail/EmailBody', () => ({ default: () => <div /> }))

const { default: MailApp } = await import('@/components/mail/MailApp')

const thread = {
  threadId: 't1', messageId: 'm1', from: 'Melissa Davies <md@northwind.com.au>', to: 'me@team.test', subject: 'Spend',
  snippet: 'snippet', date: new Date().toISOString(), unread: false, messageCount: 1,
}
const message = {
  ...thread, cc: '', body: 'Why is the total over?', html: '', stored: null, match: null,
  attachments: [{ partId: '1', filename: 'Spend report.pdf', mimeType: 'application/pdf', size: 52_000 }],
}
const TLDR = {
  summary: 'Melissa asks why total spend is over budget.',
  actions: ['Check monthly spend against budget'],
  questions: ['Which month are you looking at?'],
  reply: 'Explain that unspent budget rolls into the next month',
  model: 'm',
}

const TLDR_OVERRIDE: { questions?: string[] } = {}
const MESSAGE_OVERRIDE: { attachments?: typeof message.attachments } = {}
let calls: Array<{ url: string; init?: RequestInit }> = []
beforeEach(() => {
  delete TLDR_OVERRIDE.questions
  delete MESSAGE_OVERRIDE.attachments
  calls = []
  localStorage.clear()
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body = url.startsWith('/api/mail/inbox')
      ? { threads: [thread], nextPageToken: null, account: 'me@team.test', senderClients: [] }
      : url.startsWith('/api/mail/thread/')
        ? { messages: [{ ...message, ...MESSAGE_OVERRIDE }] }
        : url.includes('/attachment?')
          ? { blob: true }
        : url === '/api/mail/tldr'
          ? { ...TLDR, ...TLDR_OVERRIDE }
          : url.startsWith('/api/mail/accounts')
            ? { primary: 'me@team.test', accounts: [], addUrl: '', canAdd: false }
            : {}
    return { ok: true, json: async () => body, blob: async () => new Blob(['%PDF-']) } as Response
  }) as unknown as typeof fetch
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Mail TLDR', () => {
  it('shows the summary, actions and suggested reply apart from any reply, and the reply goes only into the AI box', async () => {
    render(<MailApp clients={[]} />)
    fireEvent.click(await screen.findByText('Spend'))
    fireEvent.click(within(await screen.findByTestId('mail-message-foot')).getByRole('button', { name: 'TLDR' }))

    expect(await screen.findByText(TLDR.summary)).toBeTruthy()
    expect(screen.getByText(TLDR.actions[0]!)).toBeTruthy()
    const tldrCall = calls.find((call) => call.url === '/api/mail/tldr')
    expect(JSON.parse(String(tldrCall?.init?.body))).toEqual({ gmailMessageId: 'm1' })
    // Reading a TLDR opens no reply.
    expect(screen.queryByTestId('compose')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: new RegExp(TLDR.reply) }))
    const compose = await screen.findByTestId('compose')
    expect(compose.getAttribute('data-ai-prompt')).toBe(TLDR.reply)
    expect(compose.getAttribute('data-html')).toBe('')
    expect(compose.getAttribute('data-html')).not.toContain(TLDR.summary)
    // Nothing was sent or saved.
    await waitFor(() => expect(calls.some((call) => /\/api\/mail\/(send|summaries|schedule)/.test(call.url))).toBe(false))
  })

  it('lists clarifying questions and puts them only into the AI box when asked', async () => {
    render(<MailApp clients={[]} />)
    fireEvent.click(await screen.findByText('Spend'))
    fireEvent.click(within(await screen.findByTestId('mail-message-foot')).getByRole('button', { name: 'TLDR' }))
    expect(await screen.findByText(TLDR.questions[0]!)).toBeTruthy()
    expect(screen.queryByTestId('compose')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ask these in a reply' }))
    const compose = await screen.findByTestId('compose')
    expect(compose.getAttribute('data-ai-prompt')).toContain(TLDR.questions[0])
    expect(compose.getAttribute('data-html')).toBe('')
  })

  it('shows no clarifying questions section when the email covers everything', async () => {
    TLDR_OVERRIDE.questions = []
    render(<MailApp clients={[]} />)
    fireEvent.click(await screen.findByText('Spend'))
    fireEvent.click(within(await screen.findByTestId('mail-message-foot')).getByRole('button', { name: 'TLDR' }))
    expect(await screen.findByText(TLDR.summary)).toBeTruthy()
    expect(screen.queryByText('Clarifying questions')).toBeNull()
  })

  it('lists the email\'s attachments and downloads one from this mailbox', async () => {
    const created: string[] = []
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      created.push(this.download)
    })
    render(<MailApp clients={[]} />)
    fireEvent.click(await screen.findByText('Spend'))
    const button = await screen.findByRole('button', { name: 'Download Spend report.pdf' })
    expect(button.textContent).toContain('51 KB')
    fireEvent.click(button)
    await waitFor(() => expect(created).toEqual(['Spend report.pdf']))
    expect(calls.some((call) => call.url === '/api/mail/message/m1/attachment?part=1')).toBe(true)
    click.mockRestore()
  })

  it('shows Download all only when an email has more than one attachment, and downloads each file', async () => {
    const created: string[] = []
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      created.push(this.download)
    })
    MESSAGE_OVERRIDE.attachments = [
      ...message.attachments,
      { partId: '2', filename: 'Invoice.xlsx', mimeType: 'application/vnd.ms-excel', size: 9_000 },
    ]
    render(<MailApp clients={[]} />)
    fireEvent.click(await screen.findByText('Spend'))
    fireEvent.click(await screen.findByRole('button', { name: 'Download all 2 attachments' }))
    await waitFor(() => expect(created).toEqual(['Spend report.pdf', 'Invoice.xlsx']))
    expect(calls.filter((call) => call.url.includes('/attachment?')).map((call) => call.url)).toEqual([
      '/api/mail/message/m1/attachment?part=1',
      '/api/mail/message/m1/attachment?part=2',
    ])
    click.mockRestore()
  })

  it('has no Download all button for a single attachment', async () => {
    render(<MailApp clients={[]} />)
    fireEvent.click(await screen.findByText('Spend'))
    await screen.findByRole('button', { name: 'Download Spend report.pdf' })
    expect(screen.queryByRole('button', { name: /Download all/ })).toBeNull()
  })

  it('the reading pane header has a TLDR button too, left of Reply, that opens and closes the TLDR', async () => {
    render(<MailApp clients={[]} />)
    fireEvent.click(await screen.findByText('Spend'))
    const reply = await screen.findByRole('button', { name: 'Reply' })
    const header = reply.parentElement as HTMLElement
    const buttons = Array.from(header.querySelectorAll('button')).map((button) => button.textContent)
    // Ask AI sits between TLDR and Reply.
    expect(buttons.indexOf('TLDR')).toBe(buttons.indexOf('Reply') - 2)
    expect(buttons.indexOf('Ask AI')).toBe(buttons.indexOf('Reply') - 1)
    const tldrButton = Array.from(header.querySelectorAll('button')).find((button) => button.textContent === 'TLDR') as HTMLButtonElement
    fireEvent.click(tldrButton)
    expect(await screen.findByText(TLDR.summary)).toBeTruthy()
    expect(tldrButton.getAttribute('aria-expanded')).toBe('true')
    expect(JSON.parse(String(calls.find((call) => call.url === '/api/mail/tldr')?.init?.body))).toEqual({ gmailMessageId: 'm1' })
    fireEvent.click(tldrButton)
    expect(screen.queryByText(TLDR.summary)).toBeNull()
    expect(screen.queryByTestId('compose')).toBeNull()
  })
})

describe('Mail Ask AI and reader toolbar', () => {
  it('asks a question about the open thread, shows the answer and sends or changes nothing', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    const base = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/mail/thread-ask'
        ? (calls.push({ url, init }),
          { ok: true, json: async () => ({ answer: 'The retainer is $2,500 a month.', client: { id: 7, name: 'Northwind' }, model: 'm' }) } as Response)
        : base(url, init),
    )
    render(<MailApp clients={[]} />)
    fireEvent.click(await screen.findByText('Spend'))
    const ask = await screen.findByRole('button', { name: 'Ask AI' })
    // Sits right after TLDR in the header.
    expect(ask.previousElementSibling?.textContent).toBe('TLDR')
    fireEvent.click(ask)
    const panel = screen.getByRole('region', { name: 'Ask AI, only visible to you' })
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Question about this email' }), { target: { value: "What is the client's monthly retainer?" } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Ask' }))
    expect(await within(panel).findByText('The retainer is $2,500 a month.')).toBeTruthy()
    expect(within(panel).getByText(/Northwind's client summaries/)).toBeTruthy()
    const askCall = calls.find((call) => call.url === '/api/mail/thread-ask')
    expect(JSON.parse(String(askCall?.init?.body))).toEqual({ threadId: 't1', question: "What is the client's monthly retainer?", history: [] })
    expect(screen.queryByTestId('compose')).toBeNull()
    expect(calls.some((call) => /\/api\/mail\/(send|modify|summaries|schedule)/.test(call.url))).toBe(false)
  })

  it('shows Mark unread as an icon, Archive in the ⋯ menu and a maroon Delete', async () => {
    render(<MailApp clients={[]} />)
    fireEvent.click(await screen.findByText('Spend'))
    const unread = await screen.findByRole('button', { name: 'Mark unread' })
    expect(unread.textContent).toBe('')
    expect(unread.querySelector('svg')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete' }).className).toMatch(/deleteBtn/)
    fireEvent.click(screen.getByRole('button', { name: 'More actions for this email' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    await waitFor(() => expect(calls.some((call) => call.url === '/api/mail/modify' && String(call.init?.body).includes('"archive"'))).toBe(true))
  })
})

describe('Mail header', () => {
  it('shows folder tabs with badges, Triage/Clients/Hidden toggles, an icon Refresh, then Add calendar invite and Write message', async () => {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>
    const base = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.startsWith('/api/mail/counts')
        ? ({ ok: true, json: async () => ({ inboxUnread: 42, drafts: 5 }) } as Response)
        : base(url, init),
    )
    render(<MailApp clients={[]} />)
    const tabs = screen.getByRole('tablist', { name: 'Mail folders' })
    const inbox = await within(tabs).findByRole('tab', { name: 'Inbox (42)' })
    expect(inbox.getAttribute('aria-selected')).toBe('true')
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Inbox42', 'Sent', 'Drafts5', 'Scheduled', 'Awaiting reply'])
    // Panel toggles sit outside the folder tabs.
    for (const name of ['Triage', 'Clients', 'Hidden']) expect(within(tabs).queryByRole('button', { name })).toBeNull()
    const triage = screen.getByRole('button', { name: 'Triage' })
    expect(triage.getAttribute('aria-expanded')).toBe('false')
    const refresh = screen.getByRole('button', { name: 'Refresh' })
    expect(refresh.textContent).toBe('')
    const invite = screen.getByRole('button', { name: 'Add calendar invite' })
    const write = screen.getByRole('button', { name: 'Write message' })
    expect(refresh.compareDocumentPosition(invite) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(invite.compareDocumentPosition(write) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
