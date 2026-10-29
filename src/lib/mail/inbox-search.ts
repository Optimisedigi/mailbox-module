/**
 * Gmail search for the Mail Inbox search box. Client-safe: string work only.
 *
 * Gmail's free-text search uses its word index (subject, body), which does
 * not reliably cover the sender's address, so typing "jo@client.com" or
 * "client.com" would miss that sender's mail. Plain text is therefore sent as
 * the free-text search OR a `from:` match on the same words, so the sender's
 * address (whole or part) and display name match as well as the subject.
 *
 * Text that already uses Gmail search syntax (an operator such as `from:` or
 * `subject:`, quotes, groups, OR/AND, or a leading `-`/`+`) is passed through
 * unchanged, so hand-written Gmail searches behave as they did.
 *
 * Gmail only matches whole words, so part of a name ("rebe") finds nothing
 * from "rebecca@acmeclient.com.au". The Mail page fills that gap: it matches
 * the typed text against the people in your mail (start of the address, the
 * domain, or any word of the name) and passes their addresses as
 * `senderAddresses`, which are added as more `from:` matches.
 */

/** Most extra sender addresses one search adds. */
export const MAX_SEARCH_SENDERS = 10;

const ADDRESS_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/**
 * The `senders` request parameter: comma-separated addresses. Anything that is
 * not a plain address is dropped (so nothing else reaches the Gmail search),
 * duplicates are removed, and at most MAX_SEARCH_SENDERS are kept.
 */
export function parseSearchSenders(param: string | null | undefined): string[] {
  if (!param) return [];
  const out: string[] = [];
  for (const part of param.split(",")) {
    const address = part.trim().toLowerCase();
    if (address.length > 254 || !ADDRESS_RE.test(address) || out.includes(address)) continue;
    out.push(address);
    if (out.length >= MAX_SEARCH_SENDERS) break;
  }
  return out;
}

const GMAIL_SYNTAX = /[:"(){}]|(?:^|\s)[-+]|(?:^|\s)(?:OR|AND)(?:\s|$)/;

export function inboxSearchQuery(raw: string, senderAddresses: readonly string[] = []): string {
  const terms = raw.trim().replace(/\s+/g, " ");
  if (!terms || GMAIL_SYNTAX.test(terms)) return terms;
  // Several words stay one AND group on both sides, as the free text was before.
  const group = terms.includes(" ") ? `(${terms})` : terms;
  const extra = parseSearchSenders(senderAddresses.join(","))
    .filter((address) => address !== terms.toLowerCase())
    .map((address) => ` from:${address}`)
    .join("");
  return `{${group} from:${group}${extra}}`;
}

/**
 * What the search box looks in, picked next to it:
 *  - "all": the person (sender in the Inbox, recipients in Sent / Drafts),
 *    the subject and the email's text.
 *  - "person": only the person's name or address (part of a name matches
 *    through the matched addresses, as above).
 *  - "subject": only words in the subject line.
 *  - "body": words in the email's text. Gmail has no body-only search, so
 *    this is its plain word search (which also covers the subject), without
 *    the extra name/address matches.
 */
export const MAIL_SEARCH_SCOPES = ["all", "person", "subject", "body"] as const;
export type MailSearchScope = (typeof MAIL_SEARCH_SCOPES)[number];

/** The `scope` request parameter; anything else (or nothing) is "all". */
export function parseSearchScope(param: string | null | undefined): MailSearchScope {
  return MAIL_SEARCH_SCOPES.find((scope) => scope === param) ?? "all";
}

/**
 * Gmail search for the Mail search box in any folder, limited to `scope`.
 * Hand-written Gmail syntax is passed through unchanged, whatever the scope.
 * In the Inbox the person is the sender (`from:`); in Sent and Drafts it is
 * who the email went to (`to:` / `cc:` / `bcc:`). Sent and Drafts searched
 * with "all" stay plain Gmail text plus the recipient match.
 */
export function mailSearchQuery(
  raw: string,
  options: { folder: string; scope?: MailSearchScope; senderAddresses?: readonly string[] },
): string {
  const terms = raw.trim().replace(/\s+/g, " ");
  if (!terms || GMAIL_SYNTAX.test(terms)) return terms;
  const scope = options.scope ?? "all";
  const group = terms.includes(" ") ? `(${terms})` : terms;
  if (scope === "subject") return `subject:${group}`;
  if (scope === "body") return group;
  const inbox = options.folder === "inbox";
  const people = parseSearchSenders((options.senderAddresses ?? []).join(",")).filter((address) => address !== terms.toLowerCase());
  const personFields = inbox ? ["from"] : ["to", "cc", "bcc"];
  const personParts = [
    ...personFields.map((field) => `${field}:${group}`),
    ...people.flatMap((address) => (inbox ? [`from:${address}`] : [`to:${address}`, `cc:${address}`])),
  ];
  if (scope === "person") return `{${personParts.join(" ")}}`;
  if (inbox) return inboxSearchQuery(raw, options.senderAddresses ?? []);
  return `{${group} ${personParts.join(" ")}}`;
}

/** A listed email, as far as ranking search results needs it. */
export interface RankableMailRow {
  from: string;
  to: string;
  subject: string;
  snippet: string;
}

function lowerText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function addressesIn(header: string): string[] {
  return (header.toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+/g) ?? []).map((a) => a.replace(/\.+$/, ""));
}

