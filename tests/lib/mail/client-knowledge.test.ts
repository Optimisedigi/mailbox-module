import { describe, expect, it, vi } from "vitest";
import {
  ASK_MAX_OUTPUT_TOKENS,
  BRIEF_MAX_OUTPUT_TOKENS,
  DEFAULT_PULL_SETTINGS,
  parsePullSettings,
  pullFilterKey,
  buildClientAskRequest,
  buildClientBriefRequest,
  cleanAskHistory,
  clientEmailTargets,
  clientGmailQuery,
  loadClientEmailKnowledge,
  MAX_PULL_EMAILS,
  pullClientEmails,
  PULL_COOLDOWN_MS,
  questionTerms,
} from "@/lib/mail/client-knowledge";
import { MAIL_PROMPTS } from "@/lib/mail/prompts";
import type { MailModelRequest } from "@/lib/mail/model-request";

type Row = Record<string, unknown> & { id: number };
type Where = Record<string, unknown>;

/** Just enough of Payload's where clauses for these tests: and, equals, in. */
function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "and") return (condition as Where[]).every((part) => matches(row, part));
    const value = row[key];
    const { equals, in: list } = condition as { equals?: unknown; in?: unknown[] };
    if (equals !== undefined) return value === equals;
    if (list !== undefined) return list.includes(value);
    return true;
  });
}

function fakePayload(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = { clients: [], "client-emails": [], "client-email-briefs": [], ...seed };
  let nextId = 1000;
  const sortRows = (rows: Row[], sort?: string) => {
    if (!sort) return rows;
    const field = sort.replace(/^-/, "");
    const dir = sort.startsWith("-") ? -1 : 1;
    return [...rows].sort((a, b) => (String(a[field] ?? "") < String(b[field] ?? "") ? -dir : dir));
  };
  const payload = {
    tables,
    find: vi.fn(async (args: { collection: string; where?: Where; limit?: number; sort?: string }) => {
      const rows = sortRows((tables[args.collection] ?? []).filter((row) => matches(row, args.where)), args.sort);
      return { docs: args.limit ? rows.slice(0, args.limit) : rows };
    }),
    findByID: vi.fn(async (args: { collection: string; id: number }) => {
      const row = (tables[args.collection] ?? []).find((item) => item.id === args.id);
      if (!row) throw new Error("Not Found");
      return row;
    }),
    create: vi.fn(async (args: { collection: string; data: Record<string, unknown> }) => {
      const row = { id: nextId++, ...args.data };
      (tables[args.collection] ??= []).push(row);
      return row;
    }),
    update: vi.fn(async (args: { collection: string; id: number; data: Record<string, unknown> }) => {
      const row = (tables[args.collection] ?? []).find((item) => item.id === args.id);
      if (!row) throw new Error("Not Found");
      Object.assign(row, args.data);
      return row;
    }),
    count: vi.fn(async (args: { collection: string; where?: Where }) => ({
      totalDocs: (tables[args.collection] ?? []).filter((row) => matches(row, args.where)).length,
    })),
  };
  return payload;
}

const CLIENT = {
  id: 7,
  name: "Acme Client",
  websiteUrl: "https://www.acmeclient.com.au/",
  contactEmail: "Casey <casey@acmeclient.com.au>",
  additionalContacts: [{ email: "jo.smith@gmail.com" }, { email: "pat@ourteam.example" }],
  isActive: true,
};

function gmailMessage(id: string, from: string, to: string, subject: string, date: string, body: string) {
  return { messageId: id, threadId: `t-${id}`, from, to, cc: "", bcc: "", subject, date, body, bodyHtml: "", snippet: "", labelIds: ["INBOX"] };
}

function headers(id: string, from: string, extra: Record<string, unknown> = {}) {
  return { messageId: id, threadId: `t-${id}`, from, to: "pat@ourteam.example", cc: "", labelIds: ["INBOX"], ...extra };
}

