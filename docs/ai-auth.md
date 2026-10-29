# AI providers and the AI OAuth flow

Every Mail AI feature (Write with AI, revisions, suggested subject, TLDR, thread questions, client briefs, triage, summaries) goes through one server-side function, `runMailModel()` (`src/lib/mail/run-model.ts`), which calls `callLLM()` (`src/lib/ai/llm`). The browser never sees a provider key or token.

## Choosing the model

1. **Mail Settings → Email assistant model** (admin), else
2. `MAIL_AI_MODEL` (a model name from `src/lib/ai/llm/registry.ts`), else
3. the default, `kimi-k3`, which needs the Kimi For Coding login. **If you only use API keys, set `MAIL_AI_MODEL`** (or Mail Settings) to a model whose key you have; otherwise every call first tries Kimi and then falls back.

If the chosen model's provider fails or has no credential, Mail walks `DEFAULT_AUTONOMOUS_FALLBACKS` (`kimi-k3` → `claude-sonnet-5.5` → `minimax-m3`). Every call is logged in **Mail AI Requests** (action, Gmail id, email count, model, status; never email content).

**Mail Settings → Writing style** is your house style for drafts (tone, sign-off, words to avoid). It is added to reply/draft prompts only. Who the model writes for comes from `MAIL_ORG_NAME`, `MAIL_ORG_DESCRIPTION` and `MAIL_LANGUAGE`.

## Option A: API keys (recommended)

Set the key for the provider of the model you picked. No OAuth needed.

| Provider | Variable | Example models |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-5.5`, `claude-opus-5.5`, `claude-haiku-5.5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` |
| Moonshot (Kimi) | `KIMI_API_KEY` | `kimi-k2.6` |
| MiniMax | `MINIMAX_API_KEY` | `minimax-m3` |
| Xiaomi MiMo | `MIMO_API_KEY` | `mimo-v2.6-pro`, `mimo-v2.6-flash` |
| xAI | `XAI_API_KEY` | `grok-4.7` |

## Option B: subscription OAuth logins

### Read this first

> [!CAUTION]
> These logins use the **public OAuth client IDs of the vendors' own command-line tools** (Codex CLI, Grok CLI, kimi-cli) and call endpoints meant for those tools, not documented public APIs. Using them from a server may be against the provider's terms of service. The provider can change, rate-limit or revoke them at any time, without notice. Use API keys for anything that matters, and check each provider's terms yourself before connecting.
>
> Anthropic's Claude Code OAuth is deliberately **not** included: Anthropic's terms do not allow its use by third-party apps. Use `ANTHROPIC_API_KEY` for Claude.

To stop using a login, press **Disconnect** on the AI Auth page, or tick **Force fallback** for that provider to skip it without losing the login.

### Setup

1. Set `CRED_ENCRYPTION_KEY` (64 hex characters). A login gives the app a long-lived refresh token; it is encrypted with this key (AES-256-GCM) before it is stored in the `ai-credentials` collection, which no API or admin screen can read. Only needed for these logins, not for API keys.
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Sign in as an admin and open **AI Auth** (`/admin/ai-auth`).

### The flows

| Login | Flow | Routes |
| --- | --- | --- |
| **ChatGPT plan (Codex OAuth)** | Authorization code + PKCE, paste flow. *Begin login* opens ChatGPT sign-in; after you approve, the browser lands on `http://localhost:1455/auth/callback?...`, which does not load. Copy that URL, return, press *Finish login* (reads the clipboard) or paste it. | `POST /api/ai-auth/begin`, `POST /api/ai-auth/complete` |
| **xAI Grok (SuperGrok)** | OAuth device code. A code is shown and a sign-in tab opens; approve there and the page completes on its own. | `POST /api/ai-auth/grok/begin`, `POST /api/ai-auth/grok/poll` |
| **Kimi For Coding** | OAuth device code, as above. | `POST /api/ai-auth/kimi/begin`, `POST /api/ai-auth/kimi/poll` |

The PKCE verifier and state live in a 10-minute httpOnly cookie. Access tokens are refreshed automatically shortly before they expire; concurrent refreshes in one server instance share one request.

### How a call picks its credential

`resolveCredential(provider)` (`src/lib/ai/llm/auth/resolver.ts`):

1. Provider supports OAuth, *Force fallback* is off, and a login is stored → use it (refresh if needed). **If that fails, it does not fall back to the same provider's API key**; it raises an error and the call moves to the next fallback model, and the failure is recorded in `ai-auth-events` and shown on AI Auth.
2. No login stored → use the provider's API key from the environment.
3. Neither → the next fallback model.

**Status and probe.** AI Auth lists each provider's login state, whether its key is set and the last failure, and *Probe* sends a one-token prompt to a model to show which credential served it.

## Voice drafting (OpenAI Realtime)

The compose window's mic opens an OpenAI Realtime call over WebRTC. The browser gets only a short-lived `ek_…` client secret from `POST /api/mail/voice/realtime-secret`; the real credential stays on the server.

- **Mail Settings → Use OpenAI API key for voice** off (default): the secret is minted with the connected **ChatGPT plan** (Codex login). With no login connected, voice says so; it never falls back to the key.
- On: minted with `OPENAI_API_KEY`, billed per minute. The call shows a *Using API credits* badge.
- Model `gpt-realtime-2.1`, voice `marin` (constants at the top of `src/app/(frontend)/api/mail/voice/realtime-secret/route.ts`).

The voice agent has exactly two tools, both running in the browser against the compose window: `write_email_draft` and `read_current_draft`. It cannot send, schedule or touch Gmail.
