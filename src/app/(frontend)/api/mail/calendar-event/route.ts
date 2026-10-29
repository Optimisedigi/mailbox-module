import { NextRequest, NextResponse } from "next/server";
import { loadMailboxCalendar } from "@/lib/mail/invite-calendar";
import { insertCalendarEvent, parseNewCalendarEvent } from "@/lib/mail/new-calendar-event";
import { readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * POST /api/mail/calendar-event
 * Body: { title?, date: "YYYY-MM-DD", time: "HH:MM", durationMinutes, timeZone, guests?, sendInvites }
 *
 * Mail's "Add calendar invite". Creates the event, with a Google Meet link, on
 * the calendar of the mailbox Mail is showing. It uses the shared Calendar
 * connection only when that is the same Google account (as the invite card
 * does), so no event is ever saved on someone else's calendar. Google emails
 * the guests only when sendInvites is true.
 * Returns { eventId, eventLink, meetLink, sent }.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<unknown>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const parsed = parseNewCalendarEvent(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  let calendar;
  try {
    calendar = await loadMailboxCalendar(ctx.payload, [token.email, token.userEmail]);
  } catch (err) {
    console.error("[mail-calendar-event] calendar connection failed:", ((err as Error).message ?? "").slice(0, 200));
    return NextResponse.json({ error: "Could not reach Google Calendar. Reconnect it in Settings → Google Calendar Auth." }, { status: 502 });
  }
  if (!calendar) {
    return NextResponse.json(
      { error: `Google Calendar isn't connected for ${token.email || "this mailbox"}. Connect it in Settings → Google Calendar Auth.` },
      { status: 409 },
    );
  }

  try {
    const created = await insertCalendarEvent(calendar, parsed.value);
    return NextResponse.json({ ...created, sent: parsed.value.sendInvites });
  } catch (err) {
    const e = err as { code?: number; message?: string };
    console.error("[mail-calendar-event] insert failed:", (e.message ?? "").slice(0, 200));
    const refused = e.code === 401 || e.code === 403;
    return NextResponse.json(
      { error: refused ? "Google Calendar refused the event. Reconnect it in Settings → Google Calendar Auth." : "Could not create the event. Please try again." },
      { status: 502 },
    );
  }
}
