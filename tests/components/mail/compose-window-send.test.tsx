import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ComposeWindow, { UNDO_SEND_MS, type ComposeState } from '@/components/mail/ComposeWindow'

const REPLY: ComposeState = {
  mode: 'reply',
  replyTo: { messageId: 'msg1', from: 'Casey <casey@x.com>', subject: 'Hi' },
  to: 'casey@x.com',
  cc: '',
  subject: 'Re: Hi',
  html: '<p>Thursday works.</p>',
  attachments: [],
}

function mount(initial: ComposeState = REPLY) {
  const onSend = vi.fn().mockResolvedValue(undefined)
  const onSaveDraft = vi.fn().mockResolvedValue('draft1')
  render(
    <ComposeWindow
      initial={initial}
      title="Reply"
      onClose={vi.fn()}
      onSend={onSend}
      onSchedule={vi.fn()}
      onSaveDraft={onSaveDraft}
      onDeleteDraft={vi.fn()}
      signatureHtml=""
    />,
  )
  return { onSend, onSaveDraft }
}

async function waitForBody() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false))
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ComposeWindow undo send', () => {
  it('waits 3.1 seconds with a loading Send button before sending', async () => {
    const { onSend } = mount()
    await waitForBody()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const sending = screen.getByRole('button', { name: /Sending/ })
    expect(sending.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(UNDO_SEND_MS - 100)
    })
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(100)
    })
    expect(UNDO_SEND_MS).toBe(3100)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0]?.[1].html).toContain('Thursday works.')
  })

  it('Undo during the wait stops the email', async () => {
    const { onSend } = mount()
    await waitForBody()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await act(async () => {
      vi.advanceTimersByTime(UNDO_SEND_MS * 2)
    })
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false)
    expect(screen.getByText('Sending undone.')).toBeTruthy()
  })
})

describe('ComposeWindow layout', () => {
  it('has icon-only attach and image buttons, no prompt history, and the thread toggle in the tool row', async () => {
    mount()
    await waitForBody()
    const attach = screen.getByRole('button', { name: 'Attach files' })
    expect(attach.textContent?.trim()).toBe('📎')
    expect(screen.getByRole('button', { name: 'Insert image' }).textContent?.trim()).toBe('🖼')
    expect(screen.queryByText('Undo last')).toBeNull()
    expect(screen.queryByLabelText('AI prompts so far')).toBeNull()
    const toggle = screen.getByText('Use whole thread').closest('label')
    expect(toggle?.parentElement).toBe(attach.parentElement?.parentElement)
    // Colour and list buttons share the row with Insert table.
    const toolbar = screen.getByRole('button', { name: /Insert table/ }).parentElement
    expect(toolbar?.contains(screen.getByRole('button', { name: 'Text colour' }))).toBe(true)
    expect(toolbar?.contains(screen.getByRole('button', { name: 'Bulleted list' }))).toBe(true)
    expect(toolbar?.contains(screen.getByRole('button', { name: 'Numbered list' }))).toBe(true)
  })

  it('shows Bcc with Cc and sends it', async () => {
    const { onSend } = mount()
    await waitForBody()
    expect(screen.queryByText('Bcc')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cc' }))
    const bcc = screen.getByText('Bcc').closest('label')?.querySelector('input')
    expect(bcc).toBeTruthy()
    fireEvent.change(bcc as HTMLInputElement, { target: { value: 'boss@team.test' } })
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await act(async () => {
      vi.advanceTimersByTime(UNDO_SEND_MS)
    })
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({ bcc: 'boss@team.test' })
  })

  it('attaches files dropped on the window, images included', async () => {
    mount()
    await waitForBody()
    const dialog = screen.getByRole('dialog', { name: 'Reply' })
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'chart.png', { type: 'image/png' })
    const dataTransfer = { files: [file], types: ['Files'], dropEffect: 'none' }
    fireEvent.dragEnter(dialog, { dataTransfer })
    expect(screen.getByText('Drop files to attach')).toBeTruthy()
    fireEvent.drop(dialog, { dataTransfer })
    expect(await screen.findByText('chart.png')).toBeTruthy()
    expect(screen.queryByText('Drop files to attach')).toBeNull()
  })
})