describe("clientEmailTargets / clientGmailQuery", () => {
  it("searches the client's domains, plus contacts on shared providers by exact address, never our own domain", () => {
    const targets = clientEmailTargets(CLIENT, ["pat@ourteam.example"]);
    expect(targets).toEqual({ domains: ["acmeclient.com.au"], addresses: ["jo.smith@gmail.com"] });
    const query = clientGmailQuery(targets, new Date("2026-01-01T00:00:00Z"));
    expect(query).toBe(
      "{from:acmeclient.com.au to:acmeclient.com.au cc:acmeclient.com.au from:jo.smith@gmail.com to:jo.smith@gmail.com cc:jo.smith@gmail.com} after:1767225600 -in:chats -in:drafts -in:spam -in:trash",
    );
  });

  it("has nothing to search for a client with no website or contacts", () => {
    expect(clientGmailQuery(clientEmailTargets({ id: 1, name: "Empty" }, []), new Date())).toBeNull();
  });
});

describe("buildClientBriefRequest", () => {
  it("sends the emails oldest first without the quoted earlier messages, and updates an earlier brief", () => {
    const { request, used, leftOut } = buildClientBriefRequest({
      clientId: 7,
      clientName: "Acme Client",
      previousBrief: "## Overview\nOld brief.",
      emails: [
        { date: "2026-03-02T00:00:00Z", from: "casey@acmeclient.com.au", to: "pat@od", subject: "Re: Budget", body: "Yes, $2,000 works.\n\nOn Mon, 1 Mar 2026, Pat wrote:\n> Shall we go to $2,000?" },
        { date: "2026-03-01T00:00:00Z", from: "pat@od", to: "casey@acmeclient.com.au", subject: "Budget", body: "Shall we go to $2,000?" },
      ],
    });
    expect(request.action).toBe("client-brief");
    expect(request.system).toBe(MAIL_PROMPTS["client-brief"].system);
    expect(request.clientId).toBe(7);
    expect(used).toBe(2);
    expect(leftOut).toBe(0);
    const text = request.messages[0]?.text ?? "";
    expect(text).toContain("The brief written from earlier emails:\n\n## Overview\nOld brief.");
    expect(text.indexOf("[2026-03-01]")).toBeLessThan(text.indexOf("[2026-03-02]"));
    expect(text).toContain("Yes, $2,000 works.");
    expect(text).not.toContain("> Shall we go");
    expect(text).toContain("Update the brief with these emails.");
  });

  it("keeps the newest emails when they do not all fit", () => {
    const emails = Array.from({ length: 80 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      from: "casey@acmeclient.com.au",
      to: "pat@od",
      subject: `Email ${i}`,
      body: "x".repeat(3_000),
    }));
    const { request, used, leftOut } = buildClientBriefRequest({ clientId: 7, clientName: "ITP", previousBrief: null, emails });
    expect(used + leftOut).toBe(80);
    expect(leftOut).toBeGreaterThan(0);
    const text = request.messages[0]?.text ?? "";
    expect(text).toContain("Email 79");
    expect(text).not.toContain("Subject: Email 0\n");
    expect(text).toContain(`(${leftOut} older emails were left out to fit)`);
  });
});

