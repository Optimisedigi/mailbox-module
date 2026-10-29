import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { buildMailModelRequest, buildMailSubjectRequest, MailModelRequestError, MAX_THREAD_MESSAGES, MAX_THREAD_TOTAL_CHARS, selectThreadContext } from "@/lib/mail/model-request";
import { MAIL_PROMPTS } from "@/lib/mail/prompts";

const mockPayload = { auth: vi.fn(), find: vi.fn(), findByID: vi.fn(), create: vi.fn(), update: vi.fn() };
vi.mock("payload", () => ({ getPayload: vi.fn(() => Promise.resolve(mockPayload)) }));
vi.mock("@/payload.config", () => ({ default: Promise.resolve({}) }));
const mockHasFeature = vi.fn((_user: unknown, _slug: string) => true);
vi.mock("@/lib/access", () => ({ userHasFeature: (user: unknown, slug: string) => mockHasFeature(user, slug) }));
const CLIENT_NAMES: Record<number, string> = { 7: "Acme Pty Ltd", 8: "Acme Client" };
// The optional client-list extension supplies the extra facts.
const mockProfile = vi.fn(async (args: { clientId: number }) => [`Latest contract: "CONTRACT-FOR-${args.clientId}", status signed`]);
vi.mock("@/extensions/client-list", () => ({
  clientListExtension: { loadClientFacts: (args: { clientId: number }) => mockProfile(args) },
}));
const clientById = async (args: { collection: string; id: number }) => {
  if (args.collection === "clients" && CLIENT_NAMES[args.id]) return { id: args.id, name: CLIENT_NAMES[args.id] };
  throw new Error("Not Found");
};
vi.mock("@/lib/user-gmail-tokens", () => ({
  getValidGmailToken: vi.fn(async () => ({ ok: true, accessToken: "tok", email: "pat@ourteam.example", userEmail: "" })),
}));
const mockCallLLM = vi.fn();
vi.mock("@/lib/ai/llm", () => ({ callLLM: (...args: unknown[]) => mockCallLLM(...args) }));
const mockSettings = vi.fn(async () => ({ emailAssistantModel: "email-model", writingStyle: "- **email-tone**: STYLE-RULE-NO-SIGNOFF", voiceApiKeyEnabled: false }));
vi.mock("@/lib/ai/mail-ai-settings", () => ({ getMailAiSettings: () => mockSettings() }));

const INBOX: Record<string, { from: string; subject: string; body: string }> = {
  selected: { from: "jo@acmeclient.com.au", subject: "Meeting", body: "Can we meet Thursday? SELECTED-BODY" },
  other: { from: "sam@other.com", subject: "Secret", body: "OTHER-EMAIL-BODY must never reach the model" },
};
const mockGetFullMessage = vi.fn(async (_token: string, id: string) => ({
  messageId: id, threadId: "t1", rfcMessageId: "<x@y>", to: "pat@ourteam.example", cc: "", date: "",
  snippet: "", labelIds: [], ...INBOX[id]!,
}));
const mockGetThreadMessages = vi.fn(async (_token: string, threadId: string) => [
  { messageId: "earlier", threadId, rfcMessageId: "", from: "jo@acmeclient.com.au", to: "pat@ourteam.example", cc: "", subject: "Meeting", date: "", snippet: "", labelIds: [], bodyHtml: "", body: "Proposed Tuesday. EARLIER-IN-THREAD" },
  { messageId: "selected", threadId, rfcMessageId: "", from: "jo@acmeclient.com.au", to: "pat@ourteam.example", cc: "", subject: "Meeting", date: "", snippet: "", labelIds: [], bodyHtml: "", ...INBOX.selected },
  { messageId: "stray", threadId: "some-other-thread", rfcMessageId: "", from: "sam@other.com", to: "", cc: "", subject: "x", date: "", snippet: "", labelIds: [], bodyHtml: "", body: "OTHER-EMAIL-BODY" },
]);
const mockListIds = vi.fn(async (_t: string, _q: string, _max: number) => ["m1", "m2", "m3"]);
const mockSenderSubjects = vi.fn(async (_t: string, ids: string[]) =>
  ids.map((id) => ({ messageId: id, threadId: `t-${id}`, from: id === "m3" ? "Jo <jo@acmeclient.com.au>" : "Pitch <sales@pitch.io>", subject: `Subject ${id}` })),
);
const mockBatchModify = vi.fn(async (_t: string, _ids: string[], _change: unknown) => undefined);
vi.mock("@/lib/mail/gmail-mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/gmail-mail")>()),
  getFullMessage: (t: string, id: string) => mockGetFullMessage(t, id),
  getThreadMessages: (t: string, id: string) => mockGetThreadMessages(t, id),
  listMessageIdsMatching: (t: string, q: string, max: number) => mockListIds(t, q, max),
  getMessageSenderSubjects: (t: string, ids: string[]) => mockSenderSubjects(t, ids),
  batchModifyMessages: (t: string, ids: string[], change: unknown) => mockBatchModify(t, ids, change),
}));
vi.mock("@/lib/mail/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/store")>()),
  loadClientDomainIndex: async () => (await import("@/lib/mail/client-matching")).buildClientDomainIndex(
    [{ id: 8, name: "Acme Client", websiteUrl: "https://acmeclient.com.au" }],
  ),
}));

