import { isAutomatedLocalPart, isAutomatedMessage } from "./automated-senders";
import type { MailContact } from "./contacts-shared";

/**
 * Builds the recipient autocomplete list from the user's own Gmail (server
 * only; see /api/mail/contacts). Deterministic: same messages in, same list
 * out. Rules (documented in docs/mail.md):
 *  - Sent mail: everyone you emailed (To, Cc) counts.
 *  - Received mail: only the sender (From) counts, and only once they have
 *    emailed you more than once (MIN_RECEIVED_EMAILS). Marketing and
 *    automated email never counts: Gmail's Promotions / Social / Updates /
 *    Forums tabs and Spam, bulk or auto headers (List-Unsubscribe,
 *    Precedence, ...), a no-reply style sender, or spam signs (see
 *    looksLikeSpamSender, isSpamLikeMessage).
 *  - Account and marketing mailboxes (no-reply, notifications, billing,
 *    accounts, receipts, newsletter, ...) are never suggested, whatever the
 *    email. Shared inboxes (hello@, info@, team@, support@, ...) are only
 *    suggested when you have emailed them yourself. Your own addresses are
 *    never suggested.
 *  - People you emailed rank above people who only emailed you; then more
 *    emails first; then the most recent; then alphabetical.
 */

export interface ContactSourceMessage {
  /** True for an email you sent (Gmail SENT label). */
  sent: boolean;
  from: string;
  to: string;
  cc: string;
  labelIds: string[];
  autoSubmitted?: string;
  precedence?: string;
  listId?: string;
  listUnsubscribe?: string;
}

/** Gmail tabs that hold marketing and account mail rather than conversations. */
const NON_PERSONAL_CATEGORIES = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "SPAM", "TRASH"]);

/** Account/marketing mailboxes that are not a person, on top of the no-reply list. */
const ACCOUNT_LOCAL_PART_RE =
  /^(?:accounts?|billing|invoices?|receipts?|statements?|newsletters?|marketing|promo(?:tions)?|news|digest|updates?|security|verify|verification|confirm(?:ation)?|subscriptions?|unsubscribe|reply|donotreply|automated|system|daemon|calendar-notification|drive-shares-dm-noreply)(?:[._+-].*)?$/i;

/**
 * Shared inboxes rather than a person. Left out unless you emailed them
 * yourself (then you chose that address, so it stays suggestible).
 */
const SHARED_INBOX_LOCAL_PART_RE =
  /^(?:hello|hi|hey|info|information|team|support|help|helpdesk|contact|contactus|enquir(?:y|ies)|inquir(?:y|ies)|sales|admin|office|mail|general|customerservice|customercare|care|service|feedback|events|careers|jobs|press|media)$/i;

/** Sending-service subdomains used for bulk mail ("news.brand.com", "em.shop.com"). */
const BULK_SUBDOMAIN_RE =
  /^(?:e|em|email|emails|mail|mailer|mailing|mg|mkt|mktg|news|newsletters?|marketing|promo|bounce|bounces|send|sendgrid|sg|mc|campaigns?|offers|deals|info|engage|crm|hs|t)\./i;

/** A bulk-looking first label only counts on a subdomain ("news.brand.com", not "news.com"). */
const BULK_SUBDOMAIN_NEEDS_LABELS = 3;

/**
 * True when an address looks generated or sent by a bulk mailer rather than
 * typed by a person: long digit runs or tracking characters in the mailbox
 * name, very long mailbox names, or a bulk-mail subdomain. Deterministic.
 */
