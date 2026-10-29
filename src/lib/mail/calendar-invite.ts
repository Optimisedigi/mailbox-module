import { zonedToUtc } from "@/lib/mail/zoned-time";

/**
 * Calendar invites in Mail. Parses the iCalendar (RFC 5545) part of an email
 * into the card shown at the top of the reading pane, and builds the iTIP
 * (RFC 5546) REPLY that answers it by email when Google Calendar can't.
 * Pure functions; the Gmail/Calendar I/O lives in the routes.
 */

export type InviteStatus = "accepted" | "declined" | "tentative" | "needsAction";
export type InviteResponse = Exclude<InviteStatus, "needsAction">;
export type InviteMethod = "REQUEST" | "CANCEL" | "REPLY" | "PUBLISH";

export interface InvitePerson {
  name: string;
  email: string;
}

export interface InviteAttendee extends InvitePerson {
  status: InviteStatus;
}

/** What the reading pane shows. */
export interface CalendarInvite {
  method: InviteMethod;
  uid: string;
  summary: string;
  /** ISO instants; for all-day events the UTC midnight of the date(s). */
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  organizer: InvitePerson | null;
  attendees: InviteAttendee[];
}

/** Server-only: the parsed invite plus the raw lines a REPLY must echo. */
export interface ParsedInvite extends CalendarInvite {
  sequence: string;
  raw: { dtstart: string; dtend: string; organizer: string; recurrenceId: string };
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
  /** The unfolded line exactly as received. */
  line: string;
}

const STATUS_BY_PARTSTAT: Record<string, InviteStatus> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  "NEEDS-ACTION": "needsAction",
};
const PARTSTAT_BY_RESPONSE: Record<InviteResponse, string> = {
  accepted: "ACCEPTED",
  declined: "DECLINED",
  tentative: "TENTATIVE",
};
const METHODS = new Set<InviteMethod>(["REQUEST", "CANCEL", "REPLY", "PUBLISH"]);

export function isInviteResponse(value: unknown): value is InviteResponse {
  return value === "accepted" || value === "declined" || value === "tentative";
}

function unfold(ics: string): string[] {
  return ics.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseLine(line: string): Property | null {
  // The value starts at the first colon outside a quoted parameter.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const [rawName = "", ...rawParams] = line.slice(0, colon).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const eq = param.indexOf("=");
    if (eq > 0) params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: rawName.toUpperCase(), params, value: line.slice(colon + 1), line };
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch)).trim();
}

function mailto(value: string): string {
  return value.replace(/^mailto:/i, "").trim().toLowerCase();
}

function person(prop: Property | undefined): InvitePerson | null {
  if (!prop) return null;
  const email = mailto(prop.value);
  if (!email) return null;
  return { name: unescapeText(prop.params.CN ?? ""), email };
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** DTSTART/DTEND → ISO instant. Handles UTC, TZID, floating and DATE values. */
function parseDate(prop: Property | undefined): { iso: string; allDay: boolean } | null {
  if (!prop) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(prop.value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  const date = `${y}-${mo}-${d}`;
  if (h === undefined || prop.params.VALUE === "DATE") {
    return { iso: new Date(`${date}T00:00:00Z`).toISOString(), allDay: true };
  }
  const seconds = Number(s ?? 0);
  if (z) return { iso: new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), seconds)).toISOString(), allDay: false };
  const tzid = prop.params.TZID ?? "";
  // Unknown TZIDs (e.g. Outlook's "AUS Eastern Standard Time") fall back to UTC.
  const zone = tzid && isValidTimeZone(tzid) ? tzid : "UTC";
  const instant = zonedToUtc(date, Number(h) * 60 + Number(mi), zone);
  return { iso: new Date(instant.getTime() + seconds * 1000).toISOString(), allDay: false };
}

