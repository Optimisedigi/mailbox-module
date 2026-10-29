import { NextResponse, type NextRequest } from "next/server";
import { getPayload, type Payload } from "payload";
import config from "@/payload.config";
import { getValidGmailToken } from "@/lib/user-gmail-tokens";
import { userHasFeature } from "@/lib/access";
import { MAIL_ACCOUNT_HEADER, normaliseMailAccount } from "@/lib/mail/accounts-shared";
import { isGmailRateLimitError } from "@/lib/mail/gmail-mail";

export const MAIL_FEATURE = "nav:mail";

export interface MailUser {
  id: number;
  email?: string;
  role?: string;
}

export type MailContext = { payload: Payload; user: MailUser };

/** Auth gate shared by every /api/mail route: logged in + Mail feature. */
export async function requireMailUser(req: NextRequest): Promise<MailContext | NextResponse> {
  const payload = await getPayload({ config: await config });
  const { user } = await payload.auth({ headers: req.headers });
  if (!user) return NextResponse.json({ error: "You must be logged in." }, { status: 401 });
  if (!userHasFeature(user, MAIL_FEATURE)) {
    return NextResponse.json({ error: "Mail is not enabled for your account." }, { status: 403 });
  }
  return { payload, user: user as unknown as MailUser };
}

/**
 * The Gmail account a Mail request is for (MAIL_ACCOUNT_HEADER): "" for the
 * user's main Gmail, the address of one of their extra accounts, or null when
 * the header is present but not an email address.
 */
export function requestedMailAccount(req: Pick<NextRequest, "headers"> | undefined): string | null {
  const raw = req?.headers.get(MAIL_ACCOUNT_HEADER);
  if (raw === null || raw === undefined || raw.trim() === "") return "";
  return normaliseMailAccount(raw) || null;
}

export interface MailGmailToken {
  accessToken: string;
  email: string;
  userEmail: string;
  /** Extra Gmail account address; "" = the user's main Gmail. */
  account: string;
}

/**
 * Valid Gmail token for the account the request is on (see
 * requestedMailAccount); without `req`, the user's main Gmail.
 */
export async function requireGmailToken(userId: number, req?: Pick<NextRequest, "headers">): Promise<MailGmailToken | NextResponse> {
  const account = requestedMailAccount(req);
  if (account === null) return NextResponse.json({ error: "Invalid mail account." }, { status: 400 });
  const token = await getValidGmailToken(userId, account);
  if (!token.ok) {
    return NextResponse.json(
      {
        error: "gmail-not-connected",
        reason: token.reason,
        connectUrl: account ? "/api/gmail/connect?add=1" : "/api/gmail/connect",
        ...(account ? { account } : {}),
      },
      { status: 403 },
    );
  }
  return { accessToken: token.accessToken, email: token.email, userEmail: token.userEmail, account: token.account ?? "" };
}

/** Map Gmail API failures to a JSON error the UI can show. Never echoes content. */
export function gmailErrorResponse(err: unknown, fallback: string): NextResponse {
  const e = err as { code?: number; status?: number; message?: string };
  const status = Number(e.code ?? e.status ?? 0);
  // Gmail answers "too many requests" with 403 too; that is not a permission problem.
  if (isGmailRateLimitError(err)) {
    return NextResponse.json({ error: "Gmail is busy: too many requests in the last minute. Try again in a minute." }, { status: 429 });
  }
  if (status === 401 || status === 403) {
    return NextResponse.json(
      {
        error: "scope-insufficient",
        reason: "Gmail refused the request. Reconnect Gmail to grant the Mail permissions (read, send, archive).",
        connectUrl: "/api/gmail/connect",
      },
      { status: 403 },
    );
  }
  if (status === 404) return NextResponse.json({ error: "Not found in Gmail." }, { status: 404 });
  console.error(`[mail] ${fallback}:`, (e.message ?? "").slice(0, 200));
  return NextResponse.json({ error: fallback }, { status: 502 });
}

export async function readJson<T>(req: NextRequest): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

const GMAIL_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
export function parseGmailId(raw: unknown): string | null {
  return typeof raw === "string" && GMAIL_ID_RE.test(raw.trim()) ? raw.trim() : null;
}
