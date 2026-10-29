import { describe, expect, it } from 'vitest'
import { isAutomatedMessage } from '@/lib/mail/automated-senders'

describe('isAutomatedMessage', () => {
  it('flags no-reply style senders and bulk/auto headers', () => {
    for (const from of ['no-reply@multiscreensite.com', 'Site <noreply@x.com>', 'donotreply@bank.com', 'notifications@github.com', 'alerts+ops@aws.com', 'MAILER-DAEMON@google.com']) {
      expect(isAutomatedMessage({ from }), from).toBe(true)
    }
    expect(isAutomatedMessage({ from: 'health@aws.com', autoSubmitted: 'auto-generated' })).toBe(true)
    expect(isAutomatedMessage({ from: 'team@tools.com', precedence: 'bulk' })).toBe(true)
    expect(isAutomatedMessage({ from: 'team@tools.com', listId: '<news.tools.com>' })).toBe(true)
    expect(isAutomatedMessage({ from: 'team@tools.com', listUnsubscribe: '<mailto:u@tools.com>' })).toBe(true)
  })

  it('keeps real people, including Auto-Submitted: no', () => {
    expect(isAutomatedMessage({ from: 'Jo <jo@bakehouse.com.au>' })).toBe(false)
    expect(isAutomatedMessage({ from: 'info@client.com.au' })).toBe(false)
    expect(isAutomatedMessage({ from: 'noreen@client.com.au' })).toBe(false)
    expect(isAutomatedMessage({ from: 'jo@client.com.au', autoSubmitted: 'no' })).toBe(false)
  })
})
