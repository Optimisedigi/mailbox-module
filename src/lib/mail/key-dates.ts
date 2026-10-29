/**
 * Key dates in an AI brief: the "## Key dates" section's bullets, as the
 * client email brief writes them ("- 23 Jun 2026: Search query review."),
 * with their calendar day, so each can be added to the client's Account
 * Timeline in one click. Browser-safe (no server imports).
 */

export interface KeyDate {
  /** YYYY-MM-DD */
  day: string;
  /** What happened or is due, without the date. */
  description: string;
}

/** Longest timeline description kept (the timeline's description is one line). */
export const MAX_KEY_DATE_DESCRIPTION = 300;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function isoDay(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function cleanDescription(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/^[\s:–—-]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_KEY_DATE_DESCRIPTION)
    .trim();
}

/**
 * The date at the start of one bullet ("23 Jun 2026", "23 June 2026",
 * "2026-06-23", bold or not) and the rest of the line. A date range
 * ("23–25 Jun 2026") uses its first day. Null when the bullet does not start
 * with a full date, or has nothing after it.
 */
export function parseKeyDateLine(line: string): KeyDate | null {
  const text = line.replace(/^\s*[-*•]\s+/, "").replace(/^\*\*([^*]+)\*\*/, "$1").trim();
  const dmy = /^(\d{1,2})(?:\s*[–-]\s*\d{1,2})?\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b(.*)$/.exec(text);
  if (dmy) {
    const month = MONTHS[(dmy[2] ?? "").toLowerCase()];
    const day = month ? isoDay(Number(dmy[3]), month, Number(dmy[1])) : null;
    const description = cleanDescription(dmy[4] ?? "");
    return day && description ? { day, description } : null;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})\b(.*)$/.exec(text);
  if (iso) {
    const day = isoDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const description = cleanDescription(iso[4] ?? "");
    return day && description ? { day, description } : null;
  }
  return null;
}

/** True for the heading the brief uses for its key dates. */
export function isKeyDatesHeading(heading: string): boolean {
  return /^key dates?$/i.test(heading.replace(/[#*:]/g, "").trim());
}

