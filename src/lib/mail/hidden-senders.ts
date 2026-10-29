import type { Payload } from "payload";
import { extractEmailAddresses, normaliseDomain } from "./client-matching";

/**
 * Per-user "hide these senders" filter for the Mail inbox.
 *
 * Entries are either an exact address ("orders@shop.com") or a whole domain
 * ("@shop.com", which also covers its subdomains). The list is stored in
 * Payload's built-in per-user preferences (payload-preferences, key below),
 * so it follows the user across devices and needs no schema change.
 *
 * It is turned into a Gmail search so hidden mail never appears in the inbox
 * list, and sync no longer stores hidden senders' emails against clients
 * (src/lib/mail/store.ts). Nothing is deleted, archived or changed in Gmail;
 * already-stored rows are removed only via Mail's "Check stored emails"
 * cleanup (src/lib/mail/cleanup.ts).
 */

export const HIDDEN_SENDERS_PREF_KEY = "mail-hidden-senders";
export const MAX_HIDDEN_SENDERS = 100;

/** "Jo <JO@Shop.com>" → "jo@shop.com"; "shop.com" / "@shop.com" / "https://shop.com" → "@shop.com". */
export function normaliseHiddenSender(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  if (!raw.startsWith("@")) {
    const address = extractEmailAddresses(raw)[0];
    if (address) return address;
  }
  const domain = normaliseDomain(raw.replace(/^@/, ""));
  return domain ? `@${domain}` : null;
}

/** Clean, dedupe and cap a stored or submitted list. */
export function cleanHiddenSenders(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const entry = typeof item === "string" ? normaliseHiddenSender(item) : null;
    if (entry && !out.includes(entry)) out.push(entry);
    if (out.length >= MAX_HIDDEN_SENDERS) break;
  }
  return out;
}

/**
 * Gmail search terms that exclude the hidden senders, e.g.
 * `-from:orders@shop.com -from:news.com`. Entries were normalised above, so
 * they only contain address/domain characters and cannot inject other search
 * operators.
 */
export function hiddenSendersQuery(list: string[]): string {
  return cleanHiddenSenders(list)
    .map((entry) => `-from:${entry.startsWith("@") ? entry.slice(1) : entry}`)
    .join(" ");
}

/** True when a From header belongs to a hidden address or domain (subdomains included). */
export function isHiddenSender(from: string | null | undefined, list: string[]): boolean {
  const address = extractEmailAddresses(from)[0];
  if (!address) return false;
  const domain = normaliseDomain(address);
  return cleanHiddenSenders(list).some((entry) =>
    entry.startsWith("@")
      ? domain === entry.slice(1) || domain.endsWith(`.${entry.slice(1)}`)
      : entry === address,
  );
}

/** Read the user's hidden-senders list (server side). Missing or bad data → []. */
export async function loadHiddenSenders(payload: Pick<Payload, "find">, userId: number): Promise<string[]> {
  return loadSenderListPreference(payload, userId, HIDDEN_SENDERS_PREF_KEY);
}

/**
 * Read a `{ senders: [...] }` list stored in the user's payload-preferences
 * under `key` (hidden senders, client senders). Missing or bad data → [].
 */
export async function loadSenderListPreference(
  payload: Pick<Payload, "find">,
  userId: number,
  key: string,
): Promise<string[]> {
  try {
    const res = await payload.find({
      collection: "payload-preferences",
      where: {
        and: [
          { key: { equals: key } },
          { "user.value": { equals: userId } },
          { "user.relationTo": { equals: "users" } },
        ],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    } as never);
    const value = (res as unknown as { docs: Array<{ value?: { senders?: unknown } | null }> }).docs[0]?.value;
    return cleanHiddenSenders(value?.senders);
  } catch {
    return [];
  }
}
