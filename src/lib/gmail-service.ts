import { google } from "googleapis";
import { createGoogleOAuth2Client } from "@/lib/google-oauth-client";
import { createGmailOAuthClient, gmailAppForEmail, gmailSignInHint, type GmailOAuthApp } from "@/lib/gmail-oauth-apps";
import { declarationProperty, flattenPreWrapWhitespace, splitDeclarations } from "@/lib/mail/gmail-html";
import { withEditedSignOff } from "@/lib/mail/signature";
import { removeForbiddenDashes } from "@/lib/ai/forbidden-dash-sanitizer";

/**
 * Per-user Gmail OAuth + Drafts/Read service.
 *
 * Scopes:
 *  - gmail.compose  → create drafts and send.
 *  - gmail.readonly → read the inbox, threads and attachments.
 *  - gmail.settings.basic → read the connected account's sendAs signature so
 *                           drafts/replies can include the user's Gmail signature.
 *  - gmail.modify   → archive, mark read/unread, move to Bin.
 *
 * Adding a scope means users reconnect once via /api/gmail/connect; until
 * then Gmail answers 403 insufficientPermissions and Mail shows Reconnect.
 */

// Includes openid + email so we can resolve the connecting user's address.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

function getOAuth2Client() {
  return createGoogleOAuth2Client(process.env.GMAIL_REDIRECT_URI);
}

/**
 * Generate the Google OAuth consent URL for Gmail Drafts access.
 *
 * `state` must be an HMAC-signed payload produced by the connect route — it
 * binds the OAuth flow to (nonce, targetUserId, initiatorUserId) so the
 * callback can verify the round-trip wasn't tampered with (OAuth CSRF /
 * row-rebind mitigation).
 */
export function getGmailOAuthUrl(
  state: string,
  /** `loginHint`: the address being added, pre-filled in Google's sign-in (replaces the app's own hint). */
  options: { selectAccount?: boolean; app?: GmailOAuthApp; loginHint?: string } = {},
): string {
  const app = options.app ?? "main";
  const oauth2Client = createGmailOAuthClient(app);
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    state,
    // Adding another account must let the user pick a different Google login.
    prompt: options.selectAccount ? "select_account consent" : "consent",
    include_granted_scopes: true,
    // Only a hint for Google's account picker; the callback enforces the match.
    ...(options.loginHint ? { login_hint: options.loginHint } : gmailSignInHint(app)),
  });
}

/**
 * Exchange an authorization code for tokens, and resolve the user's email.
 */
export async function exchangeGmailCode(code: string, app: GmailOAuthApp = "main"): Promise<{
  accessToken: string;
  refreshToken: string;
  expiry: string | null;
  email: string;
}> {
  const oauth2Client = createGmailOAuthClient(app);
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.access_token) {
    throw new Error("Gmail OAuth: no access_token returned");
  }
  if (!tokens.refresh_token) {
    // Without a refresh token we can't run scheduled tasks long-term.
    // This happens if the user previously connected and Google didn't
    // re-issue a refresh token. Force re-consent via prompt=consent (already
    // set above) — if it still happens, surface a clear error.
    throw new Error(
      "Gmail OAuth: no refresh_token returned. Revoke previous access at https://myaccount.google.com/permissions and reconnect.",
    );
  }

  oauth2Client.setCredentials(tokens);

  // Resolve the connecting Google account's email address so we can show it
  // in the admin UI and default scheduled-task recipients to it.
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const userinfo = await oauth2.userinfo.get();
  const email = userinfo.data.email;
  if (!email) {
    throw new Error("Gmail OAuth: could not resolve user email from userinfo");
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiry: tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : null,
    email,
  };
}

/**
 * Refresh an expired access token using the stored refresh token.
 */
/** `email` is the account the token belongs to: it picks the Google app that issued it. */
export async function refreshGmailAccessToken(refreshToken: string, email = ""): Promise<{
  accessToken: string;
  expiry: string | null;
}> {
  const oauth2Client = createGmailOAuthClient(gmailAppForEmail(email));
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2Client.refreshAccessToken();
  if (!credentials.access_token) {
    throw new Error("Gmail OAuth: refresh returned no access_token");
  }
  return {
    accessToken: credentials.access_token,
    expiry: credentials.expiry_date
      ? new Date(credentials.expiry_date).toISOString()
      : null,
  };
}

/** A file attached to an email (any type; the Mail view validates it first). */
export interface GmailFileAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

/** Image-only attachments. */
export interface GmailDraftAttachment extends GmailFileAttachment {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/** An image shown in the email body, referenced from the HTML as `cid:<contentId>`. */
export interface GmailInlineImage {
  contentId: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}

function safeMimeFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\r\n\0]/g, "")
    .replace(/[\\/]/g, "-")
    .trim()
    .slice(0, 180);
  return cleaned || "image-attachment";
}

