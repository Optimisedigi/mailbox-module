import { formatGmailDraftHtml } from "@/lib/gmail-service";
import { sanitizeEmailHtml } from "@/lib/mail/email-html";
import type { MessageContentParts } from "@/lib/mail/gmail-mail";
import { splitSignatureSignOff, takeTrailingSignOff } from "@/lib/mail/signature";

/**
 * Turns a saved Gmail draft back into what the Mail compose window edits:
 * body HTML without the Gmail signature (the window previews it and the
 * server appends it again on send/save), inline images as data: URLs the
 * editor can show, and attachments as files.
 */

const DRAFT_WRAPPER_RE = /^<div data-mailbox-gmail-draft-font="true" style="[^"]*">([\s\S]*)<\/div>$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface EditableDraftFile {
  name: string;
  mediaType: string;
  data: string;
}

export interface EditableDraft {
  html: string;
  attachments: EditableDraftFile[];
  /** Sign-off as edited in the compose window, when the draft was saved with one. */
  signOff?: string;
  /** The Gmail signature is not at the end: the draft was saved with the Signature toggle off. */
  noSignature?: boolean;
}

function unwrap(html: string): string {
  return html.trim().match(DRAFT_WRAPPER_RE)?.[1] ?? html.trim();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Remove the signature that createGmailDraft appended. Drafts are saved as
 * formatGmailDraftHtml(body + signature), so the signature is matched in the
 * same normalised form (and raw, for drafts written elsewhere).
 */
export function stripAppendedSignature(html: string, signatureHtml: string): string {
  const body = unwrap(html);
  const signature = signatureHtml.trim();
  if (!signature) return body;
  const candidates = [unwrap(formatGmailDraftHtml(signature)), signature];
  for (const candidate of candidates) {
    const trimmed = body.trimEnd();
    if (candidate && trimmed.endsWith(candidate)) {
      return trimmed.slice(0, trimmed.length - candidate.length).replace(/(?:\s*<br\s*\/?>)+\s*$/i, "").trimEnd();
    }
  }
  return body;
}

function trimTrailingBreaks(html: string): string {
  return html.replace(/(?:\s*<br\s*\/?>)+\s*$/i, "").trimEnd();
}

/**
 * Remove a signature saved with an edited sign-off (see withEditedSignOff):
 * the rest of the Gmail signature, then the marked sign-off before it.
 */
export function stripEditedSignature(html: string, signatureHtml: string): { html: string; signOff: string } | null {
  const parts = splitSignatureSignOff(signatureHtml);
  if (!parts) return null;
  let body = unwrap(html).trimEnd();
  if (parts.rest) {
    const candidates = [unwrap(formatGmailDraftHtml(parts.rest)), parts.rest.trim()];
    const candidate = candidates.find((c) => c && body.endsWith(c));
    if (!candidate) return null;
    body = body.slice(0, body.length - candidate.length);
  }
  const taken = takeTrailingSignOff(trimTrailingBreaks(body));
  if (!taken) return null;
  return { html: trimTrailingBreaks(taken.html), signOff: taken.signOff };
}

export function buildEditableDraft(parts: MessageContentParts, signatureHtml: string): EditableDraft {
  const source = parts.html || escapeHtml(parts.text).replace(/\r?\n/g, "<br>");
  const edited = parts.html ? stripEditedSignature(source, signatureHtml) : null;
  // Sanitise before the image data goes in: sanitizeEmailHtml caps the length.
  const stripped = edited ? edited.html : stripAppendedSignature(source, signatureHtml);
  // A rich draft with a signature set but none found was saved with the Signature toggle off.
  const noSignature = Boolean(parts.html && signatureHtml.trim() && !edited && stripped === unwrap(source));
  let html = sanitizeEmailHtml(stripped);

  const attachments: EditableDraftFile[] = parts.attachments.map((file) => ({
    name: file.filename,
    mediaType: file.mimeType,
    data: file.data,
  }));
  for (const image of parts.inline) {
    const reference = `cid:${image.contentId}`;
    if (IMAGE_TYPES.has(image.mimeType) && image.contentId && html.includes(reference)) {
      html = html.split(reference).join(`data:${image.mimeType};base64,${image.data}`);
    } else {
      attachments.push({ name: image.filename, mediaType: image.mimeType, data: image.data });
    }
  }
  return { html, attachments, ...(edited ? { signOff: edited.signOff } : {}), ...(noSignature ? { noSignature: true } : {}) };
}
