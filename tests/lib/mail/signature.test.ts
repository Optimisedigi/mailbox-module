import { describe, expect, it } from 'vitest'
import { appendGmailSignature, formatGmailDraftHtml } from '@/lib/gmail-service'
import { buildEditableDraft } from '@/lib/mail/draft-content'
import { cleanSignOff, splitSignatureSignOff, withEditedSignOff } from '@/lib/mail/signature'

// Gmail's usual signature shape: one div per line, a blank div, then contact details and a logo.
const DIVS =
  '<div dir="ltr"><div><font face="arial, sans-serif">Thanks,</font></div><div><font face="arial, sans-serif">Pat</font></div>' +
  '<div><br></div><div>+61 400 000 000 | <a href="mailto:pat@ourteam.example">pat@ourteam.example</a></div>' +
  '<div><img src="https://example.com/logo.png" width="200"></div></div>'

// The same written with <br>s inside one wrapper.
const BRS = '<div style="font-family:Arial;font-size:14px">Thanks,<br>Pat<br><br>+61 400 000 000 | <a href="mailto:p@x.com">p@x.com</a></div>'

describe('splitSignatureSignOff', () => {
  it('takes the leading "Thanks, Pat" lines and keeps the rest as valid HTML', () => {
    const parts = splitSignatureSignOff(DIVS)
    expect(parts?.signOff).toBe('Thanks,\nPat')
    // The wrapper div is re-opened so the rest stays balanced; the sign-off text is gone.
    expect(parts?.rest).toBe(
      '<div dir="ltr"><div><br></div><div>+61 400 000 000 | <a href="mailto:pat@ourteam.example">pat@ourteam.example</a></div>' +
        '<div><img src="https://example.com/logo.png" width="200"></div></div>',
    )
  })

  it('handles <br> line breaks and keeps the wrapper’s styling on the rest', () => {
    const parts = splitSignatureSignOff(BRS)
    expect(parts?.signOff).toBe('Thanks,\nPat')
    expect(parts?.rest).toBe('<div style="font-family:Arial;font-size:14px"><br>+61 400 000 000 | <a href="mailto:p@x.com">p@x.com</a></div>')
  })

  it('leaves signatures without a clear sign-off alone', () => {
    // Logo first, four plain lines with no gap, or one very long line.
    expect(splitSignatureSignOff('<img src="https://x/logo.png"><div>Thanks,</div>')).toBeNull()
    expect(splitSignatureSignOff('<div>Pat Lee</div><div>SEO</div><div>Sydney</div><div>Australia</div>')).toBeNull()
    expect(splitSignatureSignOff(`<div>${'x'.repeat(80)}</div><div><br></div>`)).toBeNull()
    expect(splitSignatureSignOff('')).toBeNull()
  })

  it('a signature that is only a sign-off has no rest', () => {
    expect(splitSignatureSignOff('<div>Cheers,</div><div>Pat</div>')).toEqual({ signOff: 'Cheers,\nPat', rest: '' })
  })
})

describe('edited sign-off in sent mail', () => {
  it('sends the edited sign-off in the body font, then the rest of the signature', () => {
    const html = formatGmailDraftHtml(appendGmailSignature('<p>Hi Sam,</p>', withEditedSignOff(DIVS, 'Cheers,\nPat & co')))
    expect(html).toContain('<div data-mailbox-gmail-draft-font="true" style="font-family:Verdana,sans-serif;font-size:small;')
    expect(html).toContain('<div data-mailbox-signoff="true">Cheers,<br>Pat &amp; co</div>')
    expect(html).not.toContain('Thanks,')
    expect(html).toContain('+61 400 000 000')
    expect(html).toContain('logo.png')
  })

  it('leaves exactly one blank line before the signature, whatever the body ends with', () => {
    const sig = '<div data-mailbox-signoff="true">Thanks,</div>'
    // Line divs, with empty lines left at the end of the body.
    expect(appendGmailSignature('<div>Hi</div><div><br></div><div><br></div>', sig)).toBe(`<div>Hi</div><br>${sig}`)
    // A list (its own margin plus one <br>), with and without a trailing empty line.
    const list = '<ol><li>1</li></ol>'
    expect(appendGmailSignature(list, sig)).toBe(`${list}<br>${sig}`)
    expect(appendGmailSignature(`${list}<div><br></div>`, sig)).toBe(`${list}<br>${sig}`)
    // Paragraphs: formatGmailDraftHtml turns the last one into a line plus one blank line.
    expect(formatGmailDraftHtml(appendGmailSignature('<p>Hi</p><p><br></p>', sig))).toContain(`Hi<br><br>${sig}`)
  })

  it('an emptied sign-off sends just the rest of the signature', () => {
    expect(withEditedSignOff(DIVS, '  ')).toBe(`<div data-mailbox-signoff="true"></div>${splitSignatureSignOff(DIVS)?.rest}`)
    // Reopening that draft keeps the sign-off empty and does not duplicate the signature.
    const saved = formatGmailDraftHtml(appendGmailSignature('<p>Hi Sam,</p>', withEditedSignOff(DIVS, '')))
    const draft = buildEditableDraft({ html: saved, text: '', inline: [], attachments: [], tooLarge: false }, DIVS)
    expect(draft).toMatchObject({ html: 'Hi Sam,', signOff: '' })
    // Nothing to replace: the signature is used as it is.
    expect(withEditedSignOff('<img src="https://x/l.png">', 'Hi')).toBe('<img src="https://x/l.png">')
  })

  it('a reopened draft gives back the body and the edited sign-off, without the signature', () => {
    const saved = formatGmailDraftHtml(appendGmailSignature('<p>Hi Sam,</p><p>Thursday works.</p>', withEditedSignOff(DIVS, 'Cheers,\nPat')))
    const draft = buildEditableDraft({ html: saved, text: '', inline: [], attachments: [], tooLarge: false }, DIVS)
    expect(draft.signOff).toBe('Cheers,\nPat')
    expect(draft.html).toBe('Hi Sam,<br><br>Thursday works.')
  })

  it('validates the sign-off from requests', () => {
    expect(cleanSignOff(undefined)).toBeUndefined()
    expect(cleanSignOff(42)).toBeUndefined()
    expect(cleanSignOff('Thanks,\r\nPat\u0000  ')).toBe('Thanks,\nPat')
    expect(cleanSignOff('a\nb\nc\nd\ne\nf\ng\nh')?.split('\n')).toHaveLength(6)
    expect(cleanSignOff('x'.repeat(400))).toHaveLength(300)
  })
})
