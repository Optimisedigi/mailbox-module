import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_INDEX_TTL_MS, cachedMatchableClients, invalidateMatchableClients } from "@/lib/mail/client-index-cache";

beforeEach(() => invalidateMatchableClients());

describe("cachedMatchableClients", () => {
  it("reads the clients once per minute, again after it expires or a client is saved", async () => {
    const load = vi.fn(async () => [{ id: 1, name: "Acme" }]);
    await cachedMatchableClients(load, 0);
    await cachedMatchableClients(load, CLIENT_INDEX_TTL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await cachedMatchableClients(load, CLIENT_INDEX_TTL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    invalidateMatchableClients();
    await cachedMatchableClients(load, CLIENT_INDEX_TTL_MS + 1);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not keep a failed read", async () => {
    const failing = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(cachedMatchableClients(failing, 0)).rejects.toThrow("db down");
    const load = vi.fn(async () => []);
    await cachedMatchableClients(load, 1);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