function post(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

function modelInput(): string {
  const call = mockCallLLM.mock.calls[0]![0] as { system: string; messages: Array<{ content: Array<{ text: string }> }> };
  return call.system + JSON.stringify(call.messages);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPayload.auth.mockResolvedValue({ user: { id: 10, role: "admin" } });
  mockPayload.create.mockResolvedValue({ id: 1 });
  mockPayload.findByID.mockImplementation(clientById);
  mockCallLLM.mockResolvedValue({ message: { content: [{ type: "text", text: "Draft text" }] }, model: "test-model" });
});

describe("buildMailModelRequest", () => {
  const email = { gmailMessageId: "a", from: "x@y.com", subject: "S", body: "B" };
  it("includes exactly one email for reply/summarise and none for draft", () => {
    expect(buildMailModelRequest({ action: "reply", email }).emailCount).toBe(1);
    expect(buildMailModelRequest({ action: "summarise", email }).emailCount).toBe(1);
    expect(buildMailModelRequest({ action: "draft", instruction: "hi" })).toMatchObject({ emailCount: 0, gmailMessageId: null });
  });
  it("rejects lists of emails and emails attached to a fresh draft", () => {
    expect(() => buildMailModelRequest({ action: "reply", email: [email, email] as never })).toThrow(MailModelRequestError);
    expect(() => buildMailModelRequest({ action: "draft", email, instruction: "x" })).toThrow(MailModelRequestError);
    expect(() => buildMailModelRequest({ action: "reply" })).toThrow(MailModelRequestError);
  });
  it("every prompt states it only sees the supplied email", () => {
    for (const prompt of Object.values(MAIL_PROMPTS)) expect(prompt.system).toMatch(/You only see/);
  });
});

describe("POST /api/mail/ai", () => {
  it("sends only the selected email plus the instruction, and logs one email", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(post("/api/mail/ai", { action: "reply", gmailMessageId: "selected", instruction: "say Thursday works" }));
    expect(res.status).toBe(200);
    expect(mockGetFullMessage).toHaveBeenCalledTimes(1);
    expect(mockGetFullMessage).toHaveBeenCalledWith("tok", "selected");
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    const input = modelInput();
    expect(input).toContain("SELECTED-BODY");
    expect(input).toContain("say Thursday works");
    expect(input).not.toContain("OTHER-EMAIL-BODY");
    expect(mockPayload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: "mail-ai-requests",
        data: expect.objectContaining({ action: "reply", gmailMessageId: "selected", emailCount: 1 }),
      }),
    );
    const logged = JSON.stringify(mockPayload.create.mock.calls);
    expect(logged).not.toContain("SELECTED-BODY");
  });

  it("rejects more than one email without calling the model", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(post("/api/mail/ai", { action: "reply", gmailMessageId: ["selected", "other"] }));
    expect(res.status).toBe(400);
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(mockGetFullMessage).not.toHaveBeenCalled();
  });

  it("a new draft sends no email at all", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(post("/api/mail/ai", { action: "draft", instruction: "Invite Jo to a call" }));
    expect(res.status).toBe(200);
    expect(mockGetFullMessage).not.toHaveBeenCalled();
    expect(modelInput()).not.toMatch(/SELECTED-BODY|OTHER-EMAIL-BODY/);
    expect(mockPayload.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ emailCount: 0 }) }));
  });
});

