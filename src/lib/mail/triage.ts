import { extractEmailAddresses } from "./client-matching";
import { MAIL_PROMPTS, MAIL_TRIAGE_PLAN_SYSTEM } from "./prompts";
import type { MailModelRequest } from "./model-request";
import type { MessageSenderSubject } from "./gmail-mail";
import { oneClickUnsubscribeUrl } from "./unsubscribe";

/**
 * On-request inbox triage. Only senders and subject lines are used (plus
 * Gmail's bulk-mail headers as a hint); email bodies are never fetched or sent.
 *
 * To keep tokens low the model sees each SENDER once (with their unread count
 * and two sample subjects), not each email, so 1,000 newsletters from one
 * sender cost one line. Senders matching a client are put in "Clients"
 * without asking the model. Nothing here changes Gmail.
 *
 * The categories are the AI's, not fixed: a first call looks at the biggest
 * senders and proposes 3 to 8 categories for this inbox (each marked safe to
 * clear or not), then every sender is sorted into that one set. "Might need
 * a look" (anything unsure) and "Clients" always exist and are never ticked.
 */

/** Keys of the AI's categories are "ai-1", "ai-2", ...; "keep" and "clients" are always there. */
export type TriageCategoryKey = string;
const KEEP = { key: "keep", label: "Might need a look", description: "Senders the AI was unsure about or that may need action." } as const;
const CLIENTS = { key: "clients", label: "Clients", description: "Senders matching a client in the CMS (never sent to the AI)." } as const;

/** A category the AI proposed for this inbox. */
export interface PlannedCategory {
  key: TriageCategoryKey;
  label: string;
  description: string;
  /** The AI thinks these can usually be cleared unread: ticked by default. */
  clear: boolean;
}

export const MAX_PLANNED_CATEGORIES = 8;
/**
 * Output token limit for triage calls. The model thinks before answering and
 * that counts toward the limit: a full batch of senders used about 1,900 to
 * 2,300 tokens, so the old shared 2,000 cut answers off (or left them empty).
 */
export const TRIAGE_MAX_OUTPUT_TOKENS = 8000;
/** Biggest senders the planning call sees (one subject line each). */
export const TRIAGE_PLAN_SENDERS = 150;

/** Unread messages read per triage run (each is one metadata call to Gmail). */
export const MAX_TRIAGE_MESSAGES = 3000;
/** Ids per "read" step (/api/mail/triage): about 50 s at Gmail's per-user read rate. */
export const TRIAGE_READ_CHUNK = 200;
/** Senders per model call: keeps each prompt and answer small. */
export const TRIAGE_SENDERS_PER_CALL = 120;
/** Subjects returned to the screen per sender (the model only ever sees two). */
export const MAX_SUBJECTS_PER_SENDER = 50;
const MODEL_SUBJECTS_PER_SENDER = 2;

export interface TriageSender {
  address: string;
  name: string;
  count: number;
  subjects: string[];
  messageIds: string[];
  /** Any message carried List-Id / List-Unsubscribe / bulk Precedence. */
  bulk: boolean;
  /** Newest message offering one-click unsubscribe (the route re-reads its headers from Gmail). */
  unsubscribeId?: string;
}

export interface TriageCategory {
  key: TriageCategoryKey;
  label: string;
  count: number;
  defaultSelected: boolean;
  description: string;
  senders: TriageSender[];
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function displayName(from: string, address: string): string {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>/);
  return oneLine(match?.[1] || "", 80) || address;
}

