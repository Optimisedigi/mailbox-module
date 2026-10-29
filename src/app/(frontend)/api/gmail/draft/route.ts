import { NextRequest, NextResponse } from "next/server";
import { createGmailDraft, getPrimaryGmailSignature } from "@/lib/gmail-service";
import { fetchMessageBody } from "@/lib/gmail-search";
import { buildGmailReplyContext, parseGmailMessageId, type GmailReplyContext } from "@/lib/gmail-reply-context";
import { deleteDraft, findDraftIdByMessageId, getFullMessage, getMessageContentParts, getThreadMessages } from "@/lib/mail/gmail-mail";
import { buildEditableDraft } from "@/lib/mail/draft-content";
import { cleanSignOff } from "@/lib/mail/signature";
import { parseMailComposeContent } from "@/lib/mail/compose-content";
import { MAIL_ATTACHMENT_LIMITS } from "@/lib/mail/compose-limits";
import { gmailErrorResponse, parseGmailId, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";

function cleanHeader(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, 2000) : "";
}

interface DraftBody {
  html?: unknown;
  inlineImages?: unknown;
  attachments?: unknown;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  /** Edited sign-off. */
  signOff?: unknown;
  /** true: save without the Gmail signature. */
  noSignature?: unknown;
  /** Gmail message id being replied to; resolved server-side into reply headers. */
  replyToMessageId?: unknown;
  /** Existing Gmail draft id to update in place. */
  draftId?: unknown;
}

