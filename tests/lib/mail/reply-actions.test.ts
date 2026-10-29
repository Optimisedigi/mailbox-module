import { describe, expect, it } from 'vitest'
import { forwardStartHtml, forwardSubject, hasOtherParticipants, replyRecipients, splitAddressList } from '@/lib/mail/reply-actions'

describe('replyRecipients', () => {
  it('reply all keeps the sender in To and Cc s everyone else, never us or duplicates', () => {
    const { reply, replyAll } = replyRecipients(
      {
        from: 'Mark Bailey <michael@google.com>',
        to: '"Pat" <pat@ourteam.example>, "Smith, Hannah" <hannah@flip.com.au>, michael@google.com',
        cc: 'linh@away.com, HANNAH@flip.com.au',
      },
      ['Pat@ourteam.example'],
    )
    expect(reply).toEqual({ to: 'michael@google.com', cc: '' })
    expect(replyAll).toEqual({
      to: 'Mark Bailey <michael@google.com>',
      cc: '"Smith, Hannah" <hannah@flip.com.au>, linh@away.com',
    })
  })

  it('replying all to our own sent email goes back to its To and Cc', () => {
    const { replyAll } = replyRecipients(
      { from: 'pat@ourteam.example', to: 'a@x.com, b@y.com', cc: 'c@z.com' },
      ['pat@ourteam.example'],
    )
    expect(replyAll).toEqual({ to: 'a@x.com, b@y.com', cc: 'c@z.com' })
  })

  it('a one-to-one email from a named sender has nobody else to reply all to', () => {
    const { reply, replyAll } = replyRecipients(
      { from: 'Jo Smith <Jo@x.com>', to: 'Pat <pat@ourteam.example>', cc: '' },
      ['pat@ourteam.example'],
    )
    expect(hasOtherParticipants(reply, replyAll)).toBe(false)
    expect(hasOtherParticipants(reply, { to: replyAll.to, cc: 'sam@y.com' })).toBe(true)
  })

  it('splits address lists on commas outside quotes', () => {
    expect(splitAddressList('"A, B" <a@x.com>; c@y.com')).toEqual(['"A, B" <a@x.com>', 'c@y.com'])
  })
})

describe('forward', () => {
  it('prefixes Fwd once and includes the forwarded headers and body', () => {
    expect(forwardSubject('Hi')).toBe('Fwd: Hi')
    expect(forwardSubject('Fwd: Hi')).toBe('Fwd: Hi')
    const html = forwardStartHtml({ from: 'Jo <jo@x.com>', to: 'me@y.com', cc: '', subject: 'Hi', date: 'bad', html: '', text: 'Hello there' })
    expect(html).toContain('Forwarded message')
    expect(html).toContain('From: Jo &lt;jo@x.com&gt;')
    expect(html).toContain('<p>Hello there</p>')
  })
})
