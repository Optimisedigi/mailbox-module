import { describe, expect, it } from 'vitest'
import { applyBlockEditsToText, numberBlocks, parseBlockEdits } from '@/lib/mail/revise-edits'
import { markdownLiteToBlocksHtml } from '@/lib/email-draft-markdown'

const BLOCKS = ['Hi Sam,', 'Thanks for the call.', '- one\n- two', 'Talk soon.']

describe('parseBlockEdits', () => {
  it('reads plain, fenced or wrapped JSON and cleans the text', () => {
    expect(parseBlockEdits('{"edits":[{"op":"replace","block":2,"text":"[2]\\nThanks again."}]}', 4)).toEqual([
      { op: 'replace', block: 2, text: 'Thanks again.' },
    ])
    expect(parseBlockEdits('Here you go:\n```json\n{"edits":[{"op":"insert_after","block":0,"text":"Quick one."}]}\n```', 4)).toEqual([
      { op: 'insert_after', block: 0, text: 'Quick one.' },
    ])
    // Replacing a block with nothing deletes it.
    expect(parseBlockEdits('{"edits":[{"op":"replace","block":4,"text":"  "}]}', 4)).toEqual([{ op: 'delete', block: 4 }])
    expect(parseBlockEdits('{"edits":[]}', 4)).toEqual([])
  })

  it('rejects anything it cannot apply safely', () => {
    expect(parseBlockEdits('Hi Sam, a whole new email', 4)).toBeNull()
    expect(parseBlockEdits('{"edits":[{"op":"replace","block":5,"text":"x"}]}', 4)).toBeNull()
    expect(parseBlockEdits('{"edits":[{"op":"delete","block":0}]}', 4)).toBeNull()
    expect(parseBlockEdits('{"edits":[{"op":"rewrite","block":1,"text":"x"}]}', 4)).toBeNull()
    expect(parseBlockEdits('{"edits":[{"op":"replace","block":"2","text":"x"}]}', 4)).toBeNull()
  })
})

describe('applyBlockEditsToText', () => {
  it('changes only the edited blocks and keeps the rest word for word', () => {
    expect(
      applyBlockEditsToText(BLOCKS, [
        { op: 'replace', block: 2, text: 'Thanks for the call today.' },
        { op: 'insert_after', block: 3, text: 'Friday works too.' },
        { op: 'delete', block: 4 },
        { op: 'insert_after', block: 0, text: 'Quick one.' },
      ]),
    ).toEqual(['Quick one.', 'Hi Sam,', 'Thanks for the call today.', '- one\n- two', 'Friday works too.'])
    // A replace beats a delete of the same block.
    expect(applyBlockEditsToText(['a'], [{ op: 'delete', block: 1 }, { op: 'replace', block: 1, text: 'b' }])).toEqual(['b'])
  })

  it('numbers blocks for the model', () => {
    expect(numberBlocks(['Hi,', 'Bye'])).toBe('[1]\nHi,\n\n[2]\nBye')
  })
})

describe('markdownLiteToBlocksHtml', () => {
  it('keeps one empty line per blank-line gap for the compose editor, never at the ends', () => {
    expect(markdownLiteToBlocksHtml('\nHi Sam,\n\n\nOne\nTwo\n\n- a\n\nBye\n\n', { blankLines: true })).toBe(
      '<p>Hi Sam,</p><p><br></p><p>One</p><p>Two</p><p><br></p><ul><li>a</li></ul><p><br></p><p>Bye</p>',
    )
    expect(markdownLiteToBlocksHtml('Hi\n\nBye')).toBe('<p>Hi</p><p>Bye</p>')
  })
})
