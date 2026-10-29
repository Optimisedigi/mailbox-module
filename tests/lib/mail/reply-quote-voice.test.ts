import { describe, expect, it } from 'vitest'
import { appendReplyQuote, replyQuoteHeader, replyQuoteStartHtml } from '@/lib/mail/reply-quote'
import { MAIL_VOICE_TOOLS, MAIL_VOICE_TOOL_NAMES, buildMailVoiceInstructions } from '@/lib/mail/voice-draft'
import { inboxPageToken, newThreadsOnly, parseInboxPageToken } from '@/lib/mail/folders'
import { mailAccountHeaders, normaliseMailAccount } from '@/lib/mail/accounts-shared'
import { mailThreadPath } from '@/lib/mail/drafts'

describe('reply quote', () => {
  it('starts from the email HTML, or its text as escaped paragraphs', () => {
    expect(replyQuoteStartHtml({ html: '<p>Hi <b>there</b></p>', text: 'ignored' })).toBe('<p>Hi <b>there</b></p>')
    expect(replyQuoteStartHtml({ html: '', text: 'Hi <Pat>,\nline two\n\nBye' })).toBe('<p>Hi &lt;Pat&gt;,<br>line two</p><p>Bye</p>')
  })

  it('follows the reply as a Gmail-style "wrote:" line and a blockquote', () => {
    const header = replyQuoteHeader({ from: 'Jo <jo@x.com>', date: 'not a date' })
    expect(header).toBe('On not a date, Jo <jo@x.com> wrote:')
    const html = appendReplyQuote('<p>See my notes below.</p>', { header, html: '<p>Can you do Thursday? <span>Yes!</span></p>' })
    expect(html).toBe(
      '<p>See my notes below.</p><div><br></div><div>On not a date, Jo &lt;jo@x.com&gt; wrote:</div>' +
        '<blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex"><p>Can you do Thursday? <span>Yes!</span></p></blockquote>',
    )
    expect(appendReplyQuote('<p>Reply</p>', { header, html: '  ' })).toBe('<p>Reply</p>')
  })
})

describe('mail voice agent', () => {
  it('can only write and read the draft: no send, schedule or Gmail tool exists', () => {
    expect(MAIL_VOICE_TOOLS.map((tool) => tool.name)).toEqual([...MAIL_VOICE_TOOL_NAMES])
    expect(MAIL_VOICE_TOOL_NAMES).toEqual(['write_email_draft', 'read_current_draft'])
    for (const name of ['send_email', 'create_gmail_draft', 'schedule_email']) expect(MAIL_VOICE_TOOL_NAMES).not.toContain(name)
    expect(MAIL_VOICE_TOOLS.every((tool) => !/send/i.test(tool.name))).toBe(true)
  })

  it('tells the agent it cannot send and to draft without waiting for a button', () => {
    const text = buildMailVoiceInstructions({ mode: 'reply', replyTo: 'Jo <jo@x.com>', subject: 'Quote' })
    expect(text).toMatch(/never send/i)
    expect(text).toMatch(/press Send themselves/)
    expect(text).toMatch(/Do not wait for them to press any button/)
    expect(text).toContain('from Jo <jo@x.com>')
  })
})

describe('inbox unread-first paging tokens', () => {
  it('round-trips the part and token, and treats a bare token as the read part', () => {
    expect(parseInboxPageToken(undefined)).toEqual({ part: 'unread' })
    expect(parseInboxPageToken(inboxPageToken('unread', '123'))).toEqual({ part: 'unread', token: '123' })
    expect(parseInboxPageToken(inboxPageToken('read', '456'))).toEqual({ part: 'read', token: '456' })
    expect(parseInboxPageToken('789')).toEqual({ part: 'read', token: '789' })
    // No token: that part from its start.
    expect(inboxPageToken('read', null)).toBe('r:')
    expect(parseInboxPageToken('r:')).toEqual({ part: 'read' })
  })

  it('drops threads already listed', () => {
    const seen = new Set<string>(['a'])
    expect(newThreadsOnly([{ threadId: 'a' }, { threadId: 'b' }, { threadId: 'b' }], seen)).toEqual([{ threadId: 'b' }])
  })
})

describe('mail account helpers', () => {
  it('only accepts plain addresses and sends no header for the main Gmail', () => {
    expect(normaliseMailAccount(' Sales@Team.test ')).toBe('sales@team.test')
    expect(normaliseMailAccount('sales@team.test\r\nx: y')).toBe('')
    expect(mailAccountHeaders('')).toEqual({})
    expect(mailAccountHeaders('sales@team.test')).toEqual({ 'x-mail-account': 'sales@team.test' })
    expect(mailThreadPath('t1')).toBe('/admin/mail?thread=t1')
    expect(mailThreadPath('t1', 'sales@team.test')).toBe('/admin/mail?thread=t1&account=sales%40team.test')
  })
})
