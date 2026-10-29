/**
 * Links into Mail: a thread (`?thread=`), a Gmail draft in the compose window
 * (`?draft=`) or the single-email window. Client-safe: no Gmail API calls, no
 * server imports.
 */

import { MAIL_ACCOUNT_QUERY_PARAM } from "./accounts-shared";

const GMAIL_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

export const MAIL_DRAFT_QUERY_PARAM = "draft";
/** `/admin/mail?thread=<gmail thread id>` opens that thread in the reading pane. */
export const MAIL_THREAD_QUERY_PARAM = "thread";

/** Mail path that opens the given Gmail thread (in `account`, when it is an extra Gmail account). */
export function mailThreadPath(threadId: string, account?: string | null): string {
  const path = `/admin/mail?${MAIL_THREAD_QUERY_PARAM}=${encodeURIComponent(threadId)}`;
  return account ? `${path}&${MAIL_ACCOUNT_QUERY_PARAM}=${encodeURIComponent(account)}` : path;
}

/** Path of the single-email Mail window ("Open in new window") for this thread. */
export function mailWindowPath(threadId: string, account?: string | null): string {
  return mailThreadPath(threadId, account).replace(/^\/admin\/mail\?/, "/admin/mail/window?");
}

export function isGmailId(value: string): boolean {
  return GMAIL_ID_RE.test(value);
}

/** Window event the open Mail page listens for: `detail.url` is a `/admin/mail?...` link. */
export const MAIL_OPEN_LINK_EVENT = "mailbox:mail-open-link";

const MAIL_PATH = "/admin/mail";

/**
 * Open a Mail link (`?thread=` / `?draft=`, optionally `&account=`).
 * Mail reads those params when it loads, so a router push to the page you are
 * already on would change nothing: when Mail is open, the open page is told
 * directly instead. Returns true when the open Mail page handled it (no
 * navigation happens), false when `push` was called.
 */
export function openMailLink(url: string, push: (url: string) => void): boolean {
  const onMail = typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") === MAIL_PATH;
  if (onMail && (url === MAIL_PATH || url.startsWith(`${MAIL_PATH}?`))) {
    window.dispatchEvent(new CustomEvent(MAIL_OPEN_LINK_EVENT, { detail: { url } }));
    return true;
  }
  push(url);
  return false;
}

/** Mail path that opens the given Gmail draft message in the compose window. */
export function mailDraftPath(messageId: string): string {
  return `/admin/mail?${MAIL_DRAFT_QUERY_PARAM}=${encodeURIComponent(messageId)}`;
}

