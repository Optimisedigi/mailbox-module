import React, { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import RichEmailEditor, { contentWidth, type RichEmailEditorHandle } from '@/components/mail/RichEmailEditor'

const TABLE =
  '<p>Hi,</p><table><tr><th>Month</th><th>Setup fee</th><th>Retainer</th></tr>' +
  '<tr><td>March 2026</td><td>$2,000.00</td><td>$827.42</td></tr>' +
  '<tr><td>April 2026</td><td></td><td>$1,350.00</td></tr></table>'

async function mount() {
  const ref = createRef<RichEmailEditorHandle>()
  render(
    <RichEmailEditor
      ref={ref}
      initialHtml={TABLE}
      placeholder="Write here"
      ariaLabel="Email body"
      onContentChange={() => undefined}
      onPasteFiles={() => undefined}
    />,
  )
  await waitFor(() => expect(ref.current?.getHtml()).toContain('<table'))
  return ref
}

function cell(text: string): HTMLElement {
  const found = Array.from(document.querySelectorAll('[contenteditable="true"] td, [contenteditable="true"] th')).find(
    (element) => element.textContent === text,
  )
  if (!(found instanceof HTMLElement)) throw new Error(`no cell ${text}`)
  return found
}

const rows = () =>
  Array.from(document.querySelectorAll('[contenteditable="true"] tr')).map((row) =>
    Array.from(row.querySelectorAll('td, th')).map((c) => c.textContent),
  )

beforeEach(() => {
  // jsdom has no layout: give everything a box so the column button can be placed.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 120, 80))
  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 0, 0) })
  }
})
afterEach(() => vi.restoreAllMocks())