describe("AI greeting and suggested subject", () => {
  it("replies open with Hi and the sender's first name", async () => {
    mockGetFullMessage.mockResolvedValueOnce({
      messageId: "selected", threadId: "t1", rfcMessageId: "<x@y>", to: "pat@ourteam.example", cc: "", date: "",
      snippet: "", labelIds: [], from: "Hannah Smith <hannah@otherside.com.au>", subject: "Paid ads", body: "Next steps?",
    });
    mockCallLLM.mockResolvedValueOnce({ message: { content: [{ type: "text", text: "Dear Hannah,\n\nHappy to help." }] }, model: "m" });
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(post("/api/mail/ai", { action: "reply", gmailMessageId: "selected" }));
    expect(await res.json()).toMatchObject({ text: "Hi Hannah,\n\nHappy to help." });
    expect(modelInput()).toContain("Always open with 'Hi'");
  });

  it("new emails greet the recipient name sent by the browser", async () => {
    mockCallLLM.mockResolvedValueOnce({ message: { content: [{ type: "text", text: "Hi,\n\nFancy a call?" }] }, model: "m" });
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(post("/api/mail/ai", { action: "draft", instruction: "invite to a call", recipientName: "Sam" }));
    expect(await res.json()).toMatchObject({ text: "Hi Sam,\n\nFancy a call?" });
  });

  it("replies to a sender with no display name use the browser's name", async () => {
    mockGetFullMessage.mockResolvedValueOnce({
      messageId: "selected", threadId: "t1", rfcMessageId: "<x@y>", to: "pat@ourteam.example", cc: "", date: "",
      snippet: "", labelIds: [], from: "hannah@otherside.com.au", subject: "Paid ads", body: "Next steps?",
    });
    mockCallLLM.mockResolvedValueOnce({ message: { content: [{ type: "text", text: "Happy to help." }] }, model: "m" });
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(post("/api/mail/ai", { action: "reply", gmailMessageId: "selected", recipientName: "Hannah" }));
    expect(await res.json()).toMatchObject({ text: "Hi Hannah,\n\nHappy to help." });
  });

  it("splits a suggested subject off the first draft of a new email", async () => {
    mockCallLLM.mockResolvedValueOnce({
      message: { content: [{ type: "text", text: "Subject: Call next week?\n\nHi Jo,\n\nFancy a call next week?" }] },
      model: "m",
    });
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(post("/api/mail/ai", { action: "draft", instruction: "invite Jo to a call", suggestSubject: true }));
    expect(await res.json()).toMatchObject({ subject: "Call next week?", text: "Hi Jo,\n\nFancy a call next week?" });
    expect(modelInput()).toContain("'Subject: <a short, specific subject line>'");
    expect(mockPayload.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "draft" }) }));
  });

  it("asks for a subject only on the first request of a new email", () => {
    expect(buildMailModelRequest({ action: "draft", instruction: "x", suggestSubject: true }).suggestSubject).toBe(true);
    expect(buildMailModelRequest({ action: "draft", instruction: "x" }).suggestSubject).toBe(false);
    expect(
      buildMailModelRequest({ action: "draft", instruction: "shorter", currentDraft: "Hi Jo", suggestSubject: true }).suggestSubject,
    ).toBe(false);
    expect(
      buildMailModelRequest({ action: "reply", email: { gmailMessageId: "a", from: "x", subject: "s", body: "b" }, suggestSubject: true })
        .suggestSubject,
    ).toBe(false);
  });
});

describe("POST /api/mail/subject", () => {
  it("sends only the body, without the writing style, and returns a tidy sentence-case subject", async () => {
    mockCallLLM.mockResolvedValueOnce({ message: { content: [{ type: "text", text: "Subject: \"weekly report for Google Ads.\"\n" }] }, model: "m" });
    const { POST } = await import("@/app/(frontend)/api/mail/subject/route");
    const res = await POST(post("/api/mail/subject", { body: "Hi Jo,\n\nHere is this week's Google Ads report. BODY-TEXT" }));
    expect(await res.json()).toMatchObject({ subject: "Weekly report for Google Ads" });
    expect(modelInput()).toContain("BODY-TEXT");
    expect(modelInput()).toContain("sentence case");
    expect(modelInput()).not.toContain("STYLE-RULE");
    expect(mockGetFullMessage).not.toHaveBeenCalled();
    expect(mockPayload.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "subject", emailCount: 0 }) }));
  });

  it("refuses an empty body without calling the model", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/subject/route");
    const res = await POST(post("/api/mail/subject", { body: "   " }));
    expect(res.status).toBe(400);
    expect(mockCallLLM).not.toHaveBeenCalled();
    expect(() => buildMailModelRequest({ action: "subject", instruction: "x" })).toThrow(MailModelRequestError);
    expect(() => buildMailSubjectRequest(42)).toThrow(MailModelRequestError);
  });
});

const TRIAGE_PLAN = { message: { content: [{ type: "text", text: '{"categories":[{"name":"Cold pitches","description":"Selling things.","clear":true}]}' }] }, model: "m" };

describe("POST /api/mail/triage", () => {
  it("reads only unread senders and subjects, keeps clients from the model, and changes nothing in Gmail", async () => {
    mockPayload.find.mockResolvedValue({ docs: [] });
    mockCallLLM.mockResolvedValueOnce(TRIAGE_PLAN).mockResolvedValueOnce({ message: { content: [{ type: "text", text: "1 1" }] }, model: "m" });
    const { POST } = await import("@/app/(frontend)/api/mail/triage/route");
    const res = await POST(post("/api/mail/triage", {}));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(mockListIds.mock.calls[0]?.[1]).toContain("is:unread");
    expect(mockGetFullMessage).not.toHaveBeenCalled();
    expect(modelInput()).toContain("sales@pitch.io");
    expect(modelInput()).not.toContain("acmeclient");
    expect(mockBatchModify).not.toHaveBeenCalled();
    expect(JSON.stringify(mockCallLLM.mock.calls)).not.toContain("acmeclient");
    expect(data.categories.map((c: { label: string; count: number; defaultSelected: boolean }) => [c.label, c.count, c.defaultSelected])).toEqual([
      ["Cold pitches", 2, true],
      ["Clients", 1, false],
    ]);
    expect(data.categories[0].senders[0]).toMatchObject({ address: "sales@pitch.io", messageIds: ["m1", "m2"] });
    expect(mockPayload.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "triage", emailCount: 2 }) }));
  });
});

