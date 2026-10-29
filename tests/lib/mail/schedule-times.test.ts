import { describe, expect, it } from 'vitest'
import {
  addBusinessDays,
  addBusinessDaysInZone,
  addMinutesToTime,
  calendarWeeks,
  combineDateAndTime,
  dateKey,
  defaultScheduleChoice,
  followUpDueLabel,
  formatTime12,
  parseDateKey,
  parseDatetimeLocal,
  QUICK_SEND_TIMES,
} from '@/lib/mail/schedule-times'

const local = (y: number, m: number, d: number, h = 0, mi = 0, sec = 0) => new Date(y, m - 1, d, h, mi, sec)

describe('quick schedule choices', () => {
  it('opens on today at 7:48am while that is still ahead, otherwise tomorrow', () => {
    expect(defaultScheduleChoice(local(2026, 10, 21, 6, 0))).toEqual({ day: '2026-10-21', time: '07:48' })
    expect(defaultScheduleChoice(local(2026, 10, 21, 7, 47, 30))).toEqual({ day: '2026-10-22', time: '07:48' })
    expect(defaultScheduleChoice(local(2026, 10, 31, 15))).toEqual({ day: '2026-11-01', time: '07:48' })
  })

  it('offers 7:48am and 8:11am, and +2 moves a time by two minutes, wrapping at midnight', () => {
    expect(QUICK_SEND_TIMES.map(formatTime12)).toEqual(['7:48am', '8:11am'])
    expect(addMinutesToTime('07:48', 2)).toBe('07:50')
    expect(addMinutesToTime('08:59', 2)).toBe('09:01')
    expect(addMinutesToTime('23:59', 2)).toBe('00:01')
    expect(formatTime12('12:05')).toBe('12:05pm')
    expect(formatTime12('00:10')).toBe('12:10am')
  })

  it('combines a day and a time in local time and rejects bad input', () => {
    expect(combineDateAndTime('2026-10-22', '08:11')?.getTime()).toBe(local(2026, 10, 22, 8, 11).getTime())
    expect(combineDateAndTime('2026-02-30', '08:11')).toBeNull()
    expect(parseDateKey('2026-10-22')?.getTime()).toBe(local(2026, 10, 22).getTime())
    expect(parseDateKey('nope')).toBeNull()
    expect(dateKey(local(2026, 1, 5))).toBe('2026-01-05')
  })
})

describe('calendarWeeks', () => {
  it('lays out a month Sunday first with neighbouring days', () => {
    // October 2026 starts on a Thursday and ends on a Saturday.
    const weeks = calendarWeeks(2026, 9)
    expect(weeks).toHaveLength(5)
    expect(weeks.every((week) => week.length === 7)).toBe(true)
    expect(dateKey(weeks[0]![0]!)).toBe('2026-09-27')
    expect(dateKey(weeks[4]![6]!)).toBe('2026-10-31')
    // February 2026 starts on a Sunday: exactly four weeks.
    expect(calendarWeeks(2026, 1)).toHaveLength(4)
  })
})

describe('datetime-local helpers', () => {
  it('reads a local time', () => {
    const date = local(2026, 12, 5, 7, 5)
    expect(parseDatetimeLocal('2026-12-05T07:05')?.getTime()).toBe(date.getTime())
  })

  it('rejects empty, malformed and impossible values', () => {
    expect(parseDatetimeLocal('')).toBeNull()
    expect(parseDatetimeLocal('2026-12-05')).toBeNull()
    expect(parseDatetimeLocal('2026-02-31T10:00')).toBeNull()
  })
})

