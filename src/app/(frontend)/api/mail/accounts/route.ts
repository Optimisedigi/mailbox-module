import { NextRequest, NextResponse } from "next/server";
import { deleteMailAccount, listMailAccounts } from "@/lib/mail/accounts";
import { normaliseMailAccount } from "@/lib/mail/accounts-shared";
import { readJson, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * GET /api/mail/accounts
 * The Gmail accounts the Mail account switcher offers: the user's main Gmail
 * (on their user record) and any extra accounts they added. No tokens.
 *
 * DELETE /api/mail/accounts  Body: { email }
 * Disconnects one extra account (its tokens are deleted). The main Gmail is
 * disconnected from Settings → Integrations instead. Gmail itself is not changed.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const user = (await ctx.payload.findByID({ collection: "users", id: ctx.user.id, depth: 0, overrideAccess: true })) as {
    gmailConnected?: boolean;
    gmailEmail?: string | null;
  };
  const accounts = await listMailAccounts(ctx.payload, ctx.user.id);
  return NextResponse.json({
    primary: user.gmailConnected && user.gmailEmail ? user.gmailEmail.trim().toLowerCase() : null,
    accounts: accounts.map((account) => ({ email: account.email, lastSyncAt: account.lastSyncAt })),
    // The menu adds `&email=<address>`; the connect route picks the right sign-in app from it.
    addUrl: "/api/gmail/connect?add=1",
    canAdd: ctx.user.role === "admin",
  });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ email?: unknown }>(req);
  const email = normaliseMailAccount(body?.email);
  if (!email) return NextResponse.json({ error: "Choose the account to remove." }, { status: 400 });
  const removed = await deleteMailAccount(ctx.payload, ctx.user.id, email);
  if (!removed) return NextResponse.json({ error: "That account is not connected." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
