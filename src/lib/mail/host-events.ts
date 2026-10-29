/**
 * Browser events a host app can fire to talk to Mail. Client-safe.
 *
 * MAIL_ASSISTANT_OPENED_EVENT: fire on `window` when the host opens a panel
 * that would sit over the bottom-right corner (a chat assistant, for example);
 * an open compose window minimises out of its way.
 */
export const MAIL_ASSISTANT_OPENED_EVENT = 'mailbox:assistant-opened'
