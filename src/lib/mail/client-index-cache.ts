import type { MatchableClient } from "./client-matching";

/**
 * Short-lived copy of the client rows used to match email senders to clients
 * (loadClientDomainIndex). Mail reads them on every inbox page, thread open
 * and sync, so one server instance re-reads the clients table at most once per
 * CLIENT_INDEX_TTL_MS. Saving or deleting a client clears it on that instance;
 * other instances catch up within the TTL.
 *
 * One entry only (the whole small table), so it cannot grow.
 */

export const CLIENT_INDEX_TTL_MS = 60_000;

interface Entry {
  loadedAt: number;
  clients: Promise<MatchableClient[]>;
}

const holder: { entry: Entry | null } = { entry: null };

/** Cached client rows, or `load()` once when missing or older than the TTL. */
export function cachedMatchableClients(load: () => Promise<MatchableClient[]>, now: number = Date.now()): Promise<MatchableClient[]> {
  const entry = holder.entry;
  if (entry && now - entry.loadedAt < CLIENT_INDEX_TTL_MS) return entry.clients;
  const clients = load();
  const next: Entry = { loadedAt: now, clients };
  holder.entry = next;
  // A failed read is not cached: the next request tries again.
  clients.catch(() => {
    if (holder.entry === next) holder.entry = null;
  });
  return clients;
}

/** Drop the cached rows (a client was saved or deleted). */
export function invalidateMatchableClients(): void {
  holder.entry = null;
}
