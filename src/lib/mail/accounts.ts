import type { Payload } from "payload";
import { normaliseMailAccount } from "./accounts-shared";

/**
 * Server-side storage for a user's extra Gmail accounts (the mail-accounts
 * collection). Every lookup is scoped to the owner, so a request can only
 * ever reach its own user's accounts. Tokens never leave the server.
 */

type PayloadLike = Pick<Payload, "find" | "create" | "update" | "delete">;

export interface MailAccountRow {
  id: number;
  email: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: string | null;
  historyId: string | null;
}

export interface MailAccountSummary {
  email: string;
  lastSyncAt: string | null;
  lastError: string | null;
}

export const MAX_MAIL_ACCOUNTS = 10;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function findMailAccount(payload: Pick<Payload, "find">, ownerId: number, email: string): Promise<MailAccountRow | null> {
  const clean = normaliseMailAccount(email);
  if (!clean) return null;
  const res = await payload.find({
    collection: "mail-accounts",
    where: { and: [{ owner: { equals: ownerId } }, { email: { equals: clean } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  } as never);
  const doc = (res as unknown as { docs: Array<Record<string, unknown>> }).docs[0];
  if (!doc) return null;
  return {
    id: Number(doc.id),
    email: str(doc.email),
    accessToken: str(doc.accessToken),
    refreshToken: str(doc.refreshToken),
    tokenExpiry: str(doc.tokenExpiry) || null,
    historyId: str(doc.historyId) || null,
  };
}

/** The owner's extra accounts, sorted by address (no tokens). */
export async function listMailAccounts(payload: Pick<Payload, "find">, ownerId: number): Promise<MailAccountSummary[]> {
  const res = await payload.find({
    collection: "mail-accounts",
    where: { owner: { equals: ownerId } },
    limit: MAX_MAIL_ACCOUNTS * 2,
    depth: 0,
    sort: "email",
    overrideAccess: true,
    select: { email: true, lastSyncAt: true, lastError: true },
  } as never);
  return (res as unknown as { docs: Array<Record<string, unknown>> }).docs
    .map((doc) => ({ email: str(doc.email), lastSyncAt: str(doc.lastSyncAt) || null, lastError: str(doc.lastError) || null }))
    .filter((account) => account.email !== "")
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** Every extra account (all owners), for the sync cron. */
export async function listAllMailAccounts(payload: Pick<Payload, "find">): Promise<Array<{ ownerId: number; email: string }>> {
  const res = await payload.find({
    collection: "mail-accounts",
    limit: 0,
    pagination: false,
    depth: 0,
    overrideAccess: true,
    select: { owner: true, email: true },
  } as never);
  return (res as unknown as { docs: Array<{ owner?: unknown; email?: unknown }> }).docs
    .map((doc) => ({
      ownerId: typeof doc.owner === "number" ? doc.owner : Number((doc.owner as { id?: unknown } | null)?.id),
      email: str(doc.email),
    }))
    .filter((row) => Number.isInteger(row.ownerId) && row.ownerId > 0 && row.email !== "")
    .sort((a, b) => a.ownerId - b.ownerId || a.email.localeCompare(b.email));
}

/** Insert or refresh an extra account's tokens after OAuth. */
export async function saveMailAccountTokens(
  payload: PayloadLike,
  ownerId: number,
  tokens: { email: string; accessToken: string; refreshToken: string; expiry: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = normaliseMailAccount(tokens.email);
  if (!email) return { ok: false, error: "Google did not return a usable email address." };
  const data = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiry: tokens.expiry,
    lastError: null,
  };
  const existing = await findMailAccount(payload, ownerId, email);
  if (existing) {
    await payload.update({ collection: "mail-accounts", id: existing.id, overrideAccess: true, data } as never);
    return { ok: true };
  }
  if ((await listMailAccounts(payload, ownerId)).length >= MAX_MAIL_ACCOUNTS) {
    return { ok: false, error: `You can connect up to ${MAX_MAIL_ACCOUNTS} extra Gmail accounts.` };
  }
  await payload.create({ collection: "mail-accounts", overrideAccess: true, data: { owner: ownerId, email, ...data } } as never);
  return { ok: true };
}

export async function updateMailAccount(
  payload: Pick<Payload, "update">,
  id: number,
  data: Partial<{ accessToken: string; tokenExpiry: string | null; historyId: string; lastSyncAt: string; lastError: string | null }>,
): Promise<void> {
  await payload.update({ collection: "mail-accounts", id, overrideAccess: true, data } as never);
}

/** Disconnect one extra account. False when the owner has no such account. */
export async function deleteMailAccount(payload: PayloadLike, ownerId: number, email: string): Promise<boolean> {
  const row = await findMailAccount(payload, ownerId, email);
  if (!row) return false;
  await payload.delete({ collection: "mail-accounts", id: row.id, overrideAccess: true } as never);
  return true;
}
