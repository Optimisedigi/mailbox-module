/**
 * Mail auto-refresh schedule: every 5 minutes, weekdays 6:30am–6:30pm
 * Sydney time (follows daylight saving). Outside that window the list only
 * updates on open or Refresh.
 */
export const MAIL_AUTO_REFRESH_MS = 5 * 60_000

const TIME_ZONE = process.env.NEXT_PUBLIC_MAIL_TIME_ZONE?.trim() || 'Australia/Sydney'
const START_MINUTE = 6 * 60 + 30
const END_MINUTE = 18 * 60 + 30
const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])

const formatter = new Intl.DateTimeFormat('en-AU', {
  timeZone: TIME_ZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** True on a Sydney weekday from 6:30am up to (not including) 6:30pm. */
export function isMailAutoRefreshWindow(now: Date): boolean {
  const parts = formatter.formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  if (!WEEKDAYS.has(part('weekday'))) return false
  const minute = Number(part('hour')) * 60 + Number(part('minute'))
  return minute >= START_MINUTE && minute < END_MINUTE
}
