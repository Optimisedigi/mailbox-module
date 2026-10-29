import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Payload } from "payload";
import {
  buildMailClientContext,
  formatMailClientContext,
  MAX_CLIENT_CONTEXT_CHARS,
  type MailClientFacts,
} from "@/lib/mail/client-context";

const NOW = new Date("2026-10-21T02:00:00.000Z");

const extension = vi.hoisted(() => ({
  clientListExtension: {} as { loadClientFacts?: (args: { clientId: number; now: Date }) => Promise<string[]> },
}));
vi.mock("@/extensions/client-list", () => extension);

function fakePayload(opts: { failing?: string[]; clients?: Record<number, string> } = {}): Payload {
  const clients = opts.clients ?? { 7: "Acme Pty Ltd" };
  return {
    findByID: vi.fn(async ({ id }: { id: number }) => {
      if (!clients[id]) throw new Error("Not Found");
      return { id, name: clients[id] };
    }),
    find: vi.fn(async ({ collection }: { collection: string }) => {
      if (opts.failing?.includes(collection)) throw new Error(`${collection} down`);
      if (collection === "client-email-summaries") {
        return { docs: [{ emailDate: "2026-10-10T00:00:00.000Z", summary: "Jo asked for a quote on a new landing page." }] };
      }
      return { docs: [] };
    }),
  } as unknown as Payload;
}

beforeEach(() => {
  extension.clientListExtension = {};
});

describe("buildMailClientContext", () => {
  it("has the client name and recent email summaries without a client-list extension", async () => {
    const context = await buildMailClientContext(fakePayload(), 7, NOW);
    expect(context).toEqual({
      clientId: 7,
      clientName: "Acme Pty Ltd",
      text: "Client: Acme Pty Ltd\nRecent email timeline:\n- 2026-10-10: Jo asked for a quote on a new landing page.",
    });
  });

  it("adds the extension's fact lines after the name, one per line and trimmed", async () => {
    const loadClientFacts = vi.fn(async () => ["  Services we provide: SEO,\n Google Ads ", "", "Monthly retainer: $2,000.00"]);
    extension.clientListExtension = { loadClientFacts };
    const context = await buildMailClientContext(fakePayload(), 7, NOW);
    expect(loadClientFacts).toHaveBeenCalledWith(expect.objectContaining({ clientId: 7, now: NOW }));
    expect(context?.text.split("\n").slice(0, 3)).toEqual([
      "Client: Acme Pty Ltd",
      "Services we provide: SEO, Google Ads",
      "Monthly retainer: $2,000.00",
    ]);
  });

  it("drops only the failing source's section", async () => {
    extension.clientListExtension = { loadClientFacts: async () => { throw new Error("CRM down"); } };
    const context = await buildMailClientContext(fakePayload({ failing: ["client-email-summaries"] }), 7, NOW);
    expect(context?.text).toBe("Client: Acme Pty Ltd");
  });

  it("returns null when the client does not exist", async () => {
    expect(await buildMailClientContext(fakePayload(), 99, NOW)).toBeNull();
  });
});

describe("formatMailClientContext", () => {
  it("caps the block at MAX_CLIENT_CONTEXT_CHARS on a line boundary", () => {
    const facts: MailClientFacts = {
      clientName: "Acme",
      extraFacts: [],
      recentEmails: Array.from({ length: 30 }, (_, i) => ({ date: "2026-10-01", summary: `${i} ${"x".repeat(390)}` })),
    };
    const text = formatMailClientContext(facts);
    expect(text.length).toBeLessThanOrEqual(MAX_CLIENT_CONTEXT_CHARS);
    expect(text.endsWith("x")).toBe(true);
  });
});
