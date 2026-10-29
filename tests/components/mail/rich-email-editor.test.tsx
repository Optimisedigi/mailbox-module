import React, { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import RichEmailEditor, {
  clipboardImageFiles,
  PASTE_TEXT_COLOR,
  type EmailSelectionFormat,
  type RichEmailEditorHandle,
} from '@/components/mail/RichEmailEditor'
import { clampImageWidth, MIN_IMAGE_WIDTH, resizedImageWidth, steppedImageWidth } from '@/components/mail/EmailImageNode'
import { normalizeEmailLinkUrl } from '@/components/mail/EmailLinkPlugin'
import * as lexical from 'lexical'
import { fireEvent, screen } from '@testing-library/react'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function mount(initialHtml: string, onFormatChange?: (format: EmailSelectionFormat) => void) {
  const ref = createRef<RichEmailEditorHandle>()
  const onContentChange = vi.fn()
  render(
    <RichEmailEditor
      ref={ref}
      initialHtml={initialHtml}
      placeholder="Write here"
      ariaLabel="Email body"
      onContentChange={onContentChange}
      onPasteFiles={() => undefined}
      onFormatChange={onFormatChange}
    />,
  )
  await waitFor(() => expect(ref.current?.getHtml()).toBeTruthy())
  return { ref, onContentChange }
}

// Lexical scrolls the caret into view on focus and paste; jsdom has no layout for ranges.
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(0, 0, 0, 0),
  })
}

