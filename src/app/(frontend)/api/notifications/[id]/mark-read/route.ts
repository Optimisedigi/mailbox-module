import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";

/**
 * POST /api/notifications/[id]/mark-read
 *
 * Flips `readAt` to now on a single notification. The recipient check
 * happens via the collection's `update` access — non-admin users cannot
 * mark someone else's notifications as read.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const cfg = await config;
  const payload = await getPayload({ config: cfg });

  const { user } = await payload.auth({ headers: req.headers });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Load with overrideAccess so we can verify ownership ourselves.
  let row: { recipient?: number | string | { id: number | string } } | null;
  try {
    row = (await payload.findByID({
      collection: "notifications" as never,
      id,
      depth: 0,
      overrideAccess: true,
    })) as unknown as { recipient?: number | string | { id: number | string } };
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const recipientId =
    typeof row?.recipient === "object" ? row.recipient.id : row?.recipient;
  const isAdmin = (user as { role?: string }).role === "admin";
  if (!isAdmin && recipientId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await payload.update({
    collection: "notifications" as never,
    id,
    overrideAccess: true,
    data: { readAt: new Date().toISOString() } as never,
  });

  return NextResponse.json({ ok: true });
}
