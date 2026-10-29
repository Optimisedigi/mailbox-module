import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_EMAIL_ALERT_KIND,
  MAX_ALERTS_PER_SYNC,
  alertThreadId,
  createClientEmailAlert,
  isFreshEmail,
  removeAlertsForReadEmails,
  removeClientEmailAlertsForThreads,
  senderLabel,
} from "@/lib/mail/client-email-alerts";
import { syncMailbox } from "@/lib/mail/store";

vi.mock("@/lib/ai/llm", () => ({ callLLM: vi.fn(() => { throw new Error("model must not be called during sync"); }) }));

type Row = Record<string, any> & { id: number };

/** In-memory Payload supporting the simple where shapes store.ts and the alerts use. */
function fakePayload(clients: Row[]) {
  const tables: Record<string, Row[]> = { "client-emails": [], "mail-sync-states": [], notifications: [], clients };
  let nextId = 1;
  const matches = (row: Row, where: any): boolean => {
    if (!where) return true;
    if (Array.isArray(where.and)) return where.and.every((w: any) => matches(row, w));
    return Object.entries(where).every(([field, cond]: [string, any]) => {
      if ("equals" in cond) return row[field] === cond.equals;
      if ("in" in cond) return cond.in.includes(row[field]);
      if ("exists" in cond) return cond.exists ? row[field] != null : row[field] == null;
      return true;
    });
  };
  return {
    tables,
    find: vi.fn(async (args: any) => ({ docs: tables[args.collection]!.filter((row) => matches(row, args.where)) })),
    delete: vi.fn(async (args: any) => {
      const table = tables[args.collection]!;
      const gone = table.filter((row) => matches(row, args.where));
      tables[args.collection] = table.filter((row) => !gone.includes(row));
      return { docs: gone };
    }),
    create: vi.fn(async (args: any) => {
      const table = tables[args.collection]!;
      if (args.collection === "client-emails" && table.some((row) => row.gmailMessageId === args.data.gmailMessageId)) {
        throw new Error("UNIQUE constraint failed: client_emails.gmail_message_id");
      }
      const row = { id: nextId++, ...args.data };
      table.push(row);
      return row;
    }),
    update: vi.fn(async (args: any) => {
      const row = tables[args.collection]!.find((r) => r.id === args.id)!;
      Object.assign(row, args.data);
      return row;
    }),
  };
}

const NOW = new Date("2026-10-15T10:00:00.000Z");
const alertInput = (overrides: Record<string, unknown> = {}) => ({
  ownerId: 10,
  clientId: 1,
  clientName: "Acme Client",
  from: "Jo Smith <jo@acmeclient.com.au>",
  subject: "Can you call me?",
  gmailThreadId: "t1",
  gmailMessageId: "m1",
  date: "2026-10-15T09:30:00.000Z",
  ...overrides,
});

describe("client email alert helpers", () => {
  it("reads a display name from a From header", () => {
    expect(senderLabel("Jo Smith <jo@x.com>")).toBe("Jo Smith");
    expect(senderLabel('"Smith, Jo" <jo@x.com>')).toBe("Smith, Jo");
    expect(senderLabel("jo@x.com")).toBe("jo@x.com");
  });

  it("only treats emails from the last day as fresh", () => {
    expect(isFreshEmail("2026-10-15T01:00:00.000Z", NOW)).toBe(true);
    expect(isFreshEmail("2026-10-13T09:00:00.000Z", NOW)).toBe(false);
    expect(isFreshEmail("", NOW)).toBe(true);
  });
});

describe("createClientEmailAlert", () => {
  it("creates one notification for the mailbox owner, linked to the thread", async () => {
    const payload = fakePayload([]);
    expect(await createClientEmailAlert(payload as never, alertInput(), NOW)).toBe(true);
    const [row] = payload.tables.notifications;
    expect(row).toMatchObject({
      recipient: 10,
      kind: CLIENT_EMAIL_ALERT_KIND,
      title: "Client email – please read: Acme Client",
      body: "Jo Smith · Can you call me?",
      url: "/admin/mail?thread=t1",
      relatedClient: 1,
    });
  });

  it("never raises the same alert twice, even after it was dismissed", async () => {
    const payload = fakePayload([]);
    await createClientEmailAlert(payload as never, alertInput(), NOW);
    payload.tables.notifications[0]!.readAt = NOW.toISOString();
    expect(await createClientEmailAlert(payload as never, alertInput(), NOW)).toBe(false);
    expect(payload.tables.notifications).toHaveLength(1);
  });

  it("skips calendar invites", async () => {
    const payload = fakePayload([]);
    expect(await createClientEmailAlert(payload as never, alertInput({ calendarInvite: true, subject: "Canceled: QA test" }), NOW)).toBe(false);
    expect(payload.tables.notifications).toHaveLength(0);
  });

  it("skips Google reps but still alerts for Google service mailboxes", async () => {
    const payload = fakePayload([]);
    expect(await createClientEmailAlert(payload as never, alertInput({ from: "Mark Bailey <michaelbentley@google.com>" }), NOW)).toBe(false);
    expect(await createClientEmailAlert(payload as never, alertInput({ from: "Google Cloud <googlecloud@google.com>", gmailThreadId: "t2" }), NOW)).toBe(true);
    expect(payload.tables.notifications).toHaveLength(1);
  });

  it("skips old emails", async () => {
    const payload = fakePayload([]);
    expect(await createClientEmailAlert(payload as never, alertInput({ date: "2026-10-01T00:00:00.000Z" }), NOW)).toBe(false);
    expect(payload.tables.notifications).toHaveLength(0);
  });
});

