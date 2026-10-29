import { NextRequest, NextResponse } from "next/server";
import type { Payload } from "payload";
import { extractEmailAddresses } from "@/lib/mail/client-matching";
import { summarisedIds } from "@/lib/mail/cleanup";
import { matchingClientSenderEntries } from "@/lib/mail/client-senders";
import { loadSenderClients, MAX_CLIENTS_PER_SENDER, normaliseSenderEntry, saveSenderClients, withSenderClient } from "@/lib/mail/sender-clients";
import { readJson, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * POST /api/mail/sender-client
 * Body: { sender: "jo@x.com" | "@x.com", clientIds: number[] }   choose the clients ([] = "No client")
 *    or { sender, clientId: number | null }                     one client (null = "No client")
 *    or { sender, automatic: true }                             go back to automatic matching
 *
 * Saves the user's sender → clients choice (sender-clients.ts), which decides
 * the client pill and which client new emails from that sender are saved to.
 * Several clients (an agency sender) are shown on the pill, but their emails
 * are assigned by hand. When exactly one client is chosen, this user's already-stored emails from (or sent
 * to) that sender that were filed automatically move to it, so the client
 * timelines agree with the pill. Emails assigned by hand, or with a timeline
 * summary, stay where they are. Plain code only; Gmail is not touched.
 */
const MAX_REFILE = 500;

function addressMatches(address: string, entry: string): boolean {
  if (!entry.startsWith("@")) return address === entry;
  const domain = address.split("@")[1] ?? "";
  return domain === entry.slice(1) || domain.endsWith(`.${entry.slice(1)}`);
}

async function refileStoredEmails(payload: Payload, userId: number, entry: string, clientId: number): Promise<number> {
  const term = entry.startsWith("@") ? entry.slice(1) : entry;
  const res = await payload.find({
    collection: "client-emails",
    where: {
      and: [
        { owner: { equals: userId } },
        { matchedBy: { equals: "auto" } },
        { client: { not_equals: clientId } },
        { or: [{ from: { contains: term } }, { to: { contains: term } }, { cc: { contains: term } }] },
      ],
    },
    limit: MAX_REFILE,
    depth: 0,
    sort: "id",
    overrideAccess: true,
    select: { from: true, to: true, cc: true, direction: true },
  } as never);
  const docs = (res as unknown as { docs: Array<{ id: number; from?: string | null; to?: string | null; cc?: string | null; direction?: string | null }> }).docs;
  // `contains` is a loose text match; only rows whose sender (or, for our own
  // sent mail, a recipient) really is this address or domain are moved.
  const rows = docs.filter((doc) =>
    doc.direction === "outbound"
      ? extractEmailAddresses(`${doc.to ?? ""}, ${doc.cc ?? ""}`).some((address) => addressMatches(address, entry))
      : matchingClientSenderEntries(doc.from, [entry]).length > 0,
  );
  const keep = await summarisedIds(payload, rows.map((row) => row.id));
  let moved = 0;
  for (const row of rows) {
    if (keep.has(row.id)) continue;
    await payload.update({
      collection: "client-emails",
      id: row.id,
      overrideAccess: true,
      data: { client: clientId, matchedOn: entry },
    } as never);
    moved++;
  }
  return moved;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ sender?: unknown; clientIds?: unknown; clientId?: unknown; automatic?: unknown }>(req);
  const sender = normaliseSenderEntry(typeof body?.sender === "string" ? body.sender : "");
  if (!sender) {
    return NextResponse.json({ error: "Choose an email address (jo@client.com) or a business domain (@client.com)." }, { status: 400 });
  }
  const automatic = body?.automatic === true;
  const rawIds: unknown[] = automatic
    ? []
    : Array.isArray(body?.clientIds)
      ? body.clientIds
      : body?.clientId === null || body?.clientId === undefined
        ? []
        : [body.clientId];
  const clientIds = [...new Set(rawIds.map(Number))];
  if (clientIds.some((id) => !Number.isInteger(id) || id <= 0) || clientIds.length > MAX_CLIENTS_PER_SENDER) {
    return NextResponse.json({ error: "Choose a client." }, { status: 400 });
  }

  const clients: Array<{ id: number; name: string }> = [];
  for (const id of clientIds) {
    try {
      const client = (await ctx.payload.findByID({
        collection: "clients",
        id,
        depth: 0,
        overrideAccess: false,
        user: ctx.user,
      } as never)) as { name?: string | null };
      clients.push({ id, name: client.name ?? "" });
    } catch {
      return NextResponse.json({ error: "Client not found." }, { status: 404 });
    }
  }

  const current = await loadSenderClients(ctx.payload, ctx.user.id);
  const next = withSenderClient(current, sender, automatic ? undefined : clientIds);
  try {
    await saveSenderClients(ctx.payload, ctx.user.id, next);
  } catch (err) {
    console.warn("[mail] saving sender clients failed:", (err as Error).message?.slice(0, 200));
    return NextResponse.json({ error: "Could not save the client choice." }, { status: 500 });
  }

  const clientId = clients.length === 1 ? (clients[0]?.id ?? null) : null;
  let moved = 0;
  let moveNote: string | null = null;
  if (clientId !== null) {
    try {
      moved = await refileStoredEmails(ctx.payload, ctx.user.id, sender, clientId);
    } catch (err) {
      console.warn("[mail] re-filing stored emails failed:", (err as Error).message?.slice(0, 200));
      moveNote = "Saved, but emails already stored could not all be moved.";
    }
  }
  return NextResponse.json({
    senderClients: next,
    client: clients.length === 1 ? (clients[0] ?? null) : null,
    clients,
    moved,
    moveNote,
  });
}
