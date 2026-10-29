import { NextRequest, NextResponse } from "next/server";
import { buildMailSelectionRequest, cleanSelectionRewrite, MailModelRequestError } from "@/lib/mail/model-request";
import { runMailModel } from "@/lib/mail/run-model";
import { gmailErrorResponse, parseGmailId, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";
import { userHasFeature } from "@/lib/access";
import { composeClientContext, type MailClientContext } from "@/lib/mail/client-context";
import { getFullMessage } from "@/lib/mail/gmail-mail";

const MAX_RECIPIENTS_CHARS = 4_000;

/**
 * POST /api/mail/ai/selection
 * Body: { mode: "shorten" | "lengthen" | "instruction", instruction?: string, selection: string, draft?: string,
 *         includeClientData?: true, gmailMessageId?: string (reply), to?/cc?: string (new email) }
 *
 * includeClientData ("Use client data", needs the `clients` feature): the
 * client facts go in too, so "add the monthly budget" can fill it in. The
 * client is resolved server-side exactly as for /api/mail/ai (the reply's
 * message, or a new email's To/Cc), never from a client id in the body.
 *
 * Rewrites the passage the user highlighted in the compose window: Shorten,
 * Lengthen, or their own Write with AI request. The model gets the user's own
 * draft for context (no mailbox content) and returns only the new passage.
 * Returns { text, model }; the window swaps it in for the highlight. Never
 * sends or saves anything.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{
    mode?: unknown;
    instruction?: unknown;
    selection?: unknown;
    draft?: unknown;
    includeClientData?: unknown;
    gmailMessageId?: unknown;
    to?: unknown;
    cc?: unknown;
  }>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  let clientContext: MailClientContext | null = null;
  if (body.includeClientData === true) {
    if (!userHasFeature(ctx.user, "clients")) {
      return NextResponse.json({ error: "Client data is not enabled for your account." }, { status: 403 });
    }
    const token = await requireGmailToken(ctx.user.id, req);
    if (token instanceof NextResponse) return token;
    const replyId = body.gmailMessageId === undefined || body.gmailMessageId === null || body.gmailMessageId === "" ? null : parseGmailId(body.gmailMessageId);
    if (body.gmailMessageId && !replyId) return NextResponse.json({ error: "Invalid gmailMessageId." }, { status: 400 });
    let reply = null;
    if (replyId) {
      try {
        reply = await getFullMessage(token.accessToken, replyId);
      } catch (err) {
        return gmailErrorResponse(err, "Could not load that email from Gmail.");
      }
    }
    const recipients = (raw: unknown) => (typeof raw === "string" ? raw.slice(0, MAX_RECIPIENTS_CHARS) : "");
    try {
      clientContext = await composeClientContext({
        payload: ctx.payload,
        user: ctx.user,
        ownAddresses: [token.email, token.userEmail].filter(Boolean),
        now: new Date(),
        reply,
        recipients: { to: recipients(body.to), cc: recipients(body.cc) },
      });
    } catch (err) {
      console.error("[mail] client context failed:", (err as Error).message?.slice(0, 200));
      return NextResponse.json({ error: "Could not load the client's data. Try again or untick Use client data." }, { status: 502 });
    }
    if (!clientContext) return NextResponse.json({ error: "This email isn't linked to a client." }, { status: 400 });
  }

  let request;
  try {
    request = buildMailSelectionRequest({
      mode: body.mode,
      instruction: body.instruction,
      selection: body.selection,
      draft: body.draft,
      clientContext,
    });
  } catch (err) {
    if (err instanceof MailModelRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  try {
    const result = await runMailModel({ payload: ctx.payload, userId: ctx.user.id, request });
    const text = cleanSelectionRewrite(result.text, typeof body.selection === "string" ? body.selection : "");
    if (!text.trim()) return NextResponse.json({ error: "The AI did not rewrite the text. Please try again." }, { status: 502 });
    return NextResponse.json({
      text,
      model: result.model,
      clientContext: clientContext ? { id: clientContext.clientId, name: clientContext.clientName } : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed.";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
