/**
 * Recipient autocomplete for the compose window (To, Cc, Bcc). Client-safe:
 * no server imports. The contact list itself is built on the server from the
 * user's own sent and received mail (see contacts.ts); this file only matches
 * what is typed against it and edits the field text.
 */

export interface MailContact {
  /** Lowercased email address; always shown so the person's real address is visible. */
  email: string;
  /** Display name from the email headers, or "" when none was given. */
  name: string;
}

/** Suggestions only start once this many letters are typed. */
export const CONTACT_MIN_QUERY = 2;
export const CONTACT_MAX_SUGGESTIONS = 6;

/** The recipient being typed: the comma/semicolon separated part around the caret. */
export interface RecipientToken {
  start: number;
  end: number;
  text: string;
}

export function recipientTokenAt(value: string, caret: number): RecipientToken {
  const at = Math.max(0, Math.min(caret, value.length));
  const before = value.slice(0, at);
  const start = Math.max(before.lastIndexOf(","), before.lastIndexOf(";")) + 1;
  const rest = value.slice(at);
  const nextSep = rest.search(/[,;]/);
  const end = nextSep === -1 ? value.length : at + nextSep;
  return { start, end, text: value.slice(start, end).trim() };
}

const ADDRESS_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * The address in the recipient entry under the caret, keeping the casing it
 * was typed with. A display name in that same entry still counts: double-clicking
 * "Frank <frank@x.com>" copies the address. Text that is not an address yet
 * does not.
 */
export function emailAtCaret(value: string, caret: number): { email: string; start: number; end: number } | null {
  const token = recipientTokenAt(value, caret);
  const raw = value.slice(token.start, token.end);
  const match = ADDRESS_IN_TEXT.exec(raw);
  if (!match) return null;
  const start = token.start + match.index;
  return { email: match[0], start, end: start + match[0].length };
}

/** Display name from a From/To header entry, or the raw text when it has no name. */
export function senderName(from: string): string {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>/);
  return (match?.[1] || from.replace(/<.*>/, "")).trim() || from;
}

/** Address inside angle brackets, or the whole entry when it is a bare address. */
export function senderAddress(from: string): string {
  return from.match(/<([^>]+)>/)?.[1] ?? from.trim();
}

/** The address written in one recipient entry, in the casing it was written, or null. */
export function addressInEntry(entry: string): string | null {
  return ADDRESS_IN_TEXT.exec(entry)?.[0] ?? null;
}

/** Comma-separated header entries, keeping commas that sit inside quotes. */
export function splitAddressList(value: string): string[] {
  return value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
}

/** Lowercased addresses already in a recipient field. */
export function addressesIn(value: string): Set<string> {
  return new Set((value.match(new RegExp(ADDRESS_IN_TEXT.source, "g")) ?? []).map((a) => a.toLowerCase()));
}

/**
 * Addresses in a recipient field that are finished: every entry followed by a
 * comma or semicolon (picking a suggestion adds one). The entry after the
 * last separator may still be being typed, so it is left out.
 */
export function finishedRecipientAddresses(value: string): string[] {
  const entries = value.split(/[,;]/);
  entries.pop();
  return entries.flatMap((entry) => [...addressesIn(entry)]);
}

/**
 * Contacts matching what is typed, in the server's ranking (people you email
 * most first). A contact matches when the text starts its address, the part
 * after the @, its name, or any word of its name; text starting with "@"
 * ("@client.c") matches the part after the @. Fewer than CONTACT_MIN_QUERY
 * letters, or text that is already a full address, gives no suggestions.
 * Addresses already in the field are left out.
 */
