import { describe, expect, it, vi } from "vitest";
import { buildClientDomainIndex } from "@/lib/mail/client-matching";
import {
  CLIENT_SENDERS_PREF_KEY,
  clientUnreadQueries,
  clientUnreadTerms,
  isClientSender,
  loadClientSenders,
  matchingClientSenderEntries,
  unreadClientThreads,
} from "@/lib/mail/client-senders";

const thread = (from: string, unread: boolean) => ({ threadId: from, from, unread });

describe("unreadClientThreads", () => {
  const list = ["jo@client.com", "@bigbrand.com.au"];

  it("keeps only unread threads from starred client senders", () => {
    const threads = [
      thread("Jo <jo@client.com>", true),
      thread("Jo <jo@client.com>", false), // read
      thread("Sam <sam@client.com>", true), // same domain, but only jo@ is starred
      thread("Ann <ann@shop.bigbrand.com.au>", true), // subdomain of a starred domain
      thread("Spam <x@notbigbrand.com.au>", true), // look-alike domain
      thread('"jo@client.com" <attacker@evil.com>', true), // address only in display name
    ];
    expect(unreadClientThreads(threads, list).map((t) => t.from)).toEqual([
      "Jo <jo@client.com>",
      "Ann <ann@shop.bigbrand.com.au>",
    ]);
  });

  it("returns nothing when no senders are starred", () => {
    expect(unreadClientThreads([thread("jo@client.com", true)], [])).toEqual([]);
  });
});

describe("matchingClientSenderEntries / isClientSender", () => {
  it("reports which stored entries cover a sender", () => {
    expect(matchingClientSenderEntries("jo@client.com", ["jo@client.com", "@client.com", "@other.com"])).toEqual([
      "jo@client.com",
      "@client.com",
    ]);
    expect(isClientSender("Someone <someone@other.com>", ["@client.com"])).toBe(false);
    expect(isClientSender("", ["@client.com"])).toBe(false);
  });
});

describe("clientUnreadQueries", () => {
  it("builds an unread OR-search and drops anything that is not an address or domain", () => {
    expect(clientUnreadQueries(clientUnreadTerms(null, ["jo@client.com", "@bigbrand.com.au", "x OR in:spam"]))).toEqual([
      "is:unread {from:bigbrand.com.au from:jo@client.com}",
    ]);
    expect(clientUnreadQueries(clientUnreadTerms(null, []))).toEqual([]);
    expect(clientUnreadQueries(clientUnreadTerms(null, ["{label:secret}"]))).toEqual([]);
  });

  it("splits many client senders across searches under the length limit", () => {
    const terms = Array.from({ length: 30 }, (_, i) => `client${String(i).padStart(2, "0")}.com.au`);
    const queries = clientUnreadQueries(terms, 200);
    expect(queries.length).toBeGreaterThan(1);
    for (const q of queries) expect(q.length).toBeLessThanOrEqual(200);
    expect(queries.join(" ").match(/from:/g)).toHaveLength(30);
  });
});

describe("automatic client matching (no starred senders)", () => {
  const index = buildClientDomainIndex(
    [
      { id: 1, name: "Acme Client", websiteUrl: "https://www.acmeclient.com.au/" },
      { id: 2, name: "Sole Trader", contactEmail: "sam.trader@gmail.com" },
    ],
    { ownAddresses: ["pat@ourteam.example"] },
  );

  it("includes client website domains and shared-provider contact addresses as search terms", () => {
    expect(clientUnreadTerms(index, [])).toEqual(["acmeclient.com.au", "sam.trader@gmail.com"]);
  });

  it("shows unread mail from an address on a client's website domain", () => {
    const threads = [
      thread("Ana <ana@acmeclient.com.au>", true),
      thread("Ana <ana@mail.acmeclient.com.au>", true), // subdomain rolls up
      thread("Ana <ana@acmeclient.com.au>", false), // read
      thread("Sam <sam.trader@gmail.com>", true), // exact contact on a shared provider
      thread("Other <other@gmail.com>", true), // shared provider, not a contact
      thread("Bot <noreply@acmeclient.com.au>", true), // automated sender
      thread("Hidden <hide@acmeclient.com.au>", true), // hidden by the user
      thread('"ana@acmeclient.com.au" <x@evil.com>', true), // address only in display name
    ];
    expect(unreadClientThreads(threads, [], { index, hidden: ["hide@acmeclient.com.au"] }).map((t) => t.from)).toEqual([
      "Ana <ana@acmeclient.com.au>",
      "Ana <ana@mail.acmeclient.com.au>",
      "Sam <sam.trader@gmail.com>",
    ]);
  });
});

describe("loadClientSenders", () => {
  it("reads the client-senders preference for that user only", async () => {
    const find = vi.fn().mockResolvedValue({ docs: [{ value: { senders: ["Jo <JO@Client.com>", "bad value"] } }] });
    await expect(loadClientSenders({ find } as never, 7)).resolves.toEqual(["jo@client.com"]);
    const where = find.mock.calls[0]?.[0]?.where;
    expect(where.and).toEqual(
      expect.arrayContaining([{ key: { equals: CLIENT_SENDERS_PREF_KEY } }, { "user.value": { equals: 7 } }]),
    );
  });

  it("returns [] when the lookup fails", async () => {
    const find = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(loadClientSenders({ find } as never, 7)).resolves.toEqual([]);
  });
});