/** Paste into the editor the way a browser does: a DOM paste event carrying the clipboard. */
async function paste(data: Record<string, string>) {
  const editable = document.querySelector('[contenteditable="true"]')
  if (!editable) throw new Error('editor not mounted')
  // Lexical tells clipboard and drag events apart by constructor name; jsdom has neither.
  const globals = globalThis as { ClipboardEvent?: typeof Event; DragEvent?: typeof Event }
  if (!globals.DragEvent) vi.stubGlobal('DragEvent', class DragEvent extends Event {})
  const Clipboard = globals.ClipboardEvent ?? class ClipboardEvent extends Event {}
  if (!globals.ClipboardEvent) vi.stubGlobal('ClipboardEvent', Clipboard)
  const event = new Clipboard('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { types: Object.keys(data), files: [], items: [], getData: (type: string) => data[type] ?? '' },
  })
  // Lexical commits the paste on a microtask.
  await act(async () => {
    editable.dispatchEvent(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Focus the editor and wait for Lexical to place the caret (its focus() is asynchronous). */
async function focusEnd(handle: RichEmailEditorHandle | null) {
  await act(async () => {
    handle?.focus()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const BLACK = /color: (?:#000000|rgb\(0, 0, 0\))/

describe('RichEmailEditor', () => {
  it('keeps bold, italic, underline, tables and inline images from loaded HTML', async () => {
    const { ref } = await mount(
      `<p><b>Bold</b> <i>it</i> <u>under</u></p>` +
        `<table><tr><th>Month</th><th>Clicks</th></tr><tr><td>Sep</td><td>120</td></tr></table>` +
        `<p><img src="data:image/png;base64,${PNG}" alt="chart" width="300"></p>`,
    )
    const html = ref.current?.getHtml() ?? ''
    expect(html).toMatch(/<b>[^]*Bold/)
    expect(html).toMatch(/<i>[^]*it/)
    expect(html).toMatch(/<u>[^]*under/)
    expect(html).toContain('<table')
    expect(html).toContain('Clicks')
    expect(html).toContain(`src="data:image/png;base64,${PNG}"`)
    expect(html).toContain('width="300"')
  })

  it('reopens sent/saved Gmail line divs as the same lines, blank lines included', async () => {
    const { ref } = await mount('<div>Hey,</div><div>1</div><div><br></div><div>Thanks,</div>')
    const paragraphs = Array.from(document.querySelectorAll('[contenteditable="true"] > p')).map((p) => p.textContent)
    expect(paragraphs).toEqual(['Hey,', '1', '', 'Thanks,'])
    expect(ref.current?.getHtml()).not.toMatch(/<br><br>/)
  })

  it('applies AI edits to only the named blocks, keeping the rest and its formatting, and can restore a snapshot', async () => {
    const { ref } = await mount(
      '<p>Hi Sam,</p><p><br></p><p>We <b>loved</b> the <span style="color: #cc0000;">results</span>.</p><p>Next steps:</p><ul><li>Call</li></ul><p><br></p><p>Talk soon.</p>',
    )
    const editor = ref.current
    if (!editor) throw new Error('no editor')
    const blocks = editor.getBlocks()
    expect(blocks.map((block) => block.markdown)).toEqual(['Hi Sam,', 'We loved the results.', 'Next steps:', '- Call', 'Talk soon.'])
    const before = editor.snapshot()
    const ok = editor.applyBlockEdits(
      blocks.map((block) => block.key),
      [
        { op: 'replace', block: 3, text: 'Next steps for Friday:' },
        { op: 'insert_after', block: 5, text: 'Have a good weekend.' },
        { op: 'delete', block: 1 },
      ],
    )
    expect(ok).toBe(true)
    const html = editor.getHtml()
    // Untouched blocks keep their bold and colour; the deleted greeting takes its empty line with it.
    expect(html).toMatch(/<b><strong[^>]*>loved<\/strong><\/b>/)
    expect(html).toContain('color: rgb(204, 0, 0)')
    expect(editor.getMarkdown()).toBe('We loved the results.\n\nNext steps for Friday:\n\n- Call\n\nTalk soon.\n\nHave a good weekend.')
    const lines = Array.from(document.querySelectorAll('[contenteditable="true"] > *')).map((node) => node.textContent)
    // Tight lines stay tight; the new last line gets the empty line the spacing around it calls for.
    expect(lines).toEqual(['We loved the results.', 'Next steps for Friday:', 'Call', '', 'Talk soon.', '', 'Have a good weekend.'])

    // Stale keys (the body changed meanwhile) are refused rather than guessed at.
    expect(editor.applyBlockEdits(['missing'], [{ op: 'delete', block: 1 }])).toBe(false)

    if (!before) throw new Error('no snapshot')
    await act(async () => editor.restore(before))
    expect(editor.getMarkdown()).toBe('Hi Sam,\n\nWe loved the results.\n\nNext steps:\n\n- Call\n\nTalk soon.')
  })

  it('tidies the layout: sized table columns, and empty lines after the greeting, before TL;DR and section labels, and after tables', async () => {
    const table = (rows: string[][]) =>
      `<table><tr>${rows[0]?.map((cell) => `<th>${cell}</th>`).join('')}</tr>${rows
        .slice(1)
        .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
        .join('')}</table>`
    const { ref } = await mount(
      '<p>Hi Melissa,</p><p>Here is the spend.</p><p><b>TLDR;</b></p><p>It went well.</p><p>See the data below:</p>' +
        '<p><b>Overview</b></p>' +
        table([['Metric', 'Total'], ['Impressions', '170,763'], ['Average cost per click', '$4']]) +
        '<p><b>Month by month</b></p>' +
        table([['Month', 'Leads'], ['July (from 10th)', '22']]) +
        '<p>August was our strongest month. <b>Really</b> strong.</p>' +
        table([['Brand', 'Spend'], ['Kohler', '$7,858']]),
    )
    const editor = ref.current
    if (!editor) throw new Error('no editor')
    let changed = false
    await act(async () => {
      changed = editor.tidyLayout()
    })
    expect(changed).toBe(true)
    const lines = Array.from(document.querySelectorAll('[contenteditable="true"] > *')).map((node) =>
      node.tagName === 'TABLE' ? '[table]' : node.textContent,
    )
    expect(lines).toEqual([
      'Hi Melissa,',
      '',
      'Here is the spend.',
      '',
      'TLDR;',
      'It went well.',
      'See the data below:',
      '',
      'Overview',
      '[table]',
      '',
      'Month by month',
      '[table]',
      '',
      // A partly bold sentence is not a section label.
      'August was our strongest month. Really strong.',
      // The last table gets no empty line: the signature brings its own.
      '[table]',
    ])
    // Every cell in a column has the column's width, and the first column fits its longest text.
    const html = editor.getHtml()
    const firstTable = new DOMParser().parseFromString(html, 'text/html').querySelector('table')
    const widths = Array.from(firstTable?.querySelectorAll('tr') ?? []).map((row) =>
      Array.from(row.children).map((cell) => (cell as HTMLElement).style.width),
    )
    expect(widths).toEqual([
      ['198px', '66px'],
      ['198px', '66px'],
      ['198px', '66px'],
    ])
    // Already tidy: a second press changes nothing.
    let again = true
    await act(async () => {
      again = editor.tidyLayout()
    })
    expect(again).toBe(false)
  })

  it('exports tables without Lexical’s fixed 75px cell width, keeping widths a cell really has', async () => {
    const { ref } = await mount(
      '<table><tr><th>Metric</th><th>Total</th></tr><tr><td>Impressions</td><td>170,763</td></tr></table>' +
        '<table><tr><td style="width: 140px">Pasted</td><td>x</td></tr></table>',
    )
    const doc = new DOMParser().parseFromString(ref.current?.getHtml() ?? '', 'text/html')
    const [plain, pasted] = Array.from(doc.querySelectorAll('table')).map((table) =>
      Array.from(table.querySelectorAll('th, td')).map((cell) => (cell as HTMLElement).style.width),
    )
    expect(plain).toEqual(['', '', '', ''])
    // A width from the source is the author's, so it stays; the cell next to it has none.
    expect(pasted).toEqual(['140px', ''])
  })

  it('resizes only the dragged table column, fixing every other column at the width it shows', async () => {
    const { ref } = await mount('<table><tr><th>Metric</th><th>Total</th></tr><tr><td>Impressions</td><td>170,763</td></tr></table>')
    // jsdom has no layout: each column is 100px wide, side by side.
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const index = this instanceof HTMLTableCellElement ? this.cellIndex : 0
      return new DOMRect(index * 100, 0, 100, 20)
    })
    const editable = document.querySelector('[contenteditable="true"]') as HTMLElement
    const cell = editable.querySelector('td') as HTMLTableCellElement
    const pointer = (type: string, target: Element, clientX: number) =>
      target.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }), { pointerId: 1 }))
    // Away from the edge: no resize cursor; at the edge: col-resize.
    pointer('pointermove', cell, 50)
    expect(editable.style.cursor).toBe('')
    pointer('pointermove', cell, 98)
    expect(editable.style.cursor).toBe('col-resize')
    await act(async () => {
      pointer('pointerdown', cell, 98)
      pointer('pointermove', editable, 158)
      pointer('pointerup', editable, 158)
    })
    rect.mockRestore()
    const doc = new DOMParser().parseFromString(ref.current?.getHtml() ?? '', 'text/html')
    const widths = Array.from(doc.querySelectorAll('tr')).map((row) => Array.from(row.children).map((c) => (c as HTMLElement).style.width))
    // Widths are CSS widths (inside the 1px borders), so the other column keeps the width it shows
    // instead of growing by its border on every drag; the dragged one grows by exactly the drag.
    expect(widths).toEqual([
      ['158px', '98px'],
      ['158px', '98px'],
    ])
    expect(editable.style.cursor).toBe('')
  })

  it('drops unsafe images and markup from pasted or loaded HTML', async () => {
    const { ref } = await mount('<p onclick="x()">Hi</p><img src="javascript:alert(1)"><script>alert(1)</script>')
    const html = ref.current?.getHtml() ?? ''
    expect(html).toContain('Hi')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('<script')
  })

  it('never keeps a pasted font or size, but keeps colour and bold inside coloured text', async () => {
    const { ref } = await mount(
      '<p><span style="font-family:Georgia;font-size:28px;color:#cc0000">Red <b>bold</b></span> ' +
        '<font face="Arial" size="6" color="#0b5394">blue</font> <code>mono</code></p>',
    )
    const html = ref.current?.getHtml() ?? ''
    expect(html).not.toMatch(/font-family|font-size|Georgia|Arial|<code/)
    expect(html).toMatch(/<span style="[^"]*color: (?:#cc0000|rgb\(204, 0, 0\))[^"]*">Red /)
    expect(html).toMatch(/<b><strong[^>]*style="[^"]*color: (?:#cc0000|rgb\(204, 0, 0\))[^"]*">bold<\/strong><\/b>/)
    expect(html).toMatch(/color: (?:#0b5394|rgb\(11, 83, 148\))[^"]*">blue/)
    expect(html).toContain('mono')
  })

  it('colours selected text and toggles bulleted and numbered lists', async () => {
    const onFormat = vi.fn()
    const { ref } = await mount('<p>Item one</p>', onFormat)
    act(() => {
      ref.current?.focus()
      ref.current?.toggleList('bullet')
    })
    await waitFor(() => expect(ref.current?.getHtml()).toMatch(/<ul[^>]*><li[^>]*>[^]*Item one/))
    expect(onFormat).toHaveBeenLastCalledWith({ list: 'bullet', color: null })
    act(() => ref.current?.toggleList('number'))
    await waitFor(() => expect(ref.current?.getHtml()).toMatch(/<ol[^>]*><li[^>]*>[^]*Item one/))
    act(() => ref.current?.toggleList('number'))
    await waitFor(() => expect(ref.current?.getHtml()).not.toMatch(/<ol|<ul/))

    act(() => ref.current?.setHtml('<p>Paint me</p>'))
    // Rejected values never reach the text.
    act(() => ref.current?.setTextColor('red;background:url(x)'))
    expect(ref.current?.getHtml()).not.toContain('url(')
  })

  it('pastes HTML in black, keeping bold, italic, underline and lists, and it can be recoloured after', async () => {
    const { ref } = await mount('<p><span style="color: #cc0000">Typed red</span></p>')
    await focusEnd(ref.current)
    expect(PASTE_TEXT_COLOR).toBe('#000000')

    await paste({
      'text/html':
        '<p><span style="color:#0b5394">Blue <b>bold</b> <i>it</i> <u>under</u></span> <font color="#00ff00">green</font> plain</p>' +
        '<ul><li><span style="color:#ff00ff">Pink item</span></li></ul><ol><li>Numbered</li></ol>',
      'text/plain': 'Blue bold it under green plain\nPink item\nNumbered',
    })

    const html = ref.current?.getHtml() ?? ''
    expect(html).not.toMatch(/0b5394|rgb\(11, 83, 148\)|00ff00|rgb\(0, 255, 0\)|ff00ff|rgb\(255, 0, 255\)/)
    expect(html).toMatch(/<b><strong[^>]*style="[^"]*color: (?:#000000|rgb\(0, 0, 0\))[^"]*">bold<\/strong><\/b>/)
    expect(html).toMatch(/<i>[^]*it/)
    expect(html).toMatch(/<u>[^]*under/)
    for (const text of ['Blue ', 'green', 'Pink item', 'Numbered']) {
      expect(html).toMatch(new RegExp(`style="[^"]*${BLACK.source}[^"]*">${text}`))
    }
    expect(html).toMatch(/<ul[^>]*><li[^>]*>[^]*Pink item/)
    expect(html).toMatch(/<ol[^>]*><li[^>]*>[^]*Numbered/)
    // Text that was already there keeps its colour.
    expect(html).toMatch(/color: (?:#cc0000|rgb\(204, 0, 0\))[^"]*">Typed red/)

    // It's an ordinary colour: select all and change it.
    act(() => {
      const editable = document.querySelector('[contenteditable="true"]')
      const range = document.createRange()
      if (editable) range.selectNodeContents(editable)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      ref.current?.setTextColor('#0000ff')
    })
    const recoloured = ref.current?.getHtml() ?? ''
    expect(recoloured).not.toMatch(BLACK)
    expect(recoloured).toMatch(/color: (?:#0000ff|rgb\(0, 0, 255\))[^"]*">Pink item/)
  })

  it('pastes plain text in black, even into coloured text', async () => {
    const { ref } = await mount('<p><span style="color: #cc0000">Red</span></p>')
    await focusEnd(ref.current)

    await paste({ 'text/plain': ' pasted words' })

    const html = ref.current?.getHtml() ?? ''
    expect(html).toMatch(/color: (?:#cc0000|rgb\(204, 0, 0\))[^"]*">Red</)
    expect(html).toMatch(new RegExp(`style="[^"]*${BLACK.source}[^"]*"> pasted words<`))
  })

  it('gives the AI tables as markdown and inserts new tables', async () => {
    const { ref } = await mount('<p>Hi Sam,</p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>')
    expect(ref.current?.getMarkdown()).toBe('Hi Sam,\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')

    act(() => ref.current?.setHtml(''))
    act(() => {
      ref.current?.focus()
      ref.current?.insertTable(2, 3)
    })
    await waitFor(() => expect((ref.current?.getHtml().match(/<td|<th/g) ?? []).length).toBe(6))
  })

  it('pastes a copied image as the image itself, but keeps tables and text as HTML', () => {
    const png = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })
    const clip = (html: string, text = '') => ({ files: [png] as unknown as FileList, getData: (type: string) => (type === 'text/html' ? html : text) })
    // Screenshot, copied web image, image file copied in Finder.
    expect(clipboardImageFiles(clip(''))).toEqual([png])
    expect(clipboardImageFiles(clip('<meta charset="utf-8"><img src="http://x/a.png">'))).toEqual([png])
    expect(clipboardImageFiles(clip('', 'image.png'))).toEqual([png])
    // Excel/Docs also put a picture of the selection on the clipboard: the HTML wins.
    expect(clipboardImageFiles(clip('<table><tr><td>Clicks</td></tr></table>'))).toBeNull()
    expect(clipboardImageFiles({ files: [] as unknown as FileList, getData: () => '' })).toBeNull()
  })

  it('inserts images inline at the cursor and resizes them', async () => {
    const { ref } = await mount('<p>Before after</p>')
    act(() => {
      ref.current?.focus()
      ref.current?.insertImage(`data:image/png;base64,${PNG}`, 'shot', 300)
    })
    await waitFor(() => expect(ref.current?.getHtml()).toMatch(/<p[^>]*>[^]*<img[^>]*width="300"/))
    expect(clampImageWidth(10, 500)).toBe(MIN_IMAGE_WIDTH)
    expect(clampImageWidth(900, 500)).toBe(500)
    expect(clampImageWidth(250.4, 500)).toBe(250)
    // Right corners grow when dragged right, left corners when dragged left.
    expect(resizedImageWidth(300, 50, 'se', 600)).toBe(350)
    expect(resizedImageWidth(300, 50, 'ne', 600)).toBe(350)
    expect(resizedImageWidth(300, -50, 'nw', 600)).toBe(350)
    expect(resizedImageWidth(300, 50, 'sw', 600)).toBe(250)
    expect(resizedImageWidth(300, 900, 'se', 600)).toBe(600)

    // Clicking the image selects it and shows a handle on every corner.
    const img = document.querySelector('img[alt="shot"]') as HTMLImageElement
    act(() => {
      img.click()
    })
    await waitFor(() => expect(document.querySelectorAll('[data-corner]')).toHaveLength(4))
  })
})

/** Select `text` inside the editor the way a user drags over it. */
async function selectText(text: string) {
  await act(async () => {
    const editable = document.querySelector('[contenteditable="true"]')
    const walker = document.createTreeWalker(editable ?? document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent?.indexOf(text) ?? -1
      if (start < 0) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + text.length)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function pressCmdK() {
  const editable = document.querySelector('[contenteditable="true"]')
  if (!editable) throw new Error('editor not mounted')
  await act(async () => {
    fireEvent.keyDown(editable, { key: 'k', metaKey: true })
  })
}

describe('RichEmailEditor links (Cmd+K)', () => {
  it('turns the selected text into a hyperlink', async () => {
    const { ref } = await mount('<p>See our results page today.</p>')
    await focusEnd(ref.current)
    await selectText('results page')
    await pressCmdK()

    const input = screen.getByLabelText('Link address')
    fireEvent.change(input, { target: { value: 'example.com/results' } })
    await act(async () => {
      fireEvent.submit(input.closest('form') as HTMLFormElement)
    })

    expect(screen.queryByRole('dialog', { name: 'Add link' })).toBeNull()
    const html = ref.current?.getHtml() ?? ''
    expect(html).toMatch(/<a href="https:\/\/example\.com\/results"[^>]*>[^]*results page[^]*<\/a>/)
    expect(html).toContain('See our ')
    expect(html).toContain(' today.')
  })

  it('rejects unsafe or unusable links and keeps the text unlinked', async () => {
    const { ref } = await mount('<p>Click here</p>')
    await focusEnd(ref.current)
    await selectText('here')
    await pressCmdK()

    const input = screen.getByLabelText('Link address')
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } })
    await act(async () => {
      fireEvent.submit(input.closest('form') as HTMLFormElement)
    })

    expect(screen.getByRole('alert').textContent).toMatch(/web address/)
    expect(ref.current?.getHtml()).not.toContain('<a')
  })

  it('keeps links from loaded HTML and can remove one with Cmd+K', async () => {
    const { ref } = await mount('<p>Read <a href="https://example.com/a">the report</a>.</p>')
    expect(ref.current?.getHtml()).toMatch(/<a href="https:\/\/example\.com\/a"/)
    await focusEnd(ref.current)
    await selectText('the report')
    await pressCmdK()

    expect((screen.getByLabelText('Link address') as HTMLInputElement).value).toBe('https://example.com/a')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    })
    const html = ref.current?.getHtml() ?? ''
    expect(html).not.toContain('<a')
    expect(html).toContain('the report')
  })

  it('normalises typed links to http(s), mailto or tel only', () => {
    expect(normalizeEmailLinkUrl('example.com')).toBe('https://example.com')
    expect(normalizeEmailLinkUrl('https://ourteam.example/x')).toBe('https://ourteam.example/x')
    expect(normalizeEmailLinkUrl('sam@example.com')).toBe('mailto:sam@example.com')
    expect(normalizeEmailLinkUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeEmailLinkUrl('data:text/html,hi')).toBeNull()
    expect(normalizeEmailLinkUrl('not a link')).toBeNull()
    expect(normalizeEmailLinkUrl('')).toBeNull()
  })
})

/** The Lexical editor behind the mounted body (Lexical keeps it on the root element). */
function lexicalEditor() {
  const editable = document.querySelector('[contenteditable="true"]') as (HTMLElement & { __lexicalEditor?: import('lexical').LexicalEditor }) | null
  const editor = editable?.__lexicalEditor
  if (!editor) throw new Error('editor not mounted')
  return editor
}

function bodyBlocks(): string[] {
  return Array.from(document.querySelectorAll('[contenteditable="true"] > *')).map((node) => `${node.nodeName}:${node.textContent}`)
}

describe('RichEmailEditor lists', () => {
  it('bullets only the cursor line when it shares a paragraph with the line above (Shift+Enter)', async () => {
    const { ref } = await mount('<p>Thanks<br>Pat</p>')
    await focusEnd(ref.current)
    await act(async () => {
      lexicalEditor().update(() => {
        lexical.$getRoot().getLastDescendant()?.selectEnd()
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    act(() => ref.current?.toggleList('bullet'))
    await waitFor(() => expect(bodyBlocks()).toEqual(['P:Thanks', 'UL:Pat']))
  })

  it('bullets only the new empty line after a Shift+Enter', async () => {
    const { ref } = await mount('<p>Thanks</p>')
    await act(async () => {
      lexicalEditor().update(() => {
        const paragraph = lexical.$getRoot().getFirstChild()
        if (!lexical.$isElementNode(paragraph)) throw new Error('no paragraph')
        paragraph.append(lexical.$createLineBreakNode())
        paragraph.select(2, 2)
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    act(() => ref.current?.toggleList('bullet'))
    await waitFor(() => expect(bodyBlocks()).toEqual(['P:Thanks', 'UL:']))
  })

  it('turns "- " and "1. " at the start of a line into bulleted and numbered lists', async () => {
    const { ref } = await mount('<p>Hi</p>')
    const typeChar = async (text: string) => {
      await act(async () => {
        lexicalEditor().update(() => {
          const selection = lexical.$getSelection()
          selection?.insertText(text)
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    const newLine = async () => {
      await act(async () => {
        lexicalEditor().update(() => {
          const paragraph = lexical.$createParagraphNode()
          lexical.$getRoot().append(paragraph)
          paragraph.select()
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    await newLine()
    for (const char of '- Call') await typeChar(char)
    await newLine()
    for (const char of '1. First') await typeChar(char)
    expect(bodyBlocks()).toEqual(['P:Hi', 'UL:Call', 'OL:First'])
    expect(ref.current?.getMarkdown()).toBe('Hi\n\n- Call\n\n1. First')
  })
})

describe('RichEmailEditor "@" tagging', () => {
  // The menu repositions itself with a ResizeObserver, which jsdom lacks.
  if (typeof globalThis.ResizeObserver !== 'function') {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  }

  it('suggests people after "@" and a letter, and puts the pick in as an @Name mailto link', async () => {
    const ref = createRef<RichEmailEditorHandle>()
    const onWantContacts = vi.fn()
    render(
      <RichEmailEditor
        ref={ref}
        initialHtml="<p>Hi</p>"
        placeholder="Write here"
        ariaLabel="Email body"
        onContentChange={() => undefined}
        onPasteFiles={() => undefined}
        mentions={{
          contacts: [
            { email: 'john.smith@client.com', name: 'John Smith' },
            { email: 'rebecca@acmeclient.com.au', name: 'Rebecca Jones' },
          ],
          onWantContacts,
        }}
      />,
    )
    await waitFor(() => expect(ref.current?.getHtml()).toBeTruthy())
    await focusEnd(ref.current)
    await act(async () => {
      lexicalEditor().update(() => lexical.$getRoot().selectEnd())
    })
    for (const char of ' thanks @sm') {
      await act(async () => {
        lexicalEditor().update(() => lexical.$getSelection()?.insertText(char))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }

    const option = await screen.findByRole('option', { name: /John Smith/ })
    expect(screen.queryByRole('option', { name: /Rebecca/ })).toBeNull()
    expect(onWantContacts).toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(option)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const html = ref.current?.getHtml() ?? ''
    expect(html).toMatch(/<a href="mailto:john\.smith@client\.com"[^>]*>[^]*@John Smith[^]*<\/a>/)
    expect(html).not.toContain('@sm')
    expect(html).toContain('Hi thanks ')
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('never opens for an "@" inside an email address', async () => {
    const ref = createRef<RichEmailEditorHandle>()
    render(
      <RichEmailEditor
        ref={ref}
        initialHtml="<p>Hi</p>"
        placeholder="Write here"
        ariaLabel="Email body"
        onContentChange={() => undefined}
        onPasteFiles={() => undefined}
        mentions={{ contacts: [{ email: 'smith@client.com', name: 'Smith' }], onWantContacts: () => undefined }}
      />,
    )
    await waitFor(() => expect(ref.current?.getHtml()).toBeTruthy())
    await focusEnd(ref.current)
    await act(async () => {
      lexicalEditor().update(() => lexical.$getRoot().selectEnd())
    })
    for (const char of ' jo@sm') {
      await act(async () => {
        lexicalEditor().update(() => lexical.$getSelection()?.insertText(char))
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    expect(screen.queryByRole('option')).toBeNull()
  })
})

describe('RichEmailEditor pasted images (shadow, - image / + image)', () => {
  it('gives the user’s own images a shadow that is sent with the email, and resizes only those', async () => {
    const { ref } = await mount('<p>Quoted <img src="https://example.com/logo.png" alt="logo" width="200"></p>')
    act(() => {
      ref.current?.focus()
      ref.current?.insertImage(`data:image/png;base64,${PNG}`, 'shot', 300)
      ref.current?.insertImage(`data:image/png;base64,${PNG}`, 'chart', 500)
    })
    await waitFor(() => expect(ref.current?.getHtml()).toMatch(/alt="chart"/))
    const html = ref.current?.getHtml() ?? ''
    expect(html).toMatch(/<img[^>]*alt="shot"[^>]*style="[^"]*box-shadow:/)
    // An image that came in with the loaded HTML keeps its own look.
    expect(html).not.toMatch(/<img[^>]*alt="logo"[^>]*box-shadow/)

    // Both pasted images shrink by 10% together; the loaded one is left alone.
    expect(ref.current?.scalePastedImages(-1)).toBe(2)
    await waitFor(() => expect(ref.current?.getHtml()).toMatch(/alt="shot" width="270"/))
    expect(ref.current?.getHtml()).toMatch(/alt="chart" width="450"/)
    expect(ref.current?.getHtml()).toMatch(/alt="logo" width="200"/)
    expect(ref.current?.scalePastedImages(1)).toBe(2)
    await waitFor(() => expect(ref.current?.getHtml()).toMatch(/alt="shot" width="297"/))

    // A saved draft brings its pasted images back with the shadow (still resizable).
    act(() => ref.current?.setHtml(ref.current?.getHtml() ?? ''))
    await waitFor(() => expect(ref.current?.scalePastedImages(-1)).toBe(2))
  })

  // Regression: the admin renders at zoom 0.9, where a 300px image measures 270 on screen.
  // Scaling from the on-screen size made "+ image" shrink images (270 × 1.1 = 297).
  it('scales from the image’s CSS width, not its zoomed on-screen size', async () => {
    const { ref } = await mount('<p>Hi</p>')
    act(() => {
      ref.current?.focus()
      ref.current?.insertImage(`data:image/png;base64,${PNG}`, 'shot', 300)
    })
    await waitFor(() => expect(ref.current?.getHtml()).toMatch(/alt="shot" width="300"/))
    const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this instanceof HTMLImageElement ? Number(this.getAttribute('width')) : 0
    })
    const rect = vi.spyOn(HTMLImageElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLImageElement) {
      return new DOMRect(0, 0, Number(this.getAttribute('width')) * 0.9, 10)
    })
    try {
      expect(ref.current?.scalePastedImages(1)).toBe(1)
      await waitFor(() => expect(ref.current?.getHtml()).toMatch(/alt="shot" width="330"/))
      expect(ref.current?.scalePastedImages(-1)).toBe(1)
      await waitFor(() => expect(ref.current?.getHtml()).toMatch(/alt="shot" width="297"/))
    } finally {
      offset.mockRestore()
      rect.mockRestore()
    }
  })

  it('stops at the smallest width', () => {
    expect(steppedImageWidth(300, -1, 600)).toBe(270)
    expect(steppedImageWidth(300, 1, 600)).toBe(330)
    expect(steppedImageWidth(580, 1, 600)).toBe(600)
    expect(steppedImageWidth(MIN_IMAGE_WIDTH, -1, 600)).toBe(MIN_IMAGE_WIDTH)
  })
})

describe('RichEmailEditor kept highlight', () => {
  it('keeps highlighted text after focus leaves and replaces only that text', async () => {
    const ref = createRef<RichEmailEditorHandle>()
    const onHighlightChange = vi.fn()
    render(
      <>
        <RichEmailEditor
          ref={ref}
          initialHtml="<p>Hi Sam,</p><p>We have reviewed the account in a lot of detail this week. More soon.</p>"
          placeholder="Write here"
          ariaLabel="Email body"
          onContentChange={() => undefined}
          onPasteFiles={() => undefined}
          onHighlightChange={onHighlightChange}
        />
        <textarea aria-label="AI box" />
      </>,
    )
    await waitFor(() => expect(ref.current?.getHtml()).toBeTruthy())
    await focusEnd(ref.current)
    await selectText('We have reviewed the account in a lot of detail this week.')
    await waitFor(() => expect(onHighlightChange).toHaveBeenLastCalledWith('We have reviewed the account in a lot of detail this week.'))

    // Focus moves to the AI box: the highlight is still there.
    await act(async () => {
      screen.getByLabelText('AI box').focus()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(ref.current?.getHighlightedText()).toBe('We have reviewed the account in a lot of detail this week.')

    // Text that no longer matches is refused; the matching text is replaced in place.
    expect(ref.current?.replaceHighlighted('Something else', 'x')).toBe(false)
    let replaced = false
    act(() => {
      replaced = ref.current?.replaceHighlighted('We have reviewed the account in a lot of detail this week.', 'We reviewed the account this week.') ?? false
    })
    expect(replaced).toBe(true)
    expect(ref.current?.getMarkdown()).toBe('Hi Sam,\n\nWe reviewed the account this week. More soon.')
    expect(ref.current?.getHighlightedText()).toBeNull()
    expect(onHighlightChange).toHaveBeenLastCalledWith(null)
  })
})
