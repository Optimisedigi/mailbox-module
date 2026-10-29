import { describe, expect, it, vi } from 'vitest'

const messagesGet = vi.fn()
vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: class { setCredentials() {} } },
    gmail: () => ({ users: { messages: { get: messagesGet } } }),
  },
}))

const { getMessageSenderSubjects, isGmailRateLimitError } = await import('@/lib/mail/gmail-mail')
const { gmailErrorResponse } = await import('@/lib/mail/route-helpers')

// Gmail's real answer when one account reads too fast (seen in production for a 2,948-email triage).
const QUOTA_403 = Object.assign(
  new Error("Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'"),
  { code: 403 },
)
const found = (id: string) => ({ data: { id, threadId: `t-${id}`, payload: { headers: [{ name: 'From', value: `${id}@x.com` }] } } })

/**
 * A clock stopped at 0 that records each wait instead of sleeping: a read
 * that waited N ms starts N ms after the first (reads run side by side, so
 * the waits must not add up).
 */
function fakeClock() {
  const sleeps: number[] = []
  return {
    now: () => 0,
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    sleeps,
  }
}

describe('Gmail rate limits during triage', () => {
  it('tells "slow down" apart from "no permission"', () => {
    expect(isGmailRateLimitError(QUOTA_403)).toBe(true)
    expect(isGmailRateLimitError({ code: 403, errors: [{ reason: 'userRateLimitExceeded' }] })).toBe(true)
    expect(isGmailRateLimitError({ code: 429 })).toBe(true)
    expect(isGmailRateLimitError({ code: 403, message: 'Request had insufficient authentication scopes.' })).toBe(false)
    expect(isGmailRateLimitError({ code: 401 })).toBe(false)
    expect(isGmailRateLimitError(null)).toBe(false)
  })

  it('reports a rate limit as "Gmail is busy", not as a reason to reconnect', async () => {
    const busy = gmailErrorResponse(QUOTA_403, 'x')
    expect(busy.status).toBe(429)
    expect((await busy.json()).error).toMatch(/Gmail is busy/)
    const denied = gmailErrorResponse({ code: 403, message: 'insufficient scopes' }, 'x')
    expect(denied.status).toBe(403)
    expect((await denied.json()).reason).toMatch(/Reconnect Gmail/)
  })

  it('spaces reads to the per-minute rate', async () => {
    messagesGet.mockReset()
    const clock = fakeClock()
    messagesGet.mockImplementation(async ({ id }: { id: string }) => found(id))
    const rows = await getMessageSenderSubjects('tok', ['a', 'b', 'c', 'd'], { perMinute: 120, concurrency: 4, ...clock })
    expect(rows.map((row: { messageId: string }) => row.messageId)).toEqual(['a', 'b', 'c', 'd'])
    // 120 a minute = one every 500 ms, all four started together: the first goes at once, the rest wait their turn.
    expect(clock.sleeps).toEqual([500, 1000, 1500])
  })

  it('retries a read Gmail turns away for going too fast, then gives up after the last retry', async () => {
    messagesGet.mockReset()
    const clock = fakeClock()
    messagesGet.mockRejectedValueOnce(QUOTA_403).mockRejectedValueOnce(QUOTA_403).mockImplementation(async ({ id }: { id: string }) => found(id))
    const rows = await getMessageSenderSubjects('tok', ['a'], { perMinute: 60_000, retries: 3, random: () => 0, ...clock })
    expect(rows).toHaveLength(1)
    // Waits 1 s, then 2 s.
    expect(clock.sleeps.filter((ms) => ms >= 1000)).toEqual([1000, 2000])

    messagesGet.mockReset()
    messagesGet.mockRejectedValue(QUOTA_403)
    await expect(getMessageSenderSubjects('tok', ['a'], { perMinute: 60_000, retries: 2, random: () => 0, ...fakeClock() })).rejects.toBe(QUOTA_403)
    expect(messagesGet).toHaveBeenCalledTimes(3)
  })

  it('does not retry a permission error', async () => {
    messagesGet.mockReset()
    messagesGet.mockRejectedValue(Object.assign(new Error('Forbidden'), { code: 403 }))
    await expect(getMessageSenderSubjects('tok', ['a'], { perMinute: 60_000, ...fakeClock() })).rejects.toMatchObject({ code: 403 })
    expect(messagesGet).toHaveBeenCalledTimes(1)
  })
})
