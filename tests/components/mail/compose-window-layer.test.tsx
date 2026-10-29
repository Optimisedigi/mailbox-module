import React from 'react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import ComposeWindow from '@/components/mail/ComposeWindow'

// Regression: inside the admin layout the compose window's z-index was capped by
// an ancestor stacking context, so other overlays covered it.
describe('ComposeWindow layering', () => {
  it('renders on <body>, outside any page wrapper', () => {
    render(
      <div data-testid="wrapper" style={{ position: 'relative', zIndex: 1 }}>
        <ComposeWindow
          initial={{ mode: 'new', replyTo: null, to: '', cc: '', subject: '', html: '', attachments: [] }}
          title="New message"
          onClose={vi.fn()}
          onSend={vi.fn()}
          onSchedule={vi.fn()}
          onSaveDraft={vi.fn()}
          onDeleteDraft={vi.fn()}
          signatureHtml=""
        />
      </div>,
    )
    const dialog = screen.getByRole('dialog', { name: 'New message' })
    expect(dialog.parentElement).toBe(document.body)
    expect(screen.getByTestId('wrapper').contains(dialog)).toBe(false)
  })

  it('stacks above admin overlays and the client-email alert (99999)', () => {
    const css = readFileSync('src/components/mail/ComposeWindow.module.css', 'utf8')
    const zIndex = Number(/\.window\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1])
    expect(zIndex).toBeGreaterThan(99999)
  })

  // Regression: the admin's global `ul { list-style: none }` hid every bullet in the body.
  it('shows list markers in the body despite the admin reset, with a small indent', () => {
    const css = readFileSync('src/components/mail/ComposeWindow.module.css', 'utf8')
    expect(css).toMatch(/\.editorList\s*\{[^}]*list-style:\s*disc/)
    expect(css).toMatch(/\.editorListNumber\s*\{[^}]*list-style:\s*decimal/)
    expect(css).toMatch(/\.editorListItem\s*\{[^}]*display:\s*list-item/)
  })

  it('is 22% larger than the original 560 x 640 window', () => {
    const css = readFileSync('src/components/mail/ComposeWindow.module.css', 'utf8')
    const block = /\.window\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(block).toContain('width: min(683px')
    expect(block).toContain('height: min(781px')
  })
})

describe('ComposeWindow pop-out', () => {
  afterEach(cleanup)
  const props = {
    title: 'New message',
    onClose: vi.fn(),
    onSend: vi.fn(),
    onSchedule: vi.fn(),
    onSaveDraft: vi.fn(async () => 'draft-1'),
    onDeleteDraft: vi.fn(),
    signatureHtml: '',
  }

  it('hands over the email as typed, with its saved draft, when opened in a new window', async () => {
    const onPopOut = vi.fn()
    render(
      <ComposeWindow
        {...props}
        initial={{ mode: 'new', replyTo: null, to: 'jo@x.com', cc: '', subject: 'Plan', html: '<p>Hello there</p>', attachments: [] }}
        onPopOut={onPopOut}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open in new window' }))
    expect(onPopOut).toHaveBeenCalledTimes(1)
    const snapshot = onPopOut.mock.calls[0]?.[0] as () => Promise<Record<string, unknown>>
    let state: Record<string, unknown> = {}
    await act(async () => {
      state = await snapshot()
    })
    expect(state).toMatchObject({ mode: 'new', to: 'jo@x.com', subject: 'Plan', draftId: 'draft-1' })
    expect(String(state.html)).toContain('Hello there')
  })

  it('minimises itself once the new window opens, and stays open when the browser blocks it', () => {
    const initial = { mode: 'new' as const, replyTo: null, to: '', cc: '', subject: '', html: '<p>Hi</p>', attachments: [] }
    const { unmount } = render(<ComposeWindow {...props} initial={initial} onPopOut={() => true} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in new window' }))
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
    unmount()

    render(<ComposeWindow {...props} initial={initial} onPopOut={() => false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in new window' }))
    expect(screen.getByRole('button', { name: 'Minimise' })).toBeTruthy()
  })

  it('fills the browser window when popped out, without minimise, full size or pop-out buttons', () => {
    render(<ComposeWindow {...props} initial={{ mode: 'new', replyTo: null, to: '', cc: '', subject: '', html: '', attachments: [] }} onPopOut={vi.fn()} popout />)
    const dialog = screen.getByRole('dialog', { name: 'New message' })
    expect(dialog.className).toMatch(/popout/)
    expect(screen.queryByRole('button', { name: 'Open in new window' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Minimise' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Full size' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })
})
