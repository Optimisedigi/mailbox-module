# Calendar and connectors

Mail has four connectors. Each is independent: Mail works with only Gmail connected, and each extra connector adds features.

| Connector | Scope | Stored in | Set up by | Without it |
| --- | --- | --- | --- | --- |
| Gmail | per user, per account | `users` (main) / `mail-accounts` (extra) | each user | Mail shows *Connect Gmail*; nothing else works. |
| Google Calendar | one shared Google account | `calendar-auth` global | an admin | Invite answers only email the organiser; *Add calendar invite* says Calendar isn't connected. |
| AI providers | app-wide | env keys / encrypted `ai-credentials` | an admin | AI buttons return an error; reading and sending still work. |
| OpenAI Realtime (voice) | app-wide | as AI providers | an admin | The mic shows an error; typing still works. |

## Gmail

- **Connect**: `GET /api/gmail/connect` → Google → `GET /api/gmail/callback`. The callback stores the tokens on the signed-in user (or, with `?add=1`, as an extra account in `mail-accounts`) and redirects to Mail.
- **Which account a request uses**: the browser sends the account on screen in the `x-mail-account` header; the server only accepts the user's own accounts. No header = the user's main Gmail. A compose window keeps the account it was opened in.
- **Tokens** are refreshed automatically. When Gmail refuses a request for a missing scope, the API answers `scope-insufficient` with a `connectUrl`, and Mail shows *Reconnect Gmail*.
- **Sync** (client emails only): when Mail opens, on Refresh, every ~60 s for alerts while a tab is visible, and daily from `/api/mail/sync/cron`. The first sync looks back 14 days; later ones use Gmail's history API. Only emails matched to a client are stored (never automated mail or hidden senders), and stored emails older than 12 months are deleted by the daily cron unless assigned by hand or summarised. **Gmail itself is never changed by sync**; Deleting in Mail moves an email to Gmail's Bin; Mail never deletes permanently.
- **Scheduled send** stores the email in `scheduled-emails` and `/api/mail/schedule/tick` (every minute) sends it from the account it was written in. If that account is removed, it fails rather than sending from another account.
- **Follow-up reminders** ("Remind me if no reply") live in `mail-follow-ups`; `/api/mail/follow-ups/cron` (hourly) checks the thread for a reply and raises a notification when the business days pass.

## Google Calendar

One admin connects one Google account in **Google Calendar** (global `calendar-auth`) via `GET /api/calendar/connect` → `GET /api/calendar/callback`. The refresh token is stored on the global.

Mail uses that calendar **only when it is the same address as the mailbox on screen**, so nobody reads or answers someone else's calendar:

- **Invites in email**: an email carrying a calendar invite (`text/calendar`) shows a card with the event, a "No events on this date" check against the calendar, and **Yes / No / Maybe**. With the calendar connected for that mailbox, the answer is written straight onto the calendar event (Google then notifies the organiser). Without it, Mail emails an iCalendar `REPLY` to the organiser instead. (`POST /api/mail/invite`, `src/lib/mail/invite-calendar.ts`.)
- **Add calendar invite** (toolbar): title, date, start, length and guests (searched from your mail contacts). Creates the event with a Google Meet link on that calendar (`POST /api/mail/calendar-event`). *Send to client / user* ticked: Google emails the guests. Unticked: nobody is emailed and the Meet link is copied to the clipboard.
- **Time zone**: `NEXT_PUBLIC_MAIL_TIME_ZONE` (default `Australia/Sydney`) is used for event times, schedule send, business days and auto-refresh hours.

To give each user their own calendar, connect Calendar with the same Google account as the main mailbox, or extend `loadMailboxCalendar()` in `src/lib/mail/invite-calendar.ts` to read a per-user token.

## AI providers

See [ai-auth.md](ai-auth.md). Model input is deliberately narrow: one email at a time (the whole thread only when the user ticks *Use whole thread*), client facts only when the user ticks *Use client data*, and the client is always resolved on the server, never taken from the browser. Sync never calls a model.

## Voice (OpenAI Realtime)

See [ai-auth.md → Voice drafting](ai-auth.md#voice-drafting-openai-realtime). The browser connects directly to `https://api.openai.com/v1/realtime/calls` with a short-lived secret, so your Content-Security-Policy (if any) must allow that origin for `connect-src`, and the page needs microphone permission.

## Notifications

Client-email alerts and follow-up reminders are rows in `notifications` (kinds `client-email-received`, `mail-follow-up-due`). The bundled header button shows the "new client email" drop-down; a host with its own notifications bell can list these rows and render `<ClientEmailAlert>` itself. `POST /api/notifications/:id/mark-read` marks one read.
