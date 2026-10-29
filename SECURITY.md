# Security policy

Mail handles OAuth tokens for Gmail, Google Calendar and AI providers, and real email content. Please report vulnerabilities privately.

## Reporting

Use GitHub's **Report a vulnerability** (Security tab → Advisories) on this repository. Include steps to reproduce and the impact. Don't open a public issue, and don't include real email content or credentials.

We aim to acknowledge reports within a few working days and to fix confirmed issues before disclosing them.

## Operating it safely

- Keep `PAYLOAD_SECRET`, `CRED_ENCRYPTION_KEY`, `CRON_SECRET`, Google and AI secrets out of source control (`.env*` is git-ignored; only `.env.example` is committed).
- The database holds Gmail refresh tokens and stored client email. Restrict access to it and protect backups like credentials.
- AI OAuth tokens are encrypted with `CRED_ENCRYPTION_KEY`; rotating that key means reconnecting the logins.
- Serve the app over HTTPS only; the OAuth state cookies are `Secure` in production.
