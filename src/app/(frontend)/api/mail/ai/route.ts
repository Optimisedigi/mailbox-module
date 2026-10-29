import { NextRequest, NextResponse } from "next/server";
import { getFullMessage, getThreadMessages } from "@/lib/mail/gmail-mail";
import { buildMailModelRequest, cleanDraftHistory, MailModelRequestError } from "@/lib/mail/model-request";
import { runMailModel } from "@/lib/mail/run-model";
import { applyBlockEditsToText, parseBlockEdits, type BlockEdit } from "@/lib/mail/revise-edits";
import { extractEmailHeaders } from "@/lib/gmail-draft-parsing";
import { cleanGreetingName, cleanSuggestedSubject, ensureHiGreeting, greetingName } from "@/lib/mail/greeting";
import { gmailErrorResponse, parseGmailId, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";
import { userHasFeature } from "@/lib/access";
import {
  buildMailClientContext,
  resolveRecipientClient,
  resolveReplyClient,
  type MailClientContext,
  type ResolvedMailClient,
} from "@/lib/mail/client-context";

const MAX_RECIPIENTS_CHARS = 4_000;
const NOT_LINKED = "This email isn't linked to a client.";

/**
 * POST /api/mail/ai
 * Body: { action: "reply", gmailMessageId: string, instruction?: string, history?, currentDraft? }
 *     | { action: "draft", instruction: string, history?, currentDraft?, suggestSubject? }
 *
 * Returns { text, subject?, model }. suggestSubject (new email, first request,
 * empty subject line) also asks for a subject, returned separately. The body
 * always opens with "Hi" plus a first name when known: for replies the
 * sender's display name, else recipientName (the browser's first name for the
 * one To recipient, from the typed name or the user's Gmail contacts).
 *
 * history/currentBlocks (or currentDraft) let the user keep revising the draft
 * (chat-style): earlier instructions and the draft as currently edited,
 * as the editor's blocks. A revision returns { text, edits }: only the blocks
 * the request changes (see revise-edits.ts), so the window can leave the rest
 * of the email untouched; text is the whole revised draft. They are the user's
 * own text; the only mailbox content is still the one selected email.
 *
 * includeThread (reply only, opt-in checkbox): also send the other messages of
 * the selected email's thread. The thread id comes from the selected message as
 * Gmail returns it, never from the request, so no other thread can be pulled in.
 *
 * includeClientData (opt-in checkbox, needs the `clients` feature): also send a
 * short block of client-safe CMS facts (client-context.ts). The client is
 * resolved server-side: for a reply, the client-emails row stored for the
 * selected message, else its domain match; for a draft, the first To/Cc
 * address that matches a client. A client id is never read from the body.
 * Returns clientContext: { id, name } | null.
 *
 * Runs only when the user clicks "Write with AI" (in a reply) or "Write message". For a
 * reply, the server fetches exactly the one selected message by id; nothing
 * else from the mailbox is loaded or sent. Returns editable text. Never sends.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{
    action?: unknown;
    gmailMessageId?: unknown;
    instruction?: unknown;
    history?: unknown;
    currentDraft?: unknown;
    currentBlocks?: unknown;
    includeThread?: unknown;
    suggestSubject?: unknown;
    includeClientData?: unknown;
    to?: unknown;
    cc?: unknown;
    recipientName?: unknown;
  }>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const action = body.action === "reply" || body.action === "draft" ? body.action : null;
  if (!action) return NextResponse.json({ error: "action must be reply or draft." }, { status: 400 });
  const instruction = typeof body.instruction === "string" ? body.instruction : "";
  const history = cleanDraftHistory(body.history);
  const currentDraft = typeof body.currentDraft === "string" ? body.currentDraft : "";
  const currentBlocks = Array.isArray(body.currentBlocks) ? body.currentBlocks.filter((block): block is string => typeof block === "string") : null;
  const includeClientData = body.includeClientData === true;
  if (includeClientData && !userHasFeature(ctx.user, "clients")) {
    return NextResponse.json({ error: "Client data is not enabled for your account." }, { status: 403 });
  }
  const recipients = (raw: unknown) => (typeof raw === "string" ? raw.slice(0, MAX_RECIPIENTS_CHARS) : "");

  // Load the facts for a server-resolved client; errors become a JSON response.
  const loadClientContext = async (client: ResolvedMailClient | null): Promise<MailClientContext | NextResponse> => {
    if (!client) return NextResponse.json({ error: NOT_LINKED }, { status: 400 });
    try {
      const context = await buildMailClientContext(ctx.payload, client.id, new Date());
      if (!context) return NextResponse.json({ error: NOT_LINKED }, { status: 400 });
      return context;
    } catch (err) {
      console.error("[mail] client context failed:", (err as Error).message?.slice(0, 200));
      return NextResponse.json({ error: "Could not load the client's data. Try again or untick Use client data." }, { status: 502 });
    }
  };
  let clientContext: MailClientContext | null = null;

  let request;
  // First name for the "Hi <name>," greeting: the person being replied to.
  let name = cleanGreetingName(body.recipientName);
  try {
    if (action === "draft") {
      if (body.gmailMessageId !== undefined && body.gmailMessageId !== null && body.gmailMessageId !== "") {
        return NextResponse.json({ error: "A new draft does not take an email." }, { status: 400 });
      }
      if (includeClientData) {
        const token = await requireGmailToken(ctx.user.id, req);
        if (token instanceof NextResponse) return token;
        const client = await resolveRecipientClient({
          payload: ctx.payload,
          message: { to: recipients(body.to), cc: recipients(body.cc) },
          ownAddresses: [token.email, token.userEmail].filter(Boolean),
          userId: ctx.user.id,
        });
        const loaded = await loadClientContext(client);
        if (loaded instanceof NextResponse) return loaded;
        clientContext = loaded;
      }
      request = buildMailModelRequest({
        action: "draft",
        instruction,
        history,
        currentDraft,
        currentBlocks,
        suggestSubject: body.suggestSubject === true,
        clientContext,
      });
    } else {
      const gmailMessageId = parseGmailId(body.gmailMessageId);
      if (!gmailMessageId) {
        return NextResponse.json({ error: "Select exactly one email to reply to." }, { status: 400 });
      }
      const token = await requireGmailToken(ctx.user.id, req);
      if (token instanceof NextResponse) return token;
      let message;
      let thread: Awaited<ReturnType<typeof getThreadMessages>> | null = null;
      try {
        message = await getFullMessage(token.accessToken, gmailMessageId);
        if (body.includeThread === true && message.threadId) {
          thread = await getThreadMessages(token.accessToken, message.threadId);
        }
      } catch (err) {
        return gmailErrorResponse(err, "Could not load that email from Gmail.");
      }
      // Replying to our own sent message goes to its recipient, so greet them instead.
      const own = [token.email, token.userEmail].filter(Boolean).map((address) => address.toLowerCase());
      const fromOwn = own.some((address) => message.from.toLowerCase().includes(address));
      name = greetingName(fromOwn ? message.to : message.from) || name;
      if (includeClientData) {
        const client = await resolveReplyClient({
          payload: ctx.payload,
          user: ctx.user,
          message,
          ownAddresses: [token.email, token.userEmail].filter(Boolean),
        });
        const loaded = await loadClientContext(client);
        if (loaded instanceof NextResponse) return loaded;
        clientContext = loaded;
      }
      const toModelEmail = (m: typeof message) => ({
        gmailMessageId: m.messageId,
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        date: m.date,
        body: m.body,
      });
      request = buildMailModelRequest({
        action: "reply",
        instruction,
        history,
        currentDraft,
        currentBlocks,
        email: toModelEmail(message),
        thread: thread ? thread.filter((m) => m.threadId === message.threadId).map(toModelEmail) : null,
        clientContext,
      });
    }
  } catch (err) {
    if (err instanceof MailModelRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  if (request.revise) {
    const blocks = request.revise.blocks;
    try {
      // Edits the model could not write as valid JSON get one more try.
      let result = await runMailModel({ payload: ctx.payload, userId: ctx.user.id, request });
      let edits: BlockEdit[] | null = parseBlockEdits(result.text, blocks.length);
      if (!edits) {
        result = await runMailModel({ payload: ctx.payload, userId: ctx.user.id, request });
        edits = parseBlockEdits(result.text, blocks.length);
      }
      if (!edits) return NextResponse.json({ error: "The AI's changes could not be read. Please try again." }, { status: 502 });
      return NextResponse.json({
        text: applyBlockEditsToText(blocks, edits).join("\n\n"),
        edits,
        model: result.model,
        clientContext: clientContext ? { id: clientContext.clientId, name: clientContext.clientName } : null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI request failed.";
      return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
    }
  }

  try {
    const result = await runMailModel({ payload: ctx.payload, userId: ctx.user.id, request });
    let text = result.text;
    let subject = "";
    if (request.suggestSubject) {
      const headers = extractEmailHeaders(text.replace(/^\s+/, ""));
      subject = cleanSuggestedSubject(headers.subject);
      if (headers.subject !== undefined) text = headers.body;
    }
    text = ensureHiGreeting(text, name);
    return NextResponse.json({
      text,
      ...(subject ? { subject } : {}),
      model: result.model,
      clientContext: clientContext ? { id: clientContext.clientId, name: clientContext.clientName } : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed.";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
