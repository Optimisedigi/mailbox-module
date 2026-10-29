import type { GmailMessageBody } from "@/lib/gmail-search";

/**
 * Trusted reply metadata for drafting a Gmail reply to a specific message.
 *
 * Built server-side from a message fetched with the user's own Gmail token,
 * never from model output, so an attached (untrusted) email cannot redirect
 * the reply or move it into another thread. Gmail only threads a draft when
 * the threadId, In-Reply-To/References and a matching "Re:" subject are all
 * present, so all of them are pinned together.
 */
export interface GmailReplyContext {
  to: string;
  subject: string;
  threadId?: string;
  inReplyTo?: string;
}

const MAX_MESSAGE_ID_LENGTH = 256;

/** Validate a client-supplied Gmail message id. Returns null when unusable. */
export function parseGmailMessageId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id || id.length > MAX_MESSAGE_ID_LENGTH) return null;
  // Gmail API message ids are hex; allow URL-safe id characters only.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

function sanitizeHeader(value: string | undefined, maxLength: number): string {
  return (value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, maxLength);
}

export function buildGmailReplyContext(
  email: Pick<GmailMessageBody, "from" | "subject" | "threadId" | "rfcMessageId">,
): GmailReplyContext {
  const to = sanitizeHeader(email.from, 998);
  const originalSubject = sanitizeHeader(email.subject, 998) || "(no subject)";
  const threadId = sanitizeHeader(email.threadId, 256);
  const inReplyTo = sanitizeHeader(email.rfcMessageId, 998);
  const subject = (/^re\s*:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`).slice(0, 998);
  return {
    to,
    subject,
    ...(threadId ? { threadId } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
  };
}
