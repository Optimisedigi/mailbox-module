/**
 * Auth event log. Records OAuth success / failure / refresh / fallback
 * transitions so they're visible in three surfaces:
 *   1. The chat status pill (most recent event for the active model)
 *   2. The /admin/ai-auth admin page (per-provider state, last failure, etc.)
 *   3. The ai-auth-events collection (audit trail)
 *
 * Every transition the user might want to know about goes through here.
 * Successful OAuth use is recorded but is the no-news case; failures and
 * provider failover are the loud cases the UI flags.
 */

import { getPayload } from "payload";
import config from "@/payload.config";
import type { ProviderName } from "../registry";

export type AuthEventKind =
  | "oauth-success"          // OAuth credential used to serve a request
  | "oauth-failed"           // OAuth refresh/use threw; agent loop will fall to next provider
  | "oauth-connected"        // User completed the consent flow
  | "oauth-disconnected"     // User force-fallback toggled on, or revoked
  | "provider-failover"      // Agent loop walked from one model to another mid-run
  | "credential-missing";    // Resolver had nothing to return for a provider

export interface AuthEventInput {
  provider: ProviderName;
  kind: AuthEventKind;
  message: string;
  /** Optional context: agent run id, agent name, model that was attempted. */
  agentRunId?: string;
  agentName?: string;
  modelAttempted?: string;
  modelServed?: string;
}

export interface AuthEvent extends AuthEventInput {
  id: string;
  timestamp: string;
}

/** Record an event into the ai-auth-events collection. Best-effort. */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  try {
    const payload = await getPayload({ config: await config });
    await payload.create({
      collection: "ai-auth-events",
      data: {
        provider: input.provider,
        kind: input.kind,
        message: input.message.slice(0, 500),
        agentName: input.agentName ?? null,
        modelAttempted: input.modelAttempted ?? null,
        modelServed: input.modelServed ?? null,
      },
      overrideAccess: true,
    } as never);
  } catch (err) {
    // Logging is best-effort; never let a logging failure break a call.
    console.error("[auth-events] Failed to record event:", err);
  }
}

/** The most recent auth event(s), newest first. Used by the AI auth page. */
export async function getRecentAuthEvents(opts: {
  provider?: ProviderName;
  kinds?: AuthEventKind[];
  limit?: number;
}): Promise<AuthEvent[]> {
  try {
    const payload = await getPayload({ config: await config });
    const and: Array<Record<string, unknown>> = [];
    if (opts.provider) and.push({ provider: { equals: opts.provider } });
    if (opts.kinds?.length) and.push({ kind: { in: opts.kinds } });
    const result = await payload.find({
      collection: "ai-auth-events",
      where: (and.length ? { and } : {}) as never,
      limit: opts.limit ?? 20,
      sort: "-createdAt",
      depth: 0,
      overrideAccess: true,
    } as never);
    return (result.docs as unknown as Array<Record<string, unknown>>).map((doc) => ({
      id: String(doc.id),
      provider: doc.provider as ProviderName,
      kind: doc.kind as AuthEventKind,
      message: typeof doc.message === "string" ? doc.message : "",
      agentName: typeof doc.agentName === "string" ? doc.agentName : undefined,
      modelAttempted: typeof doc.modelAttempted === "string" ? doc.modelAttempted : undefined,
      modelServed: typeof doc.modelServed === "string" ? doc.modelServed : undefined,
      timestamp: String(doc.createdAt ?? ""),
    }));
  } catch (err) {
    console.error("[auth-events] Failed to read events:", err);
    return [];
  }
}

/**
 * Find the most recent oauth-failed event for a provider. Used by the
 * /admin/ai-auth status panel to show "Last failure: 3 minutes ago".
 */
export async function getLastFailure(provider: ProviderName): Promise<AuthEvent | null> {
  const events = await getRecentAuthEvents({
    provider,
    kinds: ["oauth-failed"],
    limit: 1,
  });
  return events[0] ?? null;
}