describe("pullClientEmails", () => {
  const now = new Date("2026-10-28T05:00:00Z");

  function setup(seed: Record<string, Row[]> = {}) {
    const payload = fakePayload({ clients: [CLIENT as unknown as Row], ...seed });
    const deps = {
      getMailboxProfile: vi.fn(async () => ({ emailAddress: "Pat@OurTeam.example", historyId: "1" })),
      listMessageIdsMatching: vi.fn(async () => ["m1", "m2", "m3"]),
      getMessageHeaders: vi.fn(async (_token: string, ids: string[]) =>
        ids.map((id) =>
          id === "m3"
            ? headers(id, "news@acmeclient.com.au", { listUnsubscribe: "<mailto:x>" })
            : headers(id, "Casey <casey@acmeclient.com.au>"),
        ),
      ),
      getFullMessage: vi.fn(async (_token: string, id: string) =>
        gmailMessage(id, "Casey <casey@acmeclient.com.au>", "pat@ourteam.example", `Subject ${id}`, "2026-10-01T00:00:00Z", `Body ${id}`),
      ),
      loadHiddenSenders: vi.fn(async () => []),
    };
    const runModel = vi.fn(async (_request: MailModelRequest) => ({ text: "## Overview\nBrief.", model: "test-model" }));
    return { payload, deps, runModel };
  }

  it("first pull: searches 12 months, saves the client's emails (not automated ones) and writes the brief", async () => {
    const { payload, deps, runModel } = setup();
    const result = await pullClientEmails({ payload: payload as never, userId: 3, accessToken: "tok", clientId: 7, now, runModel, deps });

    expect(result).toMatchObject({ ok: true, found: 3, saved: 2, more: false, briefUpdated: true });
    const [, query, max] = deps.listMessageIdsMatching.mock.calls[0] ?? [];
    expect(query).toContain(`after:${Math.floor(now.getTime() / 1000) - 365 * 24 * 60 * 60}`);
    expect(max).toBe(MAX_PULL_EMAILS + 1);
    // The newsletter (List-Unsubscribe) is skipped.
    expect(deps.getFullMessage.mock.calls.map((call) => call[1])).toEqual(["m1", "m2"]);
    expect(payload.tables["client-emails"]).toHaveLength(2);
    expect(payload.tables["client-emails"]?.[0]).toMatchObject({ client: 7, owner: 3, matchedOn: "casey@acmeclient.com.au" });

    expect(runModel).toHaveBeenCalledTimes(1);
    expect(runModel.mock.calls[0]?.[0].messages[0]?.text).toContain("Body m1");
    expect(payload.tables["client-email-briefs"]).toEqual([
      expect.objectContaining({ client: 7, owner: 3, account: "pat@ourteam.example", brief: "## Overview\nBrief.", emailCount: 2, lastPulledAt: now.toISOString() }),
    ]);
  });

  it("a later pull only searches since the last one and updates the same brief", async () => {
    const lastPulledAt = "2026-10-20T00:00:00.000Z";
    const { payload, deps, runModel } = setup({
      "client-email-briefs": [{ id: 1, client: 7, owner: 3, account: "pat@ourteam.example", brief: "Old brief", emailCount: 5, lastPulledAt }],
    });
    deps.listMessageIdsMatching.mockResolvedValueOnce(["m9"]);
    await pullClientEmails({ payload: payload as never, userId: 3, accessToken: "tok", clientId: 7, now, runModel, deps });
    const [, query] = deps.listMessageIdsMatching.mock.calls[0] ?? [];
    expect(query).toContain(`after:${Math.floor((Date.parse(lastPulledAt) - 2 * 24 * 60 * 60 * 1000) / 1000)}`);
    expect(runModel.mock.calls[0]?.[0].messages[0]?.text).toContain("Old brief");
    expect(payload.tables["client-email-briefs"]).toHaveLength(1);
    expect(payload.tables["client-email-briefs"]?.[0]).toMatchObject({ brief: "## Overview\nBrief.", lastPulledAt: now.toISOString() });
  });

  it("does not pull twice within a minute, and calls no model when nothing was found", async () => {
    const recent = new Date(now.getTime() - PULL_COOLDOWN_MS / 2).toISOString();
    const busy = setup({ "client-email-briefs": [{ id: 1, client: 7, owner: 3, account: "pat@ourteam.example", brief: "B", lastPulledAt: recent }] });
    const blocked = await pullClientEmails({ payload: busy.payload as never, userId: 3, accessToken: "tok", clientId: 7, now, runModel: busy.runModel, deps: busy.deps });
    expect(blocked).toMatchObject({ ok: false, status: 429 });
    expect(busy.deps.listMessageIdsMatching).not.toHaveBeenCalled();

    const empty = setup();
    empty.deps.listMessageIdsMatching.mockResolvedValueOnce([]);
    const result = await pullClientEmails({ payload: empty.payload as never, userId: 3, accessToken: "tok", clientId: 7, now, runModel: empty.runModel, deps: empty.deps });
    expect(result).toMatchObject({ ok: true, found: 0, briefUpdated: false, brief: null });
    expect(empty.runModel).not.toHaveBeenCalled();
  });

  it("refuses a missing client or one with nothing to search for, before touching Gmail", async () => {
    const { payload, deps, runModel } = setup({ clients: [{ id: 8, name: "No contacts" }] });
    expect(await pullClientEmails({ payload: payload as never, userId: 3, accessToken: "tok", clientId: 99, now, runModel, deps })).toMatchObject({ ok: false, status: 404 });
    expect(await pullClientEmails({ payload: payload as never, userId: 3, accessToken: "tok", clientId: 8, now, runModel, deps })).toMatchObject({ ok: false, status: 400 });
    expect(deps.listMessageIdsMatching).not.toHaveBeenCalled();
  });
});

