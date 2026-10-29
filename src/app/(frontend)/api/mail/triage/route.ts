import { NextRequest, NextResponse } from "next/server";
import { getMessageSenderSubjects, listMessageIdsMatching, type MessageSenderSubject } from "@/lib/mail/gmail-mail";
import { hiddenSendersQuery, isHiddenSender, loadHiddenSenders } from "@/lib/mail/hidden-senders";
import { loadClientSenders } from "@/lib/mail/client-senders";
import { loadClientDomainIndex } from "@/lib/mail/store";
import { chosenClientsFor, matchAddress } from "@/lib/mail/client-matching";
import { runMailModel } from "@/lib/mail/run-model";
import { groupBySender, MAX_TRIAGE_MESSAGES, TRIAGE_READ_CHUNK, triageSenders } from "@/lib/mail/triage";
import { gmailErrorResponse, parseGmailId, readJson, requireGmailToken, requireMailUser, type MailUser } from "@/lib/mail/route-helpers";
import type { Payload } from "payload";

export const maxDuration = 300;

/**
 * POST /api/mail/triage
 *
 * Runs only when the user clicks "Triage unread". Lists the unread inbox
 * (same view as the Mail inbox: own sent mail and hidden senders left out),
 * reads each message's sender and subject only (Gmail metadata, never the
 * body), asks the model to propose categories for this inbox, then to sort the
 * SENDERS into them, one line per sender (see triage.ts). Client senders are kept out of the model call.
 *
 * Gmail lets one account read only about 300 emails' headers a minute, so a
 * big inbox takes longer than one request may run. The panel therefore goes
 * in steps, showing progress:
 *   { step: "list" }                → { ids, truncated }   unread ids, newest first
 *   { step: "read", ids }           → { messages }         headers for ≤ TRIAGE_READ_CHUNK ids
 *   { step: "sort", messages }      → { categories, scanned, failedBatches }
 * With no step, all three run in one request (fine for small inboxes).
 *
 * Changes nothing in Gmail: the user picks what to clear and calls /api/mail/triage/apply.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = (await readJson<{ step?: unknown; ids?: unknown; messages?: unknown }>(req)) ?? {};
  const step = body.step;
  if (step !== undefined && step !== "list" && step !== "read" && step !== "sort") {
    return NextResponse.json({ error: "Unknown triage step." }, { status: 400 });
  }
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  if (step === "read") {
    const ids = cleanIds(body.ids);
    if (!ids) return NextResponse.json({ error: `Send 1 to ${TRIAGE_READ_CHUNK} message ids to read.` }, { status: 400 });
    try {
      return NextResponse.json({ messages: await getMessageSenderSubjects(token.accessToken, ids) });
    } catch (err) {
      return gmailErrorResponse(err, "Could not read your unread emails from Gmail.");
    }
  }

  if (step === "sort") {
    const messages = cleanMessages(body.messages);
    if (!messages) return NextResponse.json({ error: "The emails to sort could not be read." }, { status: 400 });
    return sortMessages(ctx, token, messages);
  }

  let listed: { ids: string[]; truncated: boolean };
  try {
    listed = await listUnread(ctx, token.accessToken);
  } catch (err) {
    return gmailErrorResponse(err, "Could not read your unread emails from Gmail.");
  }
  if (step === "list") return NextResponse.json(listed);

  let messages: MessageSenderSubject[];
  try {
    messages = await getMessageSenderSubjects(token.accessToken, listed.ids);
  } catch (err) {
    return gmailErrorResponse(err, "Could not read your unread emails from Gmail.");
  }
  const sorted = await sortMessages(ctx, token, messages);
  if (!sorted.ok) return sorted;
  return NextResponse.json({ ...(await sorted.json()), truncated: listed.truncated });
}

type Ctx = { payload: Payload; user: MailUser };
type Token = { accessToken: string; email: string; userEmail: string };

async function listUnread(ctx: Ctx, accessToken: string): Promise<{ ids: string[]; truncated: boolean }> {
  const hiddenSenders = await loadHiddenSenders(ctx.payload, ctx.user.id);
  const q = ["in:inbox", "is:unread", "-in:sent", hiddenSendersQuery(hiddenSenders)].filter(Boolean).join(" ");
  const ids = await listMessageIdsMatching(accessToken, q, MAX_TRIAGE_MESSAGES + 1);
  return { ids: ids.slice(0, MAX_TRIAGE_MESSAGES), truncated: ids.length > MAX_TRIAGE_MESSAGES };
}

async function sortMessages(ctx: Ctx, token: Token, messages: MessageSenderSubject[]): Promise<NextResponse> {
  const clientSenders = await loadClientSenders(ctx.payload, ctx.user.id);
  const index = await loadClientDomainIndex(ctx.payload, [token.email, token.userEmail].filter(Boolean), { userId: ctx.user.id });
  const senders = groupBySender(messages);
  let sorted: Awaited<ReturnType<typeof triageSenders>>;
  try {
    sorted = await triageSenders({
      senders,
      isClient: (address) => matchAddress(index, address) !== null || chosenClientsFor(index, address).length > 0 || isHiddenSender(address, clientSenders),
      classify: async (request) => (await runMailModel({ payload: ctx.payload, userId: ctx.user.id, request })).text,
    });
  } catch {
    // The planning call failed or suggested no categories.
    return NextResponse.json({ error: "The AI could not sort your inbox. Please try again." }, { status: 502 });
  }
  const { categories, failedBatches, batches } = sorted;
  if (batches > 0 && failedBatches === batches) {
    return NextResponse.json({ error: "The AI could not sort your inbox. Please try again." }, { status: 502 });
  }
  return NextResponse.json({ categories, scanned: messages.length, failedBatches });
}

/** 1 to TRIAGE_READ_CHUNK valid Gmail ids, without repeats; null otherwise. */
function cleanIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > TRIAGE_READ_CHUNK) return null;
  const ids = value.map(parseGmailId);
  if (ids.some((id) => id === null)) return null;
  return [...new Set(ids as string[])];
}

const MAX_HEADER_CHARS = 1000;

function headerText(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.slice(0, MAX_HEADER_CHARS) : null;
}

/**
 * The headers the "read" step returned, sent back for sorting. They are the
 * user's own mailbox data, but are still checked: ids must be Gmail ids (they
 * are what Archive acts on) and text is capped, as in the one-request path.
 */
function cleanMessages(value: unknown): MessageSenderSubject[] | null {
  if (!Array.isArray(value) || value.length > MAX_TRIAGE_MESSAGES) return null;
  const out: MessageSenderSubject[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    const messageId = parseGmailId(row.messageId);
    const fields = ["threadId", "from", "subject", "listId", "listUnsubscribe", "listUnsubscribePost", "precedence"].map((key) => headerText(row[key]));
    if (!messageId || fields.some((field) => field === null)) return null;
    const [threadId, from, subject, listId, listUnsubscribe, listUnsubscribePost, precedence] = fields as string[];
    out.push({ messageId, threadId: threadId ?? "", from: from ?? "", subject: subject ?? "", listId, listUnsubscribe, listUnsubscribePost, precedence });
  }
  return out;
}
