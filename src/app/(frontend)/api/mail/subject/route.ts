import { NextRequest, NextResponse } from "next/server";
import { buildMailSubjectRequest, MailModelRequestError } from "@/lib/mail/model-request";
import { runMailModel } from "@/lib/mail/run-model";
import { cleanSuggestedSubject } from "@/lib/mail/greeting";
import { readJson, requireMailUser } from "@/lib/mail/route-helpers";

/** First line only, no trailing full stop, first letter capitalised (sentence case). */
function tidySubject(raw: string): string {
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const subject = cleanSuggestedSubject(firstLine).replace(/[.。]+$/, "").trim();
  return subject.charAt(0).toUpperCase() + subject.slice(1);
}

/**
 * POST /api/mail/subject
 * Body: { body: string }
 *
 * Runs only when the user clicks the AI subject button in the compose window.
 * The model receives the body the user has written so far (their own text, no
 * mailbox content) and returns a concise, sentence-case subject line.
 * Returns { subject, model }. Never sends or saves anything.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireMailUser(req);
  if (ctx instanceof NextResponse) return ctx;
  const body = await readJson<{ body?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  let request;
  try {
    request = buildMailSubjectRequest(body.body);
  } catch (err) {
    if (err instanceof MailModelRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  try {
    const result = await runMailModel({ payload: ctx.payload, userId: ctx.user.id, request });
    const subject = tidySubject(result.text);
    if (!subject) return NextResponse.json({ error: "The AI did not suggest a subject. Please try again." }, { status: 502 });
    return NextResponse.json({ subject, model: result.model });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed.";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
