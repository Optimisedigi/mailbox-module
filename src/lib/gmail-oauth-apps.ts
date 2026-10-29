import { createGoogleOAuth2Client } from "@/lib/google-oauth-client";
import { OAUTH_NONCE_COOKIE } from "@/lib/oauth-state";

/**
 * The Google OAuth apps Gmail can sign in with.
 *
 * - "main": the CMS's own app (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), used
 *   for every Google integration. It is "Internal", so Google only lets it sign
 *   in accounts of its own organisation (others get Error 403: org_internal).
 * - "alt", "alt2", "alt3": extra apps, for Gmail only, each serving accounts
 *   the main app cannot sign in. Each is configured with
 *     GMAIL_ALT{,2,3}_CLIENT_ID and GMAIL_ALT{,2,3}_CLIENT_SECRET, plus
 *     GMAIL_ALT{,2,3}_DOMAINS and/or GMAIL_ALT{,2,3}_ACCOUNTS: comma-separated
 *     Workspace domains ("partnerco.com.au") or exact addresses
 *     ("someone@gmail.com"; a personal Gmail has no domain of its own).
 *   An app is only used once its ID, secret and at least one domain or
 *   address are set.
 *
 * An account's address always tells which app issued its tokens (an exact
 * address first, then its domain, else the main app), so token refresh picks
 * the app the same way: no stored flag needed. The OAuth callback enforces it
 * (tokens are only kept when the signed-in address maps to the app that signed
 * it in), so the rule holds for every saved token. All apps use the same
 * redirect URI (GMAIL_REDIRECT_URI).
 */

export const GMAIL_EXTRA_APPS = ["alt", "alt2", "alt3"] as const;
export type GmailExtraApp = (typeof GMAIL_EXTRA_APPS)[number];
export type GmailOAuthApp = "main" | GmailExtraApp;

const ENV_PREFIX: Record<GmailExtraApp, string> = { alt: "GMAIL_ALT", alt2: "GMAIL_ALT2", alt3: "GMAIL_ALT3" };

/** The nonce cookie of each extra app's "add account" flow (the callback reads the app from it). */
export const GMAIL_EXTRA_APP_COOKIE: Record<GmailExtraApp, string> = {
  alt: OAUTH_NONCE_COOKIE.gmailAddAlt,
  alt2: OAUTH_NONCE_COOKIE.gmailAddAlt2,
  alt3: OAUTH_NONCE_COOKIE.gmailAddAlt3,
};

const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const ADDRESS_RE = /^[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** Which accounts an extra app signs in (no credentials). */
export interface GmailExtraAppTarget {
  app: GmailExtraApp;
  /** Sorted, lowercase. */
  domains: string[];
  /** Sorted, lowercase. */
  addresses: string[];
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function readTarget(app: GmailExtraApp): GmailExtraAppTarget | null {
  const prefix = ENV_PREFIX[app];
  if (!env(`${prefix}_CLIENT_ID`) || !env(`${prefix}_CLIENT_SECRET`)) return null;
  const entries = `${env(`${prefix}_DOMAINS`)},${env(`${prefix}_ACCOUNTS`)}`
    .split(",")
    .map((entry) => entry.trim().toLowerCase());
  const addresses = [...new Set(entries.filter((entry) => ADDRESS_RE.test(entry)))].sort();
  const domains = [
    ...new Set(entries.map((entry) => entry.replace(/^@/, "")).filter((entry) => !entry.includes("@") && DOMAIN_RE.test(entry))),
  ].sort();
  return domains.length || addresses.length ? { app, domains, addresses } : null;
}

/** The extra apps that are fully set up, in order (alt, alt2, alt3). */
export function gmailExtraAppTargets(): GmailExtraAppTarget[] {
  return GMAIL_EXTRA_APPS.map(readTarget).filter((target): target is GmailExtraAppTarget => target !== null);
}

/** The configured extra app named by a request parameter, or null (unknown or not set up). */
export function parseGmailExtraApp(value: string | null | undefined): GmailExtraApp | null {
  return gmailExtraAppTargets().find((target) => target.app === value)?.app ?? null;
}

/** The app whose tokens this address has: an app listing the exact address, else one listing its domain, else "main". */
export function gmailAppForEmail(email: string): GmailOAuthApp {
  const address = email.trim().toLowerCase();
  const domain = address.includes("@") ? (address.split("@").pop() ?? "") : "";
  if (!domain) return "main";
  const targets = gmailExtraAppTargets();
  return (
    targets.find((target) => target.addresses.includes(address))?.app ??
    targets.find((target) => target.domains.includes(domain))?.app ??
    "main"
  );
}

export function createGmailOAuthClient(app: GmailOAuthApp) {
  if (app === "main") return createGoogleOAuth2Client(process.env.GMAIL_REDIRECT_URI);
  if (!parseGmailExtraApp(app)) throw new Error("That Gmail sign-in app is not configured.");
  const prefix = ENV_PREFIX[app];
  return createGoogleOAuth2Client(process.env.GMAIL_REDIRECT_URI, env(`${prefix}_CLIENT_ID`), env(`${prefix}_CLIENT_SECRET`));
}

/**
 * A hint for Google's account picker when an app serves exactly one domain or
 * one address. Only a convenience: the callback enforces the match.
 */
export function gmailSignInHint(app: GmailOAuthApp): { hd: string } | { login_hint: string } | Record<string, never> {
  const target = app === "main" ? undefined : gmailExtraAppTargets().find((entry) => entry.app === app);
  if (!target) return {};
  if (target.domains.length === 1 && target.addresses.length === 0) return { hd: target.domains[0] ?? "" };
  if (target.addresses.length === 1 && target.domains.length === 0) return { login_hint: target.addresses[0] ?? "" };
  return {};
}

/** Whether a signed-in address may keep tokens from this app (callback check). */
export function gmailAppMatchesEmail(app: GmailOAuthApp, email: string): boolean {
  return gmailAppForEmail(email) === app;
}