/**
 * GET /api/gmail/draft?messageId=<draft message id>
 *
 * Loads one of the user's Gmail drafts into the Mail compose window. The body comes back
 * as HTML without the Gmail signature (the compose window shows the signature
 * separately and the server adds it again on send/save), with inline images as
 * data: URLs and attachments as files. For a reply draft, `replyTo` is the
 * latest non-draft message in its thread.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const messageId = parseGmailId(req.nextUrl.searchParams.get("messageId"));
  if (!messageId) return NextResponse.json({ error: "Invalid draft message id." }, { status: 400 });
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  try {
    const message = await getFullMessage(token.accessToken, messageId);
    if (!message.labelIds.includes("DRAFT")) {
      return NextResponse.json({ error: "This draft has already been sent or discarded." }, { status: 404 });
    }
    const [draftId, signature, thread, parts] = await Promise.all([
      findDraftIdByMessageId(token.accessToken, messageId),
      getPrimaryGmailSignature(token.accessToken).catch(() => ""),
      message.threadId ? getThreadMessages(token.accessToken, message.threadId) : Promise.resolve([]),
      getMessageContentParts(token.accessToken, messageId, MAIL_ATTACHMENT_LIMITS.maxTotalBytes),
    ]);
    if (!draftId) {
      return NextResponse.json({ error: "This draft has already been sent or discarded." }, { status: 404 });
    }
    if (parts.tooLarge) {
      return NextResponse.json(
        { error: "This draft's attachments are over 3 MB, so it can't be edited in Mail. Open it in Gmail instead." },
        { status: 413 },
      );
    }
    const editable = buildEditableDraft(parts, signature);
    const original = [...thread].reverse().find((entry) => !entry.labelIds.includes("DRAFT"));
    return NextResponse.json({
      draftId,
      messageId,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      html: editable.html,
      attachments: editable.attachments,
      ...(editable.signOff !== undefined ? { signOff: editable.signOff } : {}),
      ...(editable.noSignature ? { noSignature: true } : {}),
      threadId: original ? message.threadId : "",
      replyTo: original
        ? { messageId: original.messageId, from: original.from, subject: original.subject }
        : null,
    });
  } catch (err) {
    return gmailErrorResponse(err, "Could not load the Gmail draft.");
  }
}



/**
 * POST /api/gmail/draft
 * Body: { html, inlineImages?, attachments?, to?, cc?, bcc?, subject?, signOff?, noSignature?, replyToMessageId?, draftId? }
 *
 * Saves the compose window into the user's Gmail Drafts (autosave and "Save
 * as draft"), in the account named by the x-mail-account header. `draftId`
 * updates that draft in place. For a reply, the recipient, Re: subject and
 * thread headers come from the original email, fetched server-side by id.
 * Never sends.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<DraftBody>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const parsed = parseMailComposeContent({ html: body.html, inlineImages: body.inlineImages, attachments: body.attachments });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const rich = parsed.value;

  const hasReplyToMessageId = typeof body.replyToMessageId === "string" && body.replyToMessageId.trim() !== "";
  const replyToMessageId = hasReplyToMessageId ? parseGmailMessageId(body.replyToMessageId) : null;
  if (hasReplyToMessageId && !replyToMessageId) {
    return NextResponse.json({ error: "replyToMessageId is invalid." }, { status: 400 });
  }
  const hasDraftId = typeof body.draftId === "string" && body.draftId.trim() !== "";
  const draftId = hasDraftId ? parseGmailId(body.draftId) : null;
  if (hasDraftId && !draftId) {
    return NextResponse.json({ error: "draftId is invalid." }, { status: 400 });
  }

  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  let reply: GmailReplyContext | undefined;
  if (replyToMessageId) {
    try {
      reply = buildGmailReplyContext(await fetchMessageBody(token.accessToken, replyToMessageId));
    } catch (err) {
      return gmailErrorResponse(err, "Could not load the email to reply to.");
    }
  }

  const signOff = cleanSignOff(body.signOff);
  try {
    const result = await createGmailDraft(token.accessToken, {
      to: reply?.to || cleanHeader(body.to),
      cc: cleanHeader(body.cc),
      bcc: cleanHeader(body.bcc),
      ...(signOff !== undefined ? { signOff } : {}),
      ...(body.noSignature === true ? { appendSignature: false } : {}),
      subject: reply?.subject || cleanHeader(body.subject),
      htmlBody: rich.html,
      ...(rich.inlineImages.length > 0 ? { inlineImages: rich.inlineImages } : {}),
      ...(reply?.threadId ? { threadId: reply.threadId } : {}),
      ...(reply?.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
      ...(draftId ? { draftId } : {}),
      ...(rich.attachments.length > 0 ? { attachments: rich.attachments } : {}),
    });
    return NextResponse.json({
      draftId: result.draftId,
      messageId: result.messageId,
      gmailUrl: `https://mail.google.com/mail/u/0/#drafts/${result.messageId}`,
    });
  } catch (err) {
    return gmailErrorResponse(err, "Could not save the Gmail draft.");
  }
}

/**
 * DELETE /api/gmail/draft?messageId=<draft message id>
 *     or /api/gmail/draft?draftId=<gmail draft id>
 *
 * Permanently deletes one of the user's Gmail drafts (Mail view trash icons:
 * the Drafts list passes the message id, the compose window the draft id).
 * A draft that is already gone counts as deleted for draftId.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const params = req.nextUrl.searchParams;
  const directDraftId = params.has("draftId") ? parseGmailId(params.get("draftId")) : null;
  const messageId = directDraftId ? null : parseGmailId(params.get("messageId"));
  if (!directDraftId && !messageId) return NextResponse.json({ error: "Invalid draft id." }, { status: 400 });
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  if (directDraftId) {
    try {
      await deleteDraft(token.accessToken, directDraftId);
      return NextResponse.json({ ok: true, draftId: directDraftId });
    } catch (err) {
      const status = Number((err as { code?: number; status?: number }).code ?? (err as { status?: number }).status ?? 0);
      if (status === 404) return NextResponse.json({ ok: true, draftId: directDraftId, alreadyGone: true });
      return gmailErrorResponse(err, "Could not delete the Gmail draft.");
    }
  }

  try {
    const draftId = await findDraftIdByMessageId(token.accessToken, messageId ?? "");
    if (!draftId) return NextResponse.json({ error: "This draft has already been sent or discarded." }, { status: 404 });
    await deleteDraft(token.accessToken, draftId);
    return NextResponse.json({ ok: true, draftId });
  } catch (err) {
    return gmailErrorResponse(err, "Could not delete the Gmail draft.");
  }
}
