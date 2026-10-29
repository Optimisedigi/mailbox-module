import { NextRequest, NextResponse } from "next/server";
import { dismissFollowUp, followUpDb, parseRemindAt, snoozeFollowUp } from "@/lib/mail/follow-ups";
import { readJson, requireMailUser } from "@/lib/mail/route-helpers";

function parseId(raw: string): number | null {
  return /^\d{1,12}$/.test(raw) ? Number(raw) : null;
}

const GONE = "This reminder was already closed.";

/**
 * PATCH /api/mail/follow-ups/:id
 * Body: { action: "dismiss" } | { action: "snooze", remindAt: ISO }
 * Done or push back one of the user's own open reminders. 404 when it is not
 * theirs or already replied/dismissed.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  const body = await readJson<{ action?: unknown; remindAt?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const db = followUpDb(ctx.payload);
  const now = new Date();
  if (body.action === "dismiss") {
    const ok = await dismissFollowUp(db, id, ctx.user.id, now);
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: GONE }, { status: 404 });
  }
  if (body.action === "snooze") {
    const when = parseRemindAt(body.remindAt, now);
    if (!when.ok) return NextResponse.json({ error: when.error }, { status: 400 });
    const ok = await snoozeFollowUp(db, id, ctx.user.id, when.date, now);
    return ok
      ? NextResponse.json({ ok: true, remindAt: when.date.toISOString() })
      : NextResponse.json({ error: GONE }, { status: 404 });
  }
  return NextResponse.json({ error: "action must be dismiss or snooze." }, { status: 400 });
}