describe('follow-up reminder times', () => {
  it('adds business days in local time, skipping weekends and keeping the time of day', () => {
    const thu = new Date(2026, 9, 22, 9, 30) // Thursday
    expect(addBusinessDays(thu, 1)).toEqual(new Date(2026, 9, 23, 9, 30)) // Friday
    expect(addBusinessDays(thu, 2)).toEqual(new Date(2026, 9, 26, 9, 30)) // Monday
    expect(addBusinessDays(thu, 5)).toEqual(new Date(2026, 9, 29, 9, 30)) // next Thursday
    const sat = new Date(2026, 9, 24, 15, 0)
    expect(addBusinessDays(sat, 1)).toEqual(new Date(2026, 9, 26, 15, 0)) // Monday
    expect(addBusinessDays(thu, 0)).toEqual(thu)
  })

  it('counts scheduled-send reminders on Sydney days, whatever the server zone', () => {
    // 9am Fri 23 Oct in Sydney (AEDT, UTC+11) is still Thursday in UTC.
    const friSydney = new Date('2026-10-22T22:00:00.000Z')
    expect(addBusinessDaysInZone(friSydney, 1).toISOString()).toBe('2026-10-25T22:00:00.000Z') // Mon 9am Sydney
    expect(addBusinessDaysInZone(friSydney, 3).toISOString()).toBe('2026-10-27T22:00:00.000Z') // Wed 9am Sydney
    // 9am Sat in Sydney: one business day is Monday 9am.
    expect(addBusinessDaysInZone(new Date('2026-10-23T22:00:00.000Z'), 1).toISOString()).toBe('2026-10-25T22:00:00.000Z')
  })

  it('keeps the Sydney clock time across daylight-saving changes', () => {
    // 9am Fri 3 Apr 2026 AEDT (UTC+11) -> 9am Mon 6 Apr AEST (UTC+10), after DST ends on 5 Apr.
    expect(addBusinessDaysInZone(new Date('2026-04-02T22:00:00.000Z'), 1).toISOString()).toBe('2026-04-05T23:00:00.000Z')
    // 9am Fri 2 Oct 2026 AEST -> 9am Mon 5 Oct AEDT, after DST starts on 4 Oct.
    expect(addBusinessDaysInZone(new Date('2026-10-01T23:00:00.000Z'), 1).toISOString()).toBe('2026-10-04T22:00:00.000Z')
  })

  it('labels how soon a reminder is due or how late it is', () => {
    const now = new Date('2026-10-21T02:00:00.000Z')
    const at = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString()
    expect(followUpDueLabel(at(5), now)).toBe('Due today')
    expect(followUpDueLabel(at(30), now)).toBe('Due in 2 days')
    expect(followUpDueLabel(at(-2), now)).toBe('Overdue')
    expect(followUpDueLabel(at(-26), now)).toBe('Overdue 1 day')
    expect(followUpDueLabel('nope', now)).toBe('')
  })
})

describe("timeOptions", () => {
  it("lists every 15 minutes and slots in an off-grid time", async () => {
    const { timeOptions } = await import("@/lib/mail/schedule-times");
    const all = timeOptions();
    expect(all).toHaveLength(96);
    expect(all.slice(0, 3)).toEqual(["00:00", "00:15", "00:30"]);
    expect(all.at(-1)).toBe("23:45");
    const withExtra = timeOptions("07:48");
    expect(withExtra).toHaveLength(97);
    expect(withExtra.slice(31, 34)).toEqual(["07:45", "07:48", "08:00"]);
    expect(timeOptions("08:00")).toHaveLength(96);
    expect(timeOptions("bad")).toHaveLength(96);
  });
});

describe("parseTypedTime", () => {
  it("reads the ways people type a time", async () => {
    const { parseTypedTime } = await import("@/lib/mail/schedule-times");
    const cases: Array<[string, string | null]> = [
      ["9", "09:00"],
      ["9am", "09:00"],
      ["9 AM", "09:00"],
      ["9:05pm", "21:05"],
      ["9.30 am", "09:30"],
      ["905", "09:05"],
      ["1230p", "12:30"],
      ["12am", "00:00"],
      ["21:30", "21:30"],
      ["noon", "12:00"],
      ["midnight", "00:00"],
      ["13pm", null],
      ["24:00", null],
      ["9:60", null],
      ["soon", null],
      ["", null],
    ];
    for (const [text, expected] of cases) expect([text, parseTypedTime(text)]).toEqual([text, expected]);
  });
});
