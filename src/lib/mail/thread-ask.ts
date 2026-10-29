import type { Payload } from "payload";
import { stripQuotedText } from "./export";
import { MAX_QUESTION_CHARS, toBriefView, type AskTurn, type ClientEmailBriefView } from "./client-knowledge";
import type { MailModelEmail, MailModelRequest } from "./model-request";
import { MAIL_PROMPTS } from "./prompts";

/**
 * "Ask AI" in the Mail reading pane: questions about the open thread. The
 * model gets every message of that one thread and, when the thread is linked
 * to a client, that client's email briefs (Pull emails) and client-safe facts. Read-only: no tools, nothing drafted, sent,
 * saved or changed; the answer is shown as plain text.
 */

export const MAX_ASK_THREAD_MESSAGES = 40;
export const MAX_ASK_THREAD_MESSAGE_CHARS = 8_000;
export const MAX_ASK_THREAD_TOTAL_CHARS = 60_000;
const MAX_ASK_CLIENT_BRIEFS = 3;
const MAX_ASK_CLIENT_BRIEF_CHARS = 12_000;
export const THREAD_ASK_MAX_OUTPUT_TOKENS = 6_000;

export { MAX_QUESTION_CHARS };

export interface ThreadAskClient {
  clientId: number;
  clientName: string;
  /** Client-safe facts (client-context.ts); "" when none. */
  facts: string;
  briefs: ClientEmailBriefView[];
}

/**
 * The thread as the model sees it, oldest first. Whole bodies when they fit;
 * otherwise quoted earlier replies are dropped (those messages are in the
 * thread already), then the oldest messages, so the newest are always kept.
 */
export function selectAskThread(thread: MailModelEmail[]): { messages: MailModelEmail[]; leftOut: number } {
  const recent = thread.slice(-MAX_ASK_THREAD_MESSAGES);
  const total = (list: MailModelEmail[]) => list.reduce((sum, message) => sum + message.body.length, 0);
  let bodies = recent.map((message) => ({ ...message, body: message.body.trim().slice(0, MAX_ASK_THREAD_MESSAGE_CHARS) }));
  if (total(bodies) > MAX_ASK_THREAD_TOTAL_CHARS) {
    bodies = recent.map((message) => ({ ...message, body: stripQuotedText(message.body).slice(0, MAX_ASK_THREAD_MESSAGE_CHARS) }));
  }
  const kept: MailModelEmail[] = [];
  let used = 0;
  for (let i = bodies.length - 1; i >= 0; i--) {
    const message = bodies[i];
    if (!message) continue;
    if (used + message.body.length > MAX_ASK_THREAD_TOTAL_CHARS && kept.length > 0) break;
    kept.unshift(message);
    used += message.body.length;
  }
  return { messages: kept, leftOut: thread.length - kept.length };
}

/** The client's Pull emails briefs, newest first; `ownerId` limits them to one team member's (non-admins). */
export async function loadClientEmailBriefs(
  payload: Pick<Payload, "find">,
  clientId: number,
  ownerId: number | null,
): Promise<ClientEmailBriefView[]> {
  const res = await payload.find({
    collection: "client-email-briefs",
    where: { and: [{ client: { equals: clientId } }, ...(ownerId === null ? [] : [{ owner: { equals: ownerId } }])] },
    sort: "-lastPulledAt",
    limit: MAX_ASK_CLIENT_BRIEFS,
    depth: 0,
    overrideAccess: true,
  } as never);
  return (res as unknown as { docs: Parameters<typeof toBriefView>[0][] }).docs.map(toBriefView).filter((brief) => brief.brief.trim());
}

function day(iso: string | null | undefined): string {
  if (!iso) return "undated";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "undated" : date.toISOString().slice(0, 10);
}

function clientBlock(client: ThreadAskClient): string[] {
  const briefs = client.briefs.map((brief) =>
    [
      `--- Email summary from ${brief.account || "a team mailbox"} (pulled ${day(brief.lastPulledAt)}, emails ${day(brief.firstEmailDate)} to ${day(brief.lastEmailDate)}) ---`,
      brief.brief.trim().slice(0, MAX_ASK_CLIENT_BRIEF_CHARS),
    ].join("\n"),
  );
  return [
    `This thread is linked to the client ${client.clientName}.`,
    "",
    "--- Client facts from our CMS ---",
    client.facts.trim() || "None recorded.",
    "",
    briefs.length ? briefs.join("\n\n") : "No email summary has been pulled for this client yet.",
    "",
    "--- End of client material ---",
    "",
  ];
}

/** The model request for one question about the open thread. */
export function buildThreadAskRequest(args: {
  thread: MailModelEmail[];
  leftOut: number;
  client: ThreadAskClient | null;
  question: string;
  history: AskTurn[];
}): MailModelRequest {
  const messages = args.thread.map((message, index) =>
    [
      `--- Message ${index + 1} of ${args.thread.length} ---`,
      `From: ${message.from}`,
      ...(message.to ? [`To: ${message.to}`] : []),
      ...(message.cc ? [`Cc: ${message.cc}`] : []),
      ...(message.date ? [`Date: ${message.date}`] : []),
      `Subject: ${message.subject || "(no subject)"}`,
      "",
      message.body || "(no text)",
    ].join("\n"),
  );
  const text = [
    ...(args.client ? clientBlock(args.client) : ["This thread is not linked to a client.", ""]),
    `The email thread, oldest first${args.leftOut ? ` (${args.leftOut} older messages were left out to fit)` : ""}:`,
    "",
    messages.join("\n\n"),
    "",
    "--- End of thread ---",
    ...(args.history.length ? ["", "Conversation so far:", ...args.history.flatMap((turn) => [`Q: ${turn.question}`, `A: ${turn.answer}`])] : []),
    "",
    `Question: ${args.question.trim().slice(0, MAX_QUESTION_CHARS)}`,
  ].join("\n");
  return {
    action: "thread-ask",
    system: MAIL_PROMPTS["thread-ask"].system,
    messages: [{ role: "user", text }],
    gmailMessageId: args.thread.at(-1)?.gmailMessageId ?? null,
    emailCount: args.thread.length,
    suggestSubject: false,
    clientId: args.client?.clientId ?? null,
    revise: null,
    maxTokens: THREAD_ASK_MAX_OUTPUT_TOKENS,
  };
}
