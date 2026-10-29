# Feature reference

A Gmail client at **/admin/mail** (sidebar: **Mail**), plus an **Emails** tab on every client record.

## Rules it follows

- **Least access for the model.** Each AI action sends only what it needs, built on the server: *Write with AI*, *TLDR* and *Suggest subject* get the one email you are on (the whole thread only when you tick *Use whole thread*); *Ask AI* gets that thread; a client question gets that client's briefs and stored emails; *Triage* gets sender names and subject lines only, never bodies. Client facts are added only when you tick *Use client data*, and the client is resolved on the server, never taken from the browser.
- **Nothing is sent without Send.** AI output lands in the compose window (Gmail-style, bottom right), where you can edit it or keep prompting ("shorter", "more formal") until it is right. `/api/mail/send` is only called by the Send button.
- **Voice drafting can't send either.** The mic next to *Write with AI* opens an OpenAI Realtime call (secret from `/api/mail/voice/realtime-secret`). You talk the email through; the agent turns it into a clear instruction and runs the same *Write with AI* request itself, keeps revising as you talk, and reads the draft back when asked (including your own edits). Its only two tools, `write_email_draft` and `read_current_draft` (`src/lib/mail/voice-draft.ts`), run in the browser against the compose window; there is no send, schedule or Gmail tool. The new body autosaves to Drafts like typing does.
- **House writing style.** Reply and draft prompts add **Mail Settings → Writing style** and use the **Email assistant model** from Mail Settings (else `MAIL_AI_MODEL`, then the fallback chain). Summaries, TLDRs and triage don't use the style.
- **Whole thread is opt-in.** In a reply, ticking **Use whole thread** also sends the earlier messages of that same thread (loaded server-side from the selected email's own thread id, newest 15 messages, about 40k characters max). It is off by default and applies per request; the AI log's email count shows how many emails were sent.
- **Refining keeps the one-email rule.** Each refine sends the earlier prompts and drafts plus the current (edited) draft. That is the user's own text; the only mailbox content is still the one email being replied to, fetched server-side by id.
- **Code does the sorting.** Matching, storing, listing and syncing are plain code (`src/lib/mail/client-matching.ts`, `src/lib/mail/store.ts`). The sync route never calls a model.
- **Every model call is logged** in *Mail AI Requests*: action, the single Gmail id, `emailCount` (always 0 or 1), model and status. Email content is never logged.
- **Prompts live in one place:** `src/lib/mail/prompts.ts`.

## Tagging people in an email

In the compose body, type **@** and the first letters of a name (or address) to tag someone, as in Gmail: pick them with Enter, Tab or a click (arrows move, Escape closes). The body gets **@Their Name** as a `mailto:` link to their address; To, Cc and Bcc are not changed. Suggestions come from the same people list as the To / Cc / Bcc fields; an "@" straight after text (an email address) never opens it. Code: `src/components/mail/EmailMentionPlugin.tsx`, matching in `src/lib/mail/contacts-shared.ts`.

## Client matching

A message is linked to a client when an address on it resolves to that client. Addresses are tried in order: From, then To, then Cc.

- **Client domains** are the client's *Website URL* (with `www.` stripped) plus the domains of the main contact email and the additional contacts. Several domains per client works by adding a contact on each domain.
- **Exact domain.** `jo@acmeclient.com.au` matches `acmeclient.com.au`. `notacmeclient.com.au` does not.
- **Subdomains roll up.** `x@mail.acmeclient.com.au` matches `acmeclient.com.au`. The most specific client domain wins (`shop.bigbrand.com.au` beats `bigbrand.com.au`).
- **Shared providers** (gmail.com, outlook.com, bigpond.com and so on) are never a client domain. Contacts on them match by exact address only.
- **Our own addresses** (the connected mailbox's domain and `MAIL_OWN_DOMAINS`) are ignored, so sent mail matches on its recipients.
- **Ties:** if two clients claim a domain, an active client beats an inactive one. If it's still tied, the email stays unmatched and can be assigned by hand from the reading pane.
- **Your own choice wins.** On an open email, **Client: <name> ▾** sets which client that sender's emails go to, for the address or the whole `@domain`, or *No client*, or back to *Automatic*. It decides the list pill, which client new emails are saved to and *Use client data*. Choosing a client also moves that sender's already-stored, automatically filed emails to it (emails assigned by hand or summarised stay put). Choices are per user, in Payload preferences under `mail-sender-clients` (`src/lib/mail/sender-clients.ts`); **★ Clients** lists them.

## Storage and sync

- `client-emails` holds one row per Gmail message id (unique index, plus a find-before-create), with the message id, thread id, from, to, cc, subject, date, body and Gmail link. Re-syncs never duplicate.
- `client-email-summaries` holds confirmed summaries, each linked to its source email. A row is created only when you click **Add to timeline**.
- `mail-sync-states` holds a per-user Gmail `historyId`. Sync runs when Mail opens, on **Refresh**, and daily from the `/api/mail/sync/cron` job (03:30 UTC in `vercel.json`) for every mailbox that has opened Mail once and still has the Mail feature. The first sync, or one after Gmail expires the history, looks back 14 days (up to 200 messages). After that it uses Gmail's incremental history API. One sync reads at most about 500 new messages; when there are more, the cursor stops at the last one read and the next sync carries on, so nothing is skipped.
- **Not stored:** emails that match no client, emails from your hidden senders, and automated mail (`src/lib/mail/automated-senders.ts`): no-reply / notification style senders, or emails with Auto-Submitted, Precedence bulk/list/junk, List-Id or List-Unsubscribe headers. Assign one by hand if you do want it kept.
- **Cleanup:** Mail → **Hidden** → **Check stored emails** counts stored rows from your own mailbox that are from hidden senders or automated, and deletes them only after you confirm (`/api/mail/cleanup`).
- **Retention:** the daily cron deletes stored emails dated more than 12 months ago.
- **Always kept:** cleanup and retention never delete emails assigned by hand or summarised to a timeline. Gmail itself is never changed.
- Unmatched mail is not stored. It stays in Gmail and shows in the Mail inbox.

## Gmail accounts

Mail shows one Gmail account at a time. The breadcrumb reads *Home / Mail / <email>*, and the email is the account switcher: it lists your main Gmail (the one on your user record) and any extra accounts, and **+ Add another Gmail account** runs Google sign-in (`/api/gmail/connect?add=1`, account picker shown) and saves the new address to `mail-accounts`. Picking your main address there just reconnects it. **✕** removes an extra account from Mail (Gmail is not changed).

- Every Mail request names the account on screen in the `x-mail-account` header; the server only resolves it against your own accounts (`getValidGmailToken(userId, account)`), and no header means the main Gmail.
- A compose window keeps the account it was opened in, even if you switch while writing.
- Each extra account syncs client emails on its own cursor (on its `mail-accounts` row) when Mail opens it, on Refresh and in the daily cron; its alerts open Mail on that account (`?account=`).
- Scheduled emails and follow-up reminders record their account and are sent/checked from it; the Scheduled and Awaiting reply tabs show the account on screen. If an extra account is removed, its scheduled emails fail instead of going out from another account.

## Client email alerts ("Client email – please read")

A drop-down under the Mail button in the admin header tells you when a known client has emailed you, without opening Gmail.

- **What triggers it.** A sync that stores a *new inbound* email from a matched client (same matching, hidden-sender and automated-mail rules as above). Sent mail, unmatched mail, and mail from hidden or automated senders never alert. Code: `src/lib/mail/client-email-alerts.ts`, called from `syncMailbox`.
- **Who sees it.** Only the person whose mailbox received the email. Each alert is a `notifications` row (kind `client-email-received`) for that user, so it also shows in the top-bar bell.
- **Noise limits.** No alerts on the first 14-day sync or a history-expired re-sync, none for emails older than 24 hours, at most 5 per sync (newest first), and one per Gmail message, ever.
- **Actions.** **Open email** marks it read and opens the thread in Mail (`/admin/mail?thread=<id>`). **Later** or × hides the drop-down; the alert stays unread.
- **How it checks.** `ClientEmailAlert` (mounted by `MailHeaderAlerts`) calls `GET /api/mail/client-alerts?sync=1` every 60 seconds while the tab is visible. The route runs the normal incremental sync for your own mailbox at most once every ~55 seconds (across all your tabs), then returns your undismissed alerts. A sync error never breaks the panel. Users without Mail access or without Gmail connected see nothing.
- **Setup.** None beyond Mail itself: Gmail connected and the Mail feature.

## Client senders and the dashboard panel ("Unread client emails")

The admin dashboard shows a small **Unread client emails** panel. It lists unread inbox emails from clients: any sender that [client matching](#client-matching) resolves to a client (Website URL domain, contact domains, or an exact contact address on a shared provider), plus senders you starred as clients.

- **Starring.** In Mail, open an email and click **☆ Mark as client**. For a company domain you choose the address or the whole `@domain` (subdomains included), like Hide sender. **★ Client** shows it is starred; click it to unstar. **★ Clients** in the toolbar lists, adds and removes entries. Starred senders get a ★ in the inbox list.
- **Storage.** Same as hidden senders: Payload per-user preferences, key `mail-client-senders` (`src/lib/mail/client-senders.ts`). Per user, nothing changed in Gmail. Starring adds senders that automatic client matching doesn't cover (e.g. a client's personal Gmail that isn't a contact).
- **Filtering.** `GET /api/mail/client-unread` searches your own inbox for `is:unread` mail from every client domain/contact address and starred sender (split into several searches of at most 1,500 characters when there are many clients), then re-checks every thread in code: unread, and the sender's actual address is starred or resolves to a client. Auto-matched senders on your hidden list and no-reply style senders are skipped; a starred sender shows even if it is also hidden. With no client senders at all Gmail is not queried. At most 8 rows are returned, newest first; the panel links to Mail when there are more.
- **States.** Loading, an error with Retry, **Connect Gmail** when Gmail isn't connected, a prompt to add a client Website URL or star a sender when there are no client senders at all, and *No unread emails from clients* when nothing matches. Users without the Mail feature don't see the panel. Rows open the thread in Mail (`/admin/mail?thread=<id>`), which marks it read.

## Behaviour notes

- **Unread first, always.** The inbox lists every unread thread before any read one: `/api/mail/inbox` pages through `is:unread` first, then carries on with `-is:unread` in the same page once they run out, so an old unread email never hides on a later page. (A thread you just read stays where it is until the list reloads.)
- **45 emails per page.** Each page of the list holds 45 threads before *Load more* (`MAIL_LIST_PAGE_SIZE`). Gmail pages count messages, and a search can return one thread several times, so the route tops up a short page with up to 4 Gmail requests.
- The search box sits at the top of the email list, above the first email.
- Opening an unread thread marks it read, as Gmail does. **Mark unread** undoes that.
- **Notes in their email.** Replying from an open email, **•••** under your reply shows the email you're replying to in its own editor, so you can type notes (in colour, with the formatting bar) straight into it. It's sent after your reply as a Gmail-style *On …, … wrote:* quote, with your signature below. *Write with AI* and voice only rewrite your reply above it. Hide it again to leave it out.
- **Remind me if no reply** is *Off* unless you choose a number of business days for that email.
- Threads show the newest message first.
- **Reply with AI** replies to the latest message in the thread. Each message also has *Reply to this email*.
- **Save as draft** uses `/api/gmail/draft` (with `html`, so it keeps formatting, images and files) and updates the same draft on later saves.
- **Rich body.** The compose body is a Lexical editor (`src/components/mail/RichEmailEditor.tsx`). Cmd/Ctrl+B, I and U format text, and the formatting bar adds colour, lists and tables. Pasted tables from Sheets, Excel, Docs or web pages are kept, and **Insert table** adds an empty one. Pasted or inserted images show inline and are sent as `cid:` inline parts (`src/lib/mail/compose-html.ts`). Pasted non-image files and **Attach files** become attachments. Images and attachments are capped at 3 MB in total per email, because the request body carries them and many hosts (Vercel included) limit it to 4.5 MB. The server re-checks everything in `src/lib/mail/compose-content.ts`: it sanitises the HTML, allows only `cid:` or https images, sniffs image bytes, and blocks the file types Gmail blocks.
- **Signature.** Your Gmail signature is previewed under the body and appended by the server on Send / Save as draft.
- **Add calendar invite.** The toolbar button right of **Write message** opens a small form: title, date, start, length and guests (searched from your mail contacts). `POST /api/mail/calendar-event` creates the event with a Google Meet link on the calendar of the mailbox Mail is showing, using the shared Calendar connection only when it is that same account (otherwise it says Calendar isn't connected for that mailbox). **Send to client / user** ticked: Google emails the guests. Unticked: nobody is emailed and the Meet link is copied, with a small pill like double-clicking an address; if the browser blocks the clipboard, the link is shown to copy by hand (`src/lib/mail/new-calendar-event.ts`).
- **Attachments.** Files attached to a received email show as download buttons under it (name and size). The thread route lists them by MIME part id (Gmail's attachment ids change on every read; images the body shows through `cid:` are left out), and `GET /api/mail/message/[id]/attachment?part=` re-reads the message and streams that one file as a download, up to 25 MB (`src/lib/mail/message-attachments.ts`). With more than one attachment, **Download all** fetches each file through that same route, one after another; if any fail, the rest still download and a note says how many made it.
- **Inline images.** Images a received email shows through `cid:` (pasted screenshots, signature logos) are fetched by the thread route and embedded in the reading pane as `data:` image URLs after the HTML is sanitised (`embedInlineImages` in `src/lib/mail/email-html.ts`). Up to about 2.5 MB of images per thread, newest message first, to stay under a 4.5 MB response limit; any image past that shows as a download button instead.
- **TLDR.** Each email has a **TLDR** button (in the ⋯ menu on phones). `POST /api/mail/tldr` sends only that one email to the model (no thread, no client data) and shows a private summary, suggested actions, clarifying questions for the sender (only when the email leaves something out; **Ask these in a reply** puts them in the Write with AI box) and a suggested reply under the email. Nothing is saved or sent; pressing the suggested reply opens a reply with it in the **Write with AI** box only, never in the body (`src/lib/mail/tldr.ts`).
- **Gmail drafts open here.** Links to `/admin/mail?draft=<message id>`, which loads the draft (HTML, inline images, attachments; 3 MB max) into the compose window. Sending it deletes the old Gmail draft.
- **Recipient suggestions.** To, Cc and Bcc suggest addresses from the second letter typed (after the last comma), matching the start of an address, its domain, or a word of the person's name. Tab, Enter or a click adds the highlighted address; the arrows move, Escape closes. The list comes from `GET /api/mail/contacts`: the last year of your own Gmail (up to 150 sent and 150 received emails, headers only). Everyone you emailed counts; someone who only emailed you counts once they have emailed you more than once (From line only), and never when the email is marketing, automated or spam-like (Promotions/Social/Updates/Forums tabs or Spam, List-Unsubscribe or other bulk headers, no-reply senders, no To/Cc or "undisclosed recipients", bulk-mailer addresses such as `news.brand.com` or long digit/tracking ids). Account and marketing mailboxes (no-reply, notifications, billing, accounts, receipts, newsletter…) and your own addresses are never suggested; shared inboxes (hello@, info@, team@, support@…) only when you emailed them yourself. People you've emailed rank first, then by how often, then most recent (`src/lib/mail/contacts.ts`).
- **People saved in this browser.** The server stores nothing, but the browser keeps the list (names and addresses only, per Gmail account, at most 1,000 people) in localStorage (`src/lib/mail/people-cache.ts`), so the search box and To/Cc/Bcc suggest straight away. It is fetched from Gmail again in the background only when it is over 6 hours old (once the inbox has loaded and synced, or when a field is focused), and not used at all after 14 days.
- **Search.** The search box suggests people as you type (regular senders first, then people you email); typing `@` and part of a domain lists that domain's people. *Search in* limits the search: *Everything* (the person, subject and text), *Name or address*, *Subject*, or *Email text* (Gmail has no body-only search, so this is its plain word search, which also covers the subject). In the Inbox the person is the sender; in Sent and Drafts it is the recipients. Part of a name ("rebe") also finds the people it matches. Hand-written Gmail searches (`from:`, quotes, `OR`…) are passed through as typed (`src/lib/mail/inbox-search.ts`).
- **Open in new window.** The ⧉ button on the compose window (not on phones) moves the email you're writing or replying to into its own browser window (`/admin/mail/window?compose=…`). It is saved to Gmail Drafts first and handed over directly between the two windows (same site only, `src/lib/mail/compose-popout.ts`), attachments and pasted images included; the window closes itself after Send, Schedule or Close.
- **Saved triage.** The last *Triage unread* results (categories, senders, subjects, message ids and what is ticked) are kept in this browser per Gmail account (`src/lib/mail/triage-store.ts`), so closing the panel or reloading Mail shows them again. Only one triage is kept: *Triage again* replaces it, and it is deleted once everything in it has been archived or marked read (or after 14 days).
- **Archive** only removes the Inbox label. **Delete** moves emails to Gmail's Bin (with Undo); Mail never deletes permanently, except drafts you delete.

## Screenshots and files

- **Paste** a screenshot or copied image into the body: it goes inline where the cursor is, is sent as a `cid:` inline image, and a drop shadow is drawn into the picture on send. Screenshots stay PNG so text stays sharp.
- **Drag and drop** files (images included) onto the compose window: they are attached. A drop highlight shows while dragging.
- **Paste** a non-image file: attached.
- Images and attachments share a 3 MB limit per email; the server re-checks types and sizes (`src/lib/mail/compose-content.ts`).
