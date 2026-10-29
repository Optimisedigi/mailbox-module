import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import CalendarInviteButton from '@/components/mail/CalendarInviteButton'

let calls: Array<{ url: string; init?: RequestInit }> = []
let reply: { ok: boolean; body: unknown } = { ok: true, body: {} }
const writeText = vi.fn(async (_text: string) => undefined)

beforeEach(() => {
  calls = []
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  reply = { ok: true, body: { eventId: 'e1', eventLink: 'https://calendar/e1', meetLink: 'https://meet.google.com/abc', sent: false } }
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const body = url === '/api/mail/calendar-event' ? reply.body : { contacts: [], senders: [] }
    return { ok: url === '/api/mail/calendar-event' ? reply.ok : true, status: reply.ok ? 200 : 409, json: async () => body } as Response
  }) as unknown as typeof fetch
})
afterEach(() => cleanup())

function eventCall() {
  const call = calls.find((c) => c.url === '/api/mail/calendar-event')
  return { body: JSON.parse(String(call?.init?.body)), headers: call?.init?.headers as Record<string, string> }
}

describe('Add calendar invite', () => {
  it('unticked: saves for the shown mailbox without emailing anyone, copies the Meet link and shows the pill', async () => {
    render(<CalendarInviteButton account="sales@team.test" now={() => new Date(2026, 9, 28, 10, 5)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar invite' }))
    expect(screen.getByRole('dialog', { name: 'New calendar invite' })).toBeTruthy()
    // Starts at the next half hour today.
    expect(screen.getByRole('button', { name: 'Start: 10:30am' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Spend review' } })
    fireEvent.click(screen.getByRole('button', { name: /^Date:/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    fireEvent.click(screen.getByRole('button', { name: 'Tuesday 3 November 2026' }))
    // Typing a time and pressing Enter sets it; it does not submit the form.
    const typed = screen.getByLabelText('Type a time')
    fireEvent.change(typed, { target: { value: '2:30pm' } })
    fireEvent.keyDown(typed, { key: 'Enter' })
    expect(calls.some((c) => c.url === '/api/mail/calendar-event')).toBe(false)
    expect(screen.getByRole('button', { name: 'Start: 2:30pm' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'New calendar invite' })).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Guests' }), { target: { value: 'md@northwind.com.au' } })
    expect((screen.getByRole('checkbox', { name: 'Send to client / user' }) as HTMLInputElement).checked).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save and copy link' }))
    })
    const { body, headers } = eventCall()
    expect(body).toMatchObject({ title: 'Spend review', date: '2026-11-03', time: '14:30', durationMinutes: 30, guests: 'md@northwind.com.au', sendInvites: false })
    expect(typeof body.timeZone).toBe('string')
    expect(headers['x-mail-account']).toBe('sales@team.test')
    expect(writeText).toHaveBeenCalledWith('https://meet.google.com/abc')
    expect(await screen.findByText('Meeting link copied')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ticked: Google sends the invite, and nothing is copied', async () => {
    reply = { ok: true, body: { eventId: 'e1', eventLink: '', meetLink: 'https://meet.google.com/abc', sent: true } }
    render(<CalendarInviteButton account="" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar invite' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Guests' }), { target: { value: 'md@northwind.com.au' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send to client / user' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))
    })
    expect(eventCall().body.sendInvites).toBe(true)
    expect(writeText).not.toHaveBeenCalled()
    expect(await screen.findByText('Invite sent')).toBeTruthy()
  })

  it('shows the link to copy by hand when the browser blocks the clipboard', async () => {
    writeText.mockRejectedValue(new Error('not allowed'))
    render(<CalendarInviteButton account="" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar invite' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save and copy link' }))
    })
    expect((screen.getByRole('textbox', { name: 'Meeting link' }) as HTMLInputElement).value).toBe('https://meet.google.com/abc')
    expect(screen.getByRole('button', { name: 'Copy meeting link' })).toBeTruthy()
  })

  it('keeps the form open with the error when the calendar is not connected', async () => {
    reply = { ok: false, body: { error: "Google Calendar isn't connected for me@team.test." } }
    render(<CalendarInviteButton account="" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar invite' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save and copy link' }))
    })
    expect((await screen.findByRole('alert')).textContent).toContain("isn't connected")
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('Escape in the date and time panel closes only the panel, not the invite', () => {
    render(<CalendarInviteButton account="" />)
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar invite' }))
    fireEvent.click(screen.getByRole('button', { name: /^Start:/ }))
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Start' }), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'New calendar invite' })).toBeTruthy()
  })

  it('closes on Escape and returns focus to the button', async () => {
    render(<CalendarInviteButton account="" />)
    const trigger = screen.getByRole('button', { name: 'Add calendar invite' })
    fireEvent.click(trigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})