describe('ComposeWindow AI subject', () => {
  it('fills an empty subject from the first AI draft of a new email', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: 'Hi Jo,\n\nFancy a call?', subject: 'Call next week?' }), { status: 200 }),
    )
    mount({ mode: 'new', replyTo: null, to: 'jo@x.com', cc: '', subject: '', html: '', attachments: [] })
    fireEvent.change(screen.getByLabelText('Instruction for the AI'), { target: { value: 'invite Jo to a call' } })
    fireEvent.click(screen.getByRole('button', { name: 'Write with AI' }))
    await waitFor(() => expect(screen.getByLabelText('Subject')).toHaveProperty('value', 'Call next week?'))
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({ action: 'draft', suggestSubject: true })
  })
})

describe('ComposeWindow sign-off', () => {
  const SIGNATURE = '<div><div>Thanks,</div><div>Pat</div><div><br></div><div>+61 400 000 000</div></div>'

  it('shows the sign-off as editable text and sends the edited version', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(
      <ComposeWindow
        initial={REPLY}
        title="Reply"
        onClose={vi.fn()}
        onSend={onSend}
        onSchedule={vi.fn()}
        onSaveDraft={vi.fn().mockResolvedValue('draft1')}
        onDeleteDraft={vi.fn()}
        signatureHtml={SIGNATURE}
      />,
    )
    const signOff = screen.getByLabelText('Sign-off') as HTMLTextAreaElement
    expect(signOff.value).toBe('Thanks,\nPat')
    // The rest of the signature is still previewed, without the sign-off.
    const preview = screen.getByTitle('Your Gmail signature (added automatically)') as HTMLIFrameElement
    expect(preview.getAttribute('srcdoc')).toContain('+61 400 000 000')
    expect(preview.getAttribute('srcdoc')).not.toContain('Thanks,')

    fireEvent.change(signOff, { target: { value: 'Cheers,\nPete' } })
    await waitForBody()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await act(async () => {
      vi.advanceTimersByTime(UNDO_SEND_MS)
    })
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({ signOff: 'Cheers,\nPete' })
  })

  it('sends the unedited sign-off too, so the email matches the preview', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(
      <ComposeWindow
        initial={REPLY}
        title="Reply"
        onClose={vi.fn()}
        onSend={onSend}
        onSchedule={vi.fn()}
        onSaveDraft={vi.fn().mockResolvedValue('draft1')}
        onDeleteDraft={vi.fn()}
        signatureHtml={SIGNATURE}
      />,
    )
    await waitForBody()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await act(async () => {
      vi.advanceTimersByTime(UNDO_SEND_MS)
    })
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({ signOff: 'Thanks,\nPat' })
  })

  it('the Signature toggle hides the signature and sends without it', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(
      <ComposeWindow
        initial={REPLY}
        title="Reply"
        onClose={vi.fn()}
        onSend={onSend}
        onSchedule={vi.fn()}
        onSaveDraft={vi.fn().mockResolvedValue('draft1')}
        onDeleteDraft={vi.fn()}
        signatureHtml={SIGNATURE}
      />,
    )
    const toggle = screen.getByRole('checkbox', { name: 'Signature' }) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(toggle)
    expect(toggle.checked).toBe(false)
    expect(screen.queryByLabelText('Sign-off')).toBeNull()
    expect(screen.queryByTitle('Your Gmail signature (added automatically)')).toBeNull()
    await waitForBody()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await act(async () => {
      vi.advanceTimersByTime(UNDO_SEND_MS)
    })
    expect(onSend.mock.calls[0]?.[0]).toMatchObject({ noSignature: true })
  })
})

describe('ComposeWindow editing a scheduled email', () => {
  it('opens on its send time, updates it in place and never autosaves to Drafts', async () => {
    const onSchedule = vi.fn().mockResolvedValue(undefined)
    const onSaveDraft = vi.fn().mockResolvedValue('draft1')
    const when = new Date(Date.now() + 2 * 86_400_000)
    when.setHours(9, 30, 0, 0)
    render(
      <ComposeWindow
        initial={{ ...REPLY, mode: 'new', replyTo: null, scheduledId: 7, scheduledFor: when.toISOString() }}
        title="Edit scheduled email"
        onClose={vi.fn()}
        onSend={vi.fn()}
        onSchedule={onSchedule}
        onSaveDraft={onSaveDraft}
        onDeleteDraft={vi.fn()}
        signatureHtml=""
      />,
    )
    expect(screen.queryByRole('button', { name: 'Save as draft' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Send time: 9:30am' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Re: Hi (edited)' } })
    await waitForBody()
    fireEvent.click(screen.getByRole('button', { name: 'Update schedule' }))
    await waitFor(() => expect(onSchedule).toHaveBeenCalled())
    expect(onSchedule.mock.calls[0]?.[0]).toMatchObject({ scheduledId: 7, subject: 'Re: Hi (edited)' })
    expect((onSchedule.mock.calls[0]?.[2] as Date).getTime()).toBe(when.getTime())
    await new Promise((resolve) => setTimeout(resolve, 1700))
    expect(onSaveDraft).not.toHaveBeenCalled()
  })
})

