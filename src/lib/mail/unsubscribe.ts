import { lookup as dnsLookup } from "node:dns/promises";
import { assertPublicHost, checkUrlShape, type LookupFn } from "@/lib/mail/public-url";

/**
 * One-click unsubscribe (RFC 8058) for inbox triage.
 *
 * A sender offers it with two headers: `List-Unsubscribe` holding an https
 * link, and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Unsubscribing
 * is then a single POST of that body to the link, with no cookies or login.
 *
 * The link comes from an email header, so anyone who can email the user picks
 * it, and the POST runs on our server. Before it is sent: https only, default
 * port, no credentials in the URL, and the host must resolve to public
 * addresses (no loopback, private, link-local or metadata ranges). Redirects
 * are never followed, every request has a timeout, and the response body is
 * never read. The route re-reads the headers from Gmail itself, so a browser
 * can never hand the server a link to POST to.
 */

const MAX_HEADER_CHARS = 2000;
const UNSUBSCRIBE_TIMEOUT_MS = 10_000;
const USER_AGENT = "Mozilla/5.0 (compatible; MailboxModule/1.0)";

/** The https link to POST to, or null when the sender does not offer one-click unsubscribe. */
export function oneClickUnsubscribeUrl(listUnsubscribe: string | undefined, listUnsubscribePost: string | undefined): URL | null {
  if (!/^\s*List-Unsubscribe\s*=\s*One-Click\s*$/i.test(listUnsubscribePost ?? "")) return null;
  const header = (listUnsubscribe ?? "").slice(0, MAX_HEADER_CHARS);
  for (const match of header.matchAll(/<([^>]*)>/g)) {
    const raw = (match[1] ?? "").replace(/\s+/g, "");
    if (!/^https:\/\//i.test(raw)) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    const shape = checkUrlShape(url);
    if (shape.ok) return shape.url;
  }
  return null;
}

export type UnsubscribeOutcome = "unsubscribed" | "unavailable" | "failed";

const defaultLookup: LookupFn = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => row.address);
};

/** POST the one-click body to a link from `oneClickUnsubscribeUrl`. Only a 2xx answer counts as unsubscribed. */
export async function postOneClickUnsubscribe(
  url: URL,
  opts: { lookup?: LookupFn; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<UnsubscribeOutcome> {
  try {
    const shape = checkUrlShape(new URL(url.toString()));
    if (!shape.ok || shape.url.protocol !== "https:") return "failed";
    await assertPublicHost(shape.url, opts.lookup ?? defaultLookup);
    const timeout = AbortSignal.timeout(UNSUBSCRIBE_TIMEOUT_MS);
    const response = await (opts.fetchImpl ?? fetch)(shape.url.toString(), {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: "List-Unsubscribe=One-Click",
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300 ? "unsubscribed" : "failed";
  } catch {
    return "failed";
  }
}
