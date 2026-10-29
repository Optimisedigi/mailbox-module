import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { getValidGmailToken } from "@/lib/user-gmail-tokens";
import { getPrimaryGmailSignature } from "@/lib/gmail-service";
import { requestedMailAccount } from "@/lib/mail/route-helpers";

/**
 * GET /api/gmail/status
 *
 * Gmail connection status for Mail and the AI Auth page. Returns whether the logged-in user has connected their Gmail account and,
 * if so, the connected address. The Users collection stores `gmailConnected`
 * / `gmailEmail` but does not save them to the JWT, so the client `useAuth()`
 * user can't be relied on to expose them — this route reads them server-side.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });
  const { user } = await payload.auth({ headers: req.headers });

  if (!user) {
    return NextResponse.json({ error: "You must be logged in." }, { status: 401 });
  }

  const fresh = (await payload.findByID({
    collection: "users",
    id: user.id,
    depth: 0,
    overrideAccess: true,
  })) as { gmailConnected?: boolean; gmailEmail?: string | null; gmailTokenExpiry?: string | null };

  let settingsAccess = false;
  let hasSignature = false;
  let signatureHtml = "";
  let reconnectRequired = false;

  // The Mail view asks for the signature of the account it is showing (one of
  // the user's extra Gmail accounts); everyone else gets the main Gmail.
  const account = requestedMailAccount(req) ?? "";
  if (account) {
    const userId = typeof user.id === "number" ? user.id : Number(user.id);
    const token = await getValidGmailToken(userId, account);
    if (token.ok) {
      try {
        signatureHtml = await getPrimaryGmailSignature(token.accessToken);
        settingsAccess = true;
        hasSignature = signatureHtml.trim().length > 0;
      } catch {
        reconnectRequired = true;
      }
    } else {
      reconnectRequired = true;
    }
    return NextResponse.json({
      connected: token.ok,
      email: token.ok ? token.email : account,
      tokenExpiry: null,
      settingsAccess,
      hasSignature,
      signatureHtml,
      reconnectRequired,
    });
  }

  if (fresh.gmailConnected) {
    const userId = typeof user.id === "number" ? user.id : Number(user.id);
    const token = await getValidGmailToken(userId);
    if (token.ok) {
      try {
        const signature = await getPrimaryGmailSignature(token.accessToken);
        settingsAccess = true;
        hasSignature = signature.trim().length > 0;
        signatureHtml = signature;
      } catch {
        reconnectRequired = true;
      }
    } else {
      reconnectRequired = true;
    }
  }

  return NextResponse.json({
    connected: Boolean(fresh.gmailConnected),
    email: fresh.gmailEmail ?? null,
    tokenExpiry: fresh.gmailTokenExpiry ?? null,
    settingsAccess,
    hasSignature,
    // The user's own Gmail signature, shown in the Mail compose window.
    signatureHtml,
    reconnectRequired,
  });
}
