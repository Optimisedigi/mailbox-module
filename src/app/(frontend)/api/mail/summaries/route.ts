import { NextRequest, NextResponse } from "next/server";
import { readJson, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * POST /api/mail/summaries
 * Body: { clientEmailId, summary, model? }
 *
 * The confirm step: adds the reviewed (and possibly edited) summary to the
 * client's email timeline, linked to its source email. No model call here.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ clientEmailId?: unknown; summary?: unknown; model?: unknown }>(req);
  const id = Number(body?.clientEmailId);
  const summary = typeof body?.summary === "string" ? body.summary.trim().slice(0, 4000) : "";
  if (!Number.isInteger(id) || id <= 0 || !summary) {
    return NextResponse.json({ error: "clientEmailId and summary are required." }, { status: 400 });
  }

  let email: { id: number; client: number | { id: number }; date?: string };
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

  const clientId = typeof email.client === "object" ? email.client.id : email.client;
  const doc = await ctx.payload.create({
    collection: "client-email-summaries",
    overrideAccess: true,
    data: {
      client: clientId,
      email: email.id,
      owner: ctx.user.id,
      summary,
      emailDate: email.date ?? null,
      model: typeof body?.model === "string" ? body.model.slice(0, 120) : null,
    },
  } as never);
  return NextResponse.json({ summary: doc });
}
