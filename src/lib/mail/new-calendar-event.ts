import { randomUUID } from "node:crypto";
import type { calendar_v3 } from "googleapis";
import { z } from "zod";
import { zonedToUtc } from "@/lib/mail/zoned-time";
import { addressInEntry, splitAddressList } from "@/lib/mail/contacts-shared";

/**
 * Mail → "Add calendar invite": a new Google Calendar event with a Google Meet
 * link, created on the selected mailbox's own calendar. Guests get Google's
 * invite email only when `sendInvites` is ticked; otherwise the event is saved
 * quietly and the caller hands the Meet link back for the clipboard.
 */

export const MAX_INVITE_GUESTS = 50;
export const INVITE_DURATIONS = [15, 30, 45, 60, 90, 120] as const;
const MAX_TITLE_CHARS = 200;
const MAX_GUEST_FIELD_CHARS = 4_000;

export interface NewCalendarEvent {
  title: string;
  start: Date;
  end: Date;
  timeZone: string;
  guests: string[];
  sendInvites: boolean;
}

const requestSchema = z.object({
  title: z.string().max(MAX_TITLE_CHARS).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().refine((value) => (INVITE_DURATIONS as readonly number[]).includes(value)),
  timeZone: z.string().max(64),
  guests: z.string().max(MAX_GUEST_FIELD_CHARS).optional(),
  sendInvites: z.boolean(),
});

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isRealDate(date: string): boolean {
  const [year = 0, month = 0, day = 0] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/** Validate the browser's request; an error message for the form when it is not usable. */
export function parseNewCalendarEvent(raw: unknown): { ok: true; value: NewCalendarEvent } | { ok: false; error: string } {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Choose a date, a start time and a length for the meeting." };
  const { date, time, durationMinutes, timeZone, sendInvites } = parsed.data;
  if (!isRealDate(date)) return { ok: false, error: "That date does not exist." };
  if (!isTimeZone(timeZone)) return { ok: false, error: "Unknown time zone." };

  const guests: string[] = [];
  for (const entry of splitAddressList(parsed.data.guests ?? "").map((part) => part.trim()).filter(Boolean)) {
    const address = addressInEntry(entry);
    if (!address) return { ok: false, error: `"${entry.slice(0, 80)}" is not an email address.` };
    const lower = address.toLowerCase();
    if (!guests.includes(lower)) guests.push(lower);
  }
  if (guests.length > MAX_INVITE_GUESTS) return { ok: false, error: `Invite at most ${MAX_INVITE_GUESTS} people.` };
  if (sendInvites && guests.length === 0) return { ok: false, error: "Add at least one person to send the invite to." };

  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  const start = zonedToUtc(date, hours * 60 + minutes, timeZone);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const title = parsed.data.title?.trim() || "Meeting";
  return { ok: true, value: { title, start, end, timeZone, guests, sendInvites } };
}

/** The Meet link of a created event, or "" when Google gave none. */
export function meetLinkOf(event: calendar_v3.Schema$Event): string {
  if (event.hangoutLink) return event.hangoutLink;
  return event.conferenceData?.entryPoints?.find((point) => point.entryPointType === "video")?.uri ?? "";
}

export async function insertCalendarEvent(
  calendar: calendar_v3.Calendar,
  event: NewCalendarEvent,
): Promise<{ eventId: string; eventLink: string; meetLink: string }> {
  const res = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    // Unticked: the guests are on the event but Google emails nobody.
    sendUpdates: event.sendInvites ? "all" : "none",
    requestBody: {
      summary: event.title,
      start: { dateTime: event.start.toISOString(), timeZone: event.timeZone },
      end: { dateTime: event.end.toISOString(), timeZone: event.timeZone },
      attendees: event.guests.map((email) => ({ email })),
      conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
    },
  });
  return { eventId: res.data.id ?? "", eventLink: res.data.htmlLink ?? "", meetLink: meetLinkOf(res.data) };
}
