import type { Payload } from "payload";
import type { calendar_v3 } from "googleapis";
import { getAuthenticatedCalendarClient } from "@/lib/calendar-service";
import { addDays, zonedToUtc } from "@/lib/mail/zoned-time";
import { normaliseEmail, type InviteResponse, type InviteStatus } from "@/lib/mail/calendar-invite";

/**
 * Google Calendar side of Mail invites: the "No events on this date" check and
 * Yes/No/Maybe straight onto the calendar event (as Gmail does). Uses the
 * shared Calendar connection only when it is the same account as the mailbox,
 * so nobody reads or answers someone else's calendar.
 */

export interface DayEvent {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
}

const STATUS_BY_GOOGLE: Record<string, InviteStatus> = {
  accepted: "accepted",
  declined: "declined",
  tentative: "tentative",
  needsAction: "needsAction",
};

export async function loadMailboxCalendar(
  payload: Payload,
  mailboxEmails: string[],
): Promise<calendar_v3.Calendar | null> {
  const auth = (await payload.findGlobal({ slug: "calendar-auth", overrideAccess: true })) as {
    refreshToken?: unknown;
    connectedEmail?: unknown;
  };
  if (typeof auth.refreshToken !== "string" || !auth.refreshToken) return null;
  if (typeof auth.connectedEmail !== "string" || !auth.connectedEmail) return null;
  const connected = normaliseEmail(auth.connectedEmail);
  if (!mailboxEmails.filter(Boolean).some((email) => normaliseEmail(email) === connected)) return null;
  return getAuthenticatedCalendarClient(auth.refreshToken);
}

export async function findCalendarEvent(
  calendar: calendar_v3.Calendar,
  uid: string,
): Promise<calendar_v3.Schema$Event | null> {
  const res = await calendar.events.list({ calendarId: "primary", iCalUID: uid, maxResults: 5 });
  return (res.data.items ?? []).find((event) => event.status !== "cancelled") ?? null;
}

function selfAttendee(event: calendar_v3.Schema$Event, mailboxEmails: string[]): calendar_v3.Schema$EventAttendee | null {
  const mine = new Set(mailboxEmails.filter(Boolean).map(normaliseEmail));
  return event.attendees?.find((a) => a.self || (a.email ? mine.has(normaliseEmail(a.email)) : false)) ?? null;
}

export function calendarSelfStatus(event: calendar_v3.Schema$Event, mailboxEmails: string[]): InviteStatus | null {
  const me = selfAttendee(event, mailboxEmails);
  return me ? (STATUS_BY_GOOGLE[me.responseStatus ?? ""] ?? "needsAction") : null;
}

/** Set the owner's answer on the event; Google notifies the organiser. False when they aren't an attendee. */
export async function respondOnCalendar(
  calendar: calendar_v3.Calendar,
  event: calendar_v3.Schema$Event,
  mailboxEmails: string[],
  response: InviteResponse,
): Promise<boolean> {
  const me = selfAttendee(event, mailboxEmails);
  if (!me || !event.id) return false;
  await calendar.events.patch({
    calendarId: "primary",
    eventId: event.id,
    sendUpdates: "all",
    requestBody: {
      attendees: (event.attendees ?? []).map((a) => (a === me ? { ...a, responseStatus: response } : a)),
    },
  });
  return true;
}

function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Other events on the invite's local day, earliest first (excludes the invite itself). */
export async function listDayEvents(
  calendar: calendar_v3.Calendar,
  invite: { uid: string; start: string; allDay: boolean },
  timeZone: string,
): Promise<DayEvent[]> {
  const date = invite.allDay ? invite.start.slice(0, 10) : localDate(new Date(invite.start), timeZone);
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: zonedToUtc(date, 0, timeZone).toISOString(),
    timeMax: zonedToUtc(addDays(date, 1), 0, timeZone).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });
  return (res.data.items ?? [])
    .filter((event) => event.status !== "cancelled" && event.iCalUID !== invite.uid)
    .filter((event) => event.attendees?.find((a) => a.self)?.responseStatus !== "declined")
    .map((event) => ({
      summary: event.summary || "(no title)",
      start: event.start?.dateTime ?? `${event.start?.date ?? date}T00:00:00Z`,
      end: event.end?.dateTime ?? `${event.end?.date ?? date}T00:00:00Z`,
      allDay: !event.start?.dateTime,
    }));
}
