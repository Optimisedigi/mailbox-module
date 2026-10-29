import { parseMailComposeContent } from "@/lib/mail/compose-content";
import { cleanSignOff } from "@/lib/mail/signature";
import { parseGmailId } from "@/lib/mail/route-helpers";
import { parseScheduledFor, type StoredMailContent } from "@/lib/mail/scheduled";
import { FOLLOW_UP_DAY_OPTIONS, parseFollowUpDays } from "@/lib/mail/follow-ups";

/**
 * Validation shared by POST /api/mail/schedule (queue a new email) and
 * PUT /api/mail/schedule/:id (edit a queued one): the same checks as Send,
 * plus the send time.
 */

const HEADER_MAX = 2000;

export function cleanHeader(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, HEADER_MAX) : "";
}

export interface ScheduleRequestBody {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  signOff?: unknown;
  /** true: send without the Gmail signature. */
  noSignature?: unknown;
  subject?: unknown;
  html?: unknown;
  inlineImages?: unknown;
  attachments?: unknown;
  replyToMessageId?: unknown;
  draftId?: unknown;
  scheduledFor?: unknown;
  /** "Remind me if no reply" in business days after the email goes out. */
  followUpDays?: unknown;
}

export interface ParsedScheduleRequest {
  to: string;
  cc: string;
  subject: string;
  replyToMessageId: string | null;
  draftId: string | null;
  /** Null only when the time was optional and not given (edit keeping its time). */
  scheduledFor: Date | null;
  content: StoredMailContent;
}

export function parseScheduleRequest(
  body: ScheduleRequestBody,
  now: Date,
  opts: { timeOptional?: boolean; isReply?: boolean } = {},
): { ok: true; value: ParsedScheduleRequest } | { ok: false; error: string } {
  let scheduledFor: Date | null = null;
  if (!opts.timeOptional || (body.scheduledFor !== undefined && body.scheduledFor !== null && body.scheduledFor !== "")) {
    const when = parseScheduledFor(body.scheduledFor, now);
    if (!when.ok) return { ok: false, error: when.error };
    scheduledFor = when.date;
  }

  const content = parseMailComposeContent({ html: body.html, inlineImages: body.inlineImages, attachments: body.attachments });
  if (!content.ok) return { ok: false, error: content.error };

  const hasReply = typeof body.replyToMessageId === "string" && body.replyToMessageId !== "";
  const replyToMessageId = hasReply ? parseGmailId(body.replyToMessageId) : null;
  if (hasReply && !replyToMessageId) return { ok: false, error: "Invalid reply message id." };
  const hasDraft = typeof body.draftId === "string" && body.draftId !== "";
  const draftId = hasDraft ? parseGmailId(body.draftId) : null;
  if (hasDraft && !draftId) return { ok: false, error: "Invalid draft id." };

  const to = cleanHeader(body.to);
  if (!replyToMessageId && !opts.isReply && !/@/.test(to)) return { ok: false, error: "Add at least one recipient." };

  const wantsFollowUp = body.followUpDays !== undefined && body.followUpDays !== null && body.followUpDays !== 0;
  const followUpDays = parseFollowUpDays(body.followUpDays);
  if (wantsFollowUp && followUpDays === null) {
    return { ok: false, error: `Choose a reminder of ${FOLLOW_UP_DAY_OPTIONS.join(", ")} business days.` };
  }

  const signOff = cleanSignOff(body.signOff);
  return {
    ok: true,
    value: {
      to,
      cc: cleanHeader(body.cc),
      subject: cleanHeader(body.subject),
      replyToMessageId,
      draftId,
      scheduledFor,
      content: {
        // Bcc and the sign-off live with the content (not their own columns) so no schema change was needed.
        bcc: cleanHeader(body.bcc),
        ...(signOff !== undefined ? { signOff } : {}),
        ...(body.noSignature === true ? { noSignature: true } : {}),
        ...(followUpDays !== null ? { followUpDays } : {}),
        html: content.value.html,
        inlineImages: body.inlineImages ?? [],
        attachments: body.attachments ?? [],
      },
    },
  };
}
