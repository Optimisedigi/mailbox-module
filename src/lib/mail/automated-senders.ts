import { extractEmailAddresses } from "./client-matching";

/**
 * Deterministic "is this an automated email?" check for Mail sync and cleanup.
 *
 * Automated mail (form notifications, alerts, newsletters) often reaches a
 * client's address and so matches that client, but it is not a conversation
 * worth keeping on the client's timeline. An email counts as automated when:
 *  - the sender's mailbox name is a no-reply / notification style name, or
 *  - it carries a standard bulk/auto header: Auto-Submitted (anything but
 *    "no"), Precedence bulk/list/junk, List-Id, or List-Unsubscribe.
 *
 * Emails a person assigned to a client by hand are never treated as
 * automated by the callers.
 */

export interface AutomatedSignals {
  from: string;
  autoSubmitted?: string;
  precedence?: string;
  listId?: string;
  listUnsubscribe?: string;
}

const AUTOMATED_LOCAL_PART_RE =
  /^(?:no[._-]?reply|do[._-]?not[._-]?reply|noreply|notifications?|notify|alerts?|mailer[._-]?daemon|postmaster|bounces?)(?:[._+-].*)?$/i;

export function isAutomatedLocalPart(from: string): boolean {
  const address = extractEmailAddresses(from)[0];
  const local = address?.split("@")[0] ?? "";
  return local !== "" && AUTOMATED_LOCAL_PART_RE.test(local);
}

export function isAutomatedMessage(signals: AutomatedSignals): boolean {
  if (isAutomatedLocalPart(signals.from)) return true;
  const autoSubmitted = (signals.autoSubmitted ?? "").trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (/^(bulk|list|junk)$/i.test((signals.precedence ?? "").trim())) return true;
  return Boolean((signals.listId ?? "").trim() || (signals.listUnsubscribe ?? "").trim());
}
