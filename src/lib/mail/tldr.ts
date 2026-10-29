import { z } from "zod";

/**
 * A private TLDR of one email for the person reading it in Mail: a summary,
 * suggested next steps, clarifying questions (only when the email leaves
 * something out) and a suggested reply instruction. Display only: it is
 * never saved, never put in an email body and never sent. The suggested reply
 * only ever goes into the compose window's Write with AI instruction box.
 */
export interface MailTldr {
  summary: string;
  actions: string[];
  /** Questions to ask the sender when the email leaves out something we need; [] when it covers everything. */
  questions: string[];
  /** Instruction for drafting the reply, or "" when no reply is needed. */
  reply: string;
}

const MAX_SUMMARY_CHARS = 1_500;
const MAX_ACTIONS = 5;
const MAX_ACTION_CHARS = 300;
const MAX_QUESTIONS = 4;
const MAX_QUESTION_CHARS = 300;
const MAX_REPLY_CHARS = 600;

const tldrSchema = z.object({
  summary: z.string(),
  actions: z.array(z.unknown()).optional(),
  questions: z.array(z.unknown()).optional(),
  reply: z.unknown().optional(),
});

/** Parse the model's JSON answer; null when it is not a usable TLDR. */
export function parseMailTldr(raw: string): MailTldr | null {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = tldrSchema.safeParse(json);
  if (!parsed.success) return null;
  const summary = parsed.data.summary.trim().slice(0, MAX_SUMMARY_CHARS);
  if (!summary) return null;
  const actions = textList(parsed.data.actions, MAX_ACTIONS, MAX_ACTION_CHARS);
  const questions = textList(parsed.data.questions, MAX_QUESTIONS, MAX_QUESTION_CHARS);
  const reply = typeof parsed.data.reply === "string" ? parsed.data.reply.trim().slice(0, MAX_REPLY_CHARS) : "";
  return { summary, actions, questions, reply };
}

/** Non-empty strings only, trimmed and capped. */
function textList(items: unknown[] | undefined, max: number, maxChars: number): string[] {
  return (items ?? [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxChars))
    .filter(Boolean)
    .slice(0, max);
}

/** Write with AI instruction for a reply that asks the sender the clarifying questions. */
export function clarifyingReplyPrompt(questions: string[]): string {
  return ["Thank them and ask these questions before we act on it:", ...questions.map((question) => `- ${question}`)].join("\n");
}
