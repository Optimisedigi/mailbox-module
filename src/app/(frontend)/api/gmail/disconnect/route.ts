import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";

/**
 * POST /api/gmail/disconnect
 *
 * Clears the logged-in user's stored Gmail OAuth tokens. This lets the user
 * reconnect after scope changes, e.g. adding gmail.settings.basic for signatures.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });
  const { user } = await payload.auth({ headers: req.headers });

  if (!user) {
    return NextResponse.json({ error: "You must be logged in." }, { status: 401 });
  }

  await payload.update({
    collection: "users",
    id: user.id,
    overrideAccess: true,
    data: {
      gmailConnected: false,
      gmailEmail: null,
      gmailAccessToken: null,
      gmailRefreshToken: null,
      gmailTokenExpiry: null,
    },
  });

  return NextResponse.json({ ok: true });
}
