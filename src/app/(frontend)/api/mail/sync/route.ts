import { NextRequest, NextResponse } from "next/server";
import { extraAccountSyncStateStore, syncMailbox } from "@/lib/mail/store";
import { findMailAccount } from "@/lib/mail/accounts";
import { gmailErrorResponse, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * POST /api/mail/sync
 *
 * Called when Mail opens and on the Refresh button. Incremental Gmail history
 * sync; stores client-matched emails (deduped by Gmail message id). Plain
 * code only: this route never calls a model.
 */
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  try {
    // An extra Gmail account keeps its own sync cursor on its mail-accounts row.
    const row = token.account ? await findMailAccount(ctx.payload, ctx.user.id, token.account) : null;
    const result = await syncMailbox({
      payload: ctx.payload,
      userId: ctx.user.id,
      accessToken: token.accessToken,
      userEmail: token.userEmail,
      ...(row ? { stateStore: extraAccountSyncStateStore(ctx.payload, row), account: row.email } : {}),
    });
    return NextResponse.json(result);
  } catch (err) {
    return gmailErrorResponse(err, "Mail sync failed.");
  }
}