export function matchMailContacts(
  contacts: readonly MailContact[],
  typed: string,
  exclude: ReadonlySet<string> = new Set(),
  limit = CONTACT_MAX_SUGGESTIONS,
): MailContact[] {
  const query = typed.trim().toLowerCase().replace(/^["'<]+/, "");
  if (query.length < CONTACT_MIN_QUERY) return [];
  const out: MailContact[] = [];
  for (const contact of contacts) {
    if (exclude.has(contact.email)) continue;
    if (contact.email === query) return [];
    const domain = contact.email.split("@")[1] ?? "";
    const name = contact.name.toLowerCase();
    if (query.startsWith("@")) {
      if (domain.startsWith(query.slice(1))) out.push(contact);
      if (out.length >= limit) break;
      continue;
    }
    const hit =
      contact.email.startsWith(query) ||
      domain.startsWith(query) ||
      name.startsWith(query) ||
      name.split(/[\s.,'"()-]+/).some((word) => word.startsWith(query));
    if (hit) out.push(contact);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Field text with the recipient being typed replaced by `email`, followed by
 * ", " so the next address can be typed straight away, plus the new caret.
 */
export function applyRecipient(value: string, token: RecipientToken, email: string): { value: string; caret: number } {
  const head = value.slice(0, token.start).replace(/\s*$/, "");
  const tail = value.slice(token.end).replace(/^[\s,;]*/, "");
  const prefix = head ? `${head} ` : "";
  const inserted = `${prefix}${email}, `;
  return { value: inserted + tail, caret: inserted.length };
}

/**
 * Everyone the Mail search box can suggest: regular senders first, then the
 * rest of the people in your sent and received mail, each address once.
 */
export function suggestionPeople(people: { senders: readonly MailContact[]; contacts: readonly MailContact[] }): MailContact[] {
  const seen = new Set<string>();
  const out: MailContact[] = [];
  for (const contact of [...people.senders, ...people.contacts]) {
    if (seen.has(contact.email)) continue;
    seen.add(contact.email);
    out.push(contact);
  }
  return out;
}

/** Most people one Inbox search adds as extra `from:` matches (see inbox-search.ts). */
export const SEARCH_SENDER_LIMIT = 10;

/**
 * Addresses of the people a typed Inbox search means: frequent senders first,
 * then anyone else in your mail, matched as matchMailContacts does (start of
 * the address, the domain, the name or a word of it). Gmail only matches whole
 * words, so these let "rebe" find mail from rebecca@acmeclient.com.au.
 */
export function searchSenderAddresses(
  senders: readonly MailContact[],
  contacts: readonly MailContact[],
  typed: string,
): string[] {
  const out: string[] = [];
  for (const contact of [...matchMailContacts(senders, typed, new Set(), SEARCH_SENDER_LIMIT), ...matchMailContacts(contacts, typed, new Set(), SEARCH_SENDER_LIMIT)]) {
    if (out.includes(contact.email)) continue;
    out.push(contact.email);
    if (out.length >= SEARCH_SENDER_LIMIT) break;
  }
  return out;
}

/** Most people the "@" tag list in the email body shows. */
export const MENTION_MAX_SUGGESTIONS = 6;

/**
 * People to suggest for an "@" tag in the email body, in the server's ranking.
 * From the first letter: a contact matches when the text starts its address,
 * its name or any word of its name ("@jo sm" finds "John Smith").
 */
export function matchMentionContacts(
  contacts: readonly MailContact[],
  typed: string,
  limit = MENTION_MAX_SUGGESTIONS,
): MailContact[] {
  const query = typed.trim().toLowerCase().replace(/\s+/g, " ");
  if (!query) return [];
  const out: MailContact[] = [];
  for (const contact of contacts) {
    const name = contact.name.toLowerCase();
    const hit =
      contact.email.startsWith(query) ||
      name.startsWith(query) ||
      name.split(/[\s.,'"()-]+/).some((word) => word.startsWith(query));
    if (hit) out.push(contact);
    if (out.length >= limit) break;
  }
  return out;
}

/** The name a tag shows after "@": the contact's name, or the part of the address before the @. */
export function mentionLabel(contact: MailContact): string {
  return contact.name.trim() || contact.email.split("@")[0] || contact.email;
}
