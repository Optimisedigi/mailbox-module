import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import TriagePanel from '@/components/mail/TriagePanel'

afterEach(cleanup)

const ANN_IDS = Array.from({ length: 200 }, (_, i) => `a${i}`)

const RESULT = {
  scanned: 233,
  truncated: false,
  failedBatches: 0,
  categories: [
    {
      key: 'sales_pitch',
      label: 'Sales pitches',
      count: 230,
      defaultSelected: true,
      senders: [
        { address: 'ann@seo.io', name: 'Ann', count: 200, subjects: ['Rank #1', 'Bump', 'Again', 'Last try'], messageIds: ANN_IDS },
        { address: 'bob@dev.io', name: 'Bob', count: 30, subjects: ['Apps'], messageIds: ['b1'] },
      ],
    },
    { key: 'clients', label: 'Clients', count: 3, defaultSelected: false, senders: [{ address: 'jo@acme.com', name: 'Jo', count: 3, subjects: ['Invoice'], messageIds: ['c1'] }] },
  ],
}

describe('TriagePanel saved results', () => {
  const sortingApi = () =>
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/mail/tags') return { tags: [] } as never
      if (url !== '/api/mail/triage') return { ok: true } as never
      const body = JSON.parse(String(init?.body))
      if (body.step === 'list') return { ids: ['a0'], truncated: false } as never
      if (body.step === 'read') return { messages: [{ messageId: 'a0' }] } as never
      const { truncated: _t, ...sorted } = RESULT
      return sorted as never
    })

  it('shows the last triage again after closing, until it is all actioned, and Triage again replaces it', async () => {
    localStorage.clear()
    const api = sortingApi()
    const first = render(<TriagePanel account="" api={api} onApplied={vi.fn()} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Triage unread emails' }))
    })
    fireEvent.click(screen.getByRole('button', { name: /Sales pitches/ }))
    fireEvent.click(screen.getByLabelText('Clear Bob (bob@dev.io)'))
    first.unmount()

    // Reopened: the results and what was ticked are back, without asking the AI again.
    const second = render(<TriagePanel account="" api={api} onApplied={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('233 unread emails from 3 senders.')).toBeTruthy()
    expect(screen.getByText(/Saved results from/)).toBeTruthy()
    expect(screen.getByText('Selected: 200 emails from 1 sender')).toBeTruthy()
    expect(api.mock.calls.filter(([url]) => url === '/api/mail/triage')).toHaveLength(3)

    // Triage again: the old run is replaced (one saved entry, the fresh selection).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Triage again' }))
    })
    expect(screen.getByText('Selected: 230 emails from 2 senders')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('mail-triage:main') ?? '{}').selected).toEqual(['ann@seo.io', 'bob@dev.io'])

    // Archive everything left, Clients included: nothing is left to action, so the saved run is deleted.
    fireEvent.click(screen.getByRole('button', { name: /^Clients/ }))
    fireEvent.click(screen.getByLabelText('Clear Jo (jo@acme.com)'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Archive selected' }))
    })
    expect(localStorage.getItem('mail-triage:main')).toBeNull()
    second.unmount()
    localStorage.clear()
  })
})

