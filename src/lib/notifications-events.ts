/**
 * Browser event telling the notifications bell to refresh now instead of on
 * its next 60s poll, e.g. after Mail marked emails read (which removes their
 * client-email notifications). Client-safe: no server imports.
 */
export const NOTIFICATIONS_CHANGED_EVENT = "mailbox:notifications-changed";

export function announceNotificationsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}
