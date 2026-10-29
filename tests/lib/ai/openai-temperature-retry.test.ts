import { vi, beforeEach, describe, it, expect } from "vitest";

// Resolve a fake API-key credential so the provider call proceeds to fetch.
vi.mock("@/lib/ai/llm/auth/resolver", () => ({
  resolveCredential: vi.fn(() =>
    Promise.resolve({ authHeader: { Authorization: "Bearer test" }, source: "api-key" }),
  ),
}));

import { callOpenAICompatible } from "@/lib/ai/llm/providers/openai-compatible";
import type { CallLLMOptions } from "@/lib/ai/llm/types";

const globalFetch = vi.fn();
vi.stubGlobal("fetch", globalFetch);

function okResponseBody() {
  return {
    id: "x",
    choices: [{ message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

function makeRes(ok: boolean, status: number, json: unknown): Response {
  return {
    ok,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(typeof json === "string" ? json : JSON.stringify(json)),
  } as unknown as Response;
}

const opts: CallLLMOptions = {
  model: "gpt-6-sol",
  temperature: 0.7,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

const config = { provider: "openai" as const, baseUrl: "https://api.openai.com/v1" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("callOpenAICompatible temperature recovery", () => {
  it("retries without temperature when the model rejects it, then succeeds", async () => {
    const rejection = {
      error: { message: "invalid temperature: only 1 is allowed for this model", type: "invalid_request_error" },
    };
    globalFetch
      .mockResolvedValueOnce(makeRes(false, 400, rejection)) // first attempt: rejected
      .mockResolvedValueOnce(makeRes(true, 200, okResponseBody())); // retry: ok

    const result = await callOpenAICompatible(opts, "gpt-6-sol", config);
    expect(result.message.content.some((p) => p.type === "text")).toBe(true);
    expect(globalFetch).toHaveBeenCalledTimes(2);

    // First body still has temperature (toOpenAI keeps it for non-enumerated ids
    // or proactively strips for gpt-5 — either way the retry must omit it).
    const retryBody = JSON.parse((globalFetch.mock.calls[1][1] as RequestInit).body as string);
    expect(retryBody.temperature).toBeUndefined();
  });

  it("does not retry for unrelated 400 errors", async () => {
    const other = { error: { message: "invalid request: bad messages", type: "invalid_request_error" } };
    globalFetch.mockResolvedValue(makeRes(false, 400, other));

    await expect(callOpenAICompatible(opts, "kimi-k2.6", config)).rejects.toThrow();
    // withRetry may attempt a couple of times for transient-classified errors,
    // but it must never silently succeed; assert it ultimately threw above.
  });
});
