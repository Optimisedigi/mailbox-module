import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ScheduledPanel, { type ScheduledDetail, type ScheduledItem } from '@/components/mail/ScheduledPanel'

const ITEM: ScheduledItem = {
  id: 7,
  to: 'jo@client.com',
  cc: '',
  subject: 'Proposal',
  scheduledFor: '2026-12-01T08:00:00.000Z',
  status: 'pending',
  lastError: '',
  attachmentCount: 1,
  isReply: false,
}
const DETAIL: ScheduledDetail = {
  item: ITEM,
  replyToMessageId: null,
  html: '<p>See attached.</p>',
  attachments: [{ name: 'quote.pdf', mediaType: 'application/pdf', data: 'QUJD' }],
  bcc: 'boss@team.test',
  signOff: 'Thanks,\nPat',
}

function mount(selectedId: number | null = null) {
  const props = {
    onSelect: vi.fn(),
    loadDetail: vi.fn().mockResolvedValue(DETAIL),
    onEdit: vi.fn(),
    onSendNow: vi.fn().mockResolvedValue(undefined),
    onReschedule: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn().mockResolvedValue(undefined),
  }
  render(<ScheduledPanel items={[ITEM]} loading={false} selectedId={selectedId} isMobile={false} {...props} />)
  return props
}

afterEach(cleanup)

describe('ScheduledPanel', () => {
  it('lists the queue on the left like Drafts and asks to pick one', () => {
    const { onSelect } = mount()
    expect(screen.getByRole('list', { name: 'Scheduled' })).toBeTruthy()
    expect(screen.getByText('Select a scheduled email to see or edit it.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /To jo@client.com/ }))
    expect(onSelect).toHaveBeenCalledWith(7)
  })

  it('shows the selected email on the right and Edit opens it', async () => {
    const { loadDetail, onEdit } = mount(7)
    expect(loadDetail).toHaveBeenCalledWith(7)
    expect(await screen.findByText('quote.pdf', { exact: false })).toBeTruthy()
    expect(screen.getByText('Bcc boss@team.test')).toBeTruthy()
    expect(screen.getByTitle('Proposal').getAttribute('srcdoc')).toContain('See attached.')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(onEdit).toHaveBeenCalledWith(DETAIL)
  })

  it('changes the time with the schedule picker', async () => {
    const { onReschedule } = mount(7)
    await screen.findByText('quote.pdf', { exact: false })
    fireEvent.click(screen.getByRole('button', { name: 'Change time' }))
    // A later day, so 9:30am is never already past on the real clock.
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.click(screen.getByRole('button', { name: /^Send time:/ }))
    fireEvent.click(screen.getByRole('option', { name: '9:30am' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save time' }))
    await waitFor(() => expect(onReschedule).toHaveBeenCalled())
    const when = onReschedule.mock.calls[0]?.[1] as Date
    expect([when.getHours(), when.getMinutes()]).toEqual([9, 30])
  })
})
