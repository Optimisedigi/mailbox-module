import type { gmail_v1 } from "googleapis";

/**
 * Files attached to one received email, for the Mail reading pane. Gmail's
 * attachment ids change on every read, so a file is named by its MIME part id
 * ("1", "1.2", ...) and the download route finds the part again.
 *
 * Images the HTML body shows through `cid:` are part of the body, not
 * attachments (Gmail does not list them either), so they are left out.
 */

export interface MessageAttachment {
  /** MIME part id, stable for the message. */
  partId: string;
  filename: string;
  mimeType: string;
  /** Bytes, as Gmail reports them. */
  size: number;
}

export const PART_ID_RE = /^\d{1,4}(\.\d{1,4}){0,15}$/;

function header(part: gmail_v1.Schema$MessagePart, name: string): string {
  const lower = name.toLowerCase();
  return part.headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? "";
}

function walk(part: gmail_v1.Schema$MessagePart | undefined, visit: (part: gmail_v1.Schema$MessagePart) => void): void {
  if (!part) return;
  visit(part);
  part.parts?.forEach((child) => walk(child, visit));
}

function isFilePart(part: gmail_v1.Schema$MessagePart): boolean {
  return Boolean(part.partId && part.filename?.trim() && (part.body?.attachmentId || part.body?.data));
}

/** The message's attachments, in the order the email lists them. */
export function listMessageAttachments(payload: gmail_v1.Schema$MessagePart | undefined, bodyHtml: string): MessageAttachment[] {
  const html = bodyHtml.toLowerCase();
  const out: MessageAttachment[] = [];
  walk(payload, (part) => {
    if (!isFilePart(part)) return;
    const contentId = header(part, "Content-ID").replace(/^<|>$/g, "").trim().toLowerCase();
    const disposition = header(part, "Content-Disposition").toLowerCase();
    // Shown in the body through cid:, unless the sender also marked it an attachment.
    if (contentId && !disposition.startsWith("attachment") && html.includes(`cid:${contentId}`)) return;
    out.push({
      partId: part.partId ?? "",
      filename: (part.filename ?? "").trim(),
      mimeType: part.mimeType || "application/octet-stream",
      size: part.body?.size ?? 0,
    });
  });
  return out;
}

export interface InlineImagePart {
  /** Content-ID, lower case, without angle brackets. */
  contentId: string;
  mimeType: string;
  part: gmail_v1.Schema$MessagePart;
}

const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
};

function imageMimeType(part: gmail_v1.Schema$MessagePart): string {
  const mime = (part.mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return mime;
  const ext = (part.filename ?? "").trim().toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXT_MIME[ext] ?? "";
}

/**
 * Image parts the HTML body shows through `cid:` (the same parts
 * listMessageAttachments leaves out), so the reading pane can embed them.
 */
export function listInlineImageParts(payload: gmail_v1.Schema$MessagePart | undefined, bodyHtml: string): InlineImagePart[] {
  const html = bodyHtml.toLowerCase();
  const out: InlineImagePart[] = [];
  walk(payload, (part) => {
    if (!(part.body?.attachmentId || part.body?.data)) return;
    const contentId = header(part, "Content-ID").replace(/^<|>$/g, "").trim().toLowerCase();
    const disposition = header(part, "Content-Disposition").toLowerCase();
    if (!contentId || disposition.startsWith("attachment") || !html.includes(`cid:${contentId}`)) return;
    const mimeType = imageMimeType(part);
    if (mimeType) out.push({ contentId, mimeType, part });
  });
  return out;
}

/** The attachment entry for a file part (used for inline images that could not be embedded). */
export function attachmentForPart(part: gmail_v1.Schema$MessagePart): MessageAttachment {
  return {
    partId: part.partId ?? "",
    filename: (part.filename ?? "").trim() || "image",
    mimeType: part.mimeType || "application/octet-stream",
    size: part.body?.size ?? 0,
  };
}

/** The file part with this part id, or null (also for parts that are not files). */
export function findAttachmentPart(payload: gmail_v1.Schema$MessagePart | undefined, partId: string): gmail_v1.Schema$MessagePart | null {
  let found: gmail_v1.Schema$MessagePart | null = null;
  walk(payload, (part) => {
    if (!found && part.partId === partId && isFilePart(part)) found = part;
  });
  return found;
}

/** A filename safe for a Content-Disposition header: ASCII fallback plus the UTF-8 original. */
export function contentDispositionFor(filename: string): string {
  const clean = filename.replace(/[\r\n"\\/]/g, "_").slice(0, 200) || "attachment";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}
