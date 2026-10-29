import { z } from "zod";
import type { GmailFileAttachment, GmailInlineImage } from "@/lib/gmail-service";
import { hasExpectedImageSignature } from "@/lib/mail/image-signature";
import { sanitizeEmailHtml } from "@/lib/mail/email-html";
import { editorParagraphsToGmailLines, inlineEmailListStyles, inlineEmailTableStyles, stripEmailFonts } from "@/lib/mail/gmail-html";
import { MAIL_ATTACHMENT_LIMITS } from "@/lib/mail/compose-limits";
import { mapOutsidePreservedHtml } from "@/lib/mail/preserved-html";

/**
 * Server-side validation of what the Mail compose window sends: the edited
 * HTML body, the images embedded in it (cid: references), and attached files.
 *
 * The HTML is the user's own editor output, but it is still cleaned before it
 * goes into an email: active content is removed (sanitizeEmailHtml), class
 * attributes from the editor are dropped, and images may only point at an
 * inline image sent with the request (cid:) or an https URL.
 */

export interface MailComposeContent {
  html: string;
  inlineImages: GmailInlineImage[];
  attachments: GmailFileAttachment[];
}

export type MailComposeResult = { ok: true; value: MailComposeContent } | { ok: false; error: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const CONTENT_ID_RE = /^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9.-]{1,128}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** File types Gmail refuses to send; rejected here with a clear message instead. */
const BLOCKED_EXTENSIONS = new Set([
  "ade", "adp", "apk", "appx", "appxbundle", "bat", "cab", "chm", "cmd", "com", "cpl", "diagcab",
  "diagcfg", "diagpack", "dll", "dmg", "ex", "ex_", "exe", "hta", "img", "ins", "iso", "isp", "jar",
  "jnlp", "js", "jse", "lib", "lnk", "mde", "mjs", "msc", "msi", "msix", "msixbundle", "msp", "mst",
  "nsh", "pif", "ps1", "scr", "sct", "shb", "sys", "vb", "vbe", "vbs", "vhd", "vxd", "wsc", "wsf",
  "wsh", "xll",
]);

const fileSchema = z.object({
  name: z.string().trim().min(1).max(180),
  mediaType: z.string().max(255),
  data: z.string().max(MAIL_ATTACHMENT_LIMITS.maxBase64Length),
});

const composeSchema = z.object({
  html: z.string().max(MAIL_ATTACHMENT_LIMITS.maxHtmlLength),
  inlineImages: z
    .array(fileSchema.extend({ contentId: z.string().regex(CONTENT_ID_RE) }))
    .max(MAIL_ATTACHMENT_LIMITS.maxInlineImages)
    .optional(),
  attachments: z.array(fileSchema).max(MAIL_ATTACHMENT_LIMITS.maxAttachments).optional(),
});

function decodeBase64(data: string): Buffer | null {
  if (!data || data.length % 4 !== 0 || !BASE64_RE.test(data)) return null;
  const content = Buffer.from(data, "base64");
  return content.toString("base64") === data ? content : null;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Plain text of the HTML, used only to tell whether the body is empty. */
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .trim();
}

/** Keep only <img> tags whose src is a known cid: or an https URL. */
function restrictImages(html: string, contentIds: Set<string>): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/\ssrc\s*=\s*("([^"]*)"|'([^']*)')/i);
    const value = (src?.[2] ?? src?.[3] ?? "").trim();
    if (value.toLowerCase().startsWith("cid:")) return contentIds.has(value.slice(4)) ? tag : "";
    return /^https:\/\//i.test(value) ? tag : "";
  });
}

export function parseMailComposeContent(input: unknown): MailComposeResult {
  const parsed = composeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "The email content is invalid or too large. Attachments can total up to 3 MB." };
  }
  const { html, inlineImages = [], attachments = [] } = parsed.data;

  let totalBytes = 0;
  const addBytes = (bytes: number): boolean => {
    totalBytes += bytes;
    return totalBytes <= MAIL_ATTACHMENT_LIMITS.maxTotalBytes;
  };
  const tooLarge = "Images and attachments can total up to 3 MB per email.";

  const images: GmailInlineImage[] = [];
  for (const image of inlineImages) {
    if (!IMAGE_TYPES.has(image.mediaType)) return { ok: false, error: `${image.name} must be a PNG, JPEG, GIF or WebP image.` };
    const content = decodeBase64(image.data);
    if (!content || !hasExpectedImageSignature(content, image.mediaType)) {
      return { ok: false, error: `${image.name} is not a valid image.` };
    }
    if (!addBytes(content.length)) return { ok: false, error: tooLarge };
    images.push({ contentId: image.contentId, filename: image.name, mimeType: image.mediaType, content });
  }

  const files: GmailFileAttachment[] = [];
  for (const file of attachments) {
    if (/[\r\n\0]/.test(file.name)) return { ok: false, error: "An attachment has an invalid filename." };
    if (BLOCKED_EXTENSIONS.has(extensionOf(file.name))) {
      return { ok: false, error: `${file.name} can't be attached: Gmail blocks .${extensionOf(file.name)} files.` };
    }
    const content = decodeBase64(file.data);
    if (!content) return { ok: false, error: `${file.name} could not be read.` };
    if (!addBytes(content.length)) return { ok: false, error: tooLarge };
    files.push({
      filename: file.name,
      mimeType: MIME_TYPE_RE.test(file.mediaType) ? file.mediaType : "application/octet-stream",
      content,
    });
  }

  const contentIds = new Set(images.map((image) => image.contentId));
  // Classes mean nothing to Gmail, so the editor's table and list look is written inline.
  // Fonts are stripped first: the whole body is Verdana, Normal (see formatGmailDraftHtml).
  // Editor paragraphs are single lines, sent as Gmail's own line <div>s (see editorParagraphsToGmailLines).
  // Report blocks the editor kept as loaded (see preserved-html.ts) keep their own layout.
  const safe = restrictImages(sanitizeEmailHtml(html), contentIds).replace(/\sclass\s*=\s*("[^"]*"|'[^']*')/gi, "");
  const cleaned = mapOutsidePreservedHtml(safe, (segment) =>
    editorParagraphsToGmailLines(inlineEmailListStyles(inlineEmailTableStyles(stripEmailFonts(segment)))),
  ).trim();
  // Only send the inline images the body still shows.
  const usedImages = images.filter((image) => cleaned.includes(`cid:${image.contentId}`));
  if (!visibleText(cleaned) && usedImages.length === 0) return { ok: false, error: "The email body is empty." };

  return { ok: true, value: { html: cleaned, inlineImages: usedImages, attachments: files } };
}
