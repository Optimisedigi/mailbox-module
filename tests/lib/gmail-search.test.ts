import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  messagesGet: vi.fn(),
  threadsGet: vi.fn(),
  setCredentials: vi.fn(),
}));

vi.mock("googleapis", () => {
  function OAuth2Mock(this: { setCredentials?: typeof mocks.setCredentials }) {
    this.setCredentials = mocks.setCredentials;
  }

  return {
    google: {
      auth: {
        OAuth2: vi.fn(OAuth2Mock),
      },
      gmail: vi.fn(() => ({
        users: {
          messages: { get: mocks.messagesGet },
          threads: { get: mocks.threadsGet },
        },
      })),
    },
  };
});

import { fetchMessageBody } from "@/lib/gmail-search";

describe("fetchMessageBody", () => {
  beforeEach(() => {
    mocks.messagesGet.mockReset();
    mocks.threadsGet.mockReset();
    mocks.setCredentials.mockReset();
  });

  it("fetches only the selected Gmail message, not the entire thread", async () => {
    mocks.messagesGet.mockResolvedValue({
      data: {
        id: "msg-1",
        threadId: "thread-1",
        payload: {
          headers: [
            { name: "Message-ID", value: "<msg-1@example.com>" },
            { name: "Subject", value: "GA4 access" },
            { name: "From", value: "Client <client@example.com>" },
            { name: "To", value: "user@example.com" },
            { name: "Date", value: "Tue, 23 Jun 2026 10:00:00 +0000" },
          ],
          parts: [
            {
              mimeType: "text/plain",
              body: {
                data: Buffer.from("Latest selected email only", "utf8").toString("base64url"),
              },
            },
          ],
        },
      },
    });

    const result = await fetchMessageBody("access-token", "msg-1");

    expect(mocks.setCredentials).toHaveBeenCalledWith({ access_token: "access-token" });
    expect(mocks.messagesGet).toHaveBeenCalledWith({ userId: "me", id: "msg-1", format: "full" });
    expect(mocks.threadsGet).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      messageId: "msg-1",
      threadId: "thread-1",
      rfcMessageId: "<msg-1@example.com>",
      subject: "GA4 access",
      from: "Client <client@example.com>",
      to: "user@example.com",
      body: "Latest selected email only",
    });
  });
});
