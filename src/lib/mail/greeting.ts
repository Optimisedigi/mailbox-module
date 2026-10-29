/**
 * Every AI-written email body starts with "Hi" (Gmail-house style), followed
 * by the recipient's first name when it is known. The prompt asks for this;
 * these helpers make it true even when the model opens differently.
 */

import { addressInEntry, splitAddressList, type MailContact } from "./contacts-shared";

const OTHER_GREETING_RE = /^(?:hello|hey|hiya|dear|greetings|g'?day|good\s+(?:morning|afternoon|evening|day))\b/i;
const HI_RE = /^hi\b/i;
// A greeting line with no name ("Hi,", "Hello there!"), which gets the name when we know it.
const NAMELESS_GREETING_RE = /^(?:hi|hello|hey|hiya|dear|greetings|g'?day|good\s+(?:morning|afternoon|evening|day))(?:\s+there)?[ \t]*[,!.]?[ \t]*(?=\r?\n|$)/i;
const FIRST_NAME_RE = /^[\p{L}][\p{L}'-]*$/u;

function firstName(display: string): string {
  const clean = display.replace(/["']/g, "").trim();
  if (!clean || clean.includes("@")) return "";
  const word = clean.split(/\s+/)[0] ?? "";
  return word.length <= 40 && FIRST_NAME_RE.test(word) ? word : "";
}

/**
 * First name from a From/To header such as `"Sam Lee" <sam@x.com>`. Returns
 * '' when there is no display name (a bare address says nothing reliable).
 */
export function greetingName(header: string): string {
  const first = header.split(",")[0] ?? "";
  const angle = first.indexOf("<");
  if (angle < 0) return "";
  return firstName(first.slice(0, angle));
}

/**
 * First name to greet the one To recipient of an email being written: the
 * display name typed with the address, else the name the user's Gmail
 * contacts have for that address. '' for several recipients or no name.
 */
export function recipientGreetingName(to: string, contacts: readonly MailContact[] | null): string {
  const entries = splitAddressList(to).map((entry) => entry.trim()).filter(Boolean);
  const [entry] = entries;
  if (!entry || entries.length !== 1) return "";
  const typed = greetingName(entry);
  if (typed) return typed;
  const address = addressInEntry(entry)?.toLowerCase();
  const contact = address ? contacts?.find((c) => c.email === address) : undefined;
  return contact ? firstName(contact.name) : "";
}

/** A greeting name sent by the browser, kept only when it looks like a first name. */
export function cleanGreetingName(raw: unknown): string {
  return typeof raw === "string" ? firstName(raw) : "";
}

/** Make the body open with "Hi": rewrite another greeting word, or add "Hi <name>," when there is none. */
export function ensureHiGreeting(text: string, name: string): string {
  const body = text.replace(/^\s+/, "");
  if (!body) return text;
  if (name && NAMELESS_GREETING_RE.test(body)) return body.replace(NAMELESS_GREETING_RE, `Hi ${name},`);
  if (HI_RE.test(body)) return body;
  if (OTHER_GREETING_RE.test(body)) return body.replace(OTHER_GREETING_RE, "Hi");
  return `${name ? `Hi ${name},` : "Hi,"}\n\n${body}`;
}

/** Subject line the model suggested: one line, no quotes or "Subject:" prefix, capped. */
export function cleanSuggestedSubject(raw: string | undefined): string {
  return (raw ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/^\s*subject\s*:\s*/i, "")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim()
    .slice(0, 200);
}
