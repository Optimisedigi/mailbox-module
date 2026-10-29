import { MAIL_INLINE_CID_DOMAIN } from "./compose-limits";

/**
 * Browser-side prep of the Mail editor's HTML before it is sent or saved.
 * Pasted images live in the editor as data: URLs; email clients (Gmail
 * included) don't show data: images, so each becomes a cid: reference with
 * its bytes sent alongside as an inline image part.
 */

export interface InlineImagePayload {
  contentId: string;
  name: string;
  mediaType: string;
  /** Raw base64, no data: prefix. */
  data: string;
}

const DATA_IMAGE_RE = /src="data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)"/g;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export function extractInlineImages(html: string): { html: string; inlineImages: InlineImagePayload[] } {
  const inlineImages: InlineImagePayload[] = [];
  const byData = new Map<string, string>();
  const out = html.replace(DATA_IMAGE_RE, (_match, mediaType: string, data: string) => {
    let contentId = byData.get(data);
    if (!contentId) {
      const index = inlineImages.length + 1;
      contentId = `image${index}@${MAIL_INLINE_CID_DOMAIN}`;
      byData.set(data, contentId);
      inlineImages.push({ contentId, name: `image-${index}.${EXTENSIONS[mediaType] ?? "png"}`, mediaType, data });
    }
    return `src="cid:${contentId}"`;
  });
  return { html: out, inlineImages };
}

/** Decoded size of a base64 string, without decoding it. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}