export function looksLikeSpamSender(email: string): boolean {
  const [local = "", domain = ""] = email.split("@");
  if (/\d{5,}/.test(local) || /[=#$!]/.test(local) || local.length > 40) return true;
  // Hex-like tracking ids: 12+ letters/digits with no vowels at all ("x7fk3q9z2wbt").
  if (/^[^aeiou._+-]{12,}$/i.test(local) && /\d/.test(local)) return true;
  if (BULK_SUBDOMAIN_RE.test(domain) && domain.split(".").length >= BULK_SUBDOMAIN_NEEDS_LABELS) {
    // "mail.com.au"-style country suffixes aside, the rest must still be a domain.
    const rest = domain.split(".").slice(1);
    if (!(rest.length === 2 && /^(?:com|net|org|co|gov|edu)$/.test(rest[0] ?? ""))) return true;
  }
  return false;
}

/**
 * Received mail with spam signs beyond Gmail's own Spam folder: not addressed
 * to anyone (no To/Cc, or "undisclosed recipients"), so it was sent in bulk.
 */
export function isSpamLikeMessage(message: Pick<ContactSourceMessage, "to" | "cc">): boolean {
  const recipients = `${message.to} ${message.cc}`.trim();
  return recipients === "" || /undisclosed[\s-]*recipients/i.test(recipients);
}

const EMAIL_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export const MAX_CONTACTS = 500;

/** Splits an address header on commas outside quotes and angle brackets. */
function splitAddressHeader(header: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if ((ch === "," || ch === ";") && !quoted && !angle) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** `Jo Smith <jo@x.com>, "Lee, Sam" <sam@y.com>, kim@z.com` → people with names. */
export function parseAddressList(header: string | null | undefined): MailContact[] {
  if (!header) return [];
  const out: MailContact[] = [];
  for (const part of splitAddressHeader(header)) {
    const angled = part.match(/^(.*)<\s*([^<>\s]+)\s*>\s*$/);
    const email = (angled ? angled[2] : part).trim().toLowerCase().replace(/^mailto:/, "");
    if (!EMAIL_RE.test(email) || email.length > 254) continue;
    let name = angled ? (angled[1] ?? "").trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim() : "";
    if (name.toLowerCase() === email || name.includes("@")) name = "";
    out.push({ email, name: name.slice(0, 120) });
  }
  return out;
}

/** A shared inbox (hello@, info@, team@, ...): suggested only if you emailed it. */
export function isSharedInboxAddress(email: string): boolean {
  return SHARED_INBOX_LOCAL_PART_RE.test(email.split("@")[0] ?? "");
}

/** Received mail whose sender should never be learned (marketing, automated or spam-like). */
function isUntrustedReceived(message: ContactSourceMessage, sender: MailContact): boolean {
  return isMarketingOrAutomated(message) || isSpamLikeMessage(message) || isSharedInboxAddress(sender.email) || looksLikeSpamSender(sender.email);
}

/** Someone who only emailed you is suggested once they have emailed you this many times. */
export const MIN_RECEIVED_EMAILS = 2;

/** True for account / marketing / no-reply mailboxes that should never be suggested. */
export function isNonPersonalAddress(email: string): boolean {
  const local = email.split("@")[0] ?? "";
  return isAutomatedLocalPart(email) || ACCOUNT_LOCAL_PART_RE.test(local);
}

function isMarketingOrAutomated(message: ContactSourceMessage): boolean {
  if (message.labelIds.some((label) => NON_PERSONAL_CATEGORIES.has(label))) return true;
  return isAutomatedMessage(message);
}

interface Tally {
  contact: MailContact;
  sentCount: number;
  receivedCount: number;
  /** Index of the newest message the person was on (messages are newest first). */
  firstSeen: number;
}

/**
 * Ranked contacts from `messages`, which must be ordered newest first (Gmail
 * list order). `ownAddresses` are the connected mailbox and the user's login.
 */
export function buildMailContacts(
  messages: readonly ContactSourceMessage[],
  ownAddresses: readonly string[],
  limit = MAX_CONTACTS,
): MailContact[] {
  const own = new Set(ownAddresses.map((address) => address.trim().toLowerCase()).filter(Boolean));
  const tallies = new Map<string, Tally>();
  const count = (person: MailContact, sent: boolean, index: number) => {
    const tally = tallies.get(person.email);
    if (!tally) {
      tallies.set(person.email, { contact: { ...person }, sentCount: sent ? 1 : 0, receivedCount: sent ? 0 : 1, firstSeen: index });
      return;
    }
    if (sent) tally.sentCount++;
    else tally.receivedCount++;
    // Newest first, so the first name seen is the most recent; fill a gap only.
    if (!tally.contact.name && person.name) tally.contact.name = person.name;
  };
  messages.forEach((message, index) => {
    if (message.labelIds.includes("SPAM") || message.labelIds.includes("TRASH")) return;
    const sent = message.sent || message.labelIds.includes("SENT");
    if (sent) {
      const seenHere = new Set<string>();
      for (const person of [...parseAddressList(message.to), ...parseAddressList(message.cc)]) {
        if (own.has(person.email) || seenHere.has(person.email) || isNonPersonalAddress(person.email)) continue;
        seenHere.add(person.email);
        count(person, true, index);
      }
      return;
    }
    const sender = parseAddressList(message.from)[0];
    if (!sender || own.has(sender.email) || isNonPersonalAddress(sender.email) || isUntrustedReceived(message, sender)) return;
    count(sender, false, index);
  });
  return [...tallies.values()]
    .filter((tally) => tally.sentCount > 0 || tally.receivedCount >= MIN_RECEIVED_EMAILS)
    .sort(
      (a, b) =>
        Number(b.sentCount > 0) - Number(a.sentCount > 0) ||
        b.sentCount * 3 + b.receivedCount - (a.sentCount * 3 + a.receivedCount) ||
        a.firstSeen - b.firstSeen ||
        a.contact.email.localeCompare(b.contact.email),
    )
    .slice(0, limit)
    .map((tally) => tally.contact);
}

/** Inbox search suggests a sender once they have emailed you this many times. */
export const FREQUENT_SENDER_MIN_EMAILS = MIN_RECEIVED_EMAILS;
export const MAX_FREQUENT_SENDERS = 300;

/**
 * People who emailed you at least `minEmails` times (counted on the From line
 * of received mail only), for the Inbox search suggestions. The same people
 * are left out as for buildMailContacts: marketing/automated/spam-like mail,
 * account mailboxes, shared inboxes and your own addresses. Most emails first, then the most recent,
 * then alphabetical. `messages` must be newest first.
 */
export function buildFrequentSenders(
  messages: readonly ContactSourceMessage[],
  ownAddresses: readonly string[],
  minEmails = FREQUENT_SENDER_MIN_EMAILS,
  limit = MAX_FREQUENT_SENDERS,
): MailContact[] {
  const own = new Set(ownAddresses.map((address) => address.trim().toLowerCase()).filter(Boolean));
  const tallies = new Map<string, { contact: MailContact; count: number; firstSeen: number }>();
  messages.forEach((message, index) => {
    if (message.labelIds.includes("SPAM") || message.labelIds.includes("TRASH")) return;
    if (message.sent || message.labelIds.includes("SENT")) return;
    const sender = parseAddressList(message.from)[0];
    if (!sender || own.has(sender.email) || isNonPersonalAddress(sender.email) || isUntrustedReceived(message, sender)) return;
    const tally = tallies.get(sender.email);
    if (!tally) {
      tallies.set(sender.email, { contact: { ...sender }, count: 1, firstSeen: index });
      return;
    }
    tally.count++;
    if (!tally.contact.name && sender.name) tally.contact.name = sender.name;
  });
  return [...tallies.values()]
    .filter((tally) => tally.count >= minEmails)
    .sort((a, b) => b.count - a.count || a.firstSeen - b.firstSeen || a.contact.email.localeCompare(b.contact.email))
    .slice(0, limit)
    .map((tally) => tally.contact);
}