describe('TriagePanel', () => {
  it('reads a big inbox in chunks with progress, and sorts what was read if Gmail stops a later chunk', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `m${i}`)
    const bodies: Array<{ step: string; ids?: string[]; messages?: unknown[] }> = []
    let release: (() => void) | undefined
    const api = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/mail/tags') return { tags: [] } as never
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      if (body.step === 'list') return { ids, truncated: false } as never
      if (body.step === 'read') {
        const reads = bodies.filter((b) => b.step === 'read').length
        if (reads === 2) await new Promise<void>((resolve) => (release = resolve))
        if (reads === 3) throw new Error('Gmail is busy: too many requests in the last minute. Try again in a minute.')
        return { messages: (body.ids as string[]).map((messageId) => ({ messageId })) } as never
      }
      return { ...RESULT, scanned: (body.messages as unknown[]).length, truncated: undefined } as never
    })
    render(<TriagePanel api={api} onApplied={vi.fn()} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Triage unread emails' }))
    })
    // Second chunk in flight: progress shows how far it got and roughly how long is left.
    expect(screen.getByRole('status').textContent).toMatch(/Reading senders and subjects: 200 of 450\. .*under a minute/)
    await act(async () => {
      release?.()
    })
    expect(bodies.filter((b) => b.step === 'read').map((b) => b.ids?.length)).toEqual([200, 200, 50])
    // The third chunk failed: the 400 read so far are sorted, and the panel says it stopped early.
    expect(bodies.at(-1)?.step).toBe('sort')
    expect(bodies.at(-1)?.messages).toHaveLength(400)
    expect(screen.getByText(/Only the newest 400 were checked/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/Gmail stopped the reading early \(Gmail is busy/)
  })

  it('shows the error when even the first chunk fails, without sorting', async () => {
    const api = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/mail/tags') return { tags: [] } as never
      const body = JSON.parse(String(init?.body))
      if (body.step === 'list') return { ids: ['m1'], truncated: false } as never
      throw new Error('Gmail is busy: too many requests in the last minute. Try again in a minute.')
    })
    render(<TriagePanel api={api} onApplied={vi.fn()} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Triage unread emails' }))
    })
    expect(screen.getByRole('status').textContent).toMatch(/^Gmail is busy/)
    expect(api.mock.calls.filter(([url]) => url === '/api/mail/triage').map(([, init]) => JSON.parse(String(init?.body)).step)).toEqual(['list', 'read'])
  })

  it('summarises categories, lets senders be unticked, and archives only what is still ticked', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const api = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url === '/api/mail/tags') return { tags: [] } as never
      if (url !== '/api/mail/triage') return { ok: true } as never
      const step = (calls[calls.length - 1]?.body as { step?: string } | null)?.step
      if (step === 'list') return { ids: ['a0'], truncated: false } as never
      if (step === 'read') return { messages: [{ messageId: 'a0' }] } as never
      const { truncated: _t, ...sorted } = RESULT
      return sorted as never
    })
    const onApplied = vi.fn()
    render(<TriagePanel api={api} onApplied={onApplied} onClose={vi.fn()} />)
    // Nothing is read or sorted until asked (only the saved tags load).
    expect(api.mock.calls.map(([url]) => url)).toEqual(['/api/mail/tags'])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Triage unread emails' }))
    })
    expect(screen.getByText('233 unread emails from 3 senders.')).toBeTruthy()
    // Category table: emails, senders and share per category, plus a total row.
    const table = screen.getByRole('table', { name: 'Unread emails by category' })
    const salesRow = within(table).getByRole('row', { name: /Sales pitches/ })
    expect(within(salesRow).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['', '230', '2', '99%', '230'])
    expect(within(table).getByRole('row', { name: /Total/ }).textContent).toContain('233')
    // Clients are not selected by default; sales pitches are.
    expect(screen.getByText('Selected: 230 emails from 2 senders')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Sales pitches/ }))
    expect(screen.getByText('+1 more subjects')).toBeTruthy()
    // Sender table inside the category: one row per sender, however many emails they sent.
    const senders = screen.getByRole('table', { name: 'Sales pitches by sender' })
    expect(within(senders).getAllByRole('row')).toHaveLength(3)
    fireEvent.click(screen.getByLabelText('Clear Bob (bob@dev.io)'))
    expect(screen.getByText('Selected: 200 emails from 1 sender')).toBeTruthy()
    expect((screen.getByLabelText('Select all Sales pitches') as HTMLInputElement).indeterminate).toBe(true)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Archive selected' }))
    })
    expect(calls.filter((call) => call.url === '/api/mail/triage/apply')[0]).toEqual({ url: '/api/mail/triage/apply', body: { messageIds: ANN_IDS, action: 'archive' } })
    expect(onApplied).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Ann')).toBeNull()
    expect(screen.getByText('33 unread emails from 2 senders.')).toBeTruthy()
  })

  it('deletes the ticked emails to the Bin after confirming, with the actions on the left of the footer', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const api = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url, body })
      if (url === '/api/mail/tags') return { tags: [] } as never
      if (url !== '/api/mail/triage') return { ok: true } as never
      if (body.step === 'list') return { ids: ['a0'], truncated: false } as never
      if (body.step === 'read') return { messages: [{ messageId: 'a0' }] } as never
      const { truncated: _t, ...sorted } = RESULT
      return sorted as never
    })
    render(<TriagePanel api={api} onApplied={vi.fn()} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Triage unread emails' }))
    })
    const markRead = screen.getByRole('button', { name: 'Mark selected read' })
    const footerButtons = Array.from(markRead.parentElement?.querySelectorAll('button') ?? []).map((b) => b.textContent)
    expect(footerButtons.slice(0, 3)).toEqual(['Mark selected read', 'Archive selected', 'Delete selected'])

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    expect(calls.some((call) => call.url === '/api/mail/triage/apply')).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    })
    const applied = calls.filter((call) => call.url === '/api/mail/triage/apply').map((call) => call.body as { action: string; messageIds: string[] })
    expect(applied.map((body) => body.action)).toEqual(['trash'])
    expect(applied[0]?.messageIds).toEqual([...ANN_IDS, 'b1'])
    expect(screen.getByRole('status').textContent).toMatch(/Deleted 201 emails \(in Gmail's Bin for 30 days\)/)
    confirm.mockRestore()
  })

  /** A panel with RESULT sorted, recording every call; `tags` are the saved tags. */
  async function sortedPanel(tags: unknown[] = [], props: { onOpenTag?: (tag: unknown) => void } = {}) {
    const calls: Array<{ url: string; body: unknown }> = []
    const api = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url, body })
      if (url === '/api/mail/tags') {
        return (init?.method === 'POST' ? { tag: { id: 'Label_9', name: body.name, total: 0, unread: 0 } } : { tags }) as never
      }
      if (url !== '/api/mail/triage') return { ok: true } as never
      if (body.step === 'list') return { ids: ['a0'], truncated: false } as never
      if (body.step === 'read') return { messages: [{ messageId: 'a0' }] } as never
      const { truncated: _t, ...sorted } = RESULT
      return sorted as never
    })
    render(<TriagePanel api={api} onApplied={vi.fn()} onClose={vi.fn()} {...props} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Triage unread emails' }))
    })
    return calls
  }

  it('finds a sender while everything is selected and unticks all of theirs, so Archive keeps them', async () => {
    const calls = await sortedPanel()
    // Sales pitches start ticked; tick Clients too, so everything is selected.
    fireEvent.click(screen.getByLabelText('Select all Clients'))
    expect(screen.getByText('Selected: 233 emails from 3 senders')).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find senders' }), { target: { value: 'ann' } })
    const matching = screen.getByRole('table', { name: 'Senders matching the search' })
    expect(within(matching).getAllByRole('row')).toHaveLength(2)
    expect(within(matching).getByText('Sales pitches')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Untick all matching' }))
    expect(screen.getByText(/Selected: 33 emails from 2 senders/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Archive selected' }))
    })
    const applied = calls.filter((call) => call.url === '/api/mail/triage/apply').flatMap((call) => (call.body as { messageIds: string[] }).messageIds)
    expect(applied.sort()).toEqual(['b1', 'c1'])
  })

  it('saves a new tag for the matching senders, tags their emails and unticks them', async () => {
    const calls = await sortedPanel()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find senders' }), { target: { value: 'bob' } })
    fireEvent.change(screen.getByLabelText('New tag name for the matching emails'), { target: { value: 'Baby reads' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tag 30 matching emails' }))
    })
    expect(calls.find((call) => call.url === '/api/mail/tags' && call.body)?.body).toEqual({ name: 'Baby reads' })
    expect(calls.filter((call) => call.url === '/api/mail/triage/apply').map((call) => call.body)).toEqual([
      { messageIds: ['b1'], action: 'tag', tagId: 'Label_9' },
    ])
    expect(screen.getByRole('status').textContent).toMatch(/Tagged 1 email "Baby reads"/)
    expect((screen.getByLabelText('Clear Bob (bob@dev.io)') as HTMLInputElement).checked).toBe(false)
    // Ann was not in the search, so she is still selected.
    expect(screen.getByText(/Selected: 200 emails from 1 sender/)).toBeTruthy()
  })

  it('lists saved tags and opens one to work through it', async () => {
    const tag = { id: 'Label_1', name: 'Baby reads', total: 12, unread: 4 }
    const onOpenTag = vi.fn()
    const calls = await sortedPanel([tag], { onOpenTag })
    fireEvent.click(screen.getByRole('button', { name: 'Open tag Baby reads' }))
    expect(onOpenTag).toHaveBeenCalledWith(tag)
    // An existing tag is applied to the selection without saving a new one.
    fireEvent.change(screen.getByLabelText('Tag for the selected emails'), { target: { value: 'Label_1' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tag 230 selected emails' }))
    })
    expect(calls.some((call) => call.url === '/api/mail/tags' && call.body)).toBe(false)
    expect(calls.filter((call) => call.url === '/api/mail/triage/apply').map((call) => (call.body as { tagId: string }).tagId)).toEqual(['Label_1'])
    expect(screen.getByText('Selected: 0 emails from 0 senders')).toBeTruthy()
  })

  it('unsubscribes the ticked one-click senders, archives only those that worked, and leaves the rest alone', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const result = {
      ...RESULT,
      categories: RESULT.categories.map((category) =>
        category.key === 'sales_pitch'
          ? {
              ...category,
              senders: category.senders.map((sender) => ({ ...sender, unsubscribeId: sender.address === 'ann@seo.io' ? 'a0' : 'b1' })),
            }
          : category,
      ),
    }
    const api = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url, body })
      if (url === '/api/mail/tags') return { tags: [] } as never
      if (url === '/api/mail/triage/unsubscribe') {
        return { results: [{ messageId: 'a0', status: 'unsubscribed' }, { messageId: 'b1', status: 'failed' }] } as never
      }
      if (url !== '/api/mail/triage') return { ok: true } as never
      if (body.step === 'list') return { ids: ['a0'], truncated: false } as never
      if (body.step === 'read') return { messages: [{ messageId: 'a0' }] } as never
      const { truncated: _t, ...sorted } = result
      return sorted as never
    })
    const onApplied = vi.fn()
    render(<TriagePanel api={api} onApplied={onApplied} onClose={vi.fn()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Triage unread emails' }))
    })
    const button = screen.getByRole('button', { name: 'Unsubscribe and archive (2 senders)' })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    fireEvent.click(button)
    expect(calls.some((call) => call.url === '/api/mail/triage/unsubscribe')).toBe(false)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(calls.filter((call) => call.url === '/api/mail/triage/unsubscribe').map((call) => call.body)).toEqual([{ messageIds: ['a0', 'b1'] }])
    // Only Ann's emails are archived: Bob's unsubscribe failed, so his stay.
    expect(calls.filter((call) => call.url === '/api/mail/triage/apply').map((call) => call.body)).toEqual([{ messageIds: ANN_IDS, action: 'archive' }])
    expect(screen.getByRole('status').textContent).toBe(
      'Unsubscribed from 1 sender and archived 200 emails. 1 sender could not be unsubscribed; their emails were left alone.',
    )
    expect(onApplied).toHaveBeenCalledTimes(1)
    expect(screen.getByText('33 unread emails from 2 senders.')).toBeTruthy()
    confirm.mockRestore()
  })

  it('collapses to a one-line bar that keeps the results, and expands again', async () => {
    const api = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/mail/tags') return { tags: [] } as never
      const step = JSON.parse(String(init?.body)).step
      if (step === 'list') return { ids: ['a0'], truncated: false } as never
      if (step === 'read') return { messages: [{ messageId: 'a0' }] } as never
      const { truncated: _t, ...sorted } = RESULT
      return sorted as never
    })
    const onFullViewChange = vi.fn()
    const { rerender } = render(<TriagePanel api={api} onApplied={vi.fn()} onClose={vi.fn()} fullView onFullViewChange={onFullViewChange} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Triage unread emails' }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(onFullViewChange).toHaveBeenCalledWith(false)

    rerender(<TriagePanel api={api} onApplied={vi.fn()} onClose={vi.fn()} fullView={false} onFullViewChange={onFullViewChange} />)
    expect(screen.getByText('233 unread emails in 2 categories, 230 selected')).toBeTruthy()
    expect(screen.queryByRole('table', { name: 'Unread emails by category' })).toBeNull()

    rerender(<TriagePanel api={api} onApplied={vi.fn()} onClose={vi.fn()} fullView onFullViewChange={onFullViewChange} />)
    expect(screen.getByRole('table', { name: 'Unread emails by category' })).toBeTruthy()
    expect(api.mock.calls.filter(([url, init]) => url === '/api/mail/triage' && JSON.parse(String(init?.body)).step === 'sort')).toHaveLength(1)
  })
})
