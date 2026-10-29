import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ClientEmailBriefPanel, { BriefText, type ClientEmailBrief } from '@/components/mail/ClientEmailBriefPanel'

const brief: ClientEmailBrief = {
  id: 1,
  filterKey: '',
  account: 'pat@ourteam.example',
  ownerId: 3,
  brief: '## Decisions and agreements\n- **1 Mar 2026**: budget set at $2,000.',
  emailCount: 4,
  firstEmailDate: '2026-01-02T00:00:00.000Z',
  lastEmailDate: '2026-03-01T00:00:00.000Z',
  lastPulledAt: '2026-03-02T00:00:00.000Z',
}

function mockFetch(routes: Record<string, (init?: RequestInit) => unknown>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const handler = Object.entries(routes).find(([path]) => url.split('?')[0] === path)?.[1]
    const body = handler ? handler(init) : { error: 'not found' }
    return { ok: handler !== undefined, status: handler ? 200 : 404, json: async () => body } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ClientEmailBriefPanel', () => {
  it('pulls from the chosen Gmail account, then reloads the tab', async () => {
    const fetchMock = mockFetch({
      '/api/mail/accounts': () => ({ primary: 'pat@ourteam.example', accounts: [{ email: 'hello@ourteam.example' }] }),
      '/api/mail/client-pull': () => ({ ok: true, found: 12, saved: 3, more: false, leftOut: 0, briefUpdated: true, brief }),
    })
    const onPulled = vi.fn()
    render(<ClientEmailBriefPanel clientId={7} briefs={[brief]} hasEmails onPulled={onPulled} />)

    const select = await screen.findByLabelText('Gmail account')
    // The main account already has a brief, so the button pulls only new mail.
    expect(screen.getByRole('button', { name: 'Pull new emails' })).toBeTruthy()
    fireEvent.change(select, { target: { value: 'hello@ourteam.example' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pull emails' }))
    })

    const pullCall = fetchMock.mock.calls.find(([url]) => url === '/api/mail/client-pull')
    expect(pullCall?.[1]?.headers).toMatchObject({ 'x-mail-account': 'hello@ourteam.example' })
    expect(JSON.parse(String(pullCall?.[1]?.body))).toEqual({ clientId: 7 })
    expect(onPulled).toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('Found 12 emails (3 newly saved). Brief updated.')
  })

  it('asks a question and lists the emails the answer read', async () => {
    const fetchMock = mockFetch({
      '/api/mail/accounts': () => ({ primary: 'pat@ourteam.example', accounts: [] }),
      '/api/mail/client-ask': () => ({
        answer: 'The budget is $2,000 [E1].',
        sources: [{ label: 'E1', id: 11, subject: 'Budget', date: '2026-03-01T00:00:00.000Z', gmailLink: 'https://mail.google.com/mail/u/0/#all/m1' }],
      }),
    })
    render(<ClientEmailBriefPanel clientId={7} briefs={[brief]} hasEmails onPulled={() => undefined} />)
    await screen.findByText('Searches pat@ourteam.example')

    fireEvent.change(screen.getByLabelText('Ask about these emails'), { target: { value: 'What budget did we agree?' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    })
    await waitFor(() => expect(screen.getByText('The budget is $2,000 [E1].')).toBeTruthy())
    expect(screen.getByRole('link', { name: 'Open in Gmail' }).getAttribute('href')).toBe('https://mail.google.com/mail/u/0/#all/m1')
    const askCall = fetchMock.mock.calls.find(([url]) => url === '/api/mail/client-ask')
    expect(JSON.parse(String(askCall?.[1]?.body))).toEqual({ clientId: 7, question: 'What budget did we agree?', history: [] })
  })

  it('cannot ask before anything is pulled', async () => {
    mockFetch({ '/api/mail/accounts': () => ({ primary: 'pat@ourteam.example', accounts: [] }) })
    render(<ClientEmailBriefPanel clientId={7} briefs={[]} hasEmails={false} onPulled={() => undefined} />)
    expect((screen.getByLabelText('Ask about these emails') as HTMLTextAreaElement).disabled).toBe(true)
    expect(await screen.findByRole('button', { name: 'Pull emails' })).toBeTruthy()
  })
})

describe('ClientEmailBriefPanel search settings', () => {
  const settingsView = {
    settings: { useClientContacts: true, senders: [], keywords: [], matchMode: 'any' },
    filterKey: 'default',
    defaultFilterKey: 'default',
    description: "the client's contacts",
    clientTargets: { domains: ['custom.com.au', 'northwind.com.au'], addresses: [] },
  }

  it('saves senders and keywords for the client and says the next pull starts the brief afresh', async () => {
    const fetchMock = mockFetch({
      '/api/mail/accounts': () => ({ primary: 'pat@ourteam.example', accounts: [] }),
      '/api/mail/client-pull-settings': (init) =>
        init?.method === 'PUT'
          ? {
              ...settingsView,
              settings: { useClientContacts: false, senders: ['pmorris@northwind.com.au'], keywords: ['Custom Fluid'], matchMode: 'all' },
              filterKey: 'custom',
              description: 'pmorris@northwind.com.au and "Custom Fluid"',
            }
          : settingsView,
    })
    render(<ClientEmailBriefPanel clientId={7} briefs={[brief]} hasEmails onPulled={() => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Search settings' }))
    expect(screen.getByText(/custom\.com\.au, northwind\.com\.au/)).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText(/Senders or recipients/), { target: { value: 'pmorris@northwind.com.au' } })
    fireEvent.change(screen.getByLabelText(/^Keywords/), { target: { value: 'Custom Fluid' } })
    fireEvent.click(screen.getByLabelText(/Both: one of the senders/))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save search settings' }))
    })

    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      clientId: 7,
      useClientContacts: false,
      senders: ['pmorris@northwind.com.au'],
      keywords: ['Custom Fluid'],
      matchMode: 'all',
    })
    expect(screen.getByText('pmorris@northwind.com.au and "Custom Fluid"')).toBeTruthy()
    expect(screen.getByText(/The search settings changed since the brief below was written/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pull emails' })).toBeTruthy()
  })
})