describe('table row and column deletion', () => {
  it('right-click on a cell deletes its row, or its column', async () => {
    const ref = await mount()
    fireEvent.contextMenu(cell('March 2026'), { clientX: 140, clientY: 150 })
    const menu = await screen.findByRole('menu', { name: 'Table options' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Insert row above',
      'Insert row below',
      'Insert column left',
      'Insert column right',
      'Delete row',
      'Delete column',
    ])
    await act(async () => fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete row' })))
    expect(rows()).toEqual([['Month', 'Setup fee', 'Retainer'], ['April 2026', '', '$1,350.00']])

    fireEvent.contextMenu(cell('Setup fee'), { clientX: 200, clientY: 110 })
    await act(async () => fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete column' })))
    expect(rows()).toEqual([['Month', 'Retainer'], ['April 2026', '$1,350.00']])
    expect(ref.current?.getHtml()).not.toContain('Setup fee')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('leaves the browser menu alone outside tables', async () => {
    await mount()
    const paragraph = document.querySelector('[contenteditable="true"] p')
    if (!paragraph) throw new Error('no paragraph')
    expect(fireEvent.contextMenu(paragraph)).toBe(true)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('shows a column button for the selected column whose menu deletes the whole column', async () => {
    await mount()
    // Put the cursor in the Retainer column, then close the menu with Escape (focus returns to the body).
    fireEvent.contextMenu(cell('$827.42'), { clientX: 300, clientY: 150 })
    fireEvent.keyDown(await screen.findByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    // jsdom doesn't move focus into contenteditable; the browser does.
    fireEvent.focusIn(document.querySelector('[contenteditable="true"]') as HTMLElement)

    const kebab = await screen.findByRole('button', { name: 'Column options' })
    expect(kebab).toHaveAttribute('aria-haspopup', 'menu')
    fireEvent.click(kebab)
    const menu = await screen.findByRole('menu', { name: 'Column options' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Delete column'])
    await act(async () => fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete column' })))
    expect(rows()).toEqual([['Month', 'Setup fee'], ['March 2026', '$2,000.00'], ['April 2026', '']])
  })

  it('shows a row button beside the selected row whose menu deletes the whole row', async () => {
    await mount()
    fireEvent.contextMenu(cell('March 2026'), { clientX: 140, clientY: 150 })
    fireEvent.keyDown(await screen.findByRole('menu'), { key: 'Escape' })
    fireEvent.focusIn(document.querySelector('[contenteditable="true"]') as HTMLElement)
    const handle = await screen.findByRole('button', { name: 'Row options' })
    // Drawn inside the editor, so it scrolls with the table instead of floating over the page.
    expect(handle.closest('[contenteditable]')).toBeNull()
    expect(document.querySelector('[contenteditable="true"]')?.parentElement?.contains(handle)).toBe(true)
    fireEvent.click(handle)
    const menu = await screen.findByRole('menu', { name: 'Row options' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Delete row'])
    await act(async () => fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete row' })))
    expect(rows().map((row) => row[0])).toEqual(['Month', 'April 2026'])
  })

  it('opens from the keyboard context-menu key for the cell the cursor is in', async () => {
    await mount()
    fireEvent.contextMenu(cell('April 2026'), { clientX: 140, clientY: 150 })
    fireEvent.keyDown(await screen.findByRole('menu'), { key: 'Escape' })
    fireEvent.contextMenu(document.querySelector('[contenteditable="true"]') as HTMLElement)
    await act(async () => fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete row' })))
    expect(rows().map((row) => row[0])).toEqual(['Month', 'March 2026'])
  })

  it('removes the table when its last column goes', async () => {
    await mount()
    for (const text of ['Setup fee', 'Retainer', 'Month']) {
      fireEvent.contextMenu(cell(text), { clientX: 200, clientY: 110 })
      await act(async () => fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete column' })))
    }
    expect(document.querySelector('[contenteditable="true"] table')).toBeNull()
  })
})

describe('column resize widths', () => {
  it('reads a cell as its content width, so dragging one column never widens the others by their padding', () => {
    const td = document.createElement('td')
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ width: '120px', paddingLeft: '8px', paddingRight: '8px', borderLeftWidth: '1px', borderRightWidth: '1px' } as CSSStyleDeclaration)
    vi.spyOn(td, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 137, 20))
    expect(contentWidth(td)).toBe(120)
  })

  it('falls back to the box minus padding and borders when the browser gives no used width', () => {
    const td = document.createElement('td')
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ width: 'auto', paddingLeft: '8px', paddingRight: '8px', borderLeftWidth: '1px', borderRightWidth: '1px' } as CSSStyleDeclaration)
    vi.spyOn(td, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 150, 20))
    expect(contentWidth(td)).toBe(132)
  })
})

describe('table formats', () => {
  const tableElement = () => document.querySelector('[contenteditable="true"] table') as HTMLTableElement

  it('new tables use the grid format, and right-click changes the whole table’s format', async () => {
    const ref = await mount()
    act(() => ref.current?.setHtml(''))
    act(() => {
      ref.current?.focus()
      ref.current?.insertTable(2, 2)
    })
    await waitFor(() => expect(tableElement()?.getAttribute('data-table-format')).toBe('grid'))
    expect(ref.current?.getHtml()).toContain('data-table-format="grid"')
    // Lexical's own black border and grey header don't reach the email, so the format's look fills in.
    expect(ref.current?.getHtml()).not.toMatch(/border: 1px solid black|#f2f3f5|rgb\(242, 243, 245\)/)

    const firstCell = tableElement().querySelector('th') as HTMLElement
    fireEvent.contextMenu(firstCell, { clientX: 140, clientY: 150 })
    const menu = await screen.findByRole('menu', { name: 'Table options' })
    const formats = within(menu).getAllByRole('menuitemradio')
    expect(formats.map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
      ['Grid', 'true'],
      ['Report', 'false'],
      ['Minimal', 'false'],
    ])
    expect(within(menu).getByRole('group', { name: 'Table format' })).toBeInTheDocument()
    await act(async () => fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Minimal' })))
    await waitFor(() => expect(tableElement().getAttribute('data-table-format')).toBe('minimal'))
    expect(ref.current?.getHtml()).toContain('data-table-format="minimal"')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('pasted or loaded tables keep their look, with no format chosen', async () => {
    await mount()
    expect(tableElement().hasAttribute('data-table-format')).toBe(false)
    fireEvent.contextMenu(cell('March 2026'), { clientX: 140, clientY: 150 })
    const menu = await screen.findByRole('menu', { name: 'Table options' })
    expect(within(menu).getAllByRole('menuitemradio').every((item) => item.getAttribute('aria-checked') === 'false')).toBe(true)
  })

  it('reopening a sent or saved table restores its format without the format’s colours sticking to the cells', async () => {
    const ref = await mount()
    const saved =
      '<table data-table-format="report" style="border-collapse:collapse"><tr>' +
      '<th style="padding:8px 12px;background-color:#f1f5f9;color:#64748b;font-weight:600">Week</th>' +
      '<th style="background-color:#f1f5f9;color:#64748b">CPA</th></tr>' +
      '<tr><td style="color:#222">5th Oct</td><td style="color:#222;background-color:yellow">$65</td></tr></table>'
    act(() => ref.current?.setHtml(saved))
    await waitFor(() => expect(tableElement()?.getAttribute('data-table-format')).toBe('report'))
    const html = ref.current?.getHtml() ?? ''
    expect(html).not.toMatch(/#64748b|rgb\(100, 116, 139\)|#f1f5f9|rgb\(241, 245, 249\)|rgb\(34, 34, 34\)/)
    // A colour the cell had of its own is kept.
    expect(html).toContain('yellow')
  })
})

describe('adding rows and columns', () => {
  it('right-click inserts a row above or below, and a column left or right, of the clicked cell', async () => {
    const ref = await mount()
    const pick = async (text: string, name: string) => {
      fireEvent.contextMenu(cell(text), { clientX: 140, clientY: 150 })
      await act(async () => fireEvent.click(await screen.findByRole('menuitem', { name })))
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    }

    await pick('March 2026', 'Insert row below')
    expect(rows().map((row) => row[0])).toEqual(['Month', 'March 2026', '', 'April 2026'])
    await pick('March 2026', 'Insert row above')
    expect(rows().map((row) => row[0])).toEqual(['Month', '', 'March 2026', '', 'April 2026'])

    await pick('Setup fee', 'Insert column right')
    expect(rows()[0]).toEqual(['Month', 'Setup fee', '', 'Retainer'])
    await pick('Month', 'Insert column left')
    expect(rows()[0]).toEqual(['', 'Month', 'Setup fee', '', 'Retainer'])
    expect(rows().every((row) => row.length === 5)).toBe(true)

    expect(ref.current?.getHtml()).toContain('Retainer')
  })
})
