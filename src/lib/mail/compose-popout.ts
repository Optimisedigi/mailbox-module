import { MAIL_ACCOUNT_QUERY_PARAM } from "./accounts-shared";
import type { ComposeState } from "../../components/mail/ComposeWindow";

/**
 * "Open in new window" for the compose window. Client-safe.
 *
 * The email being written moves into its own browser window
 * (`/admin/mail/window?compose=<id>&account=<email>`) without going through
 * the server: the new window tells the Mail page that opened it it is ready,
 * and the Mail page posts the compose window's current state back (recipients,
 * subject, body with pasted images, attachments, Gmail draft id). Both
 * messages carry a random id and are only accepted from this site's own
 * origin and from that exact window, so no other page can feed in an email.
 */

export const COMPOSE_POPOUT_PARAM = "compose";
export const COMPOSE_POPOUT_READY = "mailbox:mail-compose-ready";
export const COMPOSE_POPOUT_STATE = "mailbox:mail-compose-state";

const POPOUT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** The `compose` param of the pop-out window, or null when missing or not an id. */
export function parsePopoutId(value: string | null | undefined): string | null {
  return value && POPOUT_ID_RE.test(value) ? value : null;
}

/** Path of the pop-out compose window for handoff `id`, in `account` when it is an extra Gmail account. */
export function composePopoutPath(id: string, account?: string | null): string {
  const path = `/admin/mail/window?${COMPOSE_POPOUT_PARAM}=${encodeURIComponent(id)}`;
  return account ? `${path}&${MAIL_ACCOUNT_QUERY_PARAM}=${encodeURIComponent(account)}` : path;
}

export function popoutReadyMessage(id: string): { type: typeof COMPOSE_POPOUT_READY; id: string } {
  return { type: COMPOSE_POPOUT_READY, id };
}

export function isPopoutReady(data: unknown, id: string): boolean {
  const message = data as { type?: unknown; id?: unknown } | null;
  return !!message && message.type === COMPOSE_POPOUT_READY && message.id === id;
}

export function popoutStateMessage(id: string, state: ComposeState): { type: typeof COMPOSE_POPOUT_STATE; id: string; state: ComposeState } {
  return { type: COMPOSE_POPOUT_STATE, id, state };
}

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * The compose state in a handoff message for `id`, or null when the message
 * is not one (wrong type or id, or not shaped like a compose window).
 */
export function readPopoutState(data: unknown, id: string): ComposeState | null {
  const message = data as { type?: unknown; id?: unknown; state?: unknown } | null;
  if (!message || message.type !== COMPOSE_POPOUT_STATE || message.id !== id) return null;
  const state = message.state as Partial<ComposeState> | null | undefined;
  if (!state || typeof state !== "object") return null;
  if (state.mode !== "reply" && state.mode !== "new") return null;
  if (![state.to, state.cc, state.subject, state.html].every(isString)) return null;
  if (!Array.isArray(state.attachments) || !state.attachments.every((file) => isString(file?.name) && isString(file?.mediaType) && isString(file?.data))) {
    return null;
  }
  if (state.replyTo !== null && (typeof state.replyTo !== "object" || !isString(state.replyTo?.messageId))) return null;
  return state as ComposeState;
}
