import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageAddresses } from '@/components/mail/MessageAddresses'

afterEach(() => cleanup())

const FROM = 'Saul Morgan <saul@acmeclient.com.au>'
const TO = '"Pat Lee" <pat@ourteam.example>, simon@brightclinic.example'

describe('MessageAddresses', () => {
  it('copies the address when the name or the address in the inbox header is double-clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<MessageAddresses from={FROM} to={TO} cc="trung@outlook.com" />)

    fireEvent.doubleClick(screen.getByText('Saul Morgan'))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied'))
    expect(writeText).toHaveBeenLastCalledWith('saul@acmeclient.com.au')

    fireEvent.doubleClick(screen.getByText('<saul@acmeclient.com.au>'))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('saul@acmeclient.com.au'))

    fireEvent.doubleClick(screen.getByText('"Pat Lee" <pat@ourteam.example>'))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('pat@ourteam.example'))

    fireEvent.doubleClick(screen.getByText('simon@brightclinic.example'))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('simon@brightclinic.example'))

    fireEvent.doubleClick(screen.getByText('trung@outlook.com'))
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('trung@outlook.com'))
  })

  it('does not copy a header line that has no address', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<MessageAddresses from="Mailer daemon" to="not an address" cc="" />)
    fireEvent.doubleClick(screen.getByText('Mailer daemon'))
    fireEvent.doubleClick(screen.getByText('not an address'))
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