describe("POST /api/mail/triage in steps (big inboxes)", () => {
  it("lists, reads a chunk, and sorts what the panel sends back, never reading bodies", async () => {
    mockPayload.find.mockResolvedValue({ docs: [] });
    const { POST } = await import("@/app/(frontend)/api/mail/triage/route");
    const listed = await (await POST(post("/api/mail/triage", { step: "list" }))).json();
    expect(listed).toEqual({ ids: ["m1", "m2", "m3"], truncated: false });
    expect(mockSenderSubjects).not.toHaveBeenCalled();

    const read = await (await POST(post("/api/mail/triage", { step: "read", ids: ["m1", "m2", "m1"] }))).json();
    expect(mockSenderSubjects).toHaveBeenCalledWith("tok", ["m1", "m2"]);
    expect(read.messages.map((m: { messageId: string }) => m.messageId)).toEqual(["m1", "m2"]);
    expect(mockCallLLM).not.toHaveBeenCalled();

    mockCallLLM.mockResolvedValueOnce(TRIAGE_PLAN).mockResolvedValueOnce({ message: { content: [{ type: "text", text: "1 1" }] }, model: "m" });
    const sorted = await (await POST(post("/api/mail/triage", { step: "sort", messages: read.messages }))).json();
    expect(sorted.categories.map((c: { key: string; count: number }) => [c.key, c.count])).toEqual([["ai-1", 2]]);
    expect(sorted.scanned).toBe(2);
    expect(mockGetFullMessage).not.toHaveBeenCalled();
    expect(mockBatchModify).not.toHaveBeenCalled();
  });

  it("gives triage calls room for the model's thinking, and logs a reply cut off at the limit", async () => {
    mockPayload.find.mockResolvedValue({ docs: [] });
    mockCallLLM
      .mockResolvedValueOnce(TRIAGE_PLAN)
      .mockResolvedValueOnce({ message: { content: [{ type: "text", text: "1 1" }] }, model: "m", stopReason: "max_tokens" });
    const { POST } = await import("@/app/(frontend)/api/mail/triage/route");
    const res = await POST(post("/api/mail/triage", { step: "sort", messages: [{ messageId: "m1", from: "a@b.com", subject: "x" }] }));
    expect(res.status).toBe(200);
    // Haiku's thinking counts toward the limit: a full batch needed about 2,300 tokens, over the old 2,000.
    expect(mockCallLLM.mock.calls.map((call) => (call[0] as { maxTokens: number }).maxTokens)).toEqual([8000, 8000]);
    expect(mockPayload.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "triage", status: "ok", error: "Stopped at the output limit" }) }),
    );
  });

  it("answers 502 when the AI cannot plan the categories", async () => {
    mockPayload.find.mockResolvedValue({ docs: [] });
    mockCallLLM.mockResolvedValueOnce({ message: { content: [{ type: "text", text: "sorry" }] }, model: "m" });
    const { POST } = await import("@/app/(frontend)/api/mail/triage/route");
    const res = await POST(post("/api/mail/triage", { step: "sort", messages: [{ messageId: "m1", from: "a@b.com", subject: "x" }] }));
    expect(res.status).toBe(502);
  });

  it("refuses bad steps, too many ids, non-Gmail ids and malformed messages", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/triage/route");
    const bad = [
      { step: "delete" },
      { step: "read", ids: [] },
      { step: "read", ids: Array.from({ length: 201 }, (_, i) => `m${i}`) },
      { step: "read", ids: ["../x"] },
      { step: "sort", messages: [{ messageId: "../x", from: "a" }] },
      { step: "sort", messages: [{ messageId: "m1", from: 5 }] },
      { step: "sort", messages: "nope" },
    ];
    for (const body of bad) expect((await POST(post("/api/mail/triage", body))).status).toBe(400);
    expect(mockSenderSubjects).not.toHaveBeenCalled();
    expect(mockCallLLM).not.toHaveBeenCalled();
  });
});

