import { NextRequest, NextResponse } from "next/server";
import { getRawMessage } from "@/lib/mail/gmail-mail";
import { gmailErrorResponse, parseGmailId, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";
import { streamBytes } from "@/lib/mail/stream-bytes";

/**
 * GET /api/mail/message/[messageId]/eml
 *
 * One email as an .eml file: the raw message from Gmail, unchanged
 * (headers, body and attachments), for the reading pane's download button.
 *
 * The file is streamed in chunks: a Vercel Function can only return 4.5 MB in
 * one response, and streamed responses are not held to that limit. Emails over
 * 25 MB (Gmail's own attachment limit) get a 413 pointing to Gmail instead.
 */
const MAX_EML_BYTES = 25 * 1024 * 1024;

// Gmail can take a while to return a 25 MB message.
export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const messageId = parseGmailId((await params).messageId);
  if (!messageId) return NextResponse.json({ error: "Invalid message id." }, { status: 400 });
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  try {
    const raw = await getRawMessage(token.accessToken, messageId, MAX_EML_BYTES);
    if (!raw) {
      return NextResponse.json(
        { error: "This email is over 25 MB (usually attachments), too large to download here. Use Download message in Gmail instead." },
        { status: 413 },
      );
    }
    // No content-length on purpose: it would let the platform buffer the response instead of streaming it.
    return new NextResponse(streamBytes(raw), {
      headers: {
        "content-type": "message/rfc822",
        "content-disposition": 'attachment; filename="email.eml"',
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    return gmailErrorResponse(err, "Could not download that email from Gmail.");
  }
}
