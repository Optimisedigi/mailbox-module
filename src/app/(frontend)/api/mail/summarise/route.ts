import { NextRequest, NextResponse } from "next/server";
import { buildMailModelRequest } from "@/lib/mail/model-request";
import { runMailModel } from "@/lib/mail/run-model";
import { readJson, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * POST /api/mail/summarise
 * Body: { clientEmailId }
 *
 * Runs only when the user clicks "Summarise to timeline". The model receives
 * that ONE stored email and nothing else (no thread, no client history).
 * Returns the draft summary for review; nothing is saved here. Saving is a
 * separate confirm step (POST /api/mail/summaries).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ clientEmailId?: unknown }>(req);
  const id = Number(body?.clientEmailId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "clientEmailId is required." }, { status: 400 });
  }

  let email: { gmailMessageId: string; from?: string; to?: string; cc?: string; subject?: string; date?: string; body?: string };
  try {
    email = (await ctx.payload.findByID({
      collection: "client-emails",
      id,
      depth: 0,
      overrideAccess: false,
      user: ctx.user,
    } as never)) as unknown as typeof email;
  } catch {
    return NextResponse.json({ error: "Email not found." }, { status: 404 });
  }

  const request = buildMailModelRequest({
    action: "summarise",
    email: {
      gmailMessageId: email.gmailMessageId,
      from: email.from ?? "",
      to: email.to ?? "",
      cc: email.cc ?? "",
      subject: email.subject ?? "",
      date: email.date ?? "",
      body: email.body ?? "",
    },
  });

  try {
    const result = await runMailModel({ payload: ctx.payload, userId: ctx.user.id, request });
    return NextResponse.json({ summary: result.text, model: result.model });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed.";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
