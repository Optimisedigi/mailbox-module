import { describe, expect, it } from 'vitest'
import { parseMailComposeContent } from '@/lib/mail/compose-content'
import { extractInlineImages } from '@/lib/mail/compose-html'
import { MAIL_ATTACHMENT_LIMITS } from '@/lib/mail/compose-limits'

// 1x1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PDF = Buffer.from('%PDF-1.4 test').toString('base64')

describe('extractInlineImages', () => {
  it('turns pasted data: images into cid references, once per distinct image', () => {
    const html = `<p>Hi</p><img src="data:image/png;base64,${PNG}" alt="a"><img src="data:image/png;base64,${PNG}" alt="b"><img src="https://example.com/x.png">`
    const result = extractInlineImages(html)
    expect(result.inlineImages).toHaveLength(1)
    expect(result.inlineImages[0]).toMatchObject({ contentId: 'image1@mailbox.local', mediaType: 'image/png', data: PNG })
    expect(result.html).toBe(
      '<p>Hi</p><img src="cid:image1@mailbox.local" alt="a"><img src="cid:image1@mailbox.local" alt="b"><img src="https://example.com/x.png">',
    )
  })
})

describe('parseMailComposeContent', () => {
  it('keeps hyperlinks added in the editor', () => {
    const result = parseMailComposeContent({
      html: '<p>See <a href="https://example.com/results" rel="noreferrer" class="x"><span>our results</span></a></p>',
      inlineImages: [],
      attachments: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.html).toContain('<a href="https://example.com/results" rel="noreferrer"><span>our results</span></a>')
  })

  it('accepts formatted HTML with a table, an inline image and an attached file', () => {
    const result = parseMailComposeContent({
      html: '<p class="x"><b>Hi</b> <i>there</i> <u>Sam</u></p><table><tr><td>A</td></tr></table><img src="cid:image1@mailbox.local">',
      inlineImages: [{ contentId: 'image1@mailbox.local', name: 'image-1.png', mediaType: 'image/png', data: PNG }],
      attachments: [{ name: 'quote.pdf', mediaType: 'application/pdf', data: PDF }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Classes are dropped; the table look the editor gave via CSS is written inline for Gmail.
    expect(result.value.html).toBe(
      '<div><b>Hi</b> <i>there</i> <u>Sam</u></div><table style="border-collapse:collapse;font-family:Verdana,sans-serif;font-size:small" cellspacing="0"><tr><td style="border:1px solid #9aa0a6;padding:4px 8px;vertical-align:top">A</td></tr></table><img src="cid:image1@mailbox.local">',
    )
    expect(result.value.inlineImages).toHaveLength(1)
    expect(result.value.attachments[0]).toMatchObject({ filename: 'quote.pdf', mimeType: 'application/pdf' })
  })

  it('removes scripts, handlers and images that are not cid: or https', () => {
    const result = parseMailComposeContent({
      html: '<p onclick="steal()">Hi</p><script>alert(1)</script><img src="javascript:alert(1)"><img src="data:image/png;base64,AAAA"><img src="cid:unknown@x.y"><img src="https://example.com/a.png">',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.html).toBe('<div>Hi</div><img src="https://example.com/a.png">')
  })

  it('drops inline images the body no longer shows', () => {
    const result = parseMailComposeContent({
      html: '<p>Hi</p>',
      inlineImages: [{ contentId: 'image1@mailbox.local', name: 'image-1.png', mediaType: 'image/png', data: PNG }],
    })
    expect(result.ok && result.value.inlineImages).toEqual([])
  })

  it('rejects an empty body, fake images, blocked file types and oversized emails', () => {
    expect(parseMailComposeContent({ html: '<p>&nbsp;</p>' })).toEqual({ ok: false, error: 'The email body is empty.' })
    expect(
      parseMailComposeContent({
        html: '<img src="cid:image1@mailbox.local">',
        inlineImages: [{ contentId: 'image1@mailbox.local', name: 'x.png', mediaType: 'image/png', data: PDF }],
      }),
    ).toEqual({ ok: false, error: 'x.png is not a valid image.' })
    expect(
      parseMailComposeContent({ html: '<p>Hi</p>', attachments: [{ name: 'setup.exe', mediaType: 'application/x-msdownload', data: PDF }] }),
    ).toEqual({ ok: false, error: "setup.exe can't be attached: Gmail blocks .exe files." })

    const big = Buffer.alloc(MAIL_ATTACHMENT_LIMITS.maxTotalBytes / 2 + 1).toString('base64')
    const tooBig = parseMailComposeContent({
      html: '<p>Hi</p>',
      attachments: [
        { name: 'a.bin', mediaType: 'application/octet-stream', data: big },
        { name: 'b.bin', mediaType: 'application/octet-stream', data: big },
      ],
    })
    expect(tooBig).toEqual({ ok: false, error: 'Images and attachments can total up to 3 MB per email.' })
  })

  it('falls back to a safe MIME type for odd attachment types', () => {
    const result = parseMailComposeContent({
      html: '<p>Hi</p>',
      attachments: [{ name: 'notes.txt', mediaType: 'text/plain\r\nX-Evil: 1', data: PDF }],
    })
    expect(result.ok && result.value.attachments[0]?.mimeType).toBe('application/octet-stream')
  })
})
