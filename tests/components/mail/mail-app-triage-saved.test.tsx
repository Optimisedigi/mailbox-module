import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@payloadcms/ui', () => ({ useStepNav: () => ({ setStepNav: () => undefined, stepNav: [] }) }))
vi.mock('@/components/mail/ComposeWindow', () => ({ default: () => <div data-testid="compose" /> }))
vi.mock('@/components/mail/EmailBody', () => ({ default: () => <div /> }))

const { default: MailApp } = await import('@/components/mail/MailApp')

// The size of a real inbox: 2,844 unread emails from 271 senders, long subjects.
const SENDERS = Array.from({ length: 271 }, (_, s) => {
  const count = s < 130 ? 11 : 10
  return {
    address: `sender${s}@brand${s}.com.au`,
    name: `Sender ${s}`,
    count,
    subjects: Array.from({ length: count }, (_, i) => `Subject line number ${i} from sender ${s}, with a typical newsletter length title`),
    messageIds: Array.from({ length: count }, (_, i) => `19a${String(s).padStart(4, '0')}${String(i).padStart(9, '0')}`),
    bulk: true,
  }
})
const SORTED = {
  scanned: 2840,
  failedBatches: 0,
  categories: [
    { key: 'ai-1', label: 'Retail and promo offers', count: 1400, defaultSelected: true, description: 'Shops', senders: SENDERS.slice(0, 135) },
    { key: 'keep', label: 'Might need a look', count: 1444, defaultSelected: false, description: 'Unsure', senders: SENDERS.slice(135) },
  ],
}

let triageCalls = 0
beforeEach(() => {
  localStorage.clear()
  triageCalls = 0
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    let body: unknown = {}
    if (url.startsWith('/api/mail/inbox')) body = { threads: [], nextPageToken: null, account: 'me@team.test', senderClients: [] }
    else if (url.startsWith('/api/mail/accounts')) body = { primary: 'me@team.test', accounts: [], addUrl: '', canAdd: false }
    else if (url.startsWith('/api/mail/tags')) body = { tags: [] }
    else if (url === '/api/mail/triage') {
      triageCalls++
      const step = JSON.parse(String(init?.body)).step
      body = step === 'list' ? { ids: ['m1'], truncated: false } : step === 'read' ? { messages: [{ messageId: 'm1' }] } : SORTED
    }
    return { ok: true, json: async () => body } as Response
  }) as unknown as typeof fetch
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('Mail triage results are kept', () => {
  it('shows the last triage again after closing the panel and after reloading Mail, without running the AI again', async () => {
    const first = render(<MailApp clients={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Triage/ }))
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Triage unread emails' }))
    })
    expect(await screen.findByText('2,840 unread emails from 271 senders.')).toBeTruthy()
    const stored = localStorage.getItem('mail-triage:main') ?? ''
    // Well inside the browser's ~5 MB per-site storage.
    expect(stored.length).toBeGreaterThan(0)
    expect(stored.length).toBeLessThan(600_000)

    // Close and reopen the panel.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: /Triage/ }))
    expect(await screen.findByText('2,840 unread emails from 271 senders.')).toBeTruthy()
    expect(screen.getByText(/Saved results from/)).toBeTruthy()

    // Reload Mail.
    first.unmount()
    render(<MailApp clients={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Triage/ }))
    expect(await screen.findByText('2,840 unread emails from 271 senders.')).toBeTruthy()
    expect(triageCalls).toBe(3)
  })

  it('says so when the browser will not keep the results', async () => {
    // jsdom (Node 22/24) keeps setItem on Storage.prototype, and spying on the instance
    // just stores a "setItem" key; the Node 26 shim in tests/setup.ts has its own method.
    const owner: Storage = Object.hasOwn(window.localStorage, 'setItem') ? window.localStorage : Storage.prototype
    const realSetItem = owner.setItem
    const setItem = vi.spyOn(owner, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('mail-triage:')) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      realSetItem.call(this, key, value)
    })
    render(<MailApp clients={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Triage/ }))
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Triage unread emails' }))
    })
    expect((await screen.findByRole('alert')).textContent).toMatch(/would not keep these results/)
    setItem.mockRestore()
  })
})