const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const CONTENT_ID_RE = /^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9.-]{1,128}$/;

/** MIME header values come from callers; anything unexpected becomes a safe default. */
function safeMimeType(mimeType: string): string {
  return MIME_TYPE_RE.test(mimeType) ? mimeType : "application/octet-stream";
}

function wrapBase64(content: Buffer): string {
  return content.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
}

/**
 * Build an RFC 2822 MIME message and base64url-encode it for Gmail's API.
 */
export function buildMimeMessage(args: {
  to: string;
  cc?: string;
  /** Blind copy: Gmail delivers to these and removes the header from what other recipients get. */
  bcc?: string;
  subject: string;
  htmlBody: string;
  /** RFC 822 Message-ID of the message being replied to, for threading. */
  inReplyTo?: string;
  attachments?: GmailFileAttachment[];
  /** Images embedded in the body (multipart/related), referenced as cid: URLs. */
  inlineImages?: GmailInlineImage[];
}): string {
  const { to, cc, bcc, subject, htmlBody, inReplyTo, attachments = [], inlineImages = [] } = args;
  // Encode subject as RFC 2047 if it contains non-ASCII to keep Gmail happy.
  const isAscii = /^[\x20-\x7E]*$/.test(subject);
  const encodedSubject = isAscii
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;

  const lines = [`To: ${to}`];
  if (cc && cc.trim()) lines.push(`Cc: ${cc.replace(/[\r\n]+/g, " ").trim()}`);
  if (bcc && bcc.trim()) lines.push(`Bcc: ${bcc.replace(/[\r\n]+/g, " ").trim()}`);
  lines.push(`Subject: ${encodedSubject}`, "MIME-Version: 1.0");
  // In-thread replies: setting In-Reply-To / References lets Gmail group the
  // draft into the original conversation alongside threadId on the message.
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`);
  }

  // Base64 in 76-character lines: 7bit allows neither non-ASCII text nor lines over
  // 998 characters, and servers that re-wrap an over-long line change the HTML.
  const htmlPart = [
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(htmlBody, "utf-8")),
  ];
  const newBoundary = () => `----=_Mailbox_${crypto.randomUUID().replaceAll("-", "")}`;

  // Body = the HTML alone, or HTML + its inline images as multipart/related.
  let bodyPart: string[] = htmlPart;
  if (inlineImages.length > 0) {
    const related = newBoundary();
    bodyPart = [`Content-Type: multipart/related; boundary="${related}"`, "", `--${related}`, ...htmlPart];
    inlineImages.forEach((image) => {
      if (!CONTENT_ID_RE.test(image.contentId)) throw new Error("Invalid inline image Content-ID");
      const filename = safeMimeFilename(image.filename);
      bodyPart.push(
        `--${related}`,
        `Content-Type: ${safeMimeType(image.mimeType)}; name="${filename.replace(/"/g, "'")}"`,
        "Content-Transfer-Encoding: base64",
        `Content-ID: <${image.contentId}>`,
        `Content-Disposition: inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "",
        wrapBase64(image.content),
      );
    });
    bodyPart.push(`--${related}--`, "");
  }

  if (attachments.length === 0) {
    lines.push(...bodyPart);
  } else {
    const boundary = newBoundary();
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, "");
    lines.push(`--${boundary}`, ...bodyPart);
    attachments.forEach((attachment) => {
      const filename = safeMimeFilename(attachment.filename);
      const encodedFilename = encodeURIComponent(filename);
      lines.push(
        `--${boundary}`,
        `Content-Type: ${safeMimeType(attachment.mimeType)}; name="${filename.replace(/"/g, "'")}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename*=UTF-8''${encodedFilename}`,
        "",
        wrapBase64(attachment.content),
      );
    });
    lines.push(`--${boundary}--`, "");
  }

  const raw = lines.join("\r\n");
  // Gmail wants base64url (URL-safe, no padding).
  return Buffer.from(raw, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Read the connected Gmail account's primary/default sendAs signature.
 */
export async function getPrimaryGmailSignature(accessToken: string): Promise<string> {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const res = await gmail.users.settings.sendAs.list({ userId: "me" });
  const sendAs = res.data.sendAs ?? [];
  const primary =
    sendAs.find((entry) => entry.isDefault) ??
    sendAs.find((entry) => entry.isPrimary) ??
    sendAs[0];
  return typeof primary?.signature === "string" ? primary.signature.trim() : "";
}

// Gmail's "Normal" size is emitted by its own editor as the CSS keyword `small`.
// Using a fixed 13px looked equivalent on desktop, but iOS Gmail renders text
// subsequently edited in Gmail (`font-size:small`) at a different size.
const GMAIL_DRAFT_FONT_STYLE = "font-family:Verdana,sans-serif;font-size:small;margin:0;padding:0;";
const GMAIL_DRAFT_PARAGRAPH_BREAK = "<br><br>";
const GMAIL_DRAFT_PARAGRAPH_BREAK_MARKER = "%%MAILBOX_GMAIL_PARAGRAPH_BREAK%%";

const TABLE_LAYOUT_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col", "caption"]);
const ANY_TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const STYLE_ATTR_RE = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/i;

/**
 * Gmail's native font for every element outside a table. Tables are left as
 * authored: their cell sizes, fonts and spacing are layout, and rewriting them
 * made Gmail's tables differ from the CMS. Quoted font names ('Open Sans') are
 * handled declaration by declaration instead of by pattern.
 */
function normaliseFontStyles(html: string): string {
  let tableDepth = 0;
  return html.replace(ANY_TAG_RE, (tag: string, closing: string, name: string, attrs: string) => {
    const lower = name.toLowerCase();
    if (lower === "table") {
      if (closing) tableDepth = Math.max(0, tableDepth - 1);
      else if (!/\/\s*$/.test(attrs)) tableDepth++;
      return tag;
    }
    if (closing || tableDepth > 0 || TABLE_LAYOUT_TAGS.has(lower)) return tag;
    const match = attrs.match(STYLE_ATTR_RE);
    if (!match) return tag;
    const style = match[2] ?? match[3] ?? "";
    if (!/font-(?:family|size)\s*:/i.test(style)) return tag;
    const declarations = splitDeclarations(style).map((declaration) => {
      const prop = declarationProperty(declaration);
      if (prop === "font-family") return "font-family:Verdana,sans-serif";
      if (prop === "font-size") return "font-size:small";
      return declaration;
    });
    const quote = match[2] !== undefined ? '"' : "'";
    const next = attrs.replace(STYLE_ATTR_RE, `${match[1]}${quote}${declarations.join(";")};${quote}`);
    return `<${name}${next}>`;
  });
}

/** Paragraphs in a table cell are separated by one line break, with none after the last (as in the CMS editor). */
function normaliseCellParagraphs(html: string): string {
  return html.replace(/(<(td|th)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi, (_m, open: string, _tag: string, inner: string, close: string) => {
    if (!/<p\b/i.test(inner)) return `${open}${inner}${close}`;
    const joined = inner.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_p, content: string) => `${content}${GMAIL_DRAFT_PARAGRAPH_BREAK_MARKER}`);
    const trimmed = joined.replace(new RegExp(`(?:${GMAIL_DRAFT_PARAGRAPH_BREAK_MARKER}\\s*)+$`), "");
    return `${open}${trimmed.replaceAll(GMAIL_DRAFT_PARAGRAPH_BREAK_MARKER, "<br>")}${close}`;
  });
}

function normaliseParagraphBreaks(html: string): string {
  const withEditableBreaks = normaliseCellParagraphs(html).replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, content: string) => {
    return `${content}${GMAIL_DRAFT_PARAGRAPH_BREAK_MARKER}`;
  });

  return withEditableBreaks
    .replace(
      new RegExp(`${GMAIL_DRAFT_PARAGRAPH_BREAK_MARKER}(?=\\s*(?:</div>|$))`, "g"),
      "",
    )
    // A list starts on its own line and brings its own small gap (its margin), so the
    // paragraph before it gets no blank line; otherwise the gap above is bigger than below.
    .replace(new RegExp(`${GMAIL_DRAFT_PARAGRAPH_BREAK_MARKER}(?=\\s*<(?:ul|ol)\\b)`, "gi"), "")
    .replaceAll(GMAIL_DRAFT_PARAGRAPH_BREAK_MARKER, GMAIL_DRAFT_PARAGRAPH_BREAK);
}

export function formatGmailDraftHtml(htmlBody: string): string {
  // No pre-wrap text in what we send: Outlook and some servers re-wrap long HTML
  // lines, and inside pre-wrap those breaks show up mid-sentence in replies.
  const trimmed = flattenPreWrapWhitespace(htmlBody.trim());
  if (!trimmed) return `<div style="${GMAIL_DRAFT_FONT_STYLE}"></div>`;
  if (trimmed.includes("data-mailbox-gmail-draft-font")) return trimmed;
  const normalised = normaliseFontStyles(normaliseParagraphBreaks(trimmed));
  return `<div data-mailbox-gmail-draft-font="true" style="${GMAIL_DRAFT_FONT_STYLE}">${normalised}</div>`;
}

/** The Gmail signature, with the compose window's edited sign-off when one was sent. */
function signatureFor(signatureHtml: string, signOff: string | undefined): string {
  return signOff === undefined ? signatureHtml : withEditedSignOff(signatureHtml, removeForbiddenDashes(signOff));
}

export function appendGmailSignature(htmlBody: string, signatureHtml: string): string {
  const signature = signatureHtml.trim();
  if (!signature) return htmlBody;
  if (htmlBody.includes(signature)) return htmlBody;

  // Exactly one blank line before the signature, as Gmail does: empty lines left at
  // the end of the body (easy to miss in the compose window) would add to it.
  const body = trimTrailingEmptyLines(htmlBody);
  // A closed <p> becomes a line plus a blank line in formatGmailDraftHtml; after any
  // other block (line div, list, table) one <br> is the blank line; after inline text it takes two.
  const separator = /<\/p>$/i.test(body) ? "" : /<\/(?:div|ul|ol|table|blockquote)>$/i.test(body) ? "<br>" : "<br><br>";
  return `${body}${separator}${signature}`;
}

const TRAILING_EMPTY_LINE_RE = /(?:\s|<br\s*\/?>|<(div|p)\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>)+$/i;

function trimTrailingEmptyLines(html: string): string {
  return html.replace(TRAILING_EMPTY_LINE_RE, "");
}

/**
 * Create a Gmail draft using the given access token. Returns the draft id
 * and the underlying message id. Appends the connected Gmail signature by default.
 */
export async function createGmailDraft(
  accessToken: string,
  args: {
    to: string;
    subject: string;
    htmlBody: string;
    cc?: string;
    bcc?: string;
    /** Edited sign-off from the compose window: replaces the signature's own "Thanks, Pat" lines. */
    signOff?: string;
    /** Gmail thread id to attach the draft to (in-thread reply). */
    threadId?: string;
    /** RFC 822 Message-ID of the message being replied to. */
    inReplyTo?: string;
    /** Append the connected Gmail account's configured signature. Defaults to true. */
    appendSignature?: boolean;
    /** Validated files to attach to the draft. */
    attachments?: GmailFileAttachment[];
    /** Validated images embedded in the body as cid: references. */
    inlineImages?: GmailInlineImage[];
    /** Replace this existing draft instead of creating a new one. */
    draftId?: string;
  },
): Promise<{ draftId: string; messageId: string }> {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const htmlBodyWithoutForbiddenDashes = removeForbiddenDashes(args.htmlBody);
  const signedHtmlBody = args.appendSignature === false
    ? htmlBodyWithoutForbiddenDashes
    : appendGmailSignature(htmlBodyWithoutForbiddenDashes, signatureFor(await getPrimaryGmailSignature(accessToken), args.signOff));
  const htmlBody = formatGmailDraftHtml(signedHtmlBody);
  const raw = buildMimeMessage({
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: removeForbiddenDashes(args.subject),
    htmlBody,
    inReplyTo: args.inReplyTo,
    attachments: args.attachments,
    inlineImages: args.inlineImages,
  });

  const message = args.threadId ? { raw, threadId: args.threadId } : { raw };
  const res = args.draftId
    ? await gmail.users.drafts.update({
        userId: "me",
        id: args.draftId,
        requestBody: { id: args.draftId, message },
      })
    : await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message },
      });

  const draftId = res.data.id;
  const messageId = res.data.message?.id;
  if (!draftId || !messageId) {
    throw new Error("Gmail draft creation returned no id");
  }
  return { draftId, messageId };
}

/**
 * Send an email immediately as the connected user. Only called from the Mail
 * view's Send button route (/api/mail/send) after an explicit user click; the
 * model never calls this. Appends the Gmail signature like drafts do.
 */
export async function sendGmailMessage(
  accessToken: string,
  args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    htmlBody: string;
    /** Edited sign-off from the compose window (see createGmailDraft). */
    signOff?: string;
    threadId?: string;
    inReplyTo?: string;
    appendSignature?: boolean;
    attachments?: GmailFileAttachment[];
    inlineImages?: GmailInlineImage[];
  },
): Promise<{ messageId: string; threadId: string }> {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const body = removeForbiddenDashes(args.htmlBody);
  const signed = args.appendSignature === false
    ? body
    : appendGmailSignature(body, signatureFor(await getPrimaryGmailSignature(accessToken), args.signOff));
  const raw = buildMimeMessage({
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: removeForbiddenDashes(args.subject),
    htmlBody: formatGmailDraftHtml(signed),
    inReplyTo: args.inReplyTo,
    attachments: args.attachments,
    inlineImages: args.inlineImages,
  });
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: args.threadId ? { raw, threadId: args.threadId } : { raw },
  });
  if (!res.data.id) throw new Error("Gmail send returned no id");
  return { messageId: res.data.id, threadId: res.data.threadId ?? args.threadId ?? "" };
}
