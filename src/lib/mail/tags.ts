/**
 * Mail tags: the user's own Gmail labels, used to file emails (from Triage)
 * into named piles like "Baby reads" to work through later. Kept in Gmail, so
 * they persist, sync to the Gmail apps, and need no CMS storage.
 *
 * Client-safe: string work only, no Gmail calls (see gmail-mail.ts for those).
 */

export interface MailTag {
  /** Gmail label id, always "Label_<digits>" for user labels. */
  id: string;
  name: string;
  /** Emails carrying the tag; null when Gmail's count was not fetched. */
  total: number | null;
  /** Unread emails carrying the tag; null when not fetched. */
  unread: number | null;
}

export const MAX_TAG_NAME = 40;

/** Gmail user labels only: system labels (INBOX, TRASH, SPAM...) can never be used as a tag. */
const TAG_ID_RE = /^Label_\d{1,30}$/;

export function parseTagId(raw: unknown): string | null {
  return typeof raw === "string" && TAG_ID_RE.test(raw.trim()) ? raw.trim() : null;
}

/** A tag name as typed, tidied: one line, single spaces, 1 to MAX_TAG_NAME characters; null if unusable. */
export function cleanTagName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (/[\u0000-\u001f\u007f]/.test(raw.replace(/[\r\n\t]/g, " "))) return null;
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= MAX_TAG_NAME ? name : null;
}

/** The existing tag with this name (Gmail label names ignore case), if any. */
export function findTagByName<T extends { name: string }>(tags: readonly T[], name: string): T | undefined {
  const wanted = name.trim().toLowerCase();
  return tags.find((tag) => tag.name.toLowerCase() === wanted);
}

/** Does a triage sender match the search text (name, address or any subject; case-insensitive)? */
export function senderMatchesSearch(sender: { name: string; address: string; subjects: readonly string[] }, search: string): boolean {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const haystack = [sender.name, sender.address, ...sender.subjects].join("\n").toLowerCase();
  return words.every((word) => haystack.includes(word));
}
