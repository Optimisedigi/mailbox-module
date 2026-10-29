import { describe, expect, it, vi } from "vitest";
import {
  buildTriagePlanRequest,
  buildTriageRequest,
  groupBySender,
  MAX_PLANNED_CATEGORIES,
  parseTriageAnswer,
  parseTriagePlan,
  triageSenders,
  TRIAGE_SENDERS_PER_CALL,
} from "@/lib/mail/triage";
import type { MessageSenderSubject } from "@/lib/mail/gmail-mail";

const msg = (id: string, from: string, subject: string, extra: Partial<MessageSenderSubject> = {}): MessageSenderSubject => ({
  messageId: id, threadId: `t${id}`, from, subject, ...extra,
});

describe("groupBySender", () => {
  it("groups by lower-cased address, biggest sender first, and flags bulk mail", () => {
    const groups = groupBySender([
      msg("1", "Jo <jo@x.com>", "Hello"),
      msg("2", "News <News@List.com>", "Issue 1", { listUnsubscribe: "<mailto:u@list.com>" }),
      msg("3", "news@list.com", "Issue 2"),
      msg("4", "news@list.com", "Issue 2"),
    ]);
    expect(groups.map((g) => [g.address, g.count, g.bulk])).toEqual([["news@list.com", 3, true], ["jo@x.com", 1, false]]);
    expect(groups[0]).toMatchObject({ name: "News", subjects: ["Issue 1", "Issue 2"], messageIds: ["2", "3", "4"] });
  });

  it("keeps the newest message offering one-click unsubscribe per sender", () => {
    const oneClick = { listUnsubscribe: "<https://list.com/u>", listUnsubscribePost: "List-Unsubscribe=One-Click" };
    const groups = groupBySender([
      msg("1", "news@list.com", "Issue 3", { listUnsubscribe: "<mailto:u@list.com>" }),
      msg("2", "news@list.com", "Issue 2", oneClick),
      msg("3", "news@list.com", "Issue 1", oneClick),
      msg("4", "jo@x.com", "Hello", { listUnsubscribe: "<https://x.com/u>" }),
    ]);
    expect(groups.map((g) => [g.address, g.unsubscribeId])).toEqual([["news@list.com", "2"], ["jo@x.com", undefined]]);
  });
});

const PLAN = JSON.stringify({
  categories: [
    { name: "Cold SEO pitches", description: "Agencies selling SEO.", clear: true },
    { name: "Google Ads alerts", description: "Account notices.", clear: false },
  ],
});

describe("buildTriagePlanRequest", () => {
  it("shows the biggest senders with one subject each, never message ids", () => {
    const senders = groupBySender([msg("abc123", "Ann <ann@seo.io>", "Rank #1"), msg("def456", "ann@seo.io", "Bump")]);
    const request = buildTriagePlanRequest(senders);
    const text = request.messages[0]!.text;
    expect(text).toContain("1. Ann <ann@seo.io> | 2 unread | Rank #1");
    expect(text).not.toMatch(/Bump|abc123|def456/);
    expect(request).toMatchObject({ action: "triage", emailCount: 2, gmailMessageId: null });
    expect(request.system).toContain("never see email bodies");
  });
});

describe("parseTriagePlan", () => {
  it("reads the AI's categories, drops duplicates and the built-in groups, and caps the count", () => {
    const many = Array.from({ length: MAX_PLANNED_CATEGORIES + 3 }, (_, i) => ({ name: `Group ${i}`, clear: true }));
    const text = `Here you go: ${JSON.stringify({ categories: [{ name: "Clients" }, { name: "Group 0", description: "x", clear: true }, { name: "group 0" }, ...many] })}`;
    const plan = parseTriagePlan(text);
    expect(plan).toHaveLength(MAX_PLANNED_CATEGORIES);
    expect(plan[0]).toEqual({ key: "ai-1", label: "Group 0", description: "x", clear: true });
    expect(plan[1]).toMatchObject({ key: "ai-2", label: "Group 1" });
  });

  it("only ticks categories the AI explicitly marks clear: true", () => {
    expect(parseTriagePlan('{"categories":[{"name":"A","clear":"yes"}]}')[0]?.clear).toBe(false);
  });

  it("throws when no usable category comes back", () => {
    expect(() => parseTriagePlan("not json")).toThrow();
    expect(() => parseTriagePlan('{"categories":[{"name":""}]}')).toThrow();
  });
});