/** Messages grouped by sender address, biggest senders first (then by address, for a stable order). */
export function groupBySender(messages: MessageSenderSubject[]): TriageSender[] {
  const groups = new Map<string, TriageSender>();
  for (const message of messages) {
    const address = (extractEmailAddresses(message.from)[0] ?? oneLine(message.from, 200)).toLowerCase() || "(unknown sender)";
    let group = groups.get(address);
    if (!group) {
      group = { address, name: displayName(message.from, address), count: 0, subjects: [], messageIds: [], bulk: false };
      groups.set(address, group);
    }
    group.count += 1;
    group.messageIds.push(message.messageId);
    const subject = oneLine(message.subject, 150) || "(no subject)";
    if (group.subjects.length < MAX_SUBJECTS_PER_SENDER && !group.subjects.includes(subject)) group.subjects.push(subject);
    if ((message.listId ?? "").trim() || (message.listUnsubscribe ?? "").trim() || /bulk|list/i.test(message.precedence ?? "")) {
      group.bulk = true;
    }
    if (!group.unsubscribeId && oneClickUnsubscribeUrl(message.listUnsubscribe, message.listUnsubscribePost)) {
      group.unsubscribeId = message.messageId;
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
}

/** Numbered lines of sender, count, bulk flag and up to `subjectsPerSender` subjects. */
function senderLines(senders: TriageSender[], subjectsPerSender: number): string {
  return senders
    .map((sender, i) => {
      const subjects = sender.subjects
        .slice(0, subjectsPerSender)
        .map((subject) => oneLine(subject, 80))
        .join(" / ");
      const name = sender.name === sender.address ? "" : `${oneLine(sender.name, 40)} `;
      return `${i + 1}. ${name}<${sender.address}> | ${sender.count} unread${sender.bulk ? " | bulk" : ""} | ${subjects}`;
    })
    .join("\n");
}

function triageRequest(system: string, text: string, senders: TriageSender[]): MailModelRequest {
  return {
    action: "triage",
    system,
    messages: [{ role: "user", text }],
    gmailMessageId: null,
    emailCount: senders.reduce((sum, sender) => sum + sender.count, 0),
    suggestSubject: false,
    clientId: null,
    revise: null,
    maxTokens: TRIAGE_MAX_OUTPUT_TOKENS,
  };
}

/** First call: the biggest senders, one subject each, for the AI to propose this inbox's categories. */
export function buildTriagePlanRequest(senders: TriageSender[]): MailModelRequest {
  const sample = senders.slice(0, TRIAGE_PLAN_SENDERS);
  return triageRequest(
    MAIL_TRIAGE_PLAN_SYSTEM,
    `Senders:\n${senderLines(sample, 1)}\n\nPropose the categories for this inbox.`,
    sample,
  );
}

/**
 * The plan's JSON → up to MAX_PLANNED_CATEGORIES categories with unique
 * names. Throws if no usable category came back (the run cannot sort without one).
 */
export function parseTriagePlan(text: string): PlannedCategory[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let parsed: unknown = null;
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  const rows = parsed && typeof parsed === "object" ? (parsed as { categories?: unknown }).categories : null;
  const out: PlannedCategory[] = [];
  const seen = new Set<string>([KEEP.label.toLowerCase(), "keep", CLIENTS.label.toLowerCase(), "client"]);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const { name, description, clear } = row as Record<string, unknown>;
    const label = typeof name === "string" ? oneLine(name, 40) : "";
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({
      key: `ai-${out.length + 1}`,
      label,
      description: typeof description === "string" ? oneLine(description, 200) : "",
      clear: clear === true,
    });
    if (out.length === MAX_PLANNED_CATEGORIES) break;
  }
  if (out.length === 0) throw new Error("The AI did not suggest any categories.");
  return out;
}

/** One sorting call for a batch of senders, against the planned categories (numbered 1..n, plus k). */
export function buildTriageRequest(senders: TriageSender[], categories: PlannedCategory[]): MailModelRequest {
  const list = categories.map((category, i) => `${i + 1} = ${category.label}${category.description ? ` (${category.description})` : ""}`);
  return triageRequest(
    `${MAIL_PROMPTS.triage.system} Categories, one number each: ${list.join("; ")}.`,
    `Senders:\n${senderLines(senders, MODEL_SUBJECTS_PER_SENDER)}\n\n${MAIL_PROMPTS.triage.defaultInstruction}`,
    senders,
  );
}

/** "12 3" / "7 k" lines → sender index (0-based) → category key. Anything missing or unreadable stays "keep". */
export function parseTriageAnswer(text: string, senderCount: number, categories: PlannedCategory[]): TriageCategoryKey[] {
  const out: TriageCategoryKey[] = Array.from({ length: senderCount }, () => KEEP.key);
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)[.):\-\s]+(\d+|k)\b/i);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    const code = (match[2] ?? "").toLowerCase();
    const key = code === "k" ? KEEP.key : categories[Number(code) - 1]?.key;
    if (key && index >= 0 && index < senderCount) out[index] = key;
  }
  return out;
}

/**
 * Sort the senders into categories. `classify` runs one model call and
 * returns its text; `isClient` keeps client senders away from the model.
 * The first call plans the categories (if it fails, the run fails); a failed
 * sorting batch leaves its senders in "keep" rather than failing the run.
 */
export async function triageSenders(args: {
  senders: TriageSender[];
  isClient: (address: string) => boolean;
  classify: (request: MailModelRequest) => Promise<string>;
  concurrency?: number;
}): Promise<{ categories: TriageCategory[]; failedBatches: number; batches: number }> {
  const assigned = new Map<string, TriageCategoryKey>();
  const forModel: TriageSender[] = [];
  for (const sender of args.senders) {
    if (args.isClient(sender.address)) assigned.set(sender.address, "clients");
    else forModel.push(sender);
  }

  const planned = forModel.length > 0 ? parseTriagePlan(await args.classify(buildTriagePlanRequest(forModel))) : [];

  const batches: TriageSender[][] = [];
  for (let i = 0; i < forModel.length; i += TRIAGE_SENDERS_PER_CALL) batches.push(forModel.slice(i, i + TRIAGE_SENDERS_PER_CALL));
  let failedBatches = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(args.concurrency ?? 3, batches.length) }, async () => {
    while (next < batches.length) {
      const batch = batches[next++] ?? [];
      let keys: TriageCategoryKey[];
      try {
        keys = parseTriageAnswer(await args.classify(buildTriageRequest(batch, planned)), batch.length, planned);
      } catch {
        failedBatches += 1;
        keys = batch.map(() => KEEP.key);
      }
      batch.forEach((sender, i) => assigned.set(sender.address, keys[i] ?? KEEP.key));
    }
  });
  await Promise.all(workers);

  const all = [
    ...planned.map((category) => ({ ...category, defaultSelected: category.clear })),
    { ...KEEP, defaultSelected: false },
    { ...CLIENTS, defaultSelected: false },
  ];
  const categories = all.map((category) => {
    const senders = args.senders.filter((sender) => assigned.get(sender.address) === category.key);
    return {
      key: category.key,
      label: category.label,
      description: category.description,
      defaultSelected: category.defaultSelected,
      count: senders.reduce((sum, sender) => sum + sender.count, 0),
      senders,
    };
  }).filter((category) => category.senders.length > 0);
  return { categories, failedBatches, batches: batches.length };
}
