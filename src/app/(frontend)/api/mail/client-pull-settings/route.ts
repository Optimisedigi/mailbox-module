import { NextRequest, NextResponse } from "next/server";
import type { MatchableClient } from "@/lib/mail/client-matching";
import {
  clientEmailTargets,
  DEFAULT_PULL_SETTINGS,
  describePullSettings,
  parsePullSettings,
  pullFilterKey,
  storedPullSettings,
  type ClientPullSettings,
} from "@/lib/mail/client-knowledge";
import { readJson, requireMailUser, type MailContext } from "@/lib/mail/route-helpers";

/**
 * GET  /api/mail/client-pull-settings?clientId=123
 * PUT  /api/mail/client-pull-settings  Body: { clientId, useClientContacts, senders, keywords, matchMode }
 *
 * How "Pull emails" finds a client's emails, shared by the team: the client's
 * own domains and contacts, and/or chosen senders (addresses or domains) and
 * keywords, matching any of them or a sender AND a keyword. Returns
 * { settings, filterKey, description, clientTargets }; clientTargets is what
 * "the client's contacts" searches for, from the client record. CMS only: no
 * Gmail, no model.
 */

async function loadClient(ctx: MailContext, clientId: number): Promise<MatchableClient | null> {
  try {
    return (await ctx.payload.findByID({
      collection: "clients",
      id: clientId,
      depth: 0,
      overrideAccess: true,
      select: { name: true, websiteUrl: true, contactEmail: true, additionalContacts: true, isActive: true },
    } as never)) as unknown as MatchableClient;
  } catch {
    return null;
  }
}

async function loadRow(ctx: MailContext, clientId: number): Promise<(Record<string, unknown> & { id: number }) | null> {
  const res = (await ctx.payload.find({
    collection: "client-email-pull-settings",
    where: { client: { equals: clientId } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  } as never)) as unknown as { docs: Array<Record<string, unknown> & { id: number }> };
  return res.docs[0] ?? null;
}

function view(client: MatchableClient, settings: ClientPullSettings, ownEmail: string | undefined) {
  return {
    settings,
    filterKey: pullFilterKey(settings),
    // Briefs written before search settings existed used these.
    defaultFilterKey: pullFilterKey(DEFAULT_PULL_SETTINGS),
    description: describePullSettings(settings),
    clientTargets: clientEmailTargets(client, ownEmail ? [ownEmail] : []),
  };
}

function parseClientId(raw: unknown): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const clientId = parseClientId(req.nextUrl.searchParams.get("clientId"));
  if (!clientId) return NextResponse.json({ error: "clientId is required." }, { status: 400 });
  const client = await loadClient(ctx, clientId);
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  return NextResponse.json(view(client, storedPullSettings(await loadRow(ctx, clientId)), ctx.user.email));
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<Record<string, unknown>>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const clientId = parseClientId(body.clientId);
  if (!clientId) return NextResponse.json({ error: "clientId is required." }, { status: 400 });
  const parsed = parsePullSettings(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const client = await loadClient(ctx, clientId);
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });

  const { settings } = parsed;
  const data = {
    useClientContacts: settings.useClientContacts,
    senders: settings.senders.join("\n"),
    keywords: settings.keywords.join("\n"),
    matchMode: settings.matchMode,
    updatedBy: ctx.user.id,
  };
  const existing = await loadRow(ctx, clientId);
  if (existing) {
    await ctx.payload.update({ collection: "client-email-pull-settings", id: existing.id, overrideAccess: true, data } as never);
  } else {
    await ctx.payload.create({ collection: "client-email-pull-settings", overrideAccess: true, data: { ...data, client: clientId } } as never);
  }
  return NextResponse.json(view(client, settings, ctx.user.email));
}
