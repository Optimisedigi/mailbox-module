/**
 * Client-safe helpers for choosing a send time in the compose window. All
 * times are in the browser's local zone; the server receives an ISO instant.
 */

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The instant a datetime-local value names in the local zone, or null if it is empty or invalid. */
export function parseDatetimeLocal(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  return date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

/** Local calendar day as YYYY-MM-DD. */
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of a YYYY-MM-DD key, or null if it is not a real date. */
export function parseDateKey(key: string): Date | null {
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(y, mo - 1, d);
  return date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * `date` moved forward by `days` business days in local time, skipping
 * Saturdays and Sundays and keeping the time of day (follow-up reminders).
 * From a weekend, one business day lands on Monday.
 */
export function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const weekday = result.getDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return result;
}

/** "Remind me if no reply" choices in business days (0 = off). */
export const FOLLOW_UP_DAY_OPTIONS = [1, 2, 3, 5, 7] as const;
/** Preselected when a recipient is a CMS client; otherwise reminders start off. */
export const DEFAULT_FOLLOW_UP_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "Due in 2 days", "Due today", "Overdue", "Overdue 3 days" for a reminder time. */
export function followUpDueLabel(remindAtIso: string, now: Date): string {
  const remindAt = new Date(remindAtIso);
  if (Number.isNaN(remindAt.getTime())) return "";
  const diff = remindAt.getTime() - now.getTime();
  if (diff > 0) {
    const days = Math.ceil(diff / DAY_MS);
    return diff < DAY_MS ? "Due today" : `Due in ${days} day${days === 1 ? "" : "s"}`;
  }
  const late = Math.floor(-diff / DAY_MS);
  return late === 0 ? "Overdue" : `Overdue ${late} day${late === 1 ? "" : "s"}`;
}

/** The team's time zone: AEST, or AEDT during daylight saving. */
/** Business-day and schedule time zone (NEXT_PUBLIC_MAIL_TIME_ZONE, default Australia/Sydney). */
export const MAIL_TIME_ZONE = process.env.NEXT_PUBLIC_MAIL_TIME_ZONE?.trim() || "Australia/Sydney";

/** Wall-clock parts of an instant in `timeZone`. */
function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") };
}

/** Minutes `timeZone` is ahead of UTC at `date` (+600 for AEST, +660 for AEDT). */
function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/**
 * Same as addBusinessDays, counted in `timeZone` (default Sydney) rather than
 * the machine's zone: server-side, for scheduled sends. Skips that zone's
 * Saturdays and Sundays and keeps its clock time across daylight-saving changes.
 */
export function addBusinessDaysInZone(date: Date, days: number, timeZone: string = MAIL_TIME_ZONE): Date {
  const start = zonedParts(date, timeZone);
  // Walk calendar days on the zone's own date (noon UTC avoids any day-edge slip).
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day, 12));
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  // Same wall-clock time on the target day, converted back with that day's offset.
  const wall = Date.UTC(
    cursor.getUTCFullYear(),
    cursor.getUTCMonth(),
    cursor.getUTCDate(),
    start.hour,
    start.minute,
    start.second,
    date.getMilliseconds(),
  );
  let result = wall - zoneOffsetMinutes(new Date(wall), timeZone) * 60_000;
  result = wall - zoneOffsetMinutes(new Date(result), timeZone) * 60_000;
  return new Date(result);
}

/** The instant of a local day (YYYY-MM-DD) at a local time (HH:MM). */
export function combineDateAndTime(day: string, time: string): Date | null {
  return parseDatetimeLocal(`${day}T${time}`);
}

/** Quick send times next to the day pills; each has a +2 minute button. */
export const QUICK_SEND_TIMES: readonly string[] = ["07:48", "08:11"];

/** HH:MM moved by `minutes`, wrapping within the day. */
export function addMinutesToTime(time: string, minutes: number): string {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return time;
  const total = (((Number(match[1]) * 60 + Number(match[2]) + minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** "07:48" -> "7:48am", "13:05" -> "1:05pm". */
export function formatTime12(time: string): string {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return time;
  const hours = Number(match[1]);
  return `${hours % 12 || 12}:${match[2]}${hours < 12 ? "am" : "pm"}`;
}

/** Opening choice: today at the first quick time if that is still ahead, otherwise tomorrow. */
export function defaultScheduleChoice(now: Date): { day: string; time: string } {
  const time = QUICK_SEND_TIMES[0] ?? "08:00";
  const today = dateKey(now);
  const todayAt = combineDateAndTime(today, time);
  const ahead = todayAt !== null && todayAt.getTime() - now.getTime() >= 60_000;
  return { day: ahead ? today : dateKey(addDays(now, 1)), time };
}

/**
 * The weeks shown for one month, Sunday first, padded with the neighbouring
 * months' days (shown greyed), as react-day-picker lays it out.
 */
export function calendarWeeks(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  const start = addDays(first, -first.getDay());
  const last = new Date(year, month + 1, 0);
  const weeks: Date[][] = [];
  for (let cursor = start; cursor <= last || weeks.length === 0; ) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** Gap between the times the date and time picker lists. */
export const TIME_STEP_MINUTES = 15;

/**
 * The times the picker lists (HH:MM, every TIME_STEP_MINUTES), plus `extra`
 * in its place when it is a valid time off that grid (7:48am stays visible
 * and selected).
 */
export function timeOptions(extra?: string): string[] {
  const times: string[] = [];
  for (let minutes = 0; minutes < 1440; minutes += TIME_STEP_MINUTES) {
    times.push(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
  }
  if (extra && /^([01]\d|2[0-3]):[0-5]\d$/.test(extra) && !times.includes(extra)) {
    times.push(extra);
    times.sort();
  }
  return times;
}

/**
 * A typed time as HH:MM, or null: "9", "9am", "9:05pm", "905", "21:30",
 * "9.30 am", "noon", "midnight". Without am/pm the hour is read as 24-hour.
 */
export function parseTypedTime(text: string): string | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, "");
  if (value === "noon") return "12:00";
  if (value === "midnight") return "00:00";
  const match = value.match(/^(\d{1,2})(?:[:.]?(\d{2}))?(a|am|p|pm)?$/);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  const suffix = match[3];
  if (minutes > 59) return null;
  if (suffix) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (suffix.startsWith("p") ? 12 : 0);
  } else if (hours > 23) {
    return null;
  }
  return `${pad(hours)}:${pad(minutes)}`;
}
