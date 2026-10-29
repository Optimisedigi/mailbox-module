import type { Payload } from "payload";
import {
  buildClientDomainIndex,
  extractEmailAddresses,
  matchMessageToClient,
  SHARED_MAILBOX_DOMAINS,
  normaliseDomain,
  type MatchableClient,
} from "./client-matching";
import {
  getFullMessage,
  getMailboxProfile,
  getMessageHeaders,
  isSyncableLabelSet,
  listMessageIdsMatching,
  mapLimited,
} from "./gmail-mail";
import { findStoredMessageIds, storeClientEmail, toClientEmailInput } from "./store";
import { isAutomatedMessage } from "./automated-senders";
import { isHiddenSender, loadHiddenSenders } from "./hidden-senders";
import { stripQuotedText } from "./export";
import { MAIL_PROMPTS } from "./prompts";
import type { MailModelRequest } from "./model-request";

/**
 * "Pull emails" on a client's Emails tab, and the questions asked afterwards.
 *
 * A pull runs only when a team member presses the button. It searches ONE
 * Gmail account (the one they picked) for mail to or from the client's
 * domains and contact addresses over the last 12 months (later pulls: only
 * since the last one), saves those emails to client-emails like Mail's sync
 * does, and has the AI write (or update) a brief of what was discussed. The
 * brief lives in client-email-briefs, one row per client, team member and
 * Gmail account.
 *
 * What counts as "the client's emails" is the client's search settings
 * (client-email-pull-settings, shared by the team): by default its own
 * domains and contacts; for a client that emails from a parent company's
 * domain, chosen sender addresses/domains and/or keywords instead, matching
 * any of them or a sender AND a keyword. Changing the settings starts the
 * brief afresh on the next pull.
 *
 * Questions (the Emails tab) are answered
 * from the stored briefs plus the saved emails that best match the question.
 * Neither reads Gmail, so nothing stays connected to the client's mail.
 *
 * Email content is untrusted: it is only ever given to the model as data,
 * the model has no tools here, and its output is shown as plain text.
 */

export const CLIENT_PULL_DAYS = 365;
/** Most emails one pull reads (newest first); a client with more gets the newest. */
export const MAX_PULL_EMAILS = 300;
/** Later pulls start this much before the last one, so mail that arrived mid-pull is not missed. */
const PULL_OVERLAP_MS = 2 * 24 * 60 * 60 * 1000;
/** A second press within this window does not start another pull. */
export const PULL_COOLDOWN_MS = 60 * 1000;
/** Most addresses and domains put in one Gmail search. */
const MAX_SEARCH_TARGETS = 25;
const MAX_BRIEF_EMAIL_CHARS = 2_000;
const MAX_BRIEF_INPUT_CHARS = 120_000;
export const MAX_BRIEF_CHARS = 40_000;
export const MAX_QUESTION_CHARS = 1_000;
const MAX_ASK_HISTORY_TURNS = 6;
const MAX_ASK_HISTORY_CHARS = 2_000;
/** Saved emails scanned for a question (newest first), and how many go to the model. */
const MAX_ASK_SCAN = 500;
const MAX_ASK_EMAILS = 12;
const MAX_ASK_EXCERPT_CHARS = 1_500;
const MAX_ASK_BRIEFS = 5;
/** Most Gmail ids a brief remembers (the newest kept), and how many questions look up. */
const MAX_BRIEF_MESSAGE_IDS = 3_000;
const MAX_ASK_BRIEF_IDS = 1_000;
export const MAX_FILTER_SENDERS = 20;
export const MAX_FILTER_KEYWORDS = 10;
const MAX_KEYWORD_CHARS = 60;
/**
 * Output token limits. The email model thinks before answering and that counts
 * toward the limit: a 90-email brief used up 3,500 tokens thinking and came back
 * empty ("stopped at the output limit"), so these leave plenty of room.
 */
export const BRIEF_MAX_OUTPUT_TOKENS = 16_000;
export const ASK_MAX_OUTPUT_TOKENS = 6_000;

type PayloadLike = Pick<Payload, "find" | "findByID" | "create" | "update" | "count">;

export interface ClientEmailTargets {
  /** Client domains (website, contact domains); shared mail providers excluded. */
  domains: string[];
  /** Contact addresses on shared mail providers (gmail.com etc.), matched exactly. */
  addresses: string[];
}

