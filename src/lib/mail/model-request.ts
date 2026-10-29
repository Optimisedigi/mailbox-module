import {
  MAIL_DRAFT_WITH_SUBJECT_SYSTEM,
  MAIL_LENGTH_INSTRUCTIONS,
  MAIL_PROMPTS,
  MAIL_SELECTION_SYSTEM,
  mailReviseSystem,
  type MailLengthMode,
  type MailModelAction,
} from "./prompts";
import { numberBlocks } from "./revise-edits";

/**
 * The only way the Mail view builds model input. It takes at most ONE email
 * (never a list), so the model can never receive the inbox, a thread or other
 * client emails. `reply` and `summarise` require exactly one email; `draft`
 * takes none.
 *
 * Opt-in thread context: when the user ticks "Use whole thread", a reply may
 * also include the OTHER messages of that same Gmail thread (loaded server-side
 * from the selected message's own thread id, never a client-supplied id). That
 * is the user explicitly asking for that specific content; it is capped, and
 * never reaches other threads, the inbox or other clients' mail.
 *
 * Revising a draft (chat-style "keep prompting"): the model gets the
 * current draft, as the user may have edited it, split into numbered blocks,
 * plus the earlier requests, and answers with only the edits the new request
 * needs (see revise-edits.ts), so the rest of the email stays as it is. The
 * draft and requests are the user's own text, not mailbox content, so the
 * one-email rule still holds.
 *
 * Opt-in client data: when the user ticks "Use client data", a reply or new
 * draft may also include a short block of client facts from the CMS (see
 * client-context.ts). The client is always resolved server-side from the
 * selected message or the recipients, never from a client-supplied id, and
 * only client-safe facts are included. Summaries and TLDRs never take client
 * data, history or a draft.
 */

export interface MailModelEmail {
  gmailMessageId: string;
  from: string;
  to?: string;
  cc?: string;
  subject: string;
  date?: string;
  body: string;
}

/** One earlier round: what the user asked for and the draft that came back. */
export interface MailDraftTurn {
  instruction: string;
  draft: string;
}

export interface MailModelMessage {
  role: "user" | "assistant";
  text: string;
}

export interface MailModelRequest {
  action: MailModelAction;
  system: string;
  messages: MailModelMessage[];
  /** Gmail id of the one email included, or null for a fresh draft. */
  gmailMessageId: string | null;
  /** Emails included: 0 (new draft), 1 (default) or the thread size when opted in. Logged with every call. */
  emailCount: number;
  /** The reply starts with a "Subject:" line to split off (first draft of a new email only). */
  suggestSubject: boolean;
  /** Client whose CMS facts were included (opt-in), or null. Logged with every call. */
  clientId: number | null;
  /** A revision: the numbered blocks the model's edits refer to; null when writing from scratch. */
  revise: { blocks: string[] } | null;
  /**
   * Output token limit for this call (default 2000). Haiku's thinking counts
   * toward it, so long answers such as triage need more room.
   */
  maxTokens?: number;
  /** Sampling temperature; run-model.ts picks one by action when unset. */
  temperature?: number;
}

/** Opt-in CMS facts for one server-resolved client. */
export interface MailClientContextInput {
  clientId: number;
  clientName: string;
  text: string;
}

export const MAX_EMAIL_BODY_CHARS = 20_000;
export const MAX_INSTRUCTION_CHARS = 4_000;
export const MAX_DRAFT_CHARS = 12_000;
/** Most blocks (paragraphs, lists, tables) a draft being revised can have. */
export const MAX_REVISE_BLOCKS = 200;
/** Earlier refine rounds kept in the conversation (oldest dropped first). */
export const MAX_HISTORY_TURNS = 8;
/** Opt-in thread context limits: most recent messages kept, oldest dropped first. */
export const MAX_THREAD_MESSAGES = 15;
export const MAX_THREAD_MESSAGE_CHARS = 6_000;
export const MAX_THREAD_TOTAL_CHARS = 40_000;

