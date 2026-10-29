import { NextRequest, NextResponse } from "next/server";
import { getFullMessage } from "@/lib/mail/gmail-mail";
import { storeClientEmail, toClientEmailInput } from "@/lib/mail/store";
import { gmailErrorResponse, parseGmailId, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * POST /api/mail/assign
 * Body: { gmailMessageId, clientId }
 *
 * Manually link one unmatched email to a client. Stored the same way as
 * automatic matches (deduped by Gmail message id). No model calls.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ gmailMessageId?: unknown; clientId?: unknown }>(req);
  const gmailMessageId = parseGmailId(body?.gmailMessageId);
  const clientId = Number(body?.clientId);
  if (!gmailMessageId || !Number.isInteger(clientId) || clientId <= 0) {
    return NextResponse.json({ error: "gmailMessageId and clientId are required." }, { status: 400 });
  }

  try {
    await ctx.payload.findByID({ collection: "clients", id: clientId, depth: 0, overrideAccess: false, user: ctx.user } as never);
  } catch {
    return NextResponse.json({ error: "Client not found." }, { status: 404 });
  }

  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;
  let message;
  try {
    message = await getFullMessage(token.accessToken, gmailMessageId);
  } catch (err) {
    return gmailErrorResponse(err, "Could not load that email from Gmail.");
  }

  const result = await storeClientEmail(
    ctx.payload,
    toClientEmailInput({
      message,
      clientId,
      ownerId: ctx.user.id,
      matchedBy: "manual",
      matchedOn: "manual",
      ownAddresses: [token.email, token.userEmail].filter(Boolean),
      gmailAccount: token.email,
    }),
  );
  return NextResponse.json({ ...result, alreadyStored: !result.created });
}
