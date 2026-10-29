import type { Payload } from "payload";
import { clientListExtension } from "@/extensions/client-list";
import { matchMessageToClient, type MatchableMessage } from "./client-matching";
import { loadClientDomainIndex } from "./store";

/**
 * Opt-in "Use client data" for Write with AI: a short, plain-text block of
 * client facts the model may quote in a reply. Built from the client's name,
 * the extra fact lines your client list system supplies
 * (clientListExtension.loadClientFacts, optional) and the latest summaries
 * on the client's email timeline.
 *
 * The client id always comes from server-side resolution (stored/matched
 * message or recipient domain), never from the browser.
 */

export const MAX_CLIENT_CONTEXT_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 400;
const MAX_EXTRA_LINE_CHARS = 500;

export interface MailClientContext {
  clientId: number;
  clientName: string;
  text: string;
}

export interface MailClientFacts {
  clientName: string;
  /** Lines from clientListExtension.loadClientFacts (already trimmed). */
  extraFacts: string[];
  recentEmails: Array<{ date: string | null; summary: string }>;
}

async function safe<T>(load: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await load();
  } catch {
    return fallback;
  }
}

function day(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return match ? match[0] : null;
}

/**
 * Load the facts for one client. Returns null when the client doesn't exist.
 * Each source is loaded independently; a failing one only drops its own part.
 */
export async function loadMailClientFacts(
  payload: Payload,
  clientId: number,
  now: Date,
): Promise<MailClientFacts | null> {
  const client = await safe(
    async () =>
      (await payload.findByID({
        collection: "clients",
        id: clientId,
        depth: 0,
        overrideAccess: true,
        select: { name: true },
      } as never)) as unknown as { id: number; name?: string | null } | null,
    null,
  );
  if (!client) return null;
  const loadExtra = clientListExtension.loadClientFacts;
  const [extraFacts, summaries] = await Promise.all([
    safe(async () => {
      if (!loadExtra) return [];
      const lines = await loadExtra({ payload, clientId, now });
      return lines
        .map((line) => String(line ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_EXTRA_LINE_CHARS))
        .filter(Boolean);
    }, [] as string[]),
    safe(async () => {
      const result = await payload.find({
        collection: "client-email-summaries",
        where: { client: { equals: clientId } } as never,
        sort: "-emailDate",
        limit: 3,
        depth: 0,
        overrideAccess: true,
      });
      return result.docs.map((doc) => ({
        date: day(doc.emailDate),
        summary: String(doc.summary ?? "").trim().slice(0, MAX_SUMMARY_CHARS),
      }));
    }, [] as Array<{ date: string | null; summary: string }>),
  ]);
  return {
    clientName: client.name?.trim() || `Client ${client.id}`,
    extraFacts,
    recentEmails: summaries.filter((entry) => entry.summary),
  };
}

/** Plain-text facts block, capped at MAX_CLIENT_CONTEXT_CHARS. */
export function formatMailClientContext(facts: MailClientFacts): string {
  const lines: string[] = [`Client: ${facts.clientName}`, ...facts.extraFacts];
  if (facts.recentEmails.length) {
    lines.push("Recent email timeline:");
    for (const entry of facts.recentEmails) lines.push(`- ${entry.date ?? "undated"}: ${entry.summary}`);
  }
  return capAtLine(lines.join("\n"), MAX_CLIENT_CONTEXT_CHARS);
}

function capAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n");
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
}

export async function buildMailClientContext(
  payload: Payload,
  clientId: number,
  now: Date,
): Promise<MailClientContext | null> {
  const facts = await loadMailClientFacts(payload, clientId, now);
  if (!facts) return null;
  return { clientId, clientName: facts.clientName, text: formatMailClientContext(facts) };
}

export interface ResolvedMailClient {
  id: number;
  name: string;
}

/**
 * The client a reply is about: the client-emails row stored for the selected
 * message (respects manual assignment and the user's own access), else the
 * domain match on its From/To/Cc. Never takes a client id from the browser.
 */
export async function resolveReplyClient(args: {
  payload: Payload;
  user: { id: number; role?: string };
  message: MatchableMessage & { messageId: string };
  ownAddresses: string[];
}): Promise<ResolvedMailClient | null> {
  const stored = await args.payload.find({
    collection: "client-emails",
    where: { gmailMessageId: { equals: args.message.messageId } },
    depth: 1,
    limit: 1,
    overrideAccess: false,
    user: args.user,
    select: { client: true },
  } as never);
  const doc = (stored as unknown as { docs: Array<{ client?: { id: number; name?: string | null } | number | null }> }).docs[0];
  if (doc?.client) {
    if (typeof doc.client === "object") return { id: doc.client.id, name: doc.client.name ?? "" };
    return { id: doc.client, name: "" };
  }
  return resolveRecipientClient({ payload: args.payload, message: args.message, ownAddresses: args.ownAddresses, userId: args.user.id });
}

/**
 * Domain/address match for a message or a new email's To/Cc. First match
 * wins. With `userId`, that user's own sender → client choices apply.
 */
export async function resolveRecipientClient(args: {
  payload: Payload;
  message: MatchableMessage;
  ownAddresses: string[];
  userId?: number;
}): Promise<ResolvedMailClient | null> {
  const index = await loadClientDomainIndex(args.payload, args.ownAddresses, { userId: args.userId });
  const match = matchMessageToClient(index, args.message);
  return match ? { id: match.clientId, name: match.clientName } : null;
}

/**
 * The client facts for a compose-window AI request, from what the window sends
 * (never a client id): a reply's selected message (the stored client-emails
 * row, else its domain match) or a new email's To/Cc. Null when the email is
 * not linked to a client.
 */
export async function composeClientContext(args: {
  payload: Payload;
  user: { id: number; role?: string };
  ownAddresses: string[];
  now: Date;
  reply: (MatchableMessage & { messageId: string }) | null;
  recipients: { to: string; cc: string };
}): Promise<MailClientContext | null> {
  const client = args.reply
    ? await resolveReplyClient({ payload: args.payload, user: args.user, message: args.reply, ownAddresses: args.ownAddresses })
    : await resolveRecipientClient({ payload: args.payload, message: args.recipients, ownAddresses: args.ownAddresses, userId: args.user.id });
  return client ? buildMailClientContext(args.payload, client.id, args.now) : null;
}
