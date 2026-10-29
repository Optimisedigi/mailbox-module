import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ComposeWindow, { type ComposeState } from '@/components/mail/ComposeWindow'

const REPLY: ComposeState = {
  mode: 'reply',
  replyTo: { messageId: 'msg1', from: 'Casey <casey@x.com>', subject: 'Hi' },
  to: 'casey@x.com',
  cc: '',
  subject: 'Re: Hi',
  html: '<p>Thursday works.</p>',
  attachments: [],
}

function setViewport(phone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: phone && /max-width/.test(query),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

function mount() {
  const onClose = vi.fn()
  const onBack = vi.fn()
  const onSaveDraft = vi.fn().mockResolvedValue('draft1')
  const onDeleteDraft = vi.fn().mockResolvedValue(undefined)
  render(
    <ComposeWindow
      initial={REPLY}
      title="Reply"
      onClose={onClose}
      onBack={onBack}
      onSend={vi.fn().mockResolvedValue(undefined)}
      onSchedule={vi.fn()}
      onSaveDraft={onSaveDraft}
      onDeleteDraft={onDeleteDraft}
      signatureHtml=""
    />,
  )
  return { onClose, onBack, onSaveDraft }
}

async function waitForBody() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false))
}

const originalMatchMedia = window.matchMedia

afterEach(() => {
  cleanup()
  localStorage.clear()
  window.matchMedia = originalMatchMedia
  vi.restoreAllMocks()
})

describe('ComposeWindow on a phone', () => {
  it('has no Full size button (phones are already full screen); desktop keeps it', async () => {
    setViewport(true)
    mount()
    await waitForBody()
    expect(screen.queryByRole('button', { name: 'Full size' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Minimise' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    cleanup()
    setViewport(false)
    mount()
    await waitForBody()
    expect(screen.getByRole('button', { name: 'Full size' })).toBeTruthy()
  })

  it('has one voice call toggle in the bottom row instead of separate call buttons', async () => {
    setViewport(true)
    mount()
    await waitForBody()
    const row = screen.getByRole('button', { name: 'Send' }).closest('footer') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Voice call' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: 'Start voice' })).toBeNull()
  })

  it('puts the AI button, schedule icon and Send in one bottom row, with drafts in a ⋯ menu', async () => {
    setViewport(true)
    mount()
    await waitForBody()
    const send = screen.getByRole('button', { name: 'Send' })
    const row = send.closest('footer') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Revise' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Schedule send' })).toBeTruthy()
    expect(screen.queryByText('Remind me if no reply')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save as draft' })).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: 'More options' }))
    expect(screen.getByRole('menuitem', { name: 'Save as draft' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Delete draft' })).toBeTruthy()
  })

  it('keeps the full footer on desktop', async () => {
    setViewport(false)
    mount()
    await waitForBody()
    expect(screen.getByText('Remind me if no reply')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save as draft' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'More options' })).toBeNull()
  })

  it('a swipe right saves the draft and goes back to the inbox', async () => {
    setViewport(true)
    const { onBack, onClose, onSaveDraft } = mount()
    await waitForBody()
    const dialog = screen.getByRole('dialog', { name: 'Reply' })
    const pt = (x: number, y: number) => ({ clientX: x, clientY: y, identifier: 1, target: dialog })
    fireEvent.touchStart(dialog, { touches: [pt(15, 400)] })
    fireEvent.touchEnd(dialog, { changedTouches: [pt(220, 410)] })
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1))
    expect(onSaveDraft).toHaveBeenCalledTimes(1)
    expect(onSaveDraft.mock.calls[0]?.[1].html).toContain('Thursday works.')
    expect(onClose).not.toHaveBeenCalled()
  })
})
