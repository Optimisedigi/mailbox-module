import type { Payload } from "payload";
import { sendGmailMessage } from "@/lib/gmail-service";
import { buildGmailReplyContext } from "@/lib/gmail-reply-context";
import type { MailComposeContent } from "@/lib/mail/compose-content";
import { getFullMessage } from "@/lib/mail/gmail-mail";
import { matchMessageToClient } from "@/lib/mail/client-matching";
import { loadClientDomainIndex, storeClientEmail, toClientEmailInput } from "@/lib/mail/store";

/**
 * Sends one composed email through Gmail and links it to its client. Shared by
 * the Send button (/api/mail/send) and the scheduled-send cron so both behave
 * the same. Gmail failures are returned (not thrown) with the stage they
 * happened at so callers can word the error.
 */

export interface DeliverInput {
  payload: Payload;
  ownerId: number;
  token: { accessToken: string; email: string; userEmail: string };
  to: string;
  cc?: string;
  bcc?: string;
  /** Edited sign-off (compose window); undefined appends the Gmail signature unchanged. */
  signOff?: string;
  /** Signature toggle off: send without the Gmail signature. */
  noSignature?: boolean;
  subject: string;
  content: MailComposeContent;
  replyToMessageId?: string | null;
}

export type DeliverResult =
  | { ok: true; messageId: string; threadId: string; client: { id: number; name: string } | null }
  | { ok: false; stage: "reply" | "recipient" | "send"; error: unknown };

export async function deliverMail(input: DeliverInput): Promise<DeliverResult> {
  const { token, content } = input;
  let reply: ReturnType<typeof buildGmailReplyContext> | undefined;
  if (input.replyToMessageId) {
    try {
      reply = buildGmailReplyContext(await getFullMessage(token.accessToken, input.replyToMessageId));
    } catch (error) {
      return { ok: false, stage: "reply", error };
    }
  }

  const to = input.to || reply?.to || "";
  if (!/@/.test(to)) return { ok: false, stage: "recipient", error: new Error("Add at least one recipient.") };
  const subject = input.subject || reply?.subject || "";

  let sent;
  try {
    sent = await sendGmailMessage(token.accessToken, {
      to,
      cc: input.cc || undefined,
      bcc: input.bcc || undefined,
      ...(input.signOff !== undefined ? { signOff: input.signOff } : {}),
      ...(input.noSignature ? { appendSignature: false } : {}),
      subject,
      htmlBody: content.html,
      ...(content.inlineImages.length > 0 ? { inlineImages: content.inlineImages } : {}),
      ...(content.attachments.length > 0 ? { attachments: content.attachments } : {}),
      ...(reply?.threadId ? { threadId: reply.threadId } : {}),
      ...(reply?.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
    });
  } catch (error) {
    return { ok: false, stage: "send", error };
  }

  // Link the sent email to its client now rather than waiting for the next sync.
  let client: { id: number; name: string } | null = null;
  try {
    const ownAddresses = [token.email, token.userEmail].filter(Boolean);
    const message = await getFullMessage(token.accessToken, sent.messageId);
    const match = matchMessageToClient(await loadClientDomainIndex(input.payload, ownAddresses, { userId: input.ownerId }), message);
    if (match) {
      await storeClientEmail(
        input.payload,
        toClientEmailInput({
          message,
          clientId: match.clientId,
          ownerId: input.ownerId,
          matchedBy: "auto",
          matchedOn: match.matchedOn,
          ownAddresses,
          gmailAccount: token.email,
        }),
      );
      client = { id: match.clientId, name: match.clientName };
    }
  } catch {
    // Sent fine; the next sync will link it.
  }
  return { ok: true, messageId: sent.messageId, threadId: sent.threadId, client };
}