describe("removing alerts once the email is read", () => {
  const seed = (payload: ReturnType<typeof fakePayload>) => {
    payload.tables.notifications.push(
      { id: 1, recipient: 10, kind: CLIENT_EMAIL_ALERT_KIND, url: "/admin/mail?thread=read1" },
      { id: 2, recipient: 10, kind: CLIENT_EMAIL_ALERT_KIND, url: "/admin/mail?thread=unread1" },
      { id: 3, recipient: 10, kind: CLIENT_EMAIL_ALERT_KIND, url: "/admin/mail?thread=gone1" },
      { id: 4, recipient: 11, kind: CLIENT_EMAIL_ALERT_KIND, url: "/admin/mail?thread=read1" },
      { id: 5, recipient: 10, kind: "team-task-mention", url: "/admin/mail?thread=read1" },
      { id: 6, recipient: 10, kind: CLIENT_EMAIL_ALERT_KIND, url: "/admin/mail?thread=broken1" },
    );
  };
  const ids = (payload: ReturnType<typeof fakePayload>) => payload.tables.notifications.map((n) => n.id);

  it("reads the thread id from main-Gmail alert links only", () => {
    expect(alertThreadId("/admin/mail?thread=abc123")).toBe("abc123");
    expect(alertThreadId("/admin/mail?thread=abc123&account=sales%40team.test")).toBeNull();
    expect(alertThreadId("/admin/collections/clients/4")).toBeNull();
    expect(alertThreadId(null)).toBeNull();
  });

  it("deletes only the owner's client email alerts for the given threads", async () => {
    const payload = fakePayload([]);
    seed(payload);
    expect(await removeClientEmailAlertsForThreads(payload as never, 10, ["read1"])).toBe(1);
    expect(ids(payload)).toEqual([2, 3, 4, 5, 6]);
    expect(await removeClientEmailAlertsForThreads(payload as never, 10, [])).toBe(0);
  });

  it("removes alerts whose email was read or deleted in Gmail, and keeps unread ones", async () => {
    const payload = fakePayload([]);
    seed(payload);
    const header = (labelIds: string[]) => ({ messageId: "m", from: "", internalDate: 0, labelIds });
    const getThreadHeaders = vi.fn(async (_token: string, threadId: string) => {
      if (threadId === "unread1") return [header(["INBOX"]), header(["INBOX", "UNREAD"])];
      if (threadId === "gone1") return [];
      if (threadId === "broken1") throw new Error("Gmail 500");
      return [header(["INBOX"])];
    });
    expect(await removeAlertsForReadEmails(payload as never, 10, "tok", { getThreadHeaders })).toBe(2);
    expect(ids(payload)).toEqual([2, 4, 5, 6]);
  });
});

