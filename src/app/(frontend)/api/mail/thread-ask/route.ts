import { NextRequest, NextResponse } from "next/server";
import { getThreadMessages } from "@/lib/mail/gmail-mail";
import { buildMailClientContext, resolveReplyClient } from "@/lib/mail/client-context";
import { cleanAskHistory } from "@/lib/mail/client-knowledge";
import { runMailModel } from "@/lib/mail/run-model";
import {
  buildThreadAskRequest,
  loadClientEmailBriefs,
  MAX_QUESTION_CHARS,
  selectAskThread,
  type ThreadAskClient,
} from "@/lib/mail/thread-ask";
import { gmailErrorResponse, parseGmailId, readJson, requireGmailToken, requireMailUser } from "@/lib/mail/route-helpers";
import { userHasFeature } from "@/lib/access";

/**
 * POST /api/mail/thread-ask
 * Body: { threadId, question, history?: [{ question, answer }] }
 *
 * "Ask AI" on an open email: answers a question from every message of that
 * one Gmail thread and, when the thread is linked to a client (resolved
 * server-side from the newest message, as Write with AI does; needs the
 * `clients` feature), that client's email summaries, presentations record
 * and client-safe CMS facts. Read-only: Gmail is only read, nothing is
 * drafted, sent, saved or changed beyond the mail-ai-requests audit row.
 * Returns { answer, model, client: { id, name } | null, messages, leftOut }.
 */
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ threadId?: unknown; question?: unknown; history?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const threadId = parseGmailId(body.threadId);
  if (!threadId) return NextResponse.json({ error: "Open one email first." }, { status: 400 });
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "Type a question first." }, { status: 400 });
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json({ error: `Keep the question under ${MAX_QUESTION_CHARS} characters.` }, { status: 400 });
  }
  const token = await requireGmailToken(ctx.user.id, req);
  if (token instanceof NextResponse) return token;

  let thread;
  try {
    thread = (await getThreadMessages(token.accessToken, threadId)).filter((message) => message.threadId === threadId);
  } catch (err) {
    return gmailErrorResponse(err, "Could not load that email from Gmail.");
  }
  const newest = thread.at(-1);
  if (!newest) return NextResponse.json({ error: "That email could not be found." }, { status: 404 });

  let client: ThreadAskClient | null = null;
  if (userHasFeature(ctx.user, "clients")) {
    try {
      const resolved = await resolveReplyClient({
        payload: ctx.payload,
        user: ctx.user,
        message: newest,
        ownAddresses: [token.email, token.userEmail].filter(Boolean),
      });
      if (resolved) {
        const [context, briefs] = await Promise.all([
          buildMailClientContext(ctx.payload, resolved.id, new Date()),
          // Like the client's Emails tab: non-admins only see summaries of their own mail.
          loadClientEmailBriefs(ctx.payload, resolved.id, ctx.user.role === "admin" ? null : ctx.user.id),
        ]);
        client = {
          clientId: resolved.id,
          clientName: context?.clientName || resolved.name || `Client ${resolved.id}`,
          facts: context?.text ?? "",
          briefs,
        };
      }
    } catch (err) {
      // The thread alone can still answer most questions.
      console.error("[mail] thread-ask client context failed:", (err as Error).message?.slice(0, 200));
    }
  }

  const { messages, leftOut } = selectAskThread(
    thread.map((message) => ({
      gmailMessageId: message.messageId,
      from: message.from,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      date: message.date,
      body: message.body,
    })),
  );
  const request = buildThreadAskRequest({ thread: messages, leftOut, client, question, history: cleanAskHistory(body.history) });
  try {
    const result = await runMailModel({ payload: ctx.payload, userId: ctx.user.id, request });
    return NextResponse.json({
      answer: result.text,
      model: result.model,
      client: client ? { id: client.clientId, name: client.clientName } : null,
      messages: messages.length,
      leftOut,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed.";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