/**
 * What to search Gmail for: the client's own domains, plus contact addresses
 * on shared providers (a gmail.com contact cannot be searched by domain).
 * Our own domains are never included. Sorted, so the query is stable.
 */
export function clientEmailTargets(client: MatchableClient, ownAddresses: string[]): ClientEmailTargets {
  const index = buildClientDomainIndex([client], { ownAddresses });
  const domains = [...index.domains.keys()].sort();
  const addresses = [...index.addresses.keys()]
    .filter((address) => SHARED_MAILBOX_DOMAINS.has(normaliseDomain(address)))
    .sort();
  return { domains, addresses };
}

/** How a client's emails are found (client-email-pull-settings). */
export interface ClientPullSettings {
  /** Search the client's own website domain and contact addresses. */
  useClientContacts: boolean;
  /** Extra sender/recipient addresses or domains (lower case, validated). */
  senders: string[];
  /** Keywords or phrases (cleaned, see cleanKeyword). */
  keywords: string[];
  /** any: any sender OR any keyword; all: a sender AND a keyword. */
  matchMode: "any" | "all";
}

export const DEFAULT_PULL_SETTINGS: ClientPullSettings = { useClientContacts: true, senders: [], keywords: [], matchMode: "any" };

const ADDRESS_ONLY_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** One sender entry as an address or a bare domain (an "@" prefix is dropped), or null when it is neither. */
export function cleanSender(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/^mailto:/, "");
  if (!value) return null;
  if (ADDRESS_ONLY_RE.test(value)) return value.length <= 254 ? value : null;
  if (value.includes("@") && !value.startsWith("@")) return null;
  const domain = normaliseDomain(value.replace(/^@/, ""));
  return domain || null;
}

/**
 * A keyword as it goes into the Gmail search, inside quotes: quotes, braces,
 * brackets and other search syntax are removed so it can only ever be a phrase.
 */
