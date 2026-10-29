import type { Payload } from "payload";
import { isAutomatedLocalPart } from "./automated-senders";
import {
  type ClientDomainIndex,
  extractEmailAddresses,
  chosenClientsFor,
  matchAddress,
  normaliseDomain,
  SHARED_MAILBOX_DOMAINS,
} from "./client-matching";
import { cleanHiddenSenders, isHiddenSender, loadSenderListPreference, normaliseHiddenSender } from "./hidden-senders";

/**
 * Per-user "client senders": addresses or domains the user starred in Mail.
 *
 * The dashboard's "Unread client emails" panel (GET /api/mail/client-unread)
 * shows unread inbox emails from these senders plus any sender that
 * automatic client matching resolves to a client. The starred list uses
 * the same entry format and storage as hidden senders: an exact address
 * ("jo@shop.com") or a whole domain ("@shop.com", subdomains included), kept
 * in Payload's per-user preferences under CLIENT_SENDERS_PREF_KEY. No schema
 * change, and nothing changes in Gmail.
 *
 * Client-safe: no server imports beyond types.
 */

export const CLIENT_SENDERS_PREF_KEY = "mail-client-senders";

/** Same normalisation as hidden senders: "Jo <JO@Shop.com>" → "jo@shop.com", "shop.com" → "@shop.com". */
export const normaliseClientSender = normaliseHiddenSender;

/** Clean, dedupe and cap (100) a stored or submitted list. */
export const cleanClientSenders = cleanHiddenSenders;

/**
 * The sender's real address. When the header has `<addr>`, that wins, so an
 * address typed into the display name (`"jo@client.com" <x@evil.com>`) can't
 * pass as a client sender.
 */
function fromAddress(from: string | null | undefined): string | undefined {
  const bracketed = (from ?? "").match(/<([^<>]+)>\s*$/)?.[1];
  return extractEmailAddresses(bracketed ?? from)[0];
}

/** The stored entries that cover this From header (exact address, or its domain / a parent domain). */
export function matchingClientSenderEntries(from: string | null | undefined, list: string[]): string[] {
  const address = fromAddress(from);
  if (!address) return [];
  const domain = normaliseDomain(address);
  return cleanClientSenders(list).filter((entry) =>
    entry.startsWith("@")
      ? domain === entry.slice(1) || domain.endsWith(`.${entry.slice(1)}`)
      : entry === address,
  );
}

/** True when a From header belongs to a starred client address or domain. */
export function isClientSender(from: string | null | undefined, list: string[]): boolean {
  return matchingClientSenderEntries(from, list).length > 0;
}

/** Keep each Gmail search well under URL/query limits; many clients become several searches. */
export const MAX_CLIENT_UNREAD_QUERY_LENGTH = 1500;

/**
 * Every sender the dashboard treats as a client, as Gmail `from:` values:
 * each client's domains (Website URL and contact domains, see
 * client-matching.ts), exact contact addresses on shared providers such as
 * gmail.com, and the user's starred senders. Values are normalised, so they
 * cannot inject other search operators. Sorted and deduped.
 */
export function clientUnreadTerms(index: ClientDomainIndex | null, starred: string[]): string[] {
  const terms = new Set<string>();
  for (const entry of cleanClientSenders(starred)) terms.add(entry.startsWith("@") ? entry.slice(1) : entry);
  if (index) {
    for (const domain of index.domains.keys()) {
      const clean = normaliseDomain(domain);
      if (clean) terms.add(clean);
    }
    for (const address of index.addresses.keys()) {
      // Addresses on a client's own domain are already covered by that domain.
      if (!SHARED_MAILBOX_DOMAINS.has(normaliseDomain(address))) continue;
      const clean = normaliseClientSender(address);
      if (clean && !clean.startsWith("@")) terms.add(clean);
    }
  }
  return [...terms].sort();
}

/**
 * Gmail searches for unread mail from any client sender, e.g.
 * `is:unread {from:jo@shop.com from:news.com}` (braces = OR), split so no
 * search exceeds `maxLength`. Returns [] when there are no client senders:
 * callers must not search Gmail then.
 */
export function clientUnreadQueries(terms: string[], maxLength = MAX_CLIENT_UNREAD_QUERY_LENGTH): string[] {
  const queries: string[] = [];
  let chunk: string[] = [];
  const build = (parts: string[]) => `is:unread {${parts.join(" ")}}`;
  for (const term of terms) {
    const part = `from:${term}`;
    if (chunk.length && build([...chunk, part]).length > maxLength) {
      queries.push(build(chunk));
      chunk = [];
    }
    chunk.push(part);
  }
  if (chunk.length) queries.push(build(chunk));
  return queries;
}

/**
 * The dashboard filter: keep only unread threads whose sender is a client.
 * A sender counts when it is starred, or when its real address resolves to a
 * client through automatic client matching (website/contact domains). Auto
 * matches skip hidden and no-reply style senders; a starred sender always
 * shows. Gmail's `from:` search is looser than this (it also matches display
 * names), so results are always re-checked here.
 */
export function unreadClientThreads<T extends { from: string; unread: boolean }>(
  threads: T[],
  list: string[],
  options: { index?: ClientDomainIndex | null; hidden?: string[] } = {},
): T[] {
  const clean = cleanClientSenders(list);
  const { index, hidden = [] } = options;
  if (clean.length === 0 && !index) return [];
  return threads.filter((thread) => {
    if (!thread.unread) return false;
    if (isClientSender(thread.from, clean)) return true;
    if (!index) return false;
    const address = fromAddress(thread.from);
    if (!address || isAutomatedLocalPart(address) || isHiddenSender(address, hidden)) return false;
    return matchAddress(index, address) !== null || chosenClientsFor(index, address).length > 0;
  });
}

/** Read the user's client-senders list (server side). Missing or bad data → []. */
export async function loadClientSenders(payload: Pick<Payload, "find">, userId: number): Promise<string[]> {
  return loadSenderListPreference(payload, userId, CLIENT_SENDERS_PREF_KEY);
}