describe('BriefText', () => {
  it('renders headings, bullets and bold as text, never as HTML from the email', () => {
    const { container } = render(<BriefText text={'## Open items\n- **Photos** due <img src=x onerror=alert(1)>'} />)
    expect(container.querySelector('h4')?.textContent).toBe('Open items')
    expect(container.querySelector('li strong')?.textContent).toBe('Photos')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('Add key date to the account timeline', () => {
  it('puts a button right after each key date, and one click adds it', async () => {
    const fetchMock = mockFetch({
      '/api/mail/accounts': () => ({ primary: 'pat@ourteam.example', accounts: [] }),
      '/api/mail/client-timeline': () => ({ added: true }),
    })
    render(
      <ClientEmailBriefPanel
        clientId={7}
        briefs={[{ ...brief, brief: '## Open items\n- 30 Oct 2026: Not a key date.\n## Key dates\n- 23 Jun 2026: Search query review.\n- Soon: no date here' }]}
        hasEmails
        onPulled={() => undefined}
      />,
    )
    // Wait for the accounts list, which moves this brief to the selected-account slot.
    await screen.findByText('Searches pat@ourteam.example')
    const button = screen.getByRole('button', { name: 'Add to account timeline: 2026-06-23, Search query review.' })
    // Only the dated Key dates bullet gets one.
    expect(screen.getAllByRole('button', { name: /^Add to account timeline/ })).toHaveLength(1)
    expect(button.closest('li')?.textContent).toContain('23 Jun 2026: Search query review.')

    await act(async () => {
      fireEvent.click(button)
    })
    await waitFor(() => expect(screen.getByText('Added to timeline ✓')).toBeTruthy())
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/mail/client-timeline')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ clientId: 7, day: '2026-06-23', description: 'Search query review.' })
  })
})
