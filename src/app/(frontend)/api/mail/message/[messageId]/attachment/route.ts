import { NextRequest, NextResponse } from "next/server";
import { getMessageAttachment } from "@/lib/mail/gmail-mail";
import { contentDispositionFor, PART_ID_RE } from "@/lib/mail/message-attachments";
import { gmailErrorResponse, parseGmailId, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";
import { streamBytes } from "@/lib/mail/stream-bytes";

/**
 * GET /api/mail/message/[messageId]/attachment?part=<MIME part id>
 *
 * One attachment of an email, for the reading pane's attachment buttons. The
 * part is looked up again in the message Gmail returns for the selected
 * mailbox, so only files of that mailbox's own mail can be fetched. Streamed
 * like the .eml download (Vercel's 4.5 MB response limit), up to Gmail's own
 * 25 MB attachment limit.
 *
 * The file is untrusted, so it is always sent as a download (octet-stream,
 * attachment disposition, nosniff, sandbox CSP) and never rendered on this site.
 */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const messageId = parseGmailId((await params).messageId);
  if (!messageId) return NextResponse.json({ error: "Invalid message id." }, { status: 400 });
  const partId = req.nextUrl.searchParams.get("part") ?? "";
  if (!PART_ID_RE.test(partId)) return NextResponse.json({ error: "Invalid attachment." }, { status: 400 });
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  try {
    const file = await getMessageAttachment(token.accessToken, messageId, partId, MAX_ATTACHMENT_BYTES);
    if (!file) return NextResponse.json({ error: "That attachment is no longer on this email." }, { status: 404 });
    if (file === "too-large") {
      return NextResponse.json({ error: "This attachment is over 25 MB, too large to download here. Download it in Gmail instead." }, { status: 413 });
    }
    return new NextResponse(streamBytes(file.bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": contentDispositionFor(file.filename),
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    return gmailErrorResponse(err, "Could not download that attachment from Gmail.");
  }
}
