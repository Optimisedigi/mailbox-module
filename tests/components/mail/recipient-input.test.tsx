import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RecipientInput } from '@/components/mail/RecipientInput'

const CONTACTS = [
  { email: 'casey@client.com', name: 'Casey Brown' },
  { email: 'cameron@agency.com', name: '' },
]

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return <RecipientInput label="To" value={value} onChange={setValue} contacts={CONTACTS} onWantContacts={vi.fn()} />
}

const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value, selectionStart: value.length } })

afterEach(cleanup)

describe('RecipientInput', () => {
  it('shows suggestions with real addresses only after two letters', () => {
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'To' })
    fireEvent.focus(input)
    type(input, 'c')
    expect(screen.queryByRole('listbox')).toBeNull()
    type(input, 'ca')
    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Casey Browncasey@client.com', 'cameron@agency.com'])
  })

  it('Tab picks the highlighted suggestion and keeps typing in the field', () => {
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'To' }) as HTMLInputElement
    fireEvent.focus(input)
    type(input, 'ca')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const tab = fireEvent.keyDown(input, { key: 'Tab' })
    expect(tab).toBe(false) // default prevented: focus stays for the next address
    expect(input.value).toBe('cameron@agency.com, ')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('a click picks a suggestion after earlier addresses', () => {
    render(<Harness initial="jo@x.com, " />)
    const input = screen.getByRole('combobox', { name: 'To' }) as HTMLInputElement
    fireEvent.focus(input)
    type(input, 'jo@x.com, cas')
    fireEvent.click(screen.getByRole('option', { name: /casey@client.com/ }))
    expect(input.value).toBe('jo@x.com, casey@client.com, ')
  })

  it('Tab moves on normally when nothing is suggested', () => {
    render(<Harness />)
    const input = screen.getByRole('combobox', { name: 'To' })
    fireEvent.focus(input)
    type(input, 'zz')
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true)
  })

  it('double-click copies the address under the cursor and shows a Copied pill', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const list = 'frank@ledgerworks.com.au, simon@brightclinic.example'
    render(<Harness initial={list} />)
    const input = screen.getByRole('combobox', { name: 'To' }) as HTMLInputElement
    const simon = list.indexOf('simon@')
    input.setSelectionRange(simon + 2, simon + 2)
    fireEvent.doubleClick(input)
    expect(input.value).toBe(list)
    expect(input.selectionStart).toBe(simon)
    expect(input.selectionEnd).toBe(simon + 'simon@brightclinic.example'.length)
    expect(writeText).toHaveBeenCalledWith('simon@brightclinic.example')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied'))
  })

  it('does not copy or show a pill when the double-click is not on an address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<Harness initial="not an address yet" />)
    fireEvent.doubleClick(screen.getByRole('combobox', { name: 'To' }))
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stays quiet when the clipboard refuses the copy', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard unavailable'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<Harness initial="frank@ledgerworks.com.au" />)
    fireEvent.doubleClick(screen.getByRole('combobox', { name: 'To' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('still hides the pill when a later copy fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const writeText = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('clipboard unavailable'))
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      const list = 'frank@ledgerworks.com.au, simon@brightclinic.example'
      render(<Harness initial={list} />)
      const input = screen.getByRole('combobox', { name: 'To' }) as HTMLInputElement
      input.setSelectionRange(0, 0)
      fireEvent.doubleClick(input)
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByRole('status')).toHaveTextContent('Copied')

      input.setSelectionRange(list.indexOf('simon@') + 1, list.indexOf('simon@') + 1)
      fireEvent.doubleClick(input)
      await act(async () => {
        await Promise.resolve()
      })
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
      expect(screen.queryByRole('status')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
