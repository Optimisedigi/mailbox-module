import { NextRequest, NextResponse } from "next/server";
import { clientListExtension } from "@/extensions/client-list";
import { userHasFeature } from "@/lib/access";
import { MAX_KEY_DATE_DESCRIPTION } from "@/lib/mail/key-dates";
import { readJson, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * POST /api/mail/client-timeline
 * Body: { clientId: number, day: "YYYY-MM-DD", description: string }
 *
 * The "Add to timeline" button next to a key date in a client's email brief.
 * Hands the entry to clientListExtension.appendTimelineEntry (optional; see
 * src/extensions/client-list.ts). Needs the `clients` feature (admins have it).
 * Returns { added: boolean }, or 501 when no timeline is connected.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  if (!userHasFeature(ctx.user, "clients")) {
    return NextResponse.json({ error: "You don't have access to edit client timelines." }, { status: 403 });
  }
  const append = clientListExtension.appendTimelineEntry;
  if (!append) {
    return NextResponse.json({ error: "Client timelines are not connected in this app." }, { status: 501 });
  }
  const body = await readJson<{ clientId?: unknown; day?: unknown; description?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const clientId = Number(body.clientId);
  if (!Number.isSafeInteger(clientId) || clientId <= 0) return NextResponse.json({ error: "clientId is required." }, { status: 400 });
  const day = typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : null;
  if (!day || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return NextResponse.json({ error: "A valid date is required." }, { status: 400 });
  const description = typeof body.description === "string" ? body.description.replace(/\s+/g, " ").trim().slice(0, MAX_KEY_DATE_DESCRIPTION) : "";
  if (!description) return NextResponse.json({ error: "A description is required." }, { status: 400 });

  try {
    await ctx.payload.findByID({ collection: "clients", id: clientId, depth: 0, overrideAccess: true, select: { id: true } } as never);
  } catch {
    return NextResponse.json({ error: "Client not found." }, { status: 404 });
  }

  const who = (ctx.user as { name?: string | null; email?: string | null }).name?.trim() || ctx.user.email || "Mail";
  try {
    const result = await append({ payload: ctx.payload, clientId, day, description, addedBy: who.slice(0, 120) });
    return NextResponse.json({ added: result.added === true });
  } catch (err) {
    console.error("[mail] add key date to timeline failed:", (err as Error).message?.slice(0, 200));
    return NextResponse.json({ error: "Could not add it to the timeline. Please try again." }, { status: 502 });
  }
}
