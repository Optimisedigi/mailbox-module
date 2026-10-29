import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ComposeWindow, { type ComposeState } from '@/components/mail/ComposeWindow'
import { MAIL_ASSISTANT_OPENED_EVENT } from '@/lib/mail/host-events'

const REPLY: ComposeState = {
  mode: 'reply',
  replyTo: { messageId: 'msg1', from: 'Casey <casey@x.com>', subject: 'Hi' },
  to: 'casey@x.com',
  cc: '',
  subject: 'Re: Hi',
  html: '',
  attachments: [],
  draftId: 'draft1',
}

function mount(onDeleteDraft = vi.fn().mockResolvedValue(undefined), onClose = vi.fn()) {
  render(
    <ComposeWindow
      initial={REPLY}
      title="Reply"
      onClose={onClose}
      onSend={vi.fn()}
      onSchedule={vi.fn()}
      onSaveDraft={vi.fn().mockResolvedValue('draft1')}
      onDeleteDraft={onDeleteDraft}
      signatureHtml=""
    />,
  )
  return { onDeleteDraft, onClose }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('ComposeWindow drafts', () => {
  it('keeps the AI instruction as you type and restores it when reopened', () => {
    mount()
    fireEvent.change(screen.getByLabelText('Instruction for the AI'), { target: { value: 'say Thursday works' } })
    expect(localStorage.getItem('mail-ai-prompt:reply:msg1')).toContain('say Thursday works')
    expect(localStorage.getItem('mail-ai-prompt:draft:draft1')).toContain('say Thursday works')
    cleanup()
    mount()
    expect(screen.getByLabelText('Instruction for the AI')).toHaveProperty('value', 'say Thursday works')
  })

  it('trash icon deletes the Gmail draft, clears the saved instruction and closes', async () => {
    localStorage.setItem('mail-ai-prompt:reply:msg1', JSON.stringify({ text: 'shorter', savedAt: Date.now() }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { onDeleteDraft, onClose } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onDeleteDraft).toHaveBeenCalledWith('draft1')
    expect(localStorage.getItem('mail-ai-prompt:reply:msg1')).toBeNull()
  })

  it('minimises when the host assistant opens so the panel is not covered', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Minimise' })).toBeTruthy()
    act(() => {
      window.dispatchEvent(new Event(MAIL_ASSISTANT_OPENED_EVENT))
    })
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
  })

  it('keeps the window open and shows the error when deleting fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { onClose } = mount(vi.fn().mockRejectedValue(new Error('Gmail refused')))
    fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }))
    expect(await screen.findByText('Gmail refused')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})
