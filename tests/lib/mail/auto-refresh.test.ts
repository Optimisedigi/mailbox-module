import { describe, expect, it } from 'vitest'
import { isMailAutoRefreshWindow } from '@/lib/mail/auto-refresh'

// Sydney is UTC+11 in daylight saving (Oct–Apr) and UTC+10 otherwise.
describe('isMailAutoRefreshWindow', () => {
  it('runs on Sydney weekdays from 6:30am up to 6:30pm (daylight saving)', () => {
    // Tue 20 Oct 2026, Sydney (UTC+11)
    expect(isMailAutoRefreshWindow(new Date('2026-10-19T19:29:00Z'))).toBe(false) // 6:29am
    expect(isMailAutoRefreshWindow(new Date('2026-10-19T19:30:00Z'))).toBe(true) // 6:30am
    expect(isMailAutoRefreshWindow(new Date('2026-10-20T07:29:00Z'))).toBe(true) // 6:29pm
    expect(isMailAutoRefreshWindow(new Date('2026-10-20T07:30:00Z'))).toBe(false) // 6:30pm
  })

  it('follows standard time outside daylight saving', () => {
    // Wed 17 Jun 2026, Sydney (UTC+10): 6:30am
    expect(isMailAutoRefreshWindow(new Date('2026-06-16T20:30:00Z'))).toBe(true)
    expect(isMailAutoRefreshWindow(new Date('2026-06-16T20:29:00Z'))).toBe(false)
  })

  it('does not run on Sydney weekends', () => {
    // Sat 24 Oct 2026, 10am Sydney
    expect(isMailAutoRefreshWindow(new Date('2026-10-23T23:00:00Z'))).toBe(false)
    // Mon 26 Oct 2026, 10am Sydney (still Sunday in UTC)
    expect(isMailAutoRefreshWindow(new Date('2026-10-25T23:00:00Z'))).toBe(true)
  })
})
