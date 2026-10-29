import { describe, expect, it } from 'vitest'
import { buildEmailDocument } from '@/lib/mail/email-html'
import {
  emailHtmlToMarkdown,
  exportFileName,
  messageToMarkdown,
  senderDisplayName,
  stripQuotedText,
  threadToMarkdown,
  type ExportableMessage,
} from '@/lib/mail/export'

const TZ = 'Australia/Sydney'

const message = (over: Partial<ExportableMessage>): ExportableMessage => ({
  from: 'Pat Lee <pat@ourteam.example>',
  to: 'Sam Lee <sam@client.com>',
  cc: '',
  subject: 'Proposal',
  date: '2026-10-21T22:38:00.000Z',
  body: '',
  html: '',
  ...over,
})

describe('emailHtmlToMarkdown', () => {
  it('keeps lines, blank lines, emphasis, links, lists and data tables', () => {
    const md = emailHtmlToMarkdown(
      buildEmailDocument(
        '<div>Hey <b>Sam</b>,</div><div><br></div><div>See <a href="https://x.com/a">the plan</a> and <i>notes</i>:</div>' +
          '<ol><li>One<ul><li>Sub</li></ul></li><li>Two</li></ol>' +
          '<table><tr><th>Item</th><th>Cost</th></tr><tr><td>Ads</td><td>$1|2</td></tr></table>',
      ),
    )
    expect(md).toBe(
      'Hey **Sam**,\n\nSee [the plan](https://x.com/a) and *notes*:\n\n1. One\n   - Sub\n2. Two\n\n| Item | Cost |\n| --- | --- |\n| Ads | $1\\|2 |',
    )
  })

  it('drops quoted earlier messages only when asked', () => {
    const html =
      '<div>Thursday works.</div><div class="gmail_quote"><div class="gmail_attr">On Tue, Sam wrote:</div><blockquote class="gmail_quote">Can we meet?</blockquote></div>'
    expect(emailHtmlToMarkdown(html, { dropQuotes: true })).toBe('Thursday works.')
    expect(emailHtmlToMarkdown(html)).toContain('> Can we meet?')
    // Outlook: everything from the reply header on is the quoted message.
    expect(
      emailHtmlToMarkdown('<div>Sounds good.</div><hr><div id="divRplyFwdMsg">From: Sam</div><div>Old text</div>', { dropQuotes: true }),
    ).toBe('Sounds good.')
  })

  it('leaves out images a Markdown file cannot show and unsafe links', () => {
    expect(emailHtmlToMarkdown('<p><img src="cid:a@b" alt="x"><img src="https://x.com/l.png" alt="Logo"> <a href="javascript:alert(1)">hi</a></p>')).toBe(
      '![Logo](https://x.com/l.png) hi',
    )
  })
})

describe('stripQuotedText', () => {
  it('cuts plain-text replies at the quoted message', () => {
    expect(stripQuotedText('Yes.\n\nOn Tue, 20 Oct 2026, Sam <s@x.com>\nwrote:\n> Can we?\n')).toBe('Yes.')
    expect(stripQuotedText('Yes.\n> quoted\nStill mine')).toBe('Yes.\nStill mine')
  })
})

describe('exports', () => {
  it('a single email has its subject, headers, date and full body', () => {
    const md = messageToMarkdown(message({ cc: 'jo@x.com', body: 'Hi Sam,\r\nThanks', html: '' }), TZ)
    expect(md).toBe(
      '# Proposal\n\n- **From:** Pat Lee <pat@ourteam.example>\n- **To:** Sam Lee <sam@client.com>\n- **Cc:** jo@x.com\n- **Date:** 22 Oct 2026, 9:38 am AEDT\n\nHi Sam,\nThanks\n',
    )
  })

  it('a thread holds only each message’s sender name, date and time, and content, oldest first', () => {
    const md = threadToMarkdown(
      [
        message({ from: 'Sam Lee <sam@client.com>', date: '2026-10-20T01:00:00.000Z', body: 'Can we meet?' }),
        message({
          html: buildEmailDocument('<div>Thursday works.</div><div class="gmail_quote">On Tue, Sam wrote:<blockquote>Can we meet?</blockquote></div>'),
        }),
      ],
      TZ,
    )
    expect(md).toBe('**Sam Lee** · 20 Oct 2026, 12:00 pm AEDT\n\nCan we meet?\n\n---\n\n**Pat Lee** · 22 Oct 2026, 9:38 am AEDT\n\nThursday works.\n')
    expect(md).not.toMatch(/Proposal|sam@client\.com|To:/)
  })

  it('names files after the subject and senders after their display name', () => {
    expect(exportFileName('Re: Q3 / budget? <draft>', 'eml')).toBe('Re Q3 budget draft.eml')
    expect(exportFileName('', 'md')).toBe('email.md')
    expect(senderDisplayName('"Lee, Sam" <sam@x.com>')).toBe('Lee, Sam')
    expect(senderDisplayName('<sam@x.com>')).toBe('sam@x.com')
    expect(senderDisplayName('sam@x.com')).toBe('sam@x.com')
  })
})