export function cleanKeyword(raw: string): string | null {
  const value = raw
    .replace(/["{}()[\]\\<>]/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_KEYWORD_CHARS)
    .trim();
  return value.length >= 2 ? value : null;
}

function listOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  return typeof raw === "string" ? raw.split(/[\n,;]+/) : [];
}

/**
 * Validate settings from the browser. Bad senders are reported back rather
 * than silently dropped, so the user sees what was not understood.
 */
export function parsePullSettings(raw: unknown): { ok: true; settings: ClientPullSettings } | { ok: false; error: string } {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const senders: string[] = [];
  const invalid: string[] = [];
  for (const entry of listOf(input.senders)) {
    if (!entry.trim()) continue;
    const sender = cleanSender(entry);
    if (sender) {
      if (!senders.includes(sender)) senders.push(sender);
    } else invalid.push(entry.trim().slice(0, 60));
  }
  if (invalid.length) return { ok: false, error: `Not an email address or domain: ${invalid.slice(0, 3).join(", ")}` };
  if (senders.length > MAX_FILTER_SENDERS) return { ok: false, error: `Add up to ${MAX_FILTER_SENDERS} senders.` };
  const keywords: string[] = [];
  for (const entry of listOf(input.keywords)) {
    const keyword = cleanKeyword(entry);
    if (keyword && !keywords.some((existing) => existing.toLowerCase() === keyword.toLowerCase())) keywords.push(keyword);
  }
  if (keywords.length > MAX_FILTER_KEYWORDS) return { ok: false, error: `Add up to ${MAX_FILTER_KEYWORDS} keywords.` };
  const settings: ClientPullSettings = {
    useClientContacts: input.useClientContacts !== false,
    senders,
    keywords,
    matchMode: input.matchMode === "all" ? "all" : "any",
  };
  if (!settings.useClientContacts && senders.length === 0 && keywords.length === 0) {
    return { ok: false, error: "Choose something to search for: the client's contacts, a sender or a keyword." };
  }
  if (settings.matchMode === "all" && (keywords.length === 0 || (!settings.useClientContacts && senders.length === 0))) {
    return { ok: false, error: "“A sender and a keyword” needs at least one sender (or the client's contacts) and one keyword." };
  }
  return { ok: true, settings };
}

/** Settings as saved, read leniently (a stored row is trusted to have been validated). */
export function storedPullSettings(doc: Record<string, unknown> | null | undefined): ClientPullSettings {
  if (!doc) return DEFAULT_PULL_SETTINGS;
  const senders = listOf(doc.senders).map(cleanSender).filter((value): value is string => Boolean(value));
  const keywords = listOf(doc.keywords).map(cleanKeyword).filter((value): value is string => Boolean(value));
  return {
    useClientContacts: doc.useClientContacts !== false,
    senders: [...new Set(senders)].slice(0, MAX_FILTER_SENDERS),
    keywords: [...new Set(keywords)].slice(0, MAX_FILTER_KEYWORDS),
    matchMode: doc.matchMode === "all" ? "all" : "any",
  };
}

/** Identifies what a brief was written from; a change means the next pull starts the brief afresh. */
export function pullFilterKey(settings: ClientPullSettings): string {
  return JSON.stringify({
    c: settings.useClientContacts,
    s: [...settings.senders].sort(),
    k: settings.keywords.map((keyword) => keyword.toLowerCase()).sort(),
    m: settings.matchMode,
  });
}

/** Plain-English summary of the settings, for "Matched on" and the UI. */
export function describePullSettings(settings: ClientPullSettings): string {
  const who = [...(settings.useClientContacts ? ["the client's contacts"] : []), ...settings.senders];
  const words = settings.keywords.map((keyword) => `"${keyword}"`);
  if (who.length && words.length) return `${who.join(", ")} ${settings.matchMode === "all" ? "and" : "or"} ${words.join(", ")}`;
  return who.length ? who.join(", ") : words.join(", ");
}

/**
 * The Gmail search for a client's mail since `after`. Senders and domains come
 * from normaliseDomain / the address regex and keywords from cleanKeyword
 * (quoted, no search syntax), so no raw user text reaches the query. Null when
 * there is nothing to search for.
 */
export function clientGmailQuery(
  targets: ClientEmailTargets,
  after: Date,
  settings: ClientPullSettings = DEFAULT_PULL_SETTINGS,
): string | null {
  const who = [
    ...new Set([...(settings.useClientContacts ? [...targets.domains, ...targets.addresses] : []), ...settings.senders]),
  ].slice(0, MAX_SEARCH_TARGETS);
  const whoTerms = who.flatMap((value) => [`from:${value}`, `to:${value}`, `cc:${value}`]).join(" ");
  const wordTerms = settings.keywords.map((keyword) => `"${keyword}"`).join(" ");
  let match: string;
  if (whoTerms && wordTerms) match = settings.matchMode === "all" ? `{${whoTerms}} {${wordTerms}}` : `{${whoTerms} ${wordTerms}}`;
  else if (whoTerms) match = `{${whoTerms}}`;
  else if (wordTerms) match = `{${wordTerms}}`;
  else return null;
  const since = Math.floor(after.getTime() / 1000);
  return `${match} after:${since} -in:chats -in:drafts -in:spam -in:trash`;
}

/** The sender entry an address falls under: exact address, or its domain or a parent domain. */
function senderEntryFor(address: string, senders: string[]): string | null {
  if (senders.includes(address)) return address;
  const labels = normaliseDomain(address).split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const domain = labels.slice(i).join(".");
    if (senders.includes(domain)) return domain;
  }
  return null;
}

export interface BriefEmail {
  date: string | null;
  from: string;
  to: string;
  subject: string;
  body: string;
}

/** The email's own words: quoted earlier messages dropped, whitespace tidied, capped. */
function ownWords(body: string, max: number): string {
  const text = stripQuotedText(body ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "undated";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "undated" : date.toISOString().slice(0, 10);
}

/**
 * The model request that writes (or, given `previousBrief`, updates) the
 * brief. Emails go oldest first; when they do not all fit, the newest are
 * kept and the rest counted in `leftOut`.
 */
export function buildClientBriefRequest(args: {
  clientId: number;
  clientName: string;
  previousBrief: string | null;
  emails: BriefEmail[];
}): { request: MailModelRequest; used: number; leftOut: number } {
  const newestFirst = [...args.emails].sort((a, b) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0));
  const kept: string[] = [];
  let total = 0;
  for (const email of newestFirst) {
    const block = [
      `[${shortDate(email.date)}] From: ${email.from} | To: ${email.to} | Subject: ${email.subject || "(no subject)"}`,
      ownWords(email.body, MAX_BRIEF_EMAIL_CHARS) || "(no text)",
    ].join("\n");
    if (total + block.length > MAX_BRIEF_INPUT_CHARS && kept.length > 0) break;
    kept.push(block);
    total += block.length;
  }
  const leftOut = newestFirst.length - kept.length;
  const previous = args.previousBrief?.trim() ?? "";
  const text = [
    `Client: ${args.clientName}`,
    "",
    ...(previous ? ["The brief written from earlier emails:", "", previous, "", "--- End of earlier brief ---", ""] : []),
    `${previous ? "New emails since that brief" : "The emails"}, oldest first${leftOut ? ` (${leftOut} older emails were left out to fit)` : ""}:`,
    "",
    kept.reverse().join("\n\n---\n\n"),
    "",
    "--- End of emails ---",
    "",
    previous ? "Update the brief with these emails." : MAIL_PROMPTS["client-brief"].defaultInstruction,
  ].join("\n");
  return {
    request: {
      action: "client-brief",
      system: MAIL_PROMPTS["client-brief"].system,
      messages: [{ role: "user", text }],
      gmailMessageId: null,
      emailCount: kept.length,
      suggestSubject: false,
      clientId: args.clientId,
      revise: null,
      maxTokens: BRIEF_MAX_OUTPUT_TOKENS,
    },
    used: kept.length,
    leftOut,
  };
}

