import { NextRequest, NextResponse } from "next/server";
import { getUnsubscribeHeaders, mapLimited } from "@/lib/mail/gmail-mail";
import { oneClickUnsubscribeUrl, postOneClickUnsubscribe, type UnsubscribeOutcome } from "@/lib/mail/unsubscribe";
import { gmailErrorResponse, parseGmailId, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

export const maxDuration = 60;

/** Senders per request; the triage panel sends bigger selections in several requests. */
const MAX_UNSUBSCRIBE_IDS = 25;

/**
 * POST /api/mail/triage/unsubscribe
 * Body: { messageIds: string[] }  one message per sender (the triage's `unsubscribeId`)
 *   → { results: [{ messageId, status: "unsubscribed" | "unavailable" | "failed" }] }
 *
 * One-click unsubscribes (RFC 8058) from each message's sender. The links are
 * read from Gmail here, never taken from the request, and each POST goes
 * through the public-host checks in unsubscribe.ts. Changes nothing in Gmail:
 * the panel archives the emails of senders that were unsubscribed.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ messageIds?: unknown }>(req);
  const raw = Array.isArray(body?.messageIds) ? body.messageIds : null;
  const messageIds = raw ? [...new Set(raw.map(parseGmailId))] : [];
  if (!raw || raw.length === 0 || messageIds.some((id) => id === null)) {
    return NextResponse.json({ error: "messageIds (Gmail ids) are required." }, { status: 400 });
  }
  if (messageIds.length > MAX_UNSUBSCRIBE_IDS) {
    return NextResponse.json({ error: `At most ${MAX_UNSUBSCRIBE_IDS} senders per request.` }, { status: 400 });
  }
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  const ids = messageIds.filter((id): id is string => id !== null);
  let headers: Awaited<ReturnType<typeof getUnsubscribeHeaders>>;
  try {
    headers = await getUnsubscribeHeaders(token.accessToken, ids);
  } catch (err) {
    return gmailErrorResponse(err, "Could not read those emails from Gmail.");
  }
  const byId = new Map(headers.map((row) => [row.messageId, row]));
  const results = await mapLimited(ids, 5, async (messageId): Promise<{ messageId: string; status: UnsubscribeOutcome }> => {
    const row = byId.get(messageId);
    const url = row ? oneClickUnsubscribeUrl(row.listUnsubscribe, row.listUnsubscribePost) : null;
    if (!url) return { messageId, status: "unavailable" };
    return { messageId, status: await postOneClickUnsubscribe(url, { signal: req.signal }) };
  });
  return NextResponse.json({ results });
}
