import { NextRequest, NextResponse } from "next/server";
import {
  buildClientAskRequest,
  cleanAskHistory,
  emailLabel,
  loadClientEmailKnowledge,
  MAX_QUESTION_CHARS,
} from "@/lib/mail/client-knowledge";
import { runMailModel } from "@/lib/mail/run-model";
import { readJson, requireMailUser } from "@/lib/mail/route-helpers";

/**
 * POST /api/mail/client-ask
 * Body: { clientId: number, question: string, history?: [{ question, answer }] }
 *
 * Answers a question about what was discussed with a client by email, from
 * the app only: the client's pulled email briefs and the saved emails that
 * best match the question. Gmail is never read here. Non-admins only see
 * their own mail (the same rule as the client-emails collection); admins see
 * every team member's. Returns { answer, sources: [{ label, id, subject, date, gmailLink }] }.
 */
export const maxDuration = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ clientId?: unknown; question?: unknown; history?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const clientId = Number(body.clientId);
  if (!Number.isSafeInteger(clientId) || clientId <= 0) {
    return NextResponse.json({ error: "clientId is required." }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "Type a question first." }, { status: 400 });
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json({ error: `Keep the question under ${MAX_QUESTION_CHARS} characters.` }, { status: 400 });
  }

  let clientName: string;
  try {
    const client = (await ctx.payload.findByID({
      collection: "clients",
      id: clientId,
      depth: 0,
      overrideAccess: true,
      select: { name: true },
    } as never)) as { name?: string | null };
    clientName = client.name?.trim() || `Client ${clientId}`;
  } catch {
    return NextResponse.json({ error: "Client not found." }, { status: 404 });
  }

  const knowledge = await loadClientEmailKnowledge({
    payload: ctx.payload,
    clientId,
    ownerId: ctx.user.role === "admin" ? null : ctx.user.id,
    question,
  });
  if (knowledge.briefs.length === 0 && knowledge.emails.length === 0) {
    return NextResponse.json({ error: "Nothing is saved for this client yet. Press Pull emails first." }, { status: 400 });
  }

  try {
    const request = buildClientAskRequest({ clientId, clientName, knowledge, question, history: cleanAskHistory(body.history) });
    const result = await runMailModel({ payload: ctx.payload, userId: ctx.user.id, request });
    return NextResponse.json({
      answer: result.text,
      model: result.model,
      sources: knowledge.emails.map((email, index) => ({
        label: emailLabel(index),
        id: email.id,
        subject: email.subject,
        date: email.date,
        gmailLink: email.gmailLink,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed.";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
