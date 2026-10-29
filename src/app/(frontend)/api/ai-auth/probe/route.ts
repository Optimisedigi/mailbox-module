import { NextRequest, NextResponse } from "next/server";
import { getPayload } from "payload";
import config from "@/payload.config";
import { callLLM } from "@/lib/ai/llm";

/**
 * POST /api/ai-auth/probe
 * Body: { model?: string }
 *
 * Diagnostic. Sends a 1-token "ok" prompt to the chosen model. Surfaces
 * the canonical model name, the credential source that served the call,
 * and the round-trip latency. Used by the admin auth-setup page to verify
 * the OAuth connection works end-to-end.
 *
 * Auth: requires a logged-in CMS user.
 */
export async function POST(req: NextRequest) {
  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });
  const { user } = await payload.auth({ headers: req.headers });
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { model?: string };
  const model = body.model ?? "claude-sonnet-5.5";

  const start = Date.now();
  try {
    const response = await callLLM({
      model,
      maxTokens: 16,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Reply with exactly the word: ok" }],
        },
      ],
    });
    const latencyMs = Date.now() - start;
    const text = response.message.content
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("")
      .trim();
    return NextResponse.json({
      ok: true,
      model: response.model,
      providerModel: response.providerModel,
      source: response.source,
      latencyMs,
      replyPreview: text.slice(0, 60),
      usage: response.usage,
    });
  } catch (err) {
    const latencyMs = Date.now() - start;
    return NextResponse.json(
      { ok: false, error: (err as Error).message, latencyMs },
      { status: 502 },
    );
  }
}
