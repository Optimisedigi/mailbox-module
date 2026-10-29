import { google } from "googleapis";

/**
 * Build a Google OAuth2 client for one of the Google integrations.
 *
 * All integrations share the same OAuth app (`GOOGLE_CLIENT_ID` /
 * `GOOGLE_CLIENT_SECRET`) and differ only in their redirect URI. Values are
 * read at call time so tests and serverless cold starts pick up the current
 * environment. Gmail can also pass another app's credentials (see
 * gmail-oauth-apps.ts).
 */
export function createGoogleOAuth2Client(
  redirectUri: string | undefined,
  clientId: string | undefined = process.env.GOOGLE_CLIENT_ID,
  clientSecret: string | undefined = process.env.GOOGLE_CLIENT_SECRET,
) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}
