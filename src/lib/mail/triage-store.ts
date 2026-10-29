/**
 * Keeps the last inbox triage (the AI's categories, each sender's unread
 * message ids and subjects, and what is ticked) in this browser's
 * localStorage, one entry per Gmail account, so closing the panel or
 * reloading Mail does not lose a run that took minutes. Client-safe.
 *
 * Only one triage is ever kept per account: a new run replaces the old one,
 * and once everything in it has been archived or marked read (nothing left
 * to action) it is deleted. A copy older than TRIAGE_MAX_AGE_MS is dropped,
 * since the unread mail it describes has moved on by then.
 */

export interface SavedTriageSender {
  address: string;
  name: string;
  count: number;
  subjects: string[];
  messageIds: string[];
  /** Message whose sender offers one-click unsubscribe. */
  unsubscribeId?: string;
}

export interface SavedTriageCategory {
  key: string;
  label: string;
  count: number;
  defaultSelected: boolean;
  description?: string;
  senders: SavedTriageSender[];
}

export interface SavedTriageResult {
  categories: SavedTriageCategory[];
  scanned: number;
  truncated: boolean;
  failedBatches: number;
}

export interface SavedTriage {
  result: SavedTriageResult;
  /** Ticked sender addresses. */
  selected: string[];
  /** When the triage was run (ms since epoch); kept as the run's time across updates. */
  savedAt: number;
}

const PREFIX = "mail-triage:";
export const TRIAGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function key(account: string): string {
  return PREFIX + (account.trim().toLowerCase() || "main");
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const stringList = (value: unknown): string[] | null => (Array.isArray(value) && value.every(isString) ? value : null);

function cleanSender(value: unknown): SavedTriageSender | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const subjects = stringList(row.subjects);
  const messageIds = stringList(row.messageIds);
  if (!isString(row.address) || !isString(row.name) || !isNumber(row.count) || !subjects || !messageIds) return null;
  return {
    address: row.address,
    name: row.name,
    count: row.count,
    subjects,
    messageIds,
    ...(isString(row.unsubscribeId) ? { unsubscribeId: row.unsubscribeId } : {}),
  };
}

function cleanCategory(value: unknown): SavedTriageCategory | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!isString(row.key) || !isString(row.label) || !isNumber(row.count) || typeof row.defaultSelected !== "boolean") return null;
  if (!Array.isArray(row.senders)) return null;
  const senders = row.senders.map(cleanSender);
  if (senders.some((sender) => sender === null)) return null;
  return {
    key: row.key,
    label: row.label,
    count: row.count,
    defaultSelected: row.defaultSelected,
    ...(isString(row.description) ? { description: row.description } : {}),
    senders: senders.filter((sender): sender is SavedTriageSender => sender !== null),
  };
}

/** True when the triage still has emails to archive, mark read or tag. */
export function triageHasWork(result: SavedTriageResult): boolean {
  return result.categories.some((category) => category.senders.some((sender) => sender.messageIds.length > 0));
}

/** The saved triage for this account ('' = main Gmail), or null when none, too old or unreadable. */
export function loadSavedTriage(storage: Storage | null, account: string, now: number): SavedTriage | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key(account));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result = parsed.result as Record<string, unknown> | undefined;
    const selected = stringList(parsed.selected);
    const savedAt = parsed.savedAt;
    const categories = Array.isArray(result?.categories) ? result.categories.map(cleanCategory) : null;
    if (
      !isNumber(savedAt) ||
      savedAt > now ||
      now - savedAt > TRIAGE_MAX_AGE_MS ||
      !result ||
      !categories ||
      categories.some((category) => category === null) ||
      !selected
    ) {
      storage.removeItem(key(account));
      return null;
    }
    const clean: SavedTriageResult = {
      categories: categories.filter((category): category is SavedTriageCategory => category !== null),
      scanned: isNumber(result.scanned) ? result.scanned : 0,
      truncated: result.truncated === true,
      failedBatches: isNumber(result.failedBatches) ? result.failedBatches : 0,
    };
    if (!triageHasWork(clean)) {
      storage.removeItem(key(account));
      return null;
    }
    return { result: clean, selected, savedAt };
  } catch {
    return null;
  }
}

/**
 * Save the account's triage, replacing any earlier one. A triage with nothing
 * left to action is deleted instead. Returns false when the browser would not
 * store it (storage full or blocked); never throws.
 */
export function saveTriage(storage: Storage | null, account: string, triage: SavedTriage): boolean {
  if (!storage) return false;
  try {
    if (!triageHasWork(triage.result)) {
      storage.removeItem(key(account));
      return true;
    }
    storage.setItem(key(account), JSON.stringify(triage));
    return true;
  } catch {
    // Too big or blocked: drop any older run so a stale one never shows instead.
    try {
      storage.removeItem(key(account));
    } catch {
      // Nothing more to do.
    }
    return false;
  }
}

