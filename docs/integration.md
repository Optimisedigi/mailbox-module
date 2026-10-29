# Integrating Mail into another app

Mail is built on **Payload CMS 3** (auth, storage, admin shell) and **Next.js 16 App Router**. The supported way to embed it is in another Payload 3 + Next.js app. Other stacks need the storage and auth layer ported (see the end of this page).

## What you add

| Part | From this repo | Into your app |
| --- | --- | --- |
| Schema | `mailboxPlugin()` (`src/mailbox/plugin.ts`) | your `payload.config.ts` `plugins` |
| UI | `src/components/mail/`, `src/components/{AiAuthPage,AdminStepNavSetter,ApiCreditsNotice,ConnectCalendarButton}.tsx`, `src/components/chat-image-fit.ts` | your components folder |
| Logic | `src/lib/**`, `src/extensions/`, `src/collections/`, `src/globals/`, `src/mailbox/` | your source folder |
| Pages | `src/app/(payload)/admin/mail/`, `src/app/(payload)/admin/ai-auth/` | your Payload admin route group |
| API | `src/app/(frontend)/api/{mail,gmail,calendar,ai-auth,notifications}/` | any route group under `app/` |
| Crons | `vercel.json` `crons` | your scheduler |

## Step by step

1. **Dependencies.** Install what this repo's `package.json` lists that you don't have yet, at the same versions: `lexical` and `@lexical/*` 0.50.0, `googleapis`, `zod`. Payload and Next must be the same major versions (Payload 3, Next 16, React 19).

2. **Copy the source.** Copy `src/` from this repo into a folder of your app, e.g. `src/mailbox-module/`. Then point the `@/*` path alias the module uses at it. If `@/*` already means your own `src/`, copying the module's folders straight into your `src/` also works; check these names don't clash first: `lib/access.ts`, `lib/swipe.ts`, `lib/visible-entities.ts`, `lib/relationship-id.ts`, `collections/Users.ts`, `collections/Clients.ts`.

   The module also imports `@/payload.config`; alias it to your Payload config (in `tsconfig.json` `paths` and your bundler).

3. **Register the plugin** in your Payload config:

   ```ts
   import { mailboxPlugin } from './mailbox-module/mailbox/plugin'

   export default buildConfig({
     // ...your config
     plugins: [
       mailboxPlugin({
         // Path from admin.importMap.baseDir to the copied folder.
         componentPathPrefix: './mailbox-module/',
         // false = don't add the Mail sidebar link, header alert and dashboard card.
         adminComponents: true,
       }),
     ],
   })
   ```

   The plugin:
   - adds the Mail collections (`client-emails`, `mail-accounts`, `scheduled-emails`, `mail-follow-ups`, …) and globals (`mail-settings`, `calendar-auth`), skipping any slug you already have;
   - **adds only the missing fields** Mail needs (`role`, `featureAccess`, `gmailConnected`, `gmailEmail`, `gmailAccessToken`, `gmailRefreshToken`, `gmailTokenExpiry`) to your existing `users` collection, or adds the bundled one if you have none;
   - adds the bundled `clients` collection only if you have no `clients` collection (see [client-list.md](client-list.md)).

4. **Regenerate the admin import map** (`payload generate:importmap`) so the Mail components are registered.

5. **Copy the pages and routes.** Put `admin/mail` and `admin/ai-auth` next to your other custom admin views (inside the same route group as Payload's `admin/[[...segments]]`). Their `importMap` import path must point at your `admin/importMap.js`. Copy the API folders under any route group.

6. **Database.** Create a migration for the new schema (`payload migrate:create mailbox`) and run it. Mail's tables are additive; it never alters your existing ones except for the added user fields.

7. **Environment.** Add the variables from `.env.example` (Google, `CRED_ENCRYPTION_KEY`, AI keys, `CRON_SECRET`, …).

8. **Crons.** Schedule the three routes in the README (`/api/mail/schedule/tick`, `/api/mail/follow-ups/cron`, `/api/mail/sync/cron`) with `Authorization: Bearer $CRON_SECRET`.

9. **Google Cloud.** Add your app's `/api/gmail/callback` and `/api/calendar/callback` URLs to the OAuth client.

## Access control

Mail checks access through one function, `userHasFeature(user, feature)` in `src/lib/access.ts`:

- `nav:mail`: can use Mail (every `/api/mail/*` route and the pages check it).
- `clients`: can use client data in AI requests, edit client timelines and client email settings.

Admins (`role: "admin"`) have every feature; others get them via `featureAccess`. **If your app has its own permission system, replace the body of `userHasFeature`** (keep the signature) and the rest follows. Non-admins only ever see emails synced from their own mailbox.

## Styling

- All Mail styling is in CSS Modules next to the components (`MailApp.module.css`, `ComposeWindow.module.css`, …). No global CSS is required, nothing leaks out, and nothing in your global CSS is needed.
- Colours are CSS variables set on the Mail root (`--mh-*`, `--mail-*` in `MailApp.module.css`). Override them in a wrapper to theme Mail.
- Some elements use Payload's theme variables (`--theme-elevation-*`) with fallbacks, so Mail follows Payload's light/dark theme.
- Floating layers (compose window, alerts) use high `z-index` values (99999–100000) so they sit above the admin shell.
- If your app has its own floating button in the bottom-right corner (a chat assistant, say), keep Mail clear of it by setting `--mailbox-corner-reserve` (desktop) and `--mailbox-corner-reserve-phone` (≤768px) on `:root` to the width it needs, e.g. `96px` and `66px`. Both default to `0px`. When that assistant opens a panel, fire `window.dispatchEvent(new Event('mailbox:assistant-opened'))` and an open compose window minimises out of its way (`src/lib/mail/host-events.ts`).

## Linking into Mail

- Open a thread: `/admin/mail?thread=<gmail thread id>&account=<email>` (`mailThreadPath()` in `src/lib/mail/drafts.ts`).
- Open a Gmail draft in the compose window: `/admin/mail?draft=<gmail message id>`.
- Single-email window: `/admin/mail/window?thread=<id>`.
- Refresh your own notification badge when Mail marks mail read: listen for `mailbox:notifications-changed` on `window`.

## Without Payload

Porting to another stack is possible but is real work: the Gmail transport, matching, prompts, MIME building, HTML sanitising and UI (`src/lib/mail/*`, `src/components/mail/*`) are framework-light, but the routes use Payload for auth (`payload.auth`), storage (`payload.find/create/update`) and per-user preferences (`payload-preferences`). You would replace `requireMailUser()` (`src/lib/mail/route-helpers.ts`), the storage calls in `src/lib/mail/*.ts`, and the admin page shell (`DefaultTemplate`).