/** Parse the first VEVENT of an iCalendar text. Null when it isn't a usable invite. */
export function parseCalendarInvite(ics: string): ParsedInvite | null {
  if (!/BEGIN:VEVENT/i.test(ics)) return null;
  let method: InviteMethod = "PUBLISH";
  const event: Property[] = [];
  let depth = 0;
  let inEvent = false;
  let done = false;
  for (const line of unfold(ics)) {
    const prop = parseLine(line);
    if (!prop || done) continue;
    if (prop.name === "BEGIN") {
      if (inEvent) depth++;
      else if (prop.value.toUpperCase() === "VEVENT") inEvent = true;
      continue;
    }
    if (prop.name === "END") {
      if (inEvent && depth > 0) depth--;
      else if (inEvent && prop.value.toUpperCase() === "VEVENT") done = true;
      continue;
    }
    if (!inEvent && prop.name === "METHOD") {
      const value = prop.value.trim().toUpperCase() as InviteMethod;
      if (METHODS.has(value)) method = value;
    }
    // Skip nested components (VALARM) so their props don't override the event's.
    if (inEvent && depth === 0) event.push(prop);
  }
  const get = (name: string) => event.find((prop) => prop.name === name);
  const uid = get("UID")?.value.trim() ?? "";
  const start = parseDate(get("DTSTART"));
  if (!uid || !start) return null;
  const end = parseDate(get("DTEND")) ?? start;
  if (get("STATUS")?.value.trim().toUpperCase() === "CANCELLED") method = "CANCEL";

  const attendees: InviteAttendee[] = [];
  for (const prop of event.filter((p) => p.name === "ATTENDEE")) {
    const who = person(prop);
    if (!who) continue;
    attendees.push({ ...who, status: STATUS_BY_PARTSTAT[(prop.params.PARTSTAT ?? "").toUpperCase()] ?? "needsAction" });
  }

  return {
    method,
    uid,
    summary: unescapeText(get("SUMMARY")?.value ?? "") || "(no title)",
    start: start.iso,
    end: end.iso,
    allDay: start.allDay,
    location: unescapeText(get("LOCATION")?.value ?? ""),
    organizer: person(get("ORGANIZER")),
    attendees,
    sequence: get("SEQUENCE")?.value.trim() || "0",
    raw: {
      dtstart: get("DTSTART")?.line ?? "",
      dtend: get("DTEND")?.line ?? "",
      organizer: get("ORGANIZER")?.line ?? "",
      recurrenceId: get("RECURRENCE-ID")?.line ?? "",
    },
  };
}

/** Strip the server-only fields before sending an invite to the browser. */
export function publicInvite(invite: ParsedInvite): CalendarInvite {
  const { sequence: _sequence, raw: _raw, ...rest } = invite;
  return rest;
}

/** Compare addresses ignoring case and Gmail-style +tags. */
export function normaliseEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

/** The attendee entry that is the mailbox owner, if listed. */
export function findSelfAttendee(invite: CalendarInvite, selfEmails: string[]): InviteAttendee | null {
  const mine = new Set(selfEmails.filter(Boolean).map(normaliseEmail));
  return invite.attendees.find((attendee) => mine.has(normaliseEmail(attendee.email))) ?? null;
}

function escapeText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/([\\;,])/g, "\\$1");
}

/** Fold to 75-octet-ish lines as RFC 5545 asks. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

function icsStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** iTIP REPLY answering `invite` as `attendee`. */
export function buildInviteReplyIcs(
  invite: ParsedInvite,
  attendee: InvitePerson,
  response: InviteResponse,
  now: Date,
): string {
  const cn = attendee.name ? `;CN="${attendee.name.replace(/["\r\n]/g, "")}"` : "";
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Mailbox Module//Mail//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${invite.uid.replace(/[\r\n]/g, "")}`,
    invite.raw.recurrenceId,
    `DTSTAMP:${icsStamp(now)}`,
    `SEQUENCE:${/^\d+$/.test(invite.sequence) ? invite.sequence : "0"}`,
    invite.raw.dtstart,
    invite.raw.dtend,
    `SUMMARY:${escapeText(invite.summary)}`,
    invite.raw.organizer,
    `ATTENDEE;PARTSTAT=${PARTSTAT_BY_RESPONSE[response]}${cn}:mailto:${attendee.email.replace(/[\r\n]/g, "")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.filter(Boolean).map(fold).join("\r\n")}\r\n`;
}