export class MailModelRequestError extends Error {}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Validate and trim client-supplied refine history. Bad entries are dropped. */
export function cleanDraftHistory(raw: unknown): MailDraftTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: MailDraftTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const instruction = clean((item as { instruction?: unknown }).instruction, MAX_INSTRUCTION_CHARS);
    const draft = clean((item as { draft?: unknown }).draft, MAX_DRAFT_CHARS);
    if (draft) turns.push({ instruction, draft });
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}

/**
 * The draft being revised, as blocks: the editor's own blocks when sent, else
 * the draft text split at blank lines. Too long a draft is refused rather
 * than cut, because cutting it would lose the end of the email.
 */
export function cleanDraftBlocks(blocks: unknown, fallbackText: string): string[] {
  const list = Array.isArray(blocks)
    ? blocks.filter((block): block is string => typeof block === "string").map((block) => block.replace(/\r\n?/g, "\n").trim())
    : fallbackText.split(/\n\s*\n/).map((block) => block.trim());
  const kept = list.filter(Boolean);
  const total = kept.reduce((sum, block) => sum + block.length, 0);
  if (kept.length > MAX_REVISE_BLOCKS || total > MAX_DRAFT_CHARS) {
    throw new MailModelRequestError("This email is too long for the AI to revise. Shorten it or edit it by hand.");
  }
  return kept;
}

function emailBlock(email: MailModelEmail): string {
  return [
    "The email:",
    `From: ${email.from}`,
    ...(email.to ? [`To: ${email.to}`] : []),
    ...(email.cc ? [`Cc: ${email.cc}`] : []),
    `Subject: ${email.subject || "(no subject)"}`,
    ...(email.date ? [`Date: ${email.date}`] : []),
    "",
    email.body.slice(0, MAX_EMAIL_BODY_CHARS),
  ].join("\n");
}

/**
 * Earlier messages of the selected email's thread, oldest first, excluding the
 * selected email itself, capped by count and size (newest kept).
 */
export function selectThreadContext(thread: MailModelEmail[], selectedId: string): MailModelEmail[] {
  const others = thread.filter((message) => message.gmailMessageId !== selectedId).slice(-MAX_THREAD_MESSAGES);
  const kept: MailModelEmail[] = [];
  let total = 0;
  for (let i = others.length - 1; i >= 0; i--) {
    const message = { ...others[i]!, body: others[i]!.body.slice(0, MAX_THREAD_MESSAGE_CHARS) };
    total += message.body.length;
    if (total > MAX_THREAD_TOTAL_CHARS) break;
    kept.unshift(message);
  }
  return kept;
}

function threadBlock(thread: MailModelEmail[]): string {
  if (thread.length === 0) return "";
  const parts = thread.map((message, index) =>
    [
      `--- Earlier message ${index + 1} of ${thread.length} ---`,
      `From: ${message.from}`,
      ...(message.to ? [`To: ${message.to}`] : []),
      ...(message.date ? [`Date: ${message.date}`] : []),
      "",
      message.body,
    ].join("\n"),
  );
  return [
    "Earlier messages in this same thread, oldest first, for context only. Reply to the email below, not to these:",
    "",
    ...parts,
    "",
    "--- End of earlier messages ---",
    "",
  ].join("\n");
}

function clientContextBlock(context: MailClientContextInput): string {
  return [
    `Facts about ${context.clientName} from our CMS, for reference only. Use a fact when the user asks for it or it helps this email; never invent or estimate numbers, and never mention that these facts came from a CMS or that you were given them:`,
    "",
    context.text,
    "",
    "--- End of CMS facts ---",
    "",
  ].join("\n");
}

