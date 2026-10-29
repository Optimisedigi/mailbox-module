import { NextRequest, NextResponse } from "next/server";
import { createUserLabel, listUserLabels } from "@/lib/mail/gmail-mail";
import { cleanTagName, MAX_TAG_NAME } from "@/lib/mail/tags";
import { gmailErrorResponse, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * GET  /api/mail/tags            → { tags }  the account's Mail tags (its own Gmail labels) with counts
 * POST /api/mail/tags { name }   → { tag }   saves a new tag (or returns the existing one with that name)
 *
 * Tags are Gmail labels, so they are kept in Gmail and show in the Gmail apps
 * too. Emails are tagged from Triage (/api/mail/triage/apply, action "tag")
 * and a tag's emails are listed with /api/mail/inbox?tag=.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;
  try {
    return NextResponse.json({ tags: await listUserLabels(token.accessToken) });
  } catch (err) {
    return gmailErrorResponse(err, "Could not load your tags from Gmail.");
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ name?: unknown }>(req);
  const name = cleanTagName(body?.name);
  if (!name) return NextResponse.json({ error: `Give the tag a name of 1 to ${MAX_TAG_NAME} characters.` }, { status: 400 });
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;
  try {
    return NextResponse.json({ tag: await createUserLabel(token.accessToken, name) });
  } catch (err) {
    if (Number((err as { code?: number }).code) === 400) {
      return NextResponse.json({ error: "Gmail does not allow that tag name. Try another." }, { status: 400 });
    }
    return gmailErrorResponse(err, "Could not save the tag in Gmail.");
  }
}
