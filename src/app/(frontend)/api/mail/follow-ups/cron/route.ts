import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { getValidGmailToken } from "@/lib/user-gmail-tokens";
import { getThreadReplyHeaders } from "@/lib/mail/gmail-mail";
import { checkFollowUps } from "@/lib/mail/follow-ups";

/**
 * GET /api/mail/follow-ups/cron (Vercel cron, hourly).
 * Auth: `Authorization: Bearer <CRON_SECRET>`.
 *
 * Checks up to 100 open follow-up reminders against their Gmail threads
 * (metadata only, no bodies): replied ones close, and ones past their time
 * with no reply raise one notification each. No model calls.
 */
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
  const expected = Buffer.from(cronSecret);
  const provided = Buffer.from(token);
  if (!token || expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const payload = await getPayload({ config: await config });
  return NextResponse.json(
    await checkFollowUps(payload, {
      now: () => new Date(),
      getToken: getValidGmailToken,
      getThreadHeaders: getThreadReplyHeaders,
    }),
  );
}
