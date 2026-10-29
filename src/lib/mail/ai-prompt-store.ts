/**
 * Keeps the compose window's unsent AI instruction ("make it shorter…") in
 * this browser's localStorage, so closing the window or leaving the page
 * doesn't lose it. Gmail Drafts can only hold the email itself, so this is
 * the one piece of compose state saved locally.
 *
 * Keys: `reply:<message id>` for a reply, `draft:<draft id>` once the email
 * is a Gmail draft, and `new` for a new email that isn't a draft yet.
 */

const PREFIX = "mail-ai-prompt:";
/** Drop saved prompts nobody came back to. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LENGTH = 4000;

export interface PromptKeyInput {
  mode: "reply" | "new";
  replyToMessageId?: string;
  draftId?: string;
  /** The window opened as a brand-new email (no draft yet). */
  startedNew: boolean;
}

/** Every key the prompt is written under, most specific first. */
export function promptKeys(input: PromptKeyInput): string[] {
  const keys: string[] = [];
  if (input.mode === "reply" && input.replyToMessageId) keys.push(`reply:${input.replyToMessageId}`);
  if (input.draftId) keys.push(`draft:${input.draftId}`);
  if (input.mode === "new" && input.startedNew) keys.push("new");
  return keys;
}

interface Stored {
  text: string;
  savedAt: number;
}

function read(storage: Storage, key: string, now: number): string {
  try {
    const raw = storage.getItem(PREFIX + key);
    if (!raw) return "";
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed.text !== "string" || typeof parsed.savedAt !== "number") return "";
    if (now - parsed.savedAt > MAX_AGE_MS) {
      storage.removeItem(PREFIX + key);
      return "";
    }
    return parsed.text;
  } catch {
    return "";
  }
}

/** The saved prompt for the first key that has one, or "". */
export function loadPrompt(storage: Storage | null, keys: string[], now: number): string {
  if (!storage) return "";
  for (const key of keys) {
    const text = read(storage, key, now);
    if (text) return text;
  }
  return "";
}

/** Save (or, when empty, clear) the prompt under every key. Never throws. */
export function savePrompt(storage: Storage | null, keys: string[], text: string, now: number): void {
  if (!storage) return;
  const value = text.slice(0, MAX_LENGTH);
  for (const key of keys) {
    try {
      if (value.trim()) storage.setItem(PREFIX + key, JSON.stringify({ text: value, savedAt: now } satisfies Stored));
      else storage.removeItem(PREFIX + key);
    } catch {
      // Storage full or blocked (private mode): nothing more we can do.
    }
  }
}

export function clearPrompt(storage: Storage | null, keys: string[]): void {
  savePrompt(storage, keys, "", 0);
}

/** localStorage when the browser allows it. */
export function browserStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