describe("syncMailbox raises client email alerts", () => {
  const clients = [{ id: 1, name: "Acme Client", websiteUrl: "acmeclient.com.au", isActive: true }];
  const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const headers: Record<string, Record<string, string>> = {
    inbound: { from: "Jo <jo@acmeclient.com.au>", to: "pat@ourteam.example" },
    outbound: { from: "pat@ourteam.example", to: "jo@acmeclient.com.au" },
    stranger: { from: "someone@random.com", to: "pat@ourteam.example" },
    noreply: { from: "no-reply@acmeclient.com.au", to: "pat@ourteam.example" },
    // From someone who is not a client, copying the client in: stored, but no alert.
    ccClient: { from: "Vendor <sales@vendor.com>", to: "pat@ourteam.example, jo@acmeclient.com.au" },
  };
  const deps = (ids: string[], dateFor: (id: string) => string = () => recent) => ({
    getMailboxProfile: vi.fn(async () => ({ emailAddress: "pat@ourteam.example", historyId: "500" })),
    listRecentMessageIds: vi.fn(async () => ids),
    listAddedMessageIdsSince: vi.fn(async () => ({ ids, resumeHistoryId: null as string | null })),
    getMessageHeaders: vi.fn(async (_t: string, list: string[]) =>
      list.map((id) => ({ messageId: id, threadId: `t-${id}`, cc: "", labelIds: ["INBOX"], ...headers[id] ?? headers.inbound! })),
    ),
    getFullMessage: vi.fn(async (_t: string, id: string) => ({
      messageId: id, threadId: `t-${id}`, rfcMessageId: "", subject: `Subject ${id}`, date: dateFor(id),
      body: "B", bodyHtml: "", cc: "", snippet: "", labelIds: [], ...headers[id] ?? headers.inbound!,
    })),
  });

  it("alerts only for new inbound client emails on an incremental sync", async () => {
    const payload = fakePayload(clients);
    payload.tables["mail-sync-states"].push({ id: 99, user: 10, historyId: "100" });
    const result = await syncMailbox({
      payload: payload as never, userId: 10, accessToken: "tok", hiddenSenders: [],
      deps: deps(["inbound", "outbound", "stranger", "noreply"]),
    });
    expect(result).toMatchObject({ mode: "incremental", stored: 2, alerts: 1 });
    expect(payload.tables.notifications).toHaveLength(1);
    expect(payload.tables.notifications[0]).toMatchObject({ recipient: 10, url: "/admin/mail?thread=t-inbound" });

    // Re-sync of the same mail raises nothing new.
    const again = await syncMailbox({
      payload: payload as never, userId: 10, accessToken: "tok", hiddenSenders: [], deps: deps(["inbound"]),
    });
    expect(again.alerts).toBe(0);
    expect(payload.tables.notifications).toHaveLength(1);
  });

  it("stores calendar invites from a client without alerting", async () => {
    const payload = fakePayload(clients);
    payload.tables["mail-sync-states"].push({ id: 99, user: 10, historyId: "100" });
    const d = deps(["inbound"]);
    const plain = d.getFullMessage.getMockImplementation()!;
    d.getFullMessage.mockImplementation(async (t: string, id: string) => ({ ...(await plain(t, id)), hasCalendarInvite: true }));
    const result = await syncMailbox({ payload: payload as never, userId: 10, accessToken: "tok", hiddenSenders: [], deps: d });
    expect(result).toMatchObject({ mode: "incremental", stored: 1, alerts: 0 });
    expect(payload.tables.notifications).toHaveLength(0);
  });

  it("does not alert for mail from a non-client that only copies a client in", async () => {
    const payload = fakePayload(clients);
    payload.tables["mail-sync-states"].push({ id: 99, user: 10, historyId: "100" });
    const result = await syncMailbox({
      payload: payload as never, userId: 10, accessToken: "tok", hiddenSenders: [], deps: deps(["ccClient"]),
    });
    expect(result).toMatchObject({ mode: "incremental", stored: 1, alerts: 0 });
    expect(payload.tables.notifications).toHaveLength(0);
  });

  it("does not alert for client mail in an extra Gmail account", async () => {
    const payload = fakePayload(clients);
    payload.tables["mail-sync-states"].push({ id: 99, user: 10, historyId: "100" });
    const result = await syncMailbox({
      payload: payload as never, userId: 10, accessToken: "tok", hiddenSenders: [], account: "sales@team.test", deps: deps(["inbound"]),
    });
    expect(result).toMatchObject({ mode: "incremental", stored: 1, alerts: 0 });
    expect(payload.tables.notifications).toHaveLength(0);
  });

  it("does not alert on the first (14-day) sync", async () => {
    const payload = fakePayload(clients);
    const result = await syncMailbox({
      payload: payload as never, userId: 10, accessToken: "tok", hiddenSenders: [], deps: deps(["inbound"]),
    });
    expect(result).toMatchObject({ mode: "initial", stored: 1, alerts: 0 });
    expect(payload.tables.notifications).toHaveLength(0);
  });

  it("caps alerts per sync and keeps the newest", async () => {
    const payload = fakePayload(clients);
    payload.tables["mail-sync-states"].push({ id: 99, user: 10, historyId: "100" });
    const ids = Array.from({ length: MAX_ALERTS_PER_SYNC + 3 }, (_, i) => `n${i}`);
    const base = Date.now() - 60 * 60 * 1000;
    const result = await syncMailbox({
      payload: payload as never, userId: 10, accessToken: "tok", hiddenSenders: [],
      deps: deps(ids, (id) => new Date(base + Number(id.slice(1)) * 60_000).toISOString()),
    });
    expect(result.stored).toBe(ids.length);
    expect(result.alerts).toBe(MAX_ALERTS_PER_SYNC);
    const urls = payload.tables.notifications.map((n) => n.url);
    expect(urls).toContain(`/admin/mail?thread=t-n${ids.length - 1}`);
    expect(urls).not.toContain("/admin/mail?thread=t-n0");
  });

  it("keeps syncing when creating an alert fails", async () => {
    const payload = fakePayload(clients);
    payload.tables["mail-sync-states"].push({ id: 99, user: 10, historyId: "100" });
    const realCreate = payload.create.getMockImplementation()!;
    payload.create.mockImplementation(async (args: any) => {
      if (args.collection === "notifications") throw new Error("db down");
      return realCreate(args);
    });
    const result = await syncMailbox({
      payload: payload as never, userId: 10, accessToken: "tok", hiddenSenders: [], deps: deps(["inbound"]),
    });
    expect(result).toMatchObject({ stored: 1, alerts: 0 });
    expect(payload.tables["mail-sync-states"][0]!.historyId).toBe("500");
  });
});
