import { describe, expect, it } from 'vitest'
import { appendGmailSignature, formatGmailDraftHtml } from '@/lib/gmail-service'
import { buildEditableDraft, stripAppendedSignature } from '@/lib/mail/draft-content'

const SIGNATURE = '<div dir="ltr"><p style="font-family:Arial;font-size:12px">Pat Lee</p><img src="https://example.com/logo.png"></div>'

describe('stripAppendedSignature', () => {
  it('removes the signature createGmailDraft appended, keeping the body', () => {
    const saved = formatGmailDraftHtml(appendGmailSignature('<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937;"><p>Hi Sam,</p><p>Thursday works.</p></div>', SIGNATURE))
    const body = stripAppendedSignature(saved, SIGNATURE)
    expect(body).toBe(
      '<div style="font-family:Verdana,sans-serif;font-size:small;line-height:1.5;color:#1f2937;">Hi Sam,<br><br>Thursday works.</div>',
    )
    expect(body).not.toContain('Pat Lee')
  })

  it('leaves drafts without that signature alone', () => {
    expect(stripAppendedSignature('<p>Hi</p>', SIGNATURE)).toBe('<p>Hi</p>')
    expect(stripAppendedSignature('<p>Hi</p>', '')).toBe('<p>Hi</p>')
  })
})

describe('buildEditableDraft', () => {
  it('shows inline images as data URLs and returns other files as attachments', () => {
    const draft = buildEditableDraft(
      {
        html: '<p>See <img src="cid:image1@mailbox.local"></p><script>x()</script>',
        text: '',
        inline: [{ filename: 'image-1.png', mimeType: 'image/png', contentId: 'image1@mailbox.local', data: 'AAAA', size: 3 }],
        attachments: [{ filename: 'quote.pdf', mimeType: 'application/pdf', contentId: '', data: 'BBBB', size: 3 }],
        tooLarge: false,
      },
      '',
    )
    expect(draft.html).toBe('<p>See <img src="data:image/png;base64,AAAA"></p>')
    expect(draft.attachments).toEqual([{ name: 'quote.pdf', mediaType: 'application/pdf', data: 'BBBB' }])
  })

  it('uses the plain-text part when a draft has no HTML', () => {
    const draft = buildEditableDraft({ html: '', text: 'Hi <Sam>\nThanks', inline: [], attachments: [], tooLarge: false }, '')
    expect(draft.html).toBe('Hi &lt;Sam&gt;<br>Thanks')
  })

  it('marks a draft saved without the signature, so it reopens with the Signature toggle off', () => {
    const parts = (html: string) => ({ html, text: '', inline: [], attachments: [], tooLarge: false })
    const signed = formatGmailDraftHtml(appendGmailSignature('<p>Hi Sam</p>', SIGNATURE))
    expect(buildEditableDraft(parts(signed), SIGNATURE).noSignature).toBeUndefined()
    expect(buildEditableDraft(parts(formatGmailDraftHtml('<p>Hi Sam</p>')), SIGNATURE).noSignature).toBe(true)
    // No signature set in Gmail: nothing to turn off.
    expect(buildEditableDraft(parts('<p>Hi Sam</p>'), '').noSignature).toBeUndefined()
  })
})