describe("POST /api/mail/triage/apply", () => {
  it("archives only the ticked message ids", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/triage/apply/route");
    const res = await POST(post("/api/mail/triage/apply", { messageIds: ["m1", "m2", "m1"], action: "archive" }));
    expect(await res.json()).toMatchObject({ ok: true, count: 2 });
    expect(mockBatchModify).toHaveBeenCalledWith("tok", ["m1", "m2"], { remove: ["INBOX"] });
  });

  it("rejects bad ids, unknown actions and oversized batches", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/triage/apply/route");
    for (const body of [
      { messageIds: ["m1"], action: "delete" },
      { messageIds: ["bad id!"], action: "read" },
      { messageIds: [], action: "read" },
      { messageIds: Array.from({ length: 1001 }, (_, i) => `m${i}`), action: "read" },
    ]) {
      expect((await POST(post("/api/mail/triage/apply", body))).status).toBe(400);
    }
    expect(mockBatchModify).not.toHaveBeenCalled();
  });
});

describe("POST /api/mail/summarise", () => {
  it("summarises only the one stored email and saves nothing to the timeline", async () => {
    mockPayload.findByID.mockResolvedValue({ id: 5, gmailMessageId: "selected", ...INBOX.selected });
    const { POST } = await import("@/app/(frontend)/api/mail/summarise/route");
    const res = await POST(post("/api/mail/summarise", { clientEmailId: 5 }));
    expect(res.status).toBe(200);
    expect(mockPayload.findByID).toHaveBeenCalledTimes(1);
    expect(mockPayload.find).not.toHaveBeenCalled();
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(modelInput()).toContain("SELECTED-BODY");
    const collections = mockPayload.create.mock.calls.map((c) => (c[0] as { collection: string }).collection);
    expect(collections).toEqual(["mail-ai-requests"]);
  });
});

describe("house writing style and model", () => {
  it("adds the Mail Settings writing style to reply prompts, using the Mail Settings model", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    await POST(post("/api/mail/ai", { action: "reply", gmailMessageId: "selected", instruction: "ok" }));
    const call = mockCallLLM.mock.calls[0]![0] as { system: string; model: string };
    expect(call.system).toContain("STYLE-RULE-NO-SIGNOFF");
    expect(call.model).toBe("email-model");
    expect(mockSettings).toHaveBeenCalled();
  });

  it("uses only the chosen model, and refuses without calling any model when none is chosen", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    await POST(post("/api/mail/ai", { action: "reply", gmailMessageId: "selected", instruction: "ok" }));
    expect((mockCallLLM.mock.calls[0]![0] as { fallbackModels?: unknown }).fallbackModels).toBeUndefined();
    mockCallLLM.mockClear();
    mockSettings.mockResolvedValueOnce({ emailAssistantModel: null, writingStyle: "", voiceApiKeyEnabled: false } as never);
    const res = await POST(post("/api/mail/ai", { action: "reply", gmailMessageId: "selected", instruction: "ok" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).error).toMatch(/No AI model is chosen yet/);
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it("does not add the writing style to timeline summaries", async () => {
    mockPayload.findByID.mockResolvedValue({ id: 5, gmailMessageId: "selected", ...INBOX.selected });
    const { POST } = await import("@/app/(frontend)/api/mail/summarise/route");
    await POST(post("/api/mail/summarise", { clientEmailId: 5 }));
    expect(modelInput()).not.toContain("STYLE-RULE-NO-SIGNOFF");
  });
});

describe("revising a draft (keep prompting)", () => {
  const llmText = (text: string) => ({ message: { content: [{ type: "text", text }] }, model: "test-model" });

  it("sends the edited draft as numbered blocks plus earlier requests, and still only the one selected email", async () => {
    mockCallLLM.mockResolvedValueOnce(llmText('{"edits":[{"op":"replace","block":2,"text":"Thursday at 2pm works."}]}'));
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(
      post("/api/mail/ai", {
        action: "reply",
        gmailMessageId: "selected",
        instruction: "say 2pm",
        history: [{ instruction: "say Thursday works", draft: "Hi Jo,\n\nThursday works. FIRST-DRAFT" }],
        currentBlocks: ["Hi Jo,", "Thursday works. MY-OWN-EDIT", "Talk soon."],
      }),
    );
    expect(res.status).toBe(200);
    // Only the changed block differs; the rest is returned word for word.
    expect(await res.json()).toMatchObject({
      text: "Hi Jo,\n\nThursday at 2pm works.\n\nTalk soon.",
      edits: [{ op: "replace", block: 2, text: "Thursday at 2pm works." }],
    });
    expect(mockGetFullMessage).toHaveBeenCalledTimes(1);
    const call = mockCallLLM.mock.calls[0]![0] as { temperature: number; messages: Array<{ role: string }> };
    expect(call.messages.map((m) => m.role)).toEqual(["user"]);
    expect(call.temperature).toBe(0.2);
    const input = modelInput();
    expect(input).toContain("SELECTED-BODY");
    expect(input).toContain("[2]\\nThursday works. MY-OWN-EDIT");
    expect(input).toContain("- say Thursday works");
    expect(input).toContain("My request: say 2pm");
    expect(input).toContain("Change as little as possible");
    // Old drafts are not replayed: the current draft is the only version the model edits.
    expect(input).not.toContain("FIRST-DRAFT");
    expect(input).not.toContain("OTHER-EMAIL-BODY");
    expect(mockPayload.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ emailCount: 1 }) }));
  });

  it("asks once more when the edits cannot be read, then gives a clear error", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const body = { action: "draft", instruction: "add Friday", currentBlocks: ["Hi Jo,", "See you."] };
    mockCallLLM.mockResolvedValueOnce(llmText("Hi Jo, here is a whole new email")).mockResolvedValueOnce(
      llmText('```json\n{"edits":[{"op":"insert_after","block":1,"text":"Friday suits me."}]}\n```'),
    );
    const ok = await POST(post("/api/mail/ai", body));
    expect(await ok.json()).toMatchObject({ text: "Hi Jo,\n\nFriday suits me.\n\nSee you." });
    expect(mockCallLLM).toHaveBeenCalledTimes(2);

    mockCallLLM.mockResolvedValue(llmText('{"edits":[{"op":"replace","block":9,"text":"x"}]}'));
    const bad = await POST(post("/api/mail/ai", body));
    expect(bad.status).toBe(502);
    expect((await bad.json()).error).toMatch(/could not be read/);
  });

  it("a revised new draft still contains no email, and falls back to the draft text when no blocks are sent", () => {
    const req = buildMailModelRequest({
      action: "draft",
      instruction: "more formal",
      history: [{ instruction: "invite Jo to a call", draft: "Hi Jo, fancy a call?" }],
      currentDraft: "Hi Jo,\n\nFancy a call next week?",
    });
    expect(req.emailCount).toBe(0);
    expect(req.messages).toHaveLength(1);
    expect(req.revise).toEqual({ blocks: ["Hi Jo,", "Fancy a call next week?"] });
    expect(req.messages[0]!.text).toContain("My request: more formal");
    expect(req.system).not.toContain("turn them into a natural, polished email");
  });

  it("requires a change instruction once there is a draft, caps history and refuses drafts too long to revise", () => {
    expect(() => buildMailModelRequest({ action: "draft", instruction: "", currentDraft: "Hi" })).toThrow(MailModelRequestError);
    const long = Array.from({ length: 20 }, (_, i) => ({ instruction: `i${i}`, draft: `d${i}` }));
    const req = buildMailModelRequest({ action: "draft", instruction: "x", history: long });
    // 8 kept rounds; the last one's draft is what gets revised.
    expect(req.revise).toEqual({ blocks: ["d19"] });
    expect(req.messages[0]!.text).toContain("- i12");
    expect(req.messages[0]!.text).not.toContain("- i11");
    expect(() => buildMailModelRequest({ action: "draft", instruction: "x", currentBlocks: ["a".repeat(12_001)] })).toThrow(/too long/);
  });
});

