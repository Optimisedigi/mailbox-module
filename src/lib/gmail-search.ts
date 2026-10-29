import { google, type gmail_v1 } from "googleapis";

/**
 * Read one Gmail message into a plain shape (headers, text body, ids).
 * Needs the `gmail.readonly` scope.
 */

export interface GmailMessageBody {
  messageId: string;
  threadId: string;
  /** RFC 822 Message-ID header, used as In-Reply-To when drafting a reply. */
  rfcMessageId: string;
  subject: string;
  from: string;
  to: string;
  date: string; // ISO 8601 (best-effort)
  body: string; // plain text
}

function gmailClient(accessToken: string): gmail_v1.Gmail {
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  const found = headers.find((h) => (h.name ?? "").toLowerCase() === lower);
  return found?.value ?? "";
}

function parseDateHeader(value: string): string {
  if (!value) return "";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value; // fall back to raw header
  return new Date(t).toISOString();
}

/**
 * Recursively walk message parts collecting bodies of the requested mime
 * type. Returns the concatenated decoded text.
 */
function collectBodyByMime(
  part: gmail_v1.Schema$MessagePart | undefined,
  mime: string,
): string {
  if (!part) return "";
  const out: string[] = [];

  const walk = (p: gmail_v1.Schema$MessagePart) => {
    if (p.mimeType === mime && p.body?.data) {
      const decoded = Buffer.from(p.body.data, "base64url").toString("utf-8");
      out.push(decoded);
    }
    if (p.parts) p.parts.forEach(walk);
  };
  walk(part);
  return out.join("\n");
}

/**
 * Naive HTML→text fallback for emails that lack a text/plain part. Removes
 * scripts/styles, replaces block tags with newlines, strips remaining tags,
 * decodes the most common entities, and collapses whitespace.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>(\s*)/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Fetch the full message body for one Gmail message id. Prefers the
 * text/plain part; falls back to a stripped text/html. Attachments are
 * ignored.
 */
function decodeMessageBody(msg: gmail_v1.Schema$Message): string {
  let body = collectBodyByMime(msg.payload, "text/plain").trim();
  if (!body) {
    const html = collectBodyByMime(msg.payload, "text/html");
    if (html) body = htmlToText(html);
  }
  // Last-ditch: top-level body when there are no parts.
  if (!body && msg.payload?.body?.data) {
    body = Buffer.from(msg.payload.body.data, "base64url").toString("utf-8");
  }
  return body;
}

function messageToBody(msg: gmail_v1.Schema$Message, fallbackMessageId: string): GmailMessageBody {
  const headers = msg.payload?.headers;
  return {
    messageId: msg.id ?? fallbackMessageId,
    threadId: msg.threadId ?? "",
    rfcMessageId: getHeader(headers, "Message-ID"),
    subject: getHeader(headers, "Subject"),
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    date: parseDateHeader(getHeader(headers, "Date")),
    body: decodeMessageBody(msg),
  };
}

export interface GmailFullMessage extends GmailMessageBody {
  cc: string;
  /** Only present on the sender's own copies (sent mail, drafts). */
  bcc: string;
  /** Raw text/html part, for display in the Mail reading pane only. */
  bodyHtml: string;
  snippet: string;
  labelIds: string[];
}

/** Decode a Gmail API message (format=full) including Cc and labels. Used by the Mail view. */
export function parseGmailFullMessage(msg: gmail_v1.Schema$Message): GmailFullMessage {
  return {
    ...messageToBody(msg, msg.id ?? ""),
    cc: getHeader(msg.payload?.headers, "Cc"),
    bcc: getHeader(msg.payload?.headers, "Bcc"),
    bodyHtml: collectBodyByMime(msg.payload, "text/html"),
    snippet: msg.snippet ?? "",
    labelIds: msg.labelIds ?? [],
  };
}

/** Read one header from a Gmail API message part list. */
export function readGmailHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return getHeader(headers, name);
}

export async function fetchMessageBody(
  accessToken: string,
  messageId: string,
): Promise<GmailMessageBody> {
  const gmail = gmailClient(accessToken);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });
  return messageToBody(res.data, messageId);
}