describe('ComposeWindow reply all toggle', () => {
  it('switches the reply to everyone on the email and back', () => {
    mount({
      ...REPLY,
      replyTo: {
        ...REPLY.replyTo!,
        recipients: { reply: { to: 'casey@x.com', cc: '' }, replyAll: { to: 'casey@x.com', cc: 'sam@y.com, jo@z.com' } },
      },
    })
    const toggle = screen.getByRole('button', { name: 'Reply all' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Cc')).toHaveValue('sam@y.com, jo@z.com')
    fireEvent.click(toggle)
    expect(screen.getByLabelText('Cc')).toHaveValue('')
  })

  it('is not offered when there is nobody else to include', () => {
    mount()
    expect(screen.queryByRole('button', { name: 'Reply all' })).toBeNull()
  })
})

describe('ComposeWindow autosave while typing recipients', () => {
  it('saves only once an address is finished or the field is left, never on half-typed addresses', async () => {
    const { onSaveDraft } = mount({ mode: 'new', replyTo: null, to: '', cc: '', subject: 'Update', html: '<p>Hi Melissa,</p>', attachments: [] })
    await waitFor(() => expect(screen.getByLabelText('Email body').textContent).toContain('Hi Melissa,'))
    const to = screen.getByRole('combobox', { name: 'To' })
    vi.useFakeTimers()
    const settle = async () => {
      await act(async () => {
        vi.advanceTimersByTime(1600)
      })
    }

    // Typing an address letter by letter, with pauses longer than the autosave delay.
    for (const value of ['md', 'mdavies@', 'mdavies@northwind.com', 'mdavies@northwind.com.au']) {
      fireEvent.change(to, { target: { value } })
      await settle()
    }
    expect(onSaveDraft).not.toHaveBeenCalled()

    // The comma finishes it: one save.
    fireEvent.change(to, { target: { value: 'mdavies@northwind.com.au, ' } })
    await settle()
    expect(onSaveDraft).toHaveBeenCalledTimes(1)
    expect(onSaveDraft.mock.calls[0]?.[0]).toMatchObject({ to: 'mdavies@northwind.com.au, ' })

    // Starting the next address does not save; leaving the field does.
    fireEvent.change(to, { target: { value: 'mdavies@northwind.com.au, jo@ques' } })
    await settle()
    expect(onSaveDraft).toHaveBeenCalledTimes(1)
    fireEvent.blur(to)
    await settle()
    expect(onSaveDraft).toHaveBeenCalledTimes(2)
    expect(onSaveDraft.mock.calls[1]?.[0]).toMatchObject({ to: 'mdavies@northwind.com.au, jo@ques' })

    // Removing a finished address counts as a change too.
    fireEvent.change(to, { target: { value: 'jo@ques' } })
    await settle()
    expect(onSaveDraft).toHaveBeenCalledTimes(3)
  })
})

describe('ComposeWindow shadowed images', () => {
  it('sends a pasted image with its shadow drawn in, so Gmail and Outlook show it', async () => {
    const bake = await import('@/components/mail/email-image-bake')
    const spy = vi.spyOn(bake, 'bakeImageInBrowser').mockResolvedValue({ src: 'data:image/png;base64,QkFLRUQ=', width: 428 })
    const { onSend } = mount({
      ...REPLY,
      html: '<p>See below.</p><p><img src="data:image/png;base64,iVBORw0KGgo=" alt="shot" width="400" style="max-width:100%;height:auto;box-shadow:0 1px 3px rgba(0,0,0,0.12), 0 4px 14px rgba(0,0,0,0.18);"></p>',
    })
    await waitForBody()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await act(async () => {
      vi.advanceTimersByTime(UNDO_SEND_MS)
    })
    vi.useRealTimers()
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(spy).toHaveBeenCalledWith('data:image/png;base64,iVBORw0KGgo=', 400)
    const content = onSend.mock.calls[0]?.[1] as { html: string; inlineImages: Array<{ data: string; mediaType: string }> }
    expect(content.html).not.toContain('box-shadow')
    expect(content.html).toContain('width="428"')
    expect(content.inlineImages).toEqual([expect.objectContaining({ data: 'QkFLRUQ=', mediaType: 'image/png' })])
  })
})
