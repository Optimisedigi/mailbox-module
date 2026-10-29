# Contributing

Thanks for helping. Bug reports, fixes, docs and features are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- **Never put real email, addresses, tokens or keys in issues, tests, fixtures or screenshots.** Use `example.com`, `*.test` or made-up names. Report security problems privately (see [SECURITY.md](SECURITY.md)), not in issues.

## Development setup

```bash
nvm use            # Node from .nvmrc
npm install
cp .env.example .env   # PAYLOAD_SECRET is enough for tests; Google/AI keys for manual testing
npm run dev
```

Tests never call Gmail, Google Calendar or any AI provider; everything external is mocked. You only need real credentials to try changes by hand, and then use a test mailbox.

## Checks (all must pass; CI runs them)

```bash
npm run typecheck
npm test
npm run build
```

## Guidelines

- **Follow the code around you**: TypeScript strict, named helpers in `src/lib/mail/`, UI in `src/components/mail/` with CSS Modules (no global CSS).
- **Keep the safety rules** in [docs/features.md](docs/features.md#rules-it-follows): each AI action sends only the email(s) it needs, and more only when the user opts in; nothing is sent without the Send button; voice has no send tool; sync never calls a model; Mail never permanently deletes Gmail messages; the client for AI facts is resolved on the server, never taken from the browser. Changes that weaken these will not be merged.
- **Validate input** on every route and keep the auth check (`requireMailUser()` or equivalent) first.
- **Tests**: every bug fix gets a regression test; new behaviour gets tests next to the existing ones in `tests/`.
- **Prompts** live in `src/lib/mail/prompts.ts` only.
- **Schema changes**: edit the collection, run `npm run migrate:create <name>`, commit the migration, and note it in the PR.
- **Accessibility**: keep labels, roles, focus handling and keyboard support working.
- **Dependencies**: avoid new ones; if needed, pin an exact version and explain why.
- Keep comments short and only where the *why* isn't obvious.

## Pull requests

1. Fork, branch from `main`, make focused commits.
2. Describe what changed and why, how you tested it, and any setup or migration steps.
3. Update the docs when behaviour or configuration changes (`README.md`, `docs/`, `.env.example`).

By contributing you agree your contribution is licensed under the [MIT License](LICENSE).