describe("opt-in whole thread", () => {
  it("does not load the thread unless the box is ticked", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    await POST(post("/api/mail/ai", { action: "reply", gmailMessageId: "selected", instruction: "ok" }));
    expect(mockGetThreadMessages).not.toHaveBeenCalled();
    expect(modelInput()).not.toContain("EARLIER-IN-THREAD");
  });

  it("adds the earlier messages of the selected email's own thread, never another thread", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(
      post("/api/mail/ai", { action: "reply", gmailMessageId: "selected", instruction: "ok", includeThread: true, threadId: "attacker-thread" }),
    );
    expect(res.status).toBe(200);
    // Thread id comes from the selected message ("t1"), not from the request body.
    expect(mockGetThreadMessages).toHaveBeenCalledWith("tok", "t1");
    const input = modelInput();
    expect(input).toContain("EARLIER-IN-THREAD");
    expect(input).toContain("SELECTED-BODY");
    expect(input).not.toContain("OTHER-EMAIL-BODY");
    expect(mockPayload.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ gmailMessageId: "selected", emailCount: 2 }) }),
    );
  });

  it("caps thread context and refuses it for new drafts", () => {
    const thread = Array.from({ length: 30 }, (_, i) => ({ gmailMessageId: `m${i}`, from: "a@b.com", subject: "s", body: `B${i}-`.padEnd(6_000, "x") }));
    const kept = selectThreadContext(thread, "m29");
    expect(kept.length).toBeLessThanOrEqual(MAX_THREAD_MESSAGES);
    expect(kept.reduce((n, m) => n + m.body.length, 0)).toBeLessThanOrEqual(MAX_THREAD_TOTAL_CHARS);
    expect(kept[kept.length - 1]!.gmailMessageId).toBe("m28");
    expect(() => buildMailModelRequest({ action: "draft", instruction: "x", thread })).toThrow(MailModelRequestError);
  });
});