describe("buildTriageRequest", () => {
  it("lists the planned categories and sends one line per sender with two subjects", () => {
    const [sender] = groupBySender([msg("abc123", "Ann <ann@seo.io>", "Rank #1"), msg("def456", "ann@seo.io", "Bump"), msg("g", "ann@seo.io", "Third")]);
    const request = buildTriageRequest([sender!], parseTriagePlan(PLAN));
    const text = request.messages[0]!.text;
    expect(text).toContain("1. Ann <ann@seo.io> | 3 unread | Rank #1 / Bump");
    expect(text).not.toMatch(/Third|abc123|def456/);
    expect(request.system).toContain("1 = Cold SEO pitches (Agencies selling SEO.); 2 = Google Ads alerts");
    expect(request).toMatchObject({ action: "triage", emailCount: 3, gmailMessageId: null });
  });
});

describe("parseTriageAnswer", () => {
  it("reads numbered category numbers and keeps anything missing, unknown or k", () => {
    const plan = parseTriagePlan(PLAN);
    expect(parseTriageAnswer("1 1\n2. 2\n3: 9\n4 k\n9 1\nnoise", 5, plan)).toEqual(["ai-1", "ai-2", "keep", "keep", "keep"]);
  });
});

describe("triageSenders", () => {
  it("plans once, keeps clients away from the model, batches senders, and ticks only clear categories", async () => {
    const senders = groupBySender([
      msg("1", "client@acme.com", "Invoice"),
      ...Array.from({ length: TRIAGE_SENDERS_PER_CALL + 1 }, (_, i) => msg(`m${i}`, `s${String(i).padStart(3, "0")}@pitch.io`, "Grow your SEO")),
      msg("x", "alerts@google.com", "Billing"),
    ]);
    const classify = vi.fn(async (request: { system: string; messages: Array<{ text: string }> }) => {
      if (request.system.includes("proposing the categories")) return PLAN;
      const lines = request.messages[0]!.text.split("\n").filter((line) => /^\d+\./.test(line));
      return lines.map((line, i) => `${i + 1} ${line.includes("google.com") ? 2 : 1}`).join("\n");
    });
    const result = await triageSenders({ senders, isClient: (a) => a.endsWith("@acme.com"), classify });
    expect(classify).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(classify.mock.calls)).not.toContain("acme.com");
    expect(result.categories.map((c) => [c.key, c.label, c.count, c.defaultSelected])).toEqual([
      ["ai-1", "Cold SEO pitches", TRIAGE_SENDERS_PER_CALL + 1, true],
      ["ai-2", "Google Ads alerts", 1, false],
      ["clients", "Clients", 1, false],
    ]);
  });

  it("puts a failed sorting batch under keep instead of failing the run", async () => {
    const senders = groupBySender([msg("1", "a@b.com", "x")]);
    const classify = vi.fn().mockResolvedValueOnce(PLAN).mockRejectedValueOnce(new Error("down"));
    const result = await triageSenders({ senders, isClient: () => false, classify });
    expect(result).toMatchObject({ failedBatches: 1, batches: 1, categories: [{ key: "keep", count: 1, defaultSelected: false }] });
  });

  it("fails the run when planning fails, and skips the AI when only clients wrote", async () => {
    const senders = groupBySender([msg("1", "a@b.com", "x")]);
    await expect(triageSenders({ senders, isClient: () => false, classify: async () => "no idea" })).rejects.toThrow();
    const classify = vi.fn();
    const result = await triageSenders({ senders, isClient: () => true, classify });
    expect(classify).not.toHaveBeenCalled();
    expect(result.categories.map((c) => c.key)).toEqual(["clients"]);
  });
});