const RESPONSE_WORD: Record<InviteResponse, string> = {
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Tentatively accepted",
};

function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function encodeHeader(value: string): string {
  const safe = headerSafe(value);
  return /^[\x20-\x7E]*$/.test(safe) ? safe : `=?UTF-8?B?${Buffer.from(safe, "utf-8").toString("base64")}?=`;
}

/**
 * The RSVP email: text/plain + text/calendar; method=REPLY, base64url for
 * Gmail's messages.send. Threads onto the invite via In-Reply-To.
 */
export function buildInviteReplyMime(args: {
  to: string;
  invite: ParsedInvite;
  attendee: InvitePerson;
  response: InviteResponse;
  inReplyTo?: string;
  now: Date;
}): string {
  const { invite, attendee, response } = args;
  const who = attendee.name || attendee.email;
  const word = RESPONSE_WORD[response];
  const ics = buildInviteReplyIcs(invite, attendee, response, args.now);
  const boundary = `----=_Mailbox_${crypto.randomUUID().replaceAll("-", "")}`;
  const lines = [
    `To: ${headerSafe(args.to)}`,
    `Subject: ${encodeHeader(`${word}: ${invite.summary}`)}`,
    "MIME-Version: 1.0",
  ];
  if (args.inReplyTo) lines.push(`In-Reply-To: ${headerSafe(args.inReplyTo)}`, `References: ${headerSafe(args.inReplyTo)}`);
  lines.push(
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(`${who} has ${word.toLowerCase()} this invitation: ${invite.summary}\r\n`, "utf-8").toString("base64"),
    `--${boundary}`,
    'Content-Type: text/calendar; charset="UTF-8"; method=REPLY',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(ics, "utf-8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "",
    `--${boundary}--`,
    "",
  );
  return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
}

export interface ThreadInvite {
  /** Gmail message the invite came from. */
  messageId: string;
  invite: CalendarInvite;
  /** The mailbox owner's answer so far, from the invite or their own emailed RSVP. */
  selfStatus: InviteStatus;
  /** Yes/No/Maybe apply: a live request the owner didn't organise. */
  canRespond: boolean;
}

/**
 * The invite to show for a thread: the newest REQUEST/CANCEL (oldest-first
 * input). The owner's status comes from their newest emailed REPLY for the
 * same event, else their PARTSTAT in the invite.
 */
export function pickThreadInvite(
  messages: Array<{ messageId: string; from: string; calendarIcs: string }>,
  selfEmails: string[],
): ThreadInvite | null {
  const mine = new Set(selfEmails.filter(Boolean).map(normaliseEmail));
  const parsed = messages
    .map((message) => ({ message, invite: message.calendarIcs ? parseCalendarInvite(message.calendarIcs) : null }))
    .filter((entry): entry is { message: (typeof messages)[number]; invite: ParsedInvite } => entry.invite !== null);
  const latest = [...parsed].reverse().find((entry) => entry.invite.method !== "REPLY");
  if (!latest) return null;
  const { invite } = latest;
  const ownReply = [...parsed]
    .reverse()
    .find((entry) => entry.invite.method === "REPLY" && entry.invite.uid === invite.uid && findSelfAttendee(entry.invite, selfEmails));
  const selfStatus =
    (ownReply ? findSelfAttendee(ownReply.invite, selfEmails)?.status : undefined) ??
    findSelfAttendee(invite, selfEmails)?.status ??
    "needsAction";
  const organisedBySelf = invite.organizer ? mine.has(normaliseEmail(invite.organizer.email)) : false;
  return {
    messageId: latest.message.messageId,
    invite: publicInvite(invite),
    selfStatus,
    canRespond: invite.method === "REQUEST" && !organisedBySelf,
  };
}
