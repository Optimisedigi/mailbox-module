# Connecting Google Cloud (Gmail and Calendar)

Mail talks to Gmail and Google Calendar through **one Google OAuth client** that you create in your own Google Cloud project. Each user signs in with their own Google account; their tokens are stored on their user record (main Gmail) or in `mail-accounts` (extra Gmail accounts). Nothing is shared between users except the optional Calendar connection.

## 1. Create a project and enable the APIs

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library**: enable **Gmail API**. Enable **Google Calendar API** too if you want invite answers and "Add calendar invite".

## 2. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen** (Google Auth Platform → Branding / Audience / Data access):

- **User type / Audience**
  - *Internal*: only accounts in your Google Workspace can sign in. No Google review needed. Best for a team inside one Workspace.
  - *External*: any Google account. While the app is in *Testing*, add every user under **Test users** (max 100) and note that Google expires testing refresh tokens after 7 days. For production use with Gmail scopes Google requires verification, and the restricted Gmail scopes need a security assessment.
- **Scopes** (Data access): add the scopes Mail requests:

| Scope | Why |
| --- | --- |
| `https://www.googleapis.com/auth/gmail.readonly` | Read the inbox, threads, attachments. |
| `https://www.googleapis.com/auth/gmail.compose` | Create drafts and send. |
| `https://www.googleapis.com/auth/gmail.modify` | Archive, mark read/unread, and move emails to the Bin (Mail never deletes permanently). |
| `https://www.googleapis.com/auth/gmail.settings.basic` | Read your Gmail signature. |
| `https://www.googleapis.com/auth/calendar.readonly`, `.../calendar.events` | Calendar (only for the Calendar connection). |
| `openid`, `.../userinfo.email` | Know which address signed in. |

## 3. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**
- **Authorized redirect URIs** (add each environment you run):
  - `http://localhost:3000/api/gmail/callback`
  - `http://localhost:3000/api/calendar/callback`
  - `https://your-domain.example/api/gmail/callback`
  - `https://your-domain.example/api/calendar/callback`

Copy the client ID and secret into `.env`:

```bash
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GMAIL_REDIRECT_URI=http://localhost:3000/api/gmail/callback
CALENDAR_REDIRECT_URI=http://localhost:3000/api/calendar/callback
```

`GMAIL_REDIRECT_URI` must match a listed redirect URI **exactly** (scheme, host, port, path). Mismatches show Google's `redirect_uri_mismatch` error.

## 4. Connect in the app

- **Gmail**: open Mail and press *Connect Gmail* (or **AI Auth → Gmail connection**). The route is `GET /api/gmail/connect`. To add another account, use the account switcher in Mail's breadcrumb → *Add another Gmail account* (`/api/gmail/connect?add=1`).
- **Calendar** (admin): **Google Calendar** global → *Connect Google Calendar* (`/api/calendar/connect`). See [connectors.md](connectors.md#google-calendar) for when Mail uses it.

## Several Workspaces: extra OAuth apps (optional)

An *Internal* app only signs in its own Workspace; other accounts get `Error 403: org_internal`. To serve another Workspace or a personal Gmail, create a second OAuth client (in that Workspace's Google Cloud, or as an External app) with the same redirect URI, then:

```bash
GMAIL_ALT_CLIENT_ID=...
GMAIL_ALT_CLIENT_SECRET=...
GMAIL_ALT_DOMAINS=partner.example        # Workspace domains it serves
GMAIL_ALT_ACCOUNTS=someone@gmail.com     # and/or exact addresses
```

Up to three: `GMAIL_ALT_*`, `GMAIL_ALT2_*`, `GMAIL_ALT3_*`. The address decides which app signs it in and refreshes its tokens (exact address first, then domain, else the main app); the callback refuses tokens from the wrong app.

## Security notes

- OAuth `state` is HMAC-signed with `PAYLOAD_SECRET` and checked against an httpOnly nonce cookie and the signed-in user, so one user can never bind tokens to another.
- Refresh tokens are stored in your database. Restrict database access accordingly, and back it up like any credential store.
- Revoke access any time at <https://myaccount.google.com/permissions>, or with **Disconnect** on the AI Auth page.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `redirect_uri_mismatch` | Add the exact `GMAIL_REDIRECT_URI` to the OAuth client. |
| `Error 403: org_internal` | The account is outside an Internal app's Workspace: make the app External or add a `GMAIL_ALT_*` app. |
| *Reconnect Gmail* button / `scope-insufficient` | The account was connected before a scope was added. Press Reconnect. |
| Tokens stop working after a week | External app in *Testing* mode: publish it, or reconnect. |
| *Gmail is busy* (429) | Gmail's per-user rate limit. Wait a minute. |
