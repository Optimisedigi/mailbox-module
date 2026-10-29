/**
 * Size limits for Mail compose (shared by the browser and the server).
 *
 * Images and attachments travel inside the JSON request as base64, which is
 * a third bigger than the files. Vercel caps request bodies at 4.5 MB, so the
 * files themselves are held to 3 MB in total per email.
 */
export const MAIL_ATTACHMENT_LIMITS = {
  maxTotalBytes: 3 * 1024 * 1024,
  /** Base64 length of a single 3 MB file. */
  maxBase64Length: Math.ceil((3 * 1024 * 1024) / 3) * 4,
  maxAttachments: 10,
  maxInlineImages: 10,
  /** Body HTML once images are cid: references (no image data inside). */
  maxHtmlLength: 500_000,
  /** Longest edge for pasted images; larger ones are shrunk in the browser. */
  maxImageEdge: 1600,
} as const;

export const MAIL_INLINE_CID_DOMAIN = "mailbox.local";