function containsAll(text: string, terms: readonly string[]): boolean {
  return terms.length > 0 && terms.every((term) => text.includes(term));
}

/**
 * How closely one email matches the typed search, highest first:
 * 6 the person's name or address is exactly the text; 5 a word of the
 * person's name or address starts with it; 4 the person matches anywhere
 * (or is one of `matchedAddresses`, the people the text matched by part of a
 * name); 3 the subject has the text; 2 the subject has every word; 1 the
 * preview has every word; 0 Gmail matched it somewhere else (e.g. the body).
 */
export function mailSearchScore(
  row: RankableMailRow,
  raw: string,
  options: { folder: string; matchedAddresses?: readonly string[] },
): number {
  const phrase = lowerText(raw);
  if (!phrase) return 0;
  const terms = phrase.split(" ");
  const personHeader = options.folder === "inbox" ? row.from : row.to;
  const person = lowerText(personHeader);
  const addresses = addressesIn(personHeader);
  const name = lowerText(personHeader.replace(/<[^>]*>/g, "").replace(/"/g, ""));
  if (name === phrase || addresses.includes(phrase)) return 6;
  const words = person.split(/[\s<>"@.,_-]+/).filter(Boolean);
  if (words.some((word) => word.startsWith(phrase)) || addresses.some((a) => a.startsWith(phrase)) || name.startsWith(phrase)) return 5;
  const matched = new Set((options.matchedAddresses ?? []).map((a) => a.toLowerCase()));
  if (person.includes(phrase) || containsAll(person, terms) || addresses.some((a) => matched.has(a))) return 4;
  const subject = lowerText(row.subject);
  if (subject.includes(phrase)) return 3;
  if (containsAll(subject, terms)) return 2;
  if (containsAll(lowerText(row.snippet), terms)) return 1;
  return 0;
}

/**
 * Search results with the closest matches first (see mailSearchScore); equal
 * matches keep Gmail's order (newest first). Hand-written Gmail searches keep
 * Gmail's order unchanged.
 */
export function rankMailSearchResults<T extends RankableMailRow>(
  rows: readonly T[],
  raw: string,
  options: { folder: string; matchedAddresses?: readonly string[] },
): T[] {
  const terms = raw.trim();
  if (!terms || GMAIL_SYNTAX.test(terms)) return [...rows];
  return rows
    .map((row, index) => ({ row, index, score: mailSearchScore(row, terms, options) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.row);
}
