import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { getValidGmailToken } from "@/lib/user-gmail-tokens";
import { defaultSendDeps, sendDueScheduledEmails } from "@/lib/mail/scheduled";

/**
 * GET /api/mail/schedule/tick (Vercel cron, every minute).
 * Auth: `Authorization: Bearer <CRON_SECRET>`.
 *
 * Sends every scheduled email whose time has come. Each email is claimed with
 * one conditional UPDATE, so overlapping runs or a "send now" click never send
 * it twice. No model calls.
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
  return NextResponse.json(await sendDueScheduledEmails(payload, defaultSendDeps(getValidGmailToken)));
}
