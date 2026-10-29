import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import SchedulePicker from '@/components/mail/SchedulePicker'

// Wed 21 Oct 2026, 6:00am local.
const NOW = () => new Date(2026, 9, 21, 6, 0)

function mount() {
  const onSchedule = vi.fn()
  render(<SchedulePicker busy={false} scheduling={false} canSchedule onSchedule={onSchedule} now={NOW} />)
  return { onSchedule }
}

const scheduled = (fn: ReturnType<typeof vi.fn>) => {
  fireEvent.click(screen.getByRole('button', { name: 'Schedule send' }))
  return fn.mock.calls.at(-1)?.[0] as Date
}

afterEach(cleanup)

describe('SchedulePicker', () => {
  it('only offers Today and Tomorrow, plus 7:48am and 8:11am with +2 buttons', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Today' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tomorrow' })).toBeTruthy()
    expect(screen.queryByText(/afternoon|Monday/)).toBeNull()
    expect(screen.getByRole('button', { name: '7:48am' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '8:11am' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add 2 minutes to 7:48am' }).textContent).toBe('+2')
  })

  it('+2 moves a quick time on two minutes each press before picking it', () => {
    const { onSchedule } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 minutes to 8:11am' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 minutes to 8:13am' }))
    fireEvent.click(screen.getByRole('button', { name: '8:15am' }))
    expect(scheduled(onSchedule).getTime()).toBe(new Date(2026, 9, 22, 8, 15).getTime())
  })

  it('picking a day in the calendar goes straight on to the times, and a time closes the panel', () => {
    const { onSchedule } = mount()
    fireEvent.click(screen.getByRole('button', { name: /Send date:/ }))
    expect(screen.getByRole('grid', { name: 'October 2026' })).toBeTruthy()
    // Past days are struck out and can't be picked; today is marked.
    expect(screen.getByRole('button', { name: 'Tuesday 20 October 2026' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Wednesday 21 October 2026' }).getAttribute('aria-current')).toBe('date')
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    fireEvent.click(screen.getByRole('button', { name: 'Thursday 5 November 2026' }))
    const list = screen.getByRole('listbox', { name: 'Send time' })
    expect(document.activeElement).toBe(list)
    fireEvent.click(screen.getByRole('option', { name: '9:30am' }))
    expect(screen.queryByRole('grid')).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send time: 9:30am' }))
    expect(scheduled(onSchedule).getTime()).toBe(new Date(2026, 10, 5, 9, 30).getTime())
  })

  it('moves between days with the arrow keys, across months', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: /Send date:/ }))
    const day = screen.getByRole('button', { name: 'Saturday 31 October 2026' })
    fireEvent.keyDown(day, { key: 'ArrowRight' })
    expect(screen.getByRole('grid', { name: 'November 2026' })).toBeTruthy()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Sunday 1 November 2026')
  })

  it('lists times every 15 minutes, keeps an off-grid quick time selected, and picks with the keyboard', () => {
    const { onSchedule } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send time: 7:48am' }))
    const list = screen.getByRole('listbox', { name: 'Send time' })
    expect(screen.getByRole('option', { name: '7:48am' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('option', { name: '7:45am' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '8:00am' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: '7:49am' })).toBeNull()
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(list.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: '8:00am' }).id)
    fireEvent.keyDown(list, { key: 'PageDown' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(scheduled(onSchedule).getTime()).toBe(new Date(2026, 9, 22, 9, 0).getTime())
  })

  it('takes an exact typed time and explains one it cannot read', () => {
    const { onSchedule } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.click(screen.getByRole('button', { name: /Send time:/ }))
    const typed = screen.getByLabelText('Type a time')
    fireEvent.change(typed, { target: { value: 'soon' } })
    fireEvent.keyDown(typed, { key: 'Enter' })
    expect(screen.getByRole('alert').textContent).toBe('Try a time like 9:05am')
    fireEvent.change(typed, { target: { value: '9:05 pm' } })
    fireEvent.keyDown(typed, { key: 'Enter' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(scheduled(onSchedule).getTime()).toBe(new Date(2026, 9, 22, 21, 5).getTime())
  })

  it('strikes out times already passed today, but not on later days', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.click(screen.getByRole('button', { name: /Send time:/ }))
    expect(screen.getByRole('option', { name: '5:45am' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('option', { name: '6:00am' }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('option', { name: '6:15am' }).getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: '5:45am' }))
    expect(screen.getByRole('listbox')).toBeTruthy()
    const typed = screen.getByLabelText('Type a time')
    fireEvent.change(typed, { target: { value: '5am' } })
    fireEvent.keyDown(typed, { key: 'Enter' })
    expect(screen.getByRole('alert').textContent).toBe('That time has already passed')
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow' }))
    fireEvent.click(screen.getByRole('button', { name: /Send time:/ }))
    expect(screen.getByRole('option', { name: '5:45am' }).getAttribute('aria-disabled')).toBeNull()
  })

  it('Escape closes only the panel and returns focus to its box', () => {
    const onOuterKey = vi.fn()
    document.addEventListener('keydown', onOuterKey)
    mount()
    const box = screen.getByRole('button', { name: /Send time:/ })
    fireEvent.click(box)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(box)
    expect(onOuterKey).not.toHaveBeenCalled()
    document.removeEventListener('keydown', onOuterKey)
  })
})