export function buildMailModelRequest(args: {
  action: MailModelAction;
  email?: MailModelEmail | null;
  /** Opt-in (reply only): other messages from the selected email's own thread. */
  thread?: MailModelEmail[] | null;
  instruction?: string | null;
  /** Earlier refine rounds (reply/draft only). */
  history?: MailDraftTurn[];
  /** The draft as it stands now, including the user's own edits. */
  currentDraft?: string | null;
  /** The same draft as the editor's blocks (preferred over currentDraft: the edits refer to these). */
  currentBlocks?: string[] | null;
  /** New email, first request only: also ask the model for a subject line ("Subject: ..." first line). */
  suggestSubject?: boolean;
  /** Opt-in (reply/draft only): CMS facts for the server-resolved client. */
  clientContext?: MailClientContextInput | null;
}): MailModelRequest {
  const prompt = MAIL_PROMPTS[args.action];
  if (!prompt) throw new MailModelRequestError(`Unknown mail action: ${String(args.action)}`);
  if (args.action === "subject" || args.action === "triage" || args.action === "client-brief" || args.action === "client-ask" || args.action === "thread-ask") {
    throw new MailModelRequestError(`Use the dedicated builder for ${args.action}.`);
  }
  if (Array.isArray(args.email)) {
    throw new MailModelRequestError("Only one email can be sent to the model per request.");
  }
  const instruction = clean(args.instruction, MAX_INSTRUCTION_CHARS);
  // Summaries and TLDRs read the one email only: no refine history, no draft.
  const readOnly = args.action === "summarise" || args.action === "tldr";
  const history = readOnly ? [] : cleanDraftHistory(args.history);
  const currentDraft = readOnly ? "" : typeof args.currentDraft === "string" ? args.currentDraft : "";
  // The draft as it stands (or, if the window sent none, the last one the AI wrote).
  const blocks =
    readOnly
      ? []
      : cleanDraftBlocks(args.currentBlocks ?? null, currentDraft.trim() || history[history.length - 1]?.draft || "");
  const refining = blocks.length > 0;

  let email: MailModelEmail | null = null;
  if (args.clientContext && readOnly) {
    throw new MailModelRequestError("Client data is only used for replies and new emails.");
  }
  const clientContext = args.clientContext?.text.trim() ? args.clientContext : null;
  const clientPrefix = clientContext ? clientContextBlock(clientContext) : "";
  if (args.thread && args.action !== "reply") {
    throw new MailModelRequestError("Thread context is only used for replies.");
  }
  if (args.action === "draft") {
    if (args.email) throw new MailModelRequestError("A new draft does not take an email.");
    if (!instruction && !refining) throw new MailModelRequestError("Write an instruction for the new email.");
  } else {
    if (!args.email || !args.email.gmailMessageId) throw new MailModelRequestError("Select one email first.");
    email = args.email;
  }
  if (refining && !instruction) throw new MailModelRequestError("Say what to change in the draft.");
  const threadContext = email && args.thread ? selectThreadContext(args.thread, email.gmailMessageId) : [];

  const opening = (firstInstruction: string) =>
    args.action === "draft"
      ? `${clientPrefix}My instruction for the new email:\n${firstInstruction}`
      : `${clientPrefix}${threadContext.length ? threadBlock(threadContext) : ""}${emailBlock(email!)}\n\nMy instruction:\n${firstInstruction || prompt.defaultInstruction}`;

  const messages: MailModelMessage[] = [];
  if (!refining) {
    messages.push({ role: "user", text: opening(instruction) });
  } else {
    // One message: the context, what was asked before, the numbered draft and the change.
    const context =
      args.action === "draft"
        ? clientPrefix
        : `${clientPrefix}${threadContext.length ? threadBlock(threadContext) : ""}${emailBlock(email!)}\n\n`;
    const earlier = history.map((turn) => turn.instruction).filter(Boolean);
    messages.push({
      role: "user",
      text: [
        context.trimEnd(),
        ...(earlier.length
          ? ["", "My earlier requests for this email (already applied to the draft):", ...earlier.map((item) => `- ${item}`)]
          : []),
        "",
        "The current draft, including any edits I made myself, as numbered blocks:",
        "",
        numberBlocks(blocks),
        "",
        `My request: ${instruction}`,
        "",
        "Answer with the JSON edits only.",
      ]
        .join("\n")
        .trimStart(),
    });
  }

  const withSubject = args.action === "draft" && args.suggestSubject === true && !refining;
  return {
    action: args.action,
    system: refining ? mailReviseSystem(args.action === "reply" ? "reply" : "draft") : withSubject ? MAIL_DRAFT_WITH_SUBJECT_SYSTEM : prompt.system,
    suggestSubject: withSubject,
    messages,
    gmailMessageId: email?.gmailMessageId ?? null,
    emailCount: email ? 1 + threadContext.length : 0,
    clientId: clientContext?.clientId ?? null,
    revise: refining ? { blocks } : null,
  };
}

