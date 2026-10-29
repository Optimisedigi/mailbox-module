import { google } from "googleapis";
import { createGoogleOAuth2Client } from "@/lib/google-oauth-client";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

function getOAuth2Client(redirectUri?: string) {
  return createGoogleOAuth2Client(redirectUri || process.env.CALENDAR_REDIRECT_URI);
}

/**
 * Generate the Google OAuth consent URL for Calendar access.
 *
 * @param redirectUri - OAuth redirect URI; must match the callback route.
 * @param state - Random CSRF state. The caller must persist this in an
 *   httpOnly cookie and constant-time compare against the value Google
 *   returns on the callback.
 */
export function getCalendarOAuthUrl(redirectUri: string, state: string): string {
  const oauth2Client = getOAuth2Client(redirectUri);
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state,
    redirect_uri: redirectUri,
  });
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCalendarCode(code: string, redirectUri?: string) {
  const oauth2Client = getOAuth2Client(redirectUri);
  const { tokens } = await oauth2Client.getToken(code);
  return {
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token!,
    expiry: tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : null,
  };
}

/**
 * Get the connected user's email address.
 */
export async function getCalendarUserEmail(accessToken: string): Promise<string> {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  return data.email || "";
}

/**
 * Get an authenticated Calendar client using the stored refresh token.
 */
export async function getAuthenticatedCalendarClient(refreshToken: string) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2Client.refreshAccessToken();
  oauth2Client.setCredentials(credentials);
  return google.calendar({ version: "v3", auth: oauth2Client });
}
