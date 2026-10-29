import { describe, expect, it, vi } from "vitest";
import {
  cleanHiddenSenders,
  hiddenSendersQuery,
  isHiddenSender,
  loadHiddenSenders,
  normaliseHiddenSender,
} from "@/lib/mail/hidden-senders";

describe("normaliseHiddenSender", () => {
  it("turns addresses and domains into one clean form", () => {
    expect(normaliseHiddenSender("StoreFront <No-Reply@MultiScreenStore.com>")).toBe("no-reply@multiscreenstore.com");
    expect(normaliseHiddenSender("@MultiScreenStore.com")).toBe("@multiscreenstore.com");
    expect(normaliseHiddenSender("multiscreenstore.com")).toBe("@multiscreenstore.com");
    expect(normaliseHiddenSender("https://www.shop.com/x")).toBe("@shop.com");
    expect(normaliseHiddenSender("not valid")).toBeNull();
    expect(normaliseHiddenSender("")).toBeNull();
  });
});

describe("hiddenSendersQuery", () => {
  it("builds Gmail exclusions and drops anything that is not an address or domain", () => {
    expect(hiddenSendersQuery(["no-reply@multiscreenstore.com", "@news.com"])).toBe(
      "-from:no-reply@multiscreenstore.com -from:news.com",
    );
    // Search operators smuggled into a stored entry never reach Gmail.
    expect(hiddenSendersQuery(["x OR in:spam", "{label:secret}"])).toBe("");
    expect(hiddenSendersQuery([])).toBe("");
  });

  it("dedupes and caps the list", () => {
    expect(cleanHiddenSenders(["a@x.com", "A@X.com", "@y.com", "y.com"])).toEqual(["a@x.com", "@y.com"]);
    expect(cleanHiddenSenders(Array.from({ length: 150 }, (_, i) => `u${i}@x.com`))).toHaveLength(100);
    expect(cleanHiddenSenders("nope")).toEqual([]);
  });
});

describe("isHiddenSender", () => {
  const list = ["no-reply@multiscreenstore.com", "@news.com"];
  it("matches exact addresses and whole domains including subdomains", () => {
    expect(isHiddenSender("StoreFront <no-reply@multiscreenstore.com>", list)).toBe(true);
    expect(isHiddenSender("orders@multiscreenstore.com", list)).toBe(false);
    expect(isHiddenSender("a@news.com", list)).toBe(true);
    expect(isHiddenSender("a@mail.news.com", list)).toBe(true);
    expect(isHiddenSender("a@notnews.com", list)).toBe(false);
  });
});

describe("loadHiddenSenders", () => {
  it("reads the user's own preference and cleans it", async () => {
    const find = vi.fn(async () => ({ docs: [{ value: { senders: ["@News.com", "bad value"] } }] }));
    expect(await loadHiddenSenders({ find } as never, 7)).toEqual(["@news.com"]);
    const where = JSON.stringify((find.mock.calls[0] as unknown[])[0]);
    expect(where).toContain('"user.value":{"equals":7}');
    expect(where).toContain("mail-hidden-senders");
  });

  it("returns an empty list when nothing is saved or the read fails", async () => {
    expect(await loadHiddenSenders({ find: vi.fn(async () => ({ docs: [] })) } as never, 7)).toEqual([]);
    expect(await loadHiddenSenders({ find: vi.fn(async () => { throw new Error("db"); }) } as never, 7)).toEqual([]);
  });
});
