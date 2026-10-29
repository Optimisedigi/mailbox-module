import { NextRequest, NextResponse } from "next/server";
import { userHasFeature } from "@/lib/access";
import { resolveRecipientClient } from "@/lib/mail/client-context";
import { readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

const MAX_RECIPIENTS_CHARS = 4_000;

/**
 * POST /api/mail/client-match
 * Body: { to?: string, cc?: string }
 *
 * Which client (if any) a new email's recipients belong to, so the compose
 * window can offer "Use client data". Plain domain matching only: no model
 * call, no client facts returned. Users without the `clients` feature always
 * get null, since they can't use client data anyway.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ to?: unknown; cc?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  if (!userHasFeature(ctx.user, "clients")) return NextResponse.json({ client: null });

  const to = typeof body.to === "string" ? body.to.slice(0, MAX_RECIPIENTS_CHARS) : "";
  const cc = typeof body.cc === "string" ? body.cc.slice(0, MAX_RECIPIENTS_CHARS) : "";
  if (!to.trim() && !cc.trim()) return NextResponse.json({ client: null });

  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;
  const client = await resolveRecipientClient({
    payload: ctx.payload,
    message: { to, cc },
    ownAddresses: [token.email, token.userEmail].filter(Boolean),
    userId: ctx.user.id,
  });
  return NextResponse.json({ client });
}
