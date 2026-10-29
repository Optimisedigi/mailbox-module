import { NextRequest, NextResponse } from "next/server";
import { pullClientEmails } from "@/lib/mail/client-knowledge";
import { runMailModel } from "@/lib/mail/run-model";
import { gmailErrorResponse, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * POST /api/mail/client-pull
 * Body: { clientId: number }  (Gmail account: the x-mail-account header, else the main Gmail)
 *
 * "Pull emails" on a client's Emails tab. Runs only on that click: searches
 * the signed-in user's chosen Gmail account for mail to or from the client
 * (last 12 months; later pulls only since the last one), saves the emails to
 * the client, and has the AI write or update the client's email brief.
 * Returns { found, saved, more, leftOut, briefUpdated, brief }. Never sends
 * or changes anything in Gmail.
 */
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ clientId?: unknown }>(req);
  const clientId = Number(body?.clientId);
  if (!Number.isSafeInteger(clientId) || clientId <= 0) {
    return NextResponse.json({ error: "clientId is required." }, { status: 400 });
  }
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  try {
    const result = await pullClientEmails({
      payload: ctx.payload,
      userId: ctx.user.id,
      accessToken: token.accessToken,
      userEmail: token.userEmail,
      clientId,
      now: new Date(),
      runModel: (request) => runMailModel({ payload: ctx.payload, userId: ctx.user.id, request }),
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    // Gmail failures carry a status code; model failures are plain errors.
    const status = (err as { code?: unknown; status?: unknown }).code ?? (err as { status?: unknown }).status;
    if (typeof status === "number") return gmailErrorResponse(err, "Could not search Gmail for this client.");
    const message = err instanceof Error ? err.message : "Pull failed.";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