export interface ClientEmailBriefView {
  id: number;
  /** The search settings the brief was written with (see pullFilterKey); "" for briefs from before settings existed. */
  filterKey: string;
  account: string;
  ownerId: number | null;
  brief: string;
  emailCount: number;
  firstEmailDate: string | null;
  lastEmailDate: string | null;
  lastPulledAt: string | null;
}

interface BriefDoc {
  id: number;
  account?: string | null;
  owner?: number | { id: number } | null;
  brief?: string | null;
  emailCount?: number | null;
  firstEmailDate?: string | null;
  lastEmailDate?: string | null;
  lastPulledAt?: string | null;
  filterKey?: string | null;
  messageIds?: string | null;
}

/** The Gmail ids a brief covers (stored as a JSON array). */
export function briefMessageIds(doc: Pick<BriefDoc, "messageIds">): string[] {
  try {
    const parsed: unknown = JSON.parse(doc.messageIds ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id)) : [];
  } catch {
    return [];
  }
}

export function toBriefView(doc: BriefDoc): ClientEmailBriefView {
  const owner = doc.owner;
  return {
    id: doc.id,
    filterKey: doc.filterKey ?? "",
    account: doc.account ?? "",
    ownerId: typeof owner === "number" ? owner : owner && typeof owner === "object" ? owner.id : null,
    brief: doc.brief ?? "",
    emailCount: doc.emailCount ?? 0,
    firstEmailDate: doc.firstEmailDate ?? null,
    lastEmailDate: doc.lastEmailDate ?? null,
    lastPulledAt: doc.lastPulledAt ?? null,
  };
}

export interface PullDeps {
  getMailboxProfile: typeof getMailboxProfile;
  listMessageIdsMatching: typeof listMessageIdsMatching;
  getMessageHeaders: typeof getMessageHeaders;
  getFullMessage: typeof getFullMessage;
  loadHiddenSenders: typeof loadHiddenSenders;
}

const defaultPullDeps: PullDeps = {
  getMailboxProfile,
  listMessageIdsMatching,
  getMessageHeaders,
  getFullMessage,
  loadHiddenSenders,
};

export type PullResult =
  | {
      ok: true;
      /** Client emails Gmail found in the searched period (up to MAX_PULL_EMAILS). */
      found: number;
      /** Emails saved to the client by this pull (the rest were already saved or skipped). */
      saved: number;
      /** True when Gmail had more than MAX_PULL_EMAILS; only the newest were read. */
      more: boolean;
      /** Older emails left out of the brief to fit the AI's input. */
      leftOut: number;
      briefUpdated: boolean;
      brief: ClientEmailBriefView | null;
    }
  | { ok: false; status: number; error: string };

interface StoredBriefEmail extends BriefEmail {
  gmailMessageId: string;
}

async function loadEmailsByGmailId(payload: PayloadLike, ids: string[]): Promise<StoredBriefEmail[]> {
  const out: StoredBriefEmail[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = (await payload.find({
      collection: "client-emails",
      where: { gmailMessageId: { in: chunk } },
      limit: chunk.length,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { gmailMessageId: true, from: true, to: true, subject: true, date: true, body: true },
    } as never)) as { docs: Array<Partial<StoredBriefEmail> & { date?: string | null }> };
    for (const doc of res.docs) {
      out.push({
        gmailMessageId: doc.gmailMessageId ?? "",
        date: doc.date ?? null,
        from: doc.from ?? "",
        to: doc.to ?? "",
        subject: doc.subject ?? "",
        body: doc.body ?? "",
      });
    }
  }
  return out;
}

