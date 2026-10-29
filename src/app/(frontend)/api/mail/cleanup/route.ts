import { NextRequest, NextResponse } from "next/server";
import { deleteClientEmails, findCleanupCandidates } from "@/lib/mail/cleanup";
import { loadHiddenSenders } from "@/lib/mail/hidden-senders";
import { gmailErrorResponse, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * GET  /api/mail/cleanup → counts of stored client emails from your own
 *      mailbox that are from hidden senders or automated. Deletes nothing.
 * POST /api/mail/cleanup { categories: ("hidden" | "automated")[] }
 *      → re-checks and deletes those rows, returning how many went.
 *
 * Only CMS rows are deleted, never Gmail. Emails assigned by hand or with a
 * timeline summary are always kept (see src/lib/mail/cleanup.ts).
 */
export const maxDuration = 60;

const CATEGORIES = ["hidden", "automated"] as const;
type Category = (typeof CATEGORIES)[number];

async function candidates(req: NextRequest) {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;
  try {
    const found = await findCleanupCandidates({
      payload: ctx.payload,
      userId: ctx.user.id,
      accessToken: token.accessToken,
      hiddenSenders: await loadHiddenSenders(ctx.payload, ctx.user.id),
    });
    return { ctx, found };
  } catch (err) {
    return gmailErrorResponse(err, "Could not check stored emails.");
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const result = await candidates(req);
  if (result instanceof NextResponse) return result;
  return NextResponse.json({
    hidden: result.found.hidden.length,
    automated: result.found.automated.length,
    more: result.found.more,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await readJson<{ categories?: unknown }>(req);
  const categories = Array.isArray(body?.categories)
    ? CATEGORIES.filter((category) => (body.categories as unknown[]).includes(category))
    : [];
  if (categories.length === 0) {
    return NextResponse.json({ error: "Choose hidden and/or automated." }, { status: 400 });
  }
  const result = await candidates(req);
  if (result instanceof NextResponse) return result;

  const deleted: Record<Category, number> = { hidden: 0, automated: 0 };
  for (const category of categories) {
    deleted[category] = await deleteClientEmails(result.ctx.payload, result.found[category], result.ctx.user.id);
  }
  console.info(`[mail] cleanup by user ${result.ctx.user.id}: deleted hidden=${deleted.hidden} automated=${deleted.automated}`);
  return NextResponse.json({ deleted, more: result.found.more });
}
