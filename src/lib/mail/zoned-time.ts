/** Calendar-date and time-zone helpers (DST-correct, no Node APIs). */

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

/** The UTC instant of a wall-clock local time in a timezone (DST-correct). */
export function zonedToUtc(date: string, minutes: number, timeZone: string): Date {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  const guess = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60)
  const offsetAt = (instant: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(instant))
    const map: Record<string, string> = {}
    for (const part of parts) if (part.type !== 'literal') map[part.type] = part.value
    const hour = Number(map.hour) === 24 ? 0 : Number(map.hour)
    const wall = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      hour,
      Number(map.minute),
      Number(map.second || 0),
    )
    return instant - wall
  }
  const first = guess + offsetAt(guess)
  // Re-check at the corrected instant, in case the guess crossed a DST change.
  return new Date(guess + offsetAt(first))
}