/**
 * Subject line for the email being written: the model gets only the body the
 * user has written so far (their own text, no mailbox content), no history,
 * no client facts.
 */
export function buildMailSubjectRequest(body: unknown): MailModelRequest {
  const text = clean(body, MAX_DRAFT_CHARS);
  if (!text) throw new MailModelRequestError("Write the email first, then ask for a subject.");
  return {
    action: "subject",
    system: MAIL_PROMPTS.subject.system,
    messages: [{ role: "user", text: `The email body:\n\n${text}\n\n${MAIL_PROMPTS.subject.defaultInstruction}` }],
    gmailMessageId: null,
    emailCount: 0,
    suggestSubject: false,
    clientId: null,
    revise: null,
  };
}

/**
 * Rewrite one highlighted passage of the email being written: Shorten or
 * Lengthen it, or follow the user's own request. The model gets the user's
 * draft (their own text, no mailbox content) for context, nothing else.
 * Logged as a "draft" request: it is the user's draft being revised.
 */
export function buildMailSelectionRequest(args: {
  mode: unknown;
  instruction?: unknown;
  selection: unknown;
  draft: unknown;
  /** Opt-in ("Use client data"): facts for the server-resolved client. */
  clientContext?: MailClientContextInput | null;
}): MailModelRequest {
  const selection = typeof args.selection === "string" ? args.selection.replace(/\r\n?/g, "\n") : "";
  if (!selection.trim()) throw new MailModelRequestError("Highlight the text to change first.");
  if (selection.length > MAX_DRAFT_CHARS) throw new MailModelRequestError("The highlighted text is too long. Highlight less of it.");
  const draft = clean(args.draft, MAX_DRAFT_CHARS);
  let request: string;
  if (args.mode === "shorten" || args.mode === "lengthen") {
    request = MAIL_LENGTH_INSTRUCTIONS.selection[args.mode satisfies MailLengthMode];
  } else if (args.mode === "instruction") {
    request = clean(args.instruction, MAX_INSTRUCTION_CHARS);
    if (!request) throw new MailModelRequestError("Say what to change in the highlighted text.");
  } else {
    throw new MailModelRequestError("mode must be shorten, lengthen or instruction.");
  }
  return {
    action: "draft",
    system: MAIL_SELECTION_SYSTEM,
    messages: [
      {
        role: "user",
        text: [
          ...(args.clientContext?.text.trim() ? [clientContextBlock(args.clientContext)] : []),
          ...(draft ? ["My draft, for context:", "", draft, ""] : []),
          "--- The highlighted passage to rewrite ---",
          selection.trim(),
          "--- End of passage ---",
          "",
          `My request: ${request}`,
        ].join("\n"),
      },
    ],
    gmailMessageId: null,
    emailCount: 0,
    suggestSubject: false,
    clientId: args.clientContext?.clientId ?? null,
    revise: null,
    temperature: 0.3,
  };
}

/**
 * The model's passage, ready to replace the highlight: code fences, quotes the
 * passage did not have and the passage markers are dropped, and the highlight's
 * own leading and trailing spaces and line breaks are kept, so the words around
 * it do not run together.
 */
export function cleanSelectionRewrite(raw: string, original: string): string {
  let text = raw.replace(/\r\n?/g, "\n").trim();
  text = text.replace(/^```[a-z]*\n([\s\S]*?)\n```$/i, "$1").trim();
  text = text.replace(/^---[^\n]*---\n/, "").replace(/\n---[^\n]*---$/, "").trim();
  const core = original.trim();
  for (const [open, close] of [['"', '"'], ["\u201c", "\u201d"], ["'", "'"]] as const) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close) && !(core.startsWith(open) && core.endsWith(close))) {
      text = text.slice(open.length, -close.length).trim();
    }
  }
  if (!text) return "";
  const lead = original.match(/^\s*/)?.[0] ?? "";
  const trail = original.match(/\s*$/)?.[0] ?? "";
  return `${lead}${text}${trail}`;
}
