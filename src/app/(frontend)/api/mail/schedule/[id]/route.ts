import { NextRequest, NextResponse } from "next/server";
import { getValidGmailToken } from "@/lib/user-gmail-tokens";
import {
  cancelScheduledEmail,
  defaultSendDeps,
  getScheduledEmail,
  parseScheduledFor,
  rescheduleScheduledEmail,
  scheduleDb,
  sendScheduledEmail,
  toEditableScheduledContent,
  updateScheduledEmail,
} from "@/lib/mail/scheduled";
import { parseScheduleRequest, type ScheduleRequestBody } from "@/lib/mail/schedule-request";
import { readJson, requireMailUser } from "@/lib/mail/route-helpers";

function parseId(raw: string): number | null {
  return /^\d{1,12}$/.test(raw) ? Number(raw) : null;
}

const GONE = "This email was already sent, is being sent, or was cancelled.";

/**
 * GET /api/mail/schedule/:id
 * One queued email with its content, for the Scheduled tab's reading pane and
 * Edit: body HTML with inline images as data: URLs, attachments, Bcc and the
 * edited sign-off. Only the owner's unsent (or failed) emails.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  const found = await getScheduledEmail(scheduleDb(ctx.payload), id, ctx.user.id);
  if (!found) return NextResponse.json({ error: GONE }, { status: 404 });
  return NextResponse.json({
    item: found.item,
    replyToMessageId: found.replyToMessageId,
    ...toEditableScheduledContent(found.content),
  });
}

/**
 * PUT /api/mail/schedule/:id
 * Body: the POST /api/mail/schedule body (scheduledFor optional: omitted keeps
 * the current time). Edits a queued email in place; validated exactly like a
 * new one. The reply it belongs to cannot be changed. 409 once it is sending
 * or sent.
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  const body = await readJson<ScheduleRequestBody>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const db = scheduleDb(ctx.payload);
  const existing = await getScheduledEmail(db, id, ctx.user.id);
  if (!existing || existing.item.status === "sending") return NextResponse.json({ error: GONE }, { status: 409 });

  const now = new Date();
  const parsed = parseScheduleRequest(body, now, { timeOptional: true, isReply: existing.replyToMessageId !== null });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { to, cc, subject, scheduledFor, content } = parsed.value;
  const updated = await updateScheduledEmail(db, id, ctx.user.id, { to, cc, subject, content, scheduledFor }, now);
  if (!updated) return NextResponse.json({ error: GONE }, { status: 409 });
  return NextResponse.json({ ok: true, scheduledFor: (scheduledFor ?? new Date(existing.item.scheduledFor)).toISOString() });
}

/**
 * PATCH /api/mail/schedule/:id
 * Body: { scheduledFor } to move it (also re-queues a failed email), or
 * { action: "send-now" } to send it immediately.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  const body = await readJson<{ scheduledFor?: unknown; action?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  if (body.action === "send-now") {
    const outcome = await sendScheduledEmail(ctx.payload, id, defaultSendDeps(getValidGmailToken), {
      ownerId: ctx.user.id,
      onlyDue: false,
    });
    if (outcome.status === "skipped") return NextResponse.json({ error: GONE }, { status: 409 });
    if (outcome.status === "sent") return NextResponse.json({ ok: true, messageId: outcome.messageId });
    return NextResponse.json({ error: outcome.error }, { status: 502 });
  }

  const now = new Date();
  const when = parseScheduledFor(body.scheduledFor, now);
  if (!when.ok) return NextResponse.json({ error: when.error }, { status: 400 });
  const moved = await rescheduleScheduledEmail(scheduleDb(ctx.payload), id, ctx.user.id, when.date, now);
  if (!moved) return NextResponse.json({ error: GONE }, { status: 409 });
  return NextResponse.json({ ok: true, scheduledFor: when.date.toISOString() });
}

/** DELETE /api/mail/schedule/:id: cancel an email that has not started sending. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  const removed = await cancelScheduledEmail(scheduleDb(ctx.payload), id, ctx.user.id);
  if (!removed) return NextResponse.json({ error: GONE }, { status: 409 });
  return NextResponse.json({ ok: true });
}
