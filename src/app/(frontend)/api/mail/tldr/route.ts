import { NextRequest, NextResponse } from "next/server";
import { getFullMessage } from "@/lib/mail/gmail-mail";
import { buildMailModelRequest } from "@/lib/mail/model-request";
import { runMailModel } from "@/lib/mail/run-model";
import { parseMailTldr } from "@/lib/mail/tldr";
import { gmailErrorResponse, parseGmailId, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * POST /api/mail/tldr
 * Body: { gmailMessageId }
 *
 * Runs only when the user clicks TLDR on an email in the reading pane. The
 * server fetches exactly that one message by id (no thread, no client data)
 * and returns { summary, actions, questions, reply, model } for the reader alone.
 * Nothing is saved, drafted or sent here: the TLDR is display-only, and the
 * suggested reply is only ever placed in the Write with AI instruction box.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ gmailMessageId?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const gmailMessageId = parseGmailId(body.gmailMessageId);
  if (!gmailMessageId) return NextResponse.json({ error: "Select exactly one email." }, { status: 400 });
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  let message;
  try {
    message = await getFullMessage(token.accessToken, gmailMessageId);
  } catch (err) {
    return gmailErrorResponse(err, "Could not load that email from Gmail.");
  }

  const request = buildMailModelRequest({
    action: "tldr",
    email: {
      gmailMessageId: message.messageId,
      from: message.from,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      date: message.date,
      body: message.body,
    },
  });

  try {
    // An answer that is not valid JSON gets one more try.
    let result = await runMailModel({ payload: ctx.payload, userId: ctx.user.id, request });
    let tldr = parseMailTldr(result.text);
    if (!tldr) {
      result = await runMailModel({ payload: ctx.payload, userId: ctx.user.id, request });
      tldr = parseMailTldr(result.text);
    }
    if (!tldr) return NextResponse.json({ error: "The AI's TLDR could not be read. Please try again." }, { status: 502 });
    return NextResponse.json({ ...tldr, model: result.model });
  } catch (err) {
    const text = err instanceof Error ? err.message : "AI request failed.";
    return NextResponse.json({ error: text.slice(0, 300) }, { status: 502 });
  }
}