describe("opt-in client data", () => {
  // Client 8 matches the sender's domain; client 7 is a manual assignment stored for "selected".
  function payloadWith(opts: { storedClient?: number | null } = {}) {
    mockPayload.find.mockImplementation(async (args: { collection: string }) => {
      if (args.collection === "client-emails") {
        return { docs: opts.storedClient ? [{ client: { id: opts.storedClient, name: CLIENT_NAMES[opts.storedClient] } }] : [] };
      }
      if (args.collection === "clients") {
        return { docs: [{ id: 8, name: "Acme Client", websiteUrl: "https://acmeclient.com.au", isActive: true }] };
      }
      return { docs: [] };
    });
  }
  const findCollections = () => mockPayload.find.mock.calls.map((call) => (call[0] as { collection: string }).collection);

  it("sends no client facts and reads no client data unless the box is ticked", async () => {
    payloadWith({ storedClient: 7 });
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(post("/api/mail/ai", { action: "reply", gmailMessageId: "selected", instruction: "ok" }));
    expect(res.status).toBe(200);
    expect(modelInput()).not.toMatch(/from our CMS\n|CONTRACT-FOR-/);
    expect(findCollections()).toEqual([]);
    expect(mockProfile).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ clientContext: null });
    expect(mockPayload.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ client: null }) }));
  });

  it("uses the client stored for the selected message, never a client id from the body", async () => {
    payloadWith({ storedClient: 7 });
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(
      post("/api/mail/ai", { action: "reply", gmailMessageId: "selected", instruction: "ok", includeClientData: true, clientId: 8 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ clientContext: { id: 7, name: "Acme Pty Ltd" } });
    const input = modelInput();
    expect(input).toContain("Facts about Acme Pty Ltd from our CMS");
    expect(input).toContain("CONTRACT-FOR-7");
    expect(input).not.toContain("CONTRACT-FOR-8");
    expect(mockProfile).toHaveBeenCalledTimes(1);
    expect(mockPayload.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ client: 7 }) }));
  });

  it("falls back to the sender's domain match when the message is not stored", async () => {
    payloadWith();
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(post("/api/mail/ai", { action: "reply", gmailMessageId: "selected", includeClientData: true }));
    expect(res.status).toBe(200);
    expect(modelInput()).toContain("CONTRACT-FOR-8");
  });

  it("matches a new email's client from its recipients", async () => {
    payloadWith();
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(
      post("/api/mail/ai", { action: "draft", instruction: "Update Jo", includeClientData: true, to: "Jo <jo@acmeclient.com.au>", cc: "" }),
    );
    expect(res.status).toBe(200);
    expect(modelInput()).toContain("CONTRACT-FOR-8");
    expect(await res.json()).toMatchObject({ clientContext: { id: 8 } });
  });

  it("returns 400 without calling the model when no client resolves", async () => {
    payloadWith();
    const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
    const res = await POST(post("/api/mail/ai", { action: "draft", instruction: "Hi", includeClientData: true, to: "x@unknown.com" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This email isn't linked to a client.");
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it("returns 403 for users without the clients feature", async () => {
    payloadWith({ storedClient: 7 });
    mockHasFeature.mockImplementation((_user, slug) => slug !== "clients");
    try {
      const { POST } = await import("@/app/(frontend)/api/mail/ai/route");
      const res = await POST(post("/api/mail/ai", { action: "reply", gmailMessageId: "selected", includeClientData: true }));
      expect(res.status).toBe(403);
      expect(mockCallLLM).not.toHaveBeenCalled();
      expect(mockProfile).not.toHaveBeenCalled();
    } finally {
      mockHasFeature.mockImplementation(() => true);
    }
  });

  it("summaries never take client context", () => {
    const email = { gmailMessageId: "a", from: "x@y.com", subject: "S", body: "B" };
    expect(() =>
      buildMailModelRequest({ action: "summarise", email, clientContext: { clientId: 7, clientName: "Acme", text: "facts" } }),
    ).toThrow(MailModelRequestError);
    const reply = buildMailModelRequest({ action: "reply", email, clientContext: { clientId: 7, clientName: "Acme", text: "facts" } });
    expect(reply.clientId).toBe(7);
    expect(reply.messages[0]!.text.indexOf("Facts about Acme")).toBeLessThan(reply.messages[0]!.text.indexOf("The email:"));
  });
});

describe("POST /api/mail/tldr", () => {
  const tldrJson = '{"summary": "Jo asks to meet Thursday.", "actions": ["Check Thursday"], "questions": ["What time on Thursday?"], "reply": "Confirm Thursday works"}';

  it("reads only the one selected email, takes no thread or client data, and saves nothing but the audit row", async () => {
    mockCallLLM.mockResolvedValue({ message: { content: [{ type: "text", text: tldrJson }] }, model: "test-model" });
    const { POST } = await import("@/app/(frontend)/api/mail/tldr/route");
    const res = await POST(post("/api/mail/tldr", { gmailMessageId: "selected", includeThread: true, includeClientData: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: "Jo asks to meet Thursday.", actions: ["Check Thursday"], questions: ["What time on Thursday?"], reply: "Confirm Thursday works", model: "test-model" });
    expect(mockGetFullMessage).toHaveBeenCalledTimes(1);
    expect(mockGetThreadMessages).not.toHaveBeenCalled();
    expect(mockProfile).not.toHaveBeenCalled();
    expect(modelInput()).toContain("SELECTED-BODY");
    expect(modelInput()).not.toContain("OTHER-EMAIL-BODY");
    expect(modelInput()).not.toContain("STYLE-RULE-NO-SIGNOFF");
    const created = mockPayload.create.mock.calls.map((c) => c[0] as { collection: string; data: { action: string } });
    expect(created.map((c) => [c.collection, c.data.action])).toEqual([["mail-ai-requests", "tldr"]]);
  });

  it("retries once when the answer is not JSON, then reports an error", async () => {
    mockCallLLM.mockResolvedValue({ message: { content: [{ type: "text", text: "not json" }] }, model: "test-model" });
    const { POST } = await import("@/app/(frontend)/api/mail/tldr/route");
    const res = await POST(post("/api/mail/tldr", { gmailMessageId: "selected" }));
    expect(res.status).toBe(502);
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
  });

  it("refuses a list of ids", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/tldr/route");
    expect((await POST(post("/api/mail/tldr", { gmailMessageId: ["selected", "other"] }))).status).toBe(400);
    expect(mockCallLLM).not.toHaveBeenCalled();
  });
});

describe("POST /api/mail/thread-ask", () => {
  function payloadWithBrief() {
    mockPayload.find.mockImplementation(async (args: { collection: string }) => {
      if (args.collection === "client-email-briefs") {
        return { docs: [{ id: 1, account: "pat@ourteam.example", brief: "BRIEF: retainer is $2,500 a month", owner: 10 }] };
      }
      return { docs: [] };
    });
  }

  it("reads the whole thread plus the linked client's facts and email summary, and only writes the audit row", async () => {
    payloadWithBrief();
    mockCallLLM.mockResolvedValue({ message: { content: [{ type: "text", text: "The retainer is $2,500 a month." }] }, model: "test-model" });
    const { POST } = await import("@/app/(frontend)/api/mail/thread-ask/route");
    const res = await POST(post("/api/mail/thread-ask", { threadId: "t1", question: "What is the client's monthly retainer?", clientId: 7 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answer: "The retainer is $2,500 a month.", client: { id: 8, name: "Acme Client" }, messages: 2 });
    expect(mockGetThreadMessages).toHaveBeenCalledWith("tok", "t1");
    const input = modelInput();
    expect(input).toContain("EARLIER-IN-THREAD");
    expect(input).toContain("SELECTED-BODY");
    expect(input).not.toContain("OTHER-EMAIL-BODY");
    expect(input).toContain("CONTRACT-FOR-8");
    expect(input).toContain("BRIEF: retainer is $2,500 a month");
    expect(input).toContain("monthly retainer?");
    expect(input).not.toContain("STYLE-RULE-NO-SIGNOFF");
    expect(mockBatchModify).not.toHaveBeenCalled();
    expect(mockPayload.update).not.toHaveBeenCalled();
    const created = mockPayload.create.mock.calls.map((c) => c[0] as { collection: string; data: { action: string; client: number | null } });
    expect(created.map((c) => [c.collection, c.data.action, c.data.client])).toEqual([["mail-ai-requests", "thread-ask", 8]]);
  });

  it("answers from the thread alone without the clients feature", async () => {
    payloadWithBrief();
    mockHasFeature.mockImplementation((_user, slug) => slug !== "clients");
    try {
      const { POST } = await import("@/app/(frontend)/api/mail/thread-ask/route");
      const res = await POST(post("/api/mail/thread-ask", { threadId: "t1", question: "When do they want to meet?" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ client: null });
      expect(modelInput()).toContain("not linked to a client");
      expect(modelInput()).not.toMatch(/CONTRACT-FOR-|BRIEF:/);
    } finally {
      mockHasFeature.mockImplementation(() => true);
    }
  });

  it("needs a thread id and a question", async () => {
    const { POST } = await import("@/app/(frontend)/api/mail/thread-ask/route");
    expect((await POST(post("/api/mail/thread-ask", { threadId: ["t1", "t2"], question: "x" }))).status).toBe(400);
    expect((await POST(post("/api/mail/thread-ask", { threadId: "t1", question: " " }))).status).toBe(400);
    expect(mockCallLLM).not.toHaveBeenCalled();
  });
});