describe("loadClientEmailKnowledge / buildClientAskRequest", () => {
  const emails: Row[] = [
    { id: 1, client: 7, owner: 3, date: "2026-03-01T00:00:00Z", direction: "outbound", from: "pat@od", to: "casey@itp", subject: "March budget", body: "We propose $2,000 for March.", gmailLink: "https://mail.google.com/mail/u/0/#all/m1" },
    { id: 2, client: 7, owner: 3, date: "2026-04-01T00:00:00Z", direction: "inbound", from: "casey@itp", to: "pat@od", subject: "Photos", body: "Here are the photos.", gmailLink: "javascript:alert(1)" },
    { id: 3, client: 7, owner: 4, date: "2026-05-01T00:00:00Z", direction: "inbound", from: "casey@itp", to: "sam@od", subject: "Budget again", body: "Budget for May?", gmailLink: null },
  ];

  it("only reads the asker's own mail unless they are an admin, and picks the emails matching the question", async () => {
    const payload = fakePayload({ "client-emails": emails, "client-email-briefs": [{ id: 9, client: 7, owner: 4, account: "sam@od", brief: "Sam's brief", lastPulledAt: "2026-05-02T00:00:00Z" }] });
    const own = await loadClientEmailKnowledge({ payload: payload as never, clientId: 7, ownerId: 3, question: "What budget did we agree?" });
    expect(own.briefs).toEqual([]);
    expect(own.emails.map((email) => email.id)).toEqual([1]);
    // Only Gmail links are passed on.
    const everyone = await loadClientEmailKnowledge({ payload: payload as never, clientId: 7, ownerId: null, question: "budgets" });
    expect(everyone.briefs.map((brief) => brief.brief)).toEqual(["Sam's brief"]);
    expect(everyone.emails.map((email) => email.id)).toEqual([1, 3]);

    const fallback = await loadClientEmailKnowledge({ payload: payload as never, clientId: 7, ownerId: 3, question: "zzz" });
    expect(fallback.fellBackToRecent).toBe(true);
    expect(fallback.emails.find((email) => email.id === 2)?.gmailLink).toBeNull();
  });

  it("labels the emails for citing and carries the conversation so far", async () => {
    const payload = fakePayload({ "client-emails": emails });
    const knowledge = await loadClientEmailKnowledge({ payload: payload as never, clientId: 7, ownerId: null, question: "budget" });
    const request = buildClientAskRequest({
      clientId: 7,
      clientName: "Acme Client",
      knowledge,
      question: "And for May?",
      history: cleanAskHistory([{ question: "March budget?", answer: "$2,000 [E1]." }, { question: "", answer: "dropped" }, "junk"]),
    });
    expect(request.action).toBe("client-ask");
    expect(request.system).toBe(MAIL_PROMPTS["client-ask"].system);
    const text = request.messages[0]?.text ?? "";
    expect(text).toContain("No email brief has been pulled for this client yet.");
    expect(text).toContain("[E1] 2026-03-01 · We sent");
    expect(text).toContain("[E2] 2026-05-01 · Client sent");
    expect(text).toContain("Q: March budget?\nA: $2,000 [E1].");
    expect(text).not.toContain("dropped");
    expect(text.trimEnd().endsWith("Question: And for May?")).toBe(true);
  });

  it("matches question words loosely", () => {
    expect(questionTerms("What did they say about the budgets and $2,000?")).toEqual(["budget", "$2,000"]);
  });
});