function gmailStatus(err: unknown): number {
  return Number((err as { code?: number; status?: number }).code ?? (err as { status?: number }).status ?? 0);
}

/**
 * One pull: search the mailbox, save the client's new emails, then write or
 * update the brief. The model is only called when there are emails to read.
 * Gmail auth failures are thrown (the route turns them into a reconnect
 * prompt); one email that cannot be read or saved is skipped.
 */
export async function pullClientEmails(args: {
  payload: PayloadLike;
  userId: number;
  accessToken: string;
  userEmail?: string;
  clientId: number;
  now: Date;
  runModel: (request: MailModelRequest) => Promise<{ text: string; model: string }>;
  deps?: Partial<PullDeps>;
}): Promise<PullResult> {
  const deps = { ...defaultPullDeps, ...args.deps };
  const { payload, userId, clientId, now } = args;

  let client: MatchableClient;
  try {
    client = (await payload.findByID({
      collection: "clients",
      id: clientId,
      depth: 0,
      overrideAccess: true,
      select: { name: true, websiteUrl: true, contactEmail: true, additionalContacts: true, isActive: true },
    } as never)) as unknown as MatchableClient;
  } catch {
    return { ok: false, status: 404, error: "Client not found." };
  }
  if (!client || typeof client.id !== "number") return { ok: false, status: 404, error: "Client not found." };
  const clientName = client.name?.trim() || `Client ${clientId}`;

  const profile = await deps.getMailboxProfile(args.accessToken);
  const account = profile.emailAddress.trim().toLowerCase();
  const ownAddresses = [profile.emailAddress, args.userEmail ?? ""].filter(Boolean);
  const targets = clientEmailTargets(client, ownAddresses);
  const settingsRes = (await payload.find({
    collection: "client-email-pull-settings",
    where: { client: { equals: clientId } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  } as never)) as unknown as { docs: Array<Record<string, unknown>> };
  const settings = storedPullSettings(settingsRes.docs[0]);
  const filterKey = pullFilterKey(settings);
  const custom = filterKey !== pullFilterKey(DEFAULT_PULL_SETTINGS);

  const existingRes = (await payload.find({
    collection: "client-email-briefs",
    where: { and: [{ client: { equals: clientId } }, { owner: { equals: userId } }, { account: { equals: account } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  } as never)) as { docs: BriefDoc[] };
  const existing = existingRes.docs[0] ?? null;
  // Briefs from before search settings existed were written with the defaults.
  const sameFilter = existing !== null && (existing.filterKey || pullFilterKey(DEFAULT_PULL_SETTINGS)) === filterKey;
  const lastPulled = sameFilter && existing?.lastPulledAt ? Date.parse(existing.lastPulledAt) : NaN;
  if (Number.isFinite(lastPulled) && now.getTime() - lastPulled < PULL_COOLDOWN_MS) {
    return { ok: false, status: 429, error: "These emails were pulled a moment ago. Try again in a minute." };
  }

  // New settings: a fresh 12-month search and a new brief, so nothing from the old search lingers.
  const after = Number.isFinite(lastPulled)
    ? new Date(lastPulled - PULL_OVERLAP_MS)
    : new Date(now.getTime() - CLIENT_PULL_DAYS * 24 * 60 * 60 * 1000);
  const query = clientGmailQuery(targets, after, settings);
  if (!query) {
    return {
      ok: false,
      status: 400,
      error: settings.useClientContacts
        ? "This client has no website or contact email to search for. Add one on the client record, or add senders or keywords in Search settings."
        : "Add a sender or keyword in Search settings, then pull again.",
    };
  }

  const listed = [...new Set(await deps.listMessageIdsMatching(args.accessToken, query, MAX_PULL_EMAILS + 1))];
  const more = listed.length > MAX_PULL_EMAILS;
  const ids = listed.slice(0, MAX_PULL_EMAILS);

  const already = await findStoredMessageIds(payload, ids);
  const fresh = ids.filter((id) => !already.has(id));
  let saved = 0;
  const savedIds: string[] = [];
  if (fresh.length > 0) {
    const index = buildClientDomainIndex([client], { ownAddresses });
    const matchedOnFor = (header: { from: string; to: string; cc: string }): string | null => {
      const contact = settings.useClientContacts ? matchMessageToClient(index, header) : null;
      if (contact) return contact.matchedOn;
      if (!custom) return null;
      for (const address of [header.from, header.to, header.cc].flatMap(extractEmailAddresses)) {
        const entry = senderEntryFor(address, settings.senders);
        if (entry) return entry;
      }
      return `Pull emails search: ${describePullSettings(settings)}`.slice(0, 500);
    };
    const hidden = await deps.loadHiddenSenders(payload as Payload, userId);
    const headers = await deps.getMessageHeaders(args.accessToken, fresh);
    const wanted = headers
      .filter((header) => isSyncableLabelSet(header.labelIds) && !isAutomatedMessage(header) && !isHiddenSender(header.from, hidden))
      .map((header) => ({ header, matchedOn: matchedOnFor(header) }))
      // Default settings: only mail the client's domains and contacts really match (as Mail's sync).
      // Custom settings: the search itself is the selection (keywords cannot be checked from headers).
      .filter((entry): entry is { header: typeof entry.header; matchedOn: string } => entry.matchedOn !== null);
    const results = await mapLimited(wanted, 4, async ({ header, matchedOn }) => {
      try {
        const message = await deps.getFullMessage(args.accessToken, header.messageId);
        const result = await storeClientEmail(
          payload,
          toClientEmailInput({
            message,
            clientId,
            ownerId: userId,
            matchedBy: "auto",
            matchedOn,
            ownAddresses,
            gmailAccount: profile.emailAddress,
          }),
        );
        return { id: header.messageId, created: result.created, stored: result.created || result.id !== null };
      } catch (err) {
        const status = gmailStatus(err);
        if (status === 401 || status === 403) throw err;
        console.error(`[mail] client pull could not save ${header.messageId}:`, (err instanceof Error ? err.message : String(err)).slice(0, 200));
        return { id: header.messageId, created: false, stored: false };
      }
    });
    for (const result of results) {
      if (result.created) saved++;
      if (result.stored) savedIds.push(result.id);
    }
  }

  // Emails another client already has are still read: the user's search chose them.
  const pulledIds = [...already, ...savedIds];
  const emails = await loadEmailsByGmailId(payload, pulledIds);
  const nowIso = now.toISOString();
  const coveredIds = [...new Set([...(sameFilter && existing ? briefMessageIds(existing) : []), ...emails.map((email) => email.gmailMessageId)])].slice(
    -MAX_BRIEF_MESSAGE_IDS,
  );

  if (emails.length === 0) {
    if (!existing) return { ok: true, found: ids.length, saved, more, leftOut: 0, briefUpdated: false, brief: null };
    // New settings that find nothing: the old brief no longer applies.
    const data = sameFilter
      ? { lastPulledAt: nowIso }
      : { lastPulledAt: nowIso, filterKey, brief: "", messageIds: "[]", emailCount: 0, firstEmailDate: null, lastEmailDate: null };
    const updated = (await payload.update({
      collection: "client-email-briefs",
      id: existing.id,
      overrideAccess: true,
      data,
    } as never)) as unknown as BriefDoc;
    return { ok: true, found: ids.length, saved, more, leftOut: 0, briefUpdated: !sameFilter, brief: toBriefView(updated) };
  }

  const { request, leftOut } = buildClientBriefRequest({
    clientId,
    clientName,
    previousBrief: sameFilter ? (existing?.brief ?? null) : null,
    emails,
  });
  const result = await args.runModel(request);
  const brief = result.text.trim().slice(0, MAX_BRIEF_CHARS);
  if (!brief) return { ok: false, status: 502, error: "The AI did not write a brief. Please try again." };

  const dates = emails.map((email) => email.date).filter((date): date is string => Boolean(date && Number.isFinite(Date.parse(date))));
  const kept = sameFilter ? [existing?.firstEmailDate ?? "", existing?.lastEmailDate ?? ""] : [];
  const earliest = [...dates, ...kept].filter(Boolean).sort()[0] ?? null;
  const latest = [...dates, ...kept].filter(Boolean).sort().at(-1) ?? null;
  const data = {
    brief,
    filterKey,
    messageIds: JSON.stringify(coveredIds),
    emailCount: coveredIds.length,
    firstEmailDate: earliest,
    lastEmailDate: latest,
    lastPulledAt: nowIso,
    model: result.model,
  };
  const doc = existing
    ? await payload.update({ collection: "client-email-briefs", id: existing.id, overrideAccess: true, data } as never)
    : await payload.create({
        collection: "client-email-briefs",
        overrideAccess: true,
        data: { ...data, client: clientId, owner: userId, account },
      } as never);
  return { ok: true, found: ids.length, saved, more, leftOut, briefUpdated: true, brief: toBriefView(doc as unknown as BriefDoc) };
}

const STOPWORDS = new Set([
  "the", "and", "for", "did", "does", "when", "what", "was", "were", "with", "that", "this", "from", "have",
  "has", "our", "their", "they", "about", "how", "who", "where", "which", "any", "are", "you", "your", "can",
  "will", "would", "should", "could", "say", "said", "tell", "email", "emails", "client", "they're", "there",
]);

/** Lower-case words worth matching from a question; a light plural strip lets "budgets" match "budget". */
export function questionTerms(question: string): string[] {
  const terms = question
    .toLowerCase()
    // Keeps figures whole ("$2,000", "4.5%"), so they match the emails as written.
    .split(/[^a-z0-9$%.,]+/)
    .map((term) => term.replace(/^[.,]+|[.,]+$/g, ""))
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term))
    .map((term) => (term.length > 4 && term.endsWith("s") ? term.slice(0, -1) : term));
  return [...new Set(terms)];
}

export interface KnowledgeEmail {
  id: number;
  date: string | null;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  subject: string;
  excerpt: string;
  gmailLink: string | null;
}

export interface ClientEmailKnowledge {
  briefs: ClientEmailBriefView[];
  emails: KnowledgeEmail[];
  /** Saved emails for this client that could be searched. */
  savedEmails: number;
  /** True when no email matched the question's words, so the newest were given instead. */
  fellBackToRecent: boolean;
}

const EMAIL_SELECT = {
  gmailMessageId: true,
  date: true,
  direction: true,
  from: true,
  to: true,
  subject: true,
  body: true,
  gmailLink: true,
} as const;

interface EmailDoc {
  id: number;
  gmailMessageId?: string | null;
  date?: string | null;
  direction?: "inbound" | "outbound" | null;
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  body?: string | null;
  gmailLink?: string | null;
}

/**
 * What a question is answered from: the client's briefs and the saved emails
 * that best match the question (newest first on a tie). `ownerId` limits both
 * to one team member's mail (non-admins); null = everyone's (admins only).
 */
export async function loadClientEmailKnowledge(args: {
  payload: Pick<Payload, "find">;
  clientId: number;
  ownerId: number | null;
  question: string;
}): Promise<ClientEmailKnowledge> {
  const scope = [
    { client: { equals: args.clientId } },
    ...(args.ownerId === null ? [] : [{ owner: { equals: args.ownerId } }]),
  ];
  const [briefRes, emailRes] = await Promise.all([
    args.payload.find({
      collection: "client-email-briefs",
      where: { and: scope },
      sort: "-lastPulledAt",
      limit: MAX_ASK_BRIEFS,
      depth: 0,
      overrideAccess: true,
    } as never),
    args.payload.find({
      collection: "client-emails",
      where: { and: scope },
      sort: "-date",
      limit: MAX_ASK_SCAN,
      depth: 0,
      overrideAccess: true,
      select: EMAIL_SELECT,
    } as never),
  ]);
  const briefDocs = (briefRes as { docs: BriefDoc[] }).docs;
  const briefs = briefDocs.map(toBriefView).filter((brief) => brief.brief.trim());
  // Emails a brief was written from but that are saved to another client (an email
  // belongs to one client): found by the Gmail ids the brief recorded.
  const own = (emailRes as { docs: EmailDoc[] }).docs;
  const known = new Set(own.map((doc) => doc.gmailMessageId));
  const extraIds = [...new Set(briefDocs.flatMap((doc) => briefMessageIds(doc).slice(-MAX_ASK_BRIEF_IDS)))].filter((id) => !known.has(id));
  const extra: EmailDoc[] = [];
  for (let i = 0; i < extraIds.length && i < MAX_ASK_BRIEF_IDS; i += 200) {
    const chunk = extraIds.slice(i, i + 200);
    const res = await args.payload.find({
      collection: "client-emails",
      where: { gmailMessageId: { in: chunk } },
      limit: chunk.length,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: EMAIL_SELECT,
    } as never);
    extra.push(...(res as { docs: EmailDoc[] }).docs);
  }
  const docs = [...own, ...extra]
    .sort((a, b) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0))
    .slice(0, MAX_ASK_SCAN);

  const terms = questionTerms(args.question);
  const scored = docs.map((doc, index) => {
    const subject = (doc.subject ?? "").toLowerCase();
    const rest = `${doc.from ?? ""} ${doc.to ?? ""} ${doc.body ?? ""}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (subject.includes(term) ? 2 : 0) + (rest.includes(term) ? 1 : 0), 0);
    return { doc, index, score };
  });
  const matching = scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const fellBackToRecent = matching.length === 0;
  const chosen = (fellBackToRecent ? scored.slice(0, 6) : matching.slice(0, MAX_ASK_EMAILS))
    // Oldest first reads like the conversation did.
    .sort((a, b) => b.index - a.index);

  return {
    briefs,
    savedEmails: docs.length,
    fellBackToRecent,
    emails: chosen.map(({ doc }) => ({
      id: doc.id,
      date: doc.date ?? null,
      direction: doc.direction === "outbound" ? "outbound" : "inbound",
      from: doc.from ?? "",
      to: doc.to ?? "",
      subject: doc.subject ?? "",
      excerpt: ownWords(doc.body ?? "", MAX_ASK_EXCERPT_CHARS),
      gmailLink: doc.gmailLink?.startsWith("https://mail.google.com/") ? doc.gmailLink : null,
    })),
  };
}

export interface AskTurn {
  question: string;
  answer: string;
}

/** Validate the browser's conversation so far: last few turns, capped. Bad entries are dropped. */
export function cleanAskHistory(raw: unknown): AskTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: AskTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const question = (item as { question?: unknown }).question;
    const answer = (item as { answer?: unknown }).answer;
    if (typeof question !== "string" || typeof answer !== "string" || !question.trim()) continue;
    turns.push({ question: question.trim().slice(0, MAX_QUESTION_CHARS), answer: answer.trim().slice(0, MAX_ASK_HISTORY_CHARS) });
  }
  return turns.slice(-MAX_ASK_HISTORY_TURNS);
}

/** Emails are labelled E1, E2… in the order given; answers cite them by label. */
export function emailLabel(index: number): string {
  return `E${index + 1}`;
}

/** The model request for one question about a client's emails. */
export function buildClientAskRequest(args: {
  clientId: number;
  clientName: string;
  knowledge: ClientEmailKnowledge;
  question: string;
  history: AskTurn[];
}): MailModelRequest {
  const { knowledge } = args;
  const briefs = knowledge.briefs.map((brief) =>
    [
      `--- Brief from ${brief.account || "a team mailbox"} (pulled ${shortDate(brief.lastPulledAt)}, emails ${shortDate(brief.firstEmailDate)} to ${shortDate(brief.lastEmailDate)}) ---`,
      brief.brief.trim(),
    ].join("\n"),
  );
  const emails = knowledge.emails.map((email, index) =>
    [
      `[${emailLabel(index)}] ${shortDate(email.date)} · ${email.direction === "outbound" ? "We sent" : "Client sent"} · From: ${email.from} · To: ${email.to} · Subject: ${email.subject || "(no subject)"}`,
      email.excerpt || "(no text)",
    ].join("\n"),
  );
  const text = [
    `Client: ${args.clientName}`,
    "",
    briefs.length ? briefs.join("\n\n") : "No email brief has been pulled for this client yet.",
    "",
    `Saved emails${knowledge.fellBackToRecent ? " (none matched the question's words, so these are the newest)" : " that best match the question"}, oldest first:`,
    "",
    emails.length ? emails.join("\n\n") : "None.",
    "",
    "--- End of email material ---",
    ...(args.history.length
      ? ["", "Conversation so far:", ...args.history.flatMap((turn) => [`Q: ${turn.question}`, `A: ${turn.answer}`])]
      : []),
    "",
    `Question: ${args.question.trim().slice(0, MAX_QUESTION_CHARS)}`,
  ].join("\n");
  return {
    action: "client-ask",
    system: MAIL_PROMPTS["client-ask"].system,
    messages: [{ role: "user", text }],
    gmailMessageId: null,
    emailCount: knowledge.emails.length,
    suggestSubject: false,
    clientId: args.clientId,
    revise: null,
    maxTokens: ASK_MAX_OUTPUT_TOKENS,
  };
}
