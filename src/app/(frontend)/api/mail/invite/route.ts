import { NextRequest, NextResponse } from "next/server";
import { getMessageWithCalendar, sendRawMessage } from "@/lib/mail/gmail-mail";
import {
  buildInviteReplyMime,
  findSelfAttendee,
  isInviteResponse,
  parseCalendarInvite,
  type InviteStatus,
} from "@/lib/mail/calendar-invite";
import {
  calendarSelfStatus,
  findCalendarEvent,
  listDayEvents,
  loadMailboxCalendar,
  respondOnCalendar,
  type DayEvent,
} from "@/lib/mail/invite-calendar";
import { gmailErrorResponse, parseGmailId, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * GET  /api/mail/invite?messageId=<gmail id>&tz=<IANA zone>
 *   Calendar context for the invite card: the owner's answer on Google
 *   Calendar and their other events that day. `calendar: false` when the
 *   shared Calendar connection isn't this mailbox (the card then hides it).
 * POST /api/mail/invite  { messageId, response: "accepted" | "declined" | "tentative" }
 *   Yes/No/Maybe. Updates the Google Calendar event when possible (Google
 *   tells the organiser); otherwise emails the organiser an iCalendar REPLY.
 *   The invite is always re-read from Gmail; nothing from the browser but the
 *   choice is trusted.
 */

function validTimeZone(raw: string | null): string {
  if (!raw) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return "UTC";
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const messageId = parseGmailId(req.nextUrl.searchParams.get("messageId"));
  if (!messageId) return NextResponse.json({ error: "Invalid message id." }, { status: 400 });
  const timeZone = validTimeZone(req.nextUrl.searchParams.get("tz"));
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  let invite;
  try {
    const message = await getMessageWithCalendar(token.accessToken, messageId);
    invite = message.calendarIcs ? parseCalendarInvite(message.calendarIcs) : null;
  } catch (err) {
    return gmailErrorResponse(err, "Could not load the invite from Gmail.");
  }
  if (!invite) return NextResponse.json({ error: "This email has no calendar invite." }, { status: 404 });

  const mailbox = [token.email, token.userEmail];
  try {
    const calendar = await loadMailboxCalendar(ctx.payload, mailbox);
    if (!calendar) return NextResponse.json({ calendar: false, status: null, dayEvents: [] });
    const [event, dayEvents] = await Promise.all([
      findCalendarEvent(calendar, invite.uid),
      listDayEvents(calendar, invite, timeZone),
    ]);
    const status: InviteStatus | null = event ? calendarSelfStatus(event, mailbox) : null;
    return NextResponse.json({ calendar: true, status, dayEvents: dayEvents satisfies DayEvent[] });
  } catch (err) {
    console.error("[mail-invite] calendar lookup failed:", ((err as Error).message ?? "").slice(0, 200));
    return NextResponse.json({ calendar: false, status: null, dayEvents: [] });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ messageId?: unknown; response?: unknown }>(req);
  const messageId = parseGmailId(body?.messageId);
  if (!messageId) return NextResponse.json({ error: "Invalid message id." }, { status: 400 });
  const response = body?.response;
  if (!isInviteResponse(response)) return NextResponse.json({ error: "Choose Yes, No or Maybe." }, { status: 400 });
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  let message;
  try {
    message = await getMessageWithCalendar(token.accessToken, messageId);
  } catch (err) {
    return gmailErrorResponse(err, "Could not load the invite from Gmail.");
  }
  const invite = message.calendarIcs ? parseCalendarInvite(message.calendarIcs) : null;
  if (!invite) return NextResponse.json({ error: "This email has no calendar invite." }, { status: 404 });
  if (invite.method !== "REQUEST") {
    return NextResponse.json({ error: invite.method === "CANCEL" ? "This event was cancelled." : "This invite can't be answered." }, { status: 409 });
  }

  const mailbox = [token.email, token.userEmail];
  try {
    const calendar = await loadMailboxCalendar(ctx.payload, mailbox);
    const event = calendar ? await findCalendarEvent(calendar, invite.uid) : null;
    if (calendar && event && (await respondOnCalendar(calendar, event, mailbox, response))) {
      return NextResponse.json({ status: response, via: "calendar" });
    }
  } catch (err) {
    // Fall through to the emailed reply, which needs only Gmail.
    console.error("[mail-invite] calendar update failed:", ((err as Error).message ?? "").slice(0, 200));
  }

  if (!invite.organizer) return NextResponse.json({ error: "This invite has no organiser to reply to." }, { status: 422 });
  const attendee = findSelfAttendee(invite, mailbox) ?? { name: "", email: token.email };
  try {
    const raw = buildInviteReplyMime({
      to: invite.organizer.email,
      invite,
      attendee,
      response,
      ...(message.rfcMessageId ? { inReplyTo: message.rfcMessageId } : {}),
      now: new Date(),
    });
    await sendRawMessage(token.accessToken, raw, message.threadId || undefined);
    return NextResponse.json({ status: response, via: "email" });
  } catch (err) {
    return gmailErrorResponse(err, "Could not send your reply to the organiser.");
  }
}