describe("search settings (parent-company clients)", () => {
  it("accepts addresses and domains, cleans keywords, and reports what it cannot read", () => {
    const parsed = parsePullSettings({
      useClientContacts: false,
      senders: ["PMorris@Northwind.com.au", "@custom.com.au", "https://www.custom.com.au/x", "pmorris@northwind.com.au"],
      keywords: ['Custom "Fluid" Power', "{x} OR from:all", "a"],
      matchMode: "all",
    });
    expect(parsed).toEqual({
      ok: true,
      settings: {
        useClientContacts: false,
        senders: ["pmorris@northwind.com.au", "custom.com.au"],
        keywords: ["Custom Fluid Power", "x OR from:all"],
        matchMode: "all",
      },
    });
    expect(parsePullSettings({ senders: ["not an address@"] })).toMatchObject({ ok: false, error: expect.stringContaining("not an address@") });
    expect(parsePullSettings({ useClientContacts: false })).toMatchObject({ ok: false });
    expect(parsePullSettings({ useClientContacts: false, senders: ["a@b.com"], matchMode: "all" })).toMatchObject({ ok: false });
  });

  it("builds any / both searches with keywords as quoted phrases", () => {
    const targets = { domains: ["northwind.com.au"], addresses: [] };
    const after = new Date("2026-01-01T00:00:00Z");
    const base = { useClientContacts: false, senders: ["pmorris@northwind.com.au"], keywords: ["Custom Fluid", "CFP"] };
    expect(clientGmailQuery(targets, after, { ...base, matchMode: "any" })).toBe(
      '{from:pmorris@northwind.com.au to:pmorris@northwind.com.au cc:pmorris@northwind.com.au "Custom Fluid" "CFP"} after:1767225600 -in:chats -in:drafts -in:spam -in:trash',
    );
    expect(clientGmailQuery(targets, after, { ...base, matchMode: "all" })).toBe(
      '{from:pmorris@northwind.com.au to:pmorris@northwind.com.au cc:pmorris@northwind.com.au} {"Custom Fluid" "CFP"} after:1767225600 -in:chats -in:drafts -in:spam -in:trash',
    );
    expect(clientGmailQuery(targets, after, { ...DEFAULT_PULL_SETTINGS, useClientContacts: false, keywords: ["CFP"] })).toBe(
      '{"CFP"} after:1767225600 -in:chats -in:drafts -in:spam -in:trash',
    );
  });

  it("gives the brief and answers room to think: a 90-email brief came back empty at 3,500 tokens", () => {
    const { request } = buildClientBriefRequest({ clientId: 1, clientName: "C", previousBrief: null, emails: [] });
    expect(request.maxTokens).toBe(BRIEF_MAX_OUTPUT_TOKENS);
    expect(BRIEF_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(16_000);
    const ask = buildClientAskRequest({
      clientId: 1,
      clientName: "C",
      knowledge: { briefs: [], emails: [], savedEmails: 0, fellBackToRecent: true },
      question: "q",
      history: [],
    });
    expect(ask.maxTokens).toBe(ASK_MAX_OUTPUT_TOKENS);
  });

  it("with custom settings, saves what the search found even off the client's domains, and a settings change starts the brief afresh", async () => {
    const now = new Date("2026-10-28T05:00:00Z");
    const settings = { useClientContacts: false, senders: "pmorris@northwind.com.au", keywords: "Custom Fluid", matchMode: "all" };
    const payload = fakePayload({
      clients: [CLIENT as unknown as Row],
      "client-email-pull-settings": [{ id: 5, client: 7, ...settings }],
      // Written yesterday with the default settings; within its cooldown it would block a same-settings pull.
      "client-email-briefs": [
        { id: 1, client: 7, owner: 3, account: "pat@ourteam.example", brief: "Old Northwind-wide brief", messageIds: '["old1"]', lastPulledAt: new Date(now.getTime() - 1000).toISOString() },
      ],
    });
    const deps = {
      getMailboxProfile: vi.fn(async () => ({ emailAddress: "pat@ourteam.example", historyId: "1" })),
      listMessageIdsMatching: vi.fn(async () => ["q1"]),
      getMessageHeaders: vi.fn(async () => [{ ...headers("q1", "Paul <pmorris@northwind.com.au>") }]),
      getFullMessage: vi.fn(async () => gmailMessage("q1", "Paul <pmorris@northwind.com.au>", "pat@ourteam.example", "CFP budget", "2026-10-02T00:00:00Z", "Custom Fluid budget")),
      loadHiddenSenders: vi.fn(async () => []),
    };
    const runModel = vi.fn(async (_request: MailModelRequest) => ({ text: "New brief", model: "m" }));
    const result = await pullClientEmails({ payload: payload as never, userId: 3, accessToken: "tok", clientId: 7, now, runModel, deps });

    expect(result).toMatchObject({ ok: true, found: 1, saved: 1, briefUpdated: true });
    const [, query] = deps.listMessageIdsMatching.mock.calls[0] ?? [];
    // Not the cooldown, and a fresh 12-month search with only the chosen sender and keyword.
    expect(query).toContain(`after:${Math.floor(now.getTime() / 1000) - 365 * 24 * 60 * 60}`);
    expect(query).not.toContain("custom.com.au");
    expect(query).toContain('{"Custom Fluid"}');
    expect(payload.tables["client-emails"]?.[0]).toMatchObject({ client: 7, matchedOn: "pmorris@northwind.com.au" });
    // The old brief is not carried into the new one.
    expect(runModel.mock.calls[0]?.[0].messages[0]?.text).not.toContain("Old Northwind-wide brief");
    expect(payload.tables["client-email-briefs"]?.[0]).toMatchObject({
      brief: "New brief",
      filterKey: pullFilterKey({ useClientContacts: false, senders: ["pmorris@northwind.com.au"], keywords: ["Custom Fluid"], matchMode: "all" }),
      messageIds: '["q1"]',
      emailCount: 1,
    });
  });

  it("questions also read the brief's emails that are saved to another client", async () => {
    const payload = fakePayload({
      "client-emails": [
        { id: 1, client: 99, owner: 3, gmailMessageId: "q1", date: "2026-10-02T00:00:00Z", direction: "inbound", from: "pmorris@northwind.com.au", to: "pat@od", subject: "CFP budget", body: "Custom Fluid budget is $5,000.", gmailLink: null },
      ],
      "client-email-briefs": [{ id: 1, client: 7, owner: 3, account: "pat@od", brief: "Brief", messageIds: '["q1"]', lastPulledAt: "2026-10-28T00:00:00Z" }],
    });
    const knowledge = await loadClientEmailKnowledge({ payload: payload as never, clientId: 7, ownerId: 3, question: "budget" });
    expect(knowledge.emails.map((email) => email.subject)).toEqual(["CFP budget"]);
  });
});
